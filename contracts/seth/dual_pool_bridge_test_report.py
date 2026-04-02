#!/usr/bin/env python3
"""
双池（Seth PoolB + 桥双向）测试报告生成器

- 入金（Solana → Seth）：重复调用 contracts/solana/scripts/test-inbound-lock.js
- 出金（Seth → Solana）：重复调用 test-outbound-lock.py
- Seth 侧：每次阶段前后查询 PoolB.reserveSETH / reservesUSDC / getPrice

用法:
  cd contracts/seth
  pip install -r requirements-seth-deploy.txt
  python dual_pool_bridge_test_report.py

环境: 读取 ../relayer/.env（SETH_HOST/PORT、SOLANA_RPC_URL、RELAYER_PRIVATE_KEY 作 USER_PRIVATE_KEY）
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

CONTRACTS_SETH = Path(__file__).resolve().parent
CONTRACTS_SOLANA = CONTRACTS_SETH.parent / "solana"
RELAYER_ENV = CONTRACTS_SETH.parent.parent / "relayer" / ".env"
DEPLOY = CONTRACTS_SETH / "deployment-info.json"


def load_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _extract_hex_output(resp_text: str) -> str | None:
    if not resp_text:
        return None
    t = resp_text.strip().lower().replace("0x", "")
    if len(t) >= 64 and all(c in "0123456789abcdef" for c in t[:128]):
        return t
    return None


def _decode_uint256_word(hex_out: str, word_index: int = 0) -> int:
    start = word_index * 64
    end = start + 64
    if len(hex_out) < end:
        return 0
    return int(hex_out[start:end], 16)


@dataclass
class PoolSnapshot:
    label: str
    reserve_seth: int
    reserves_usdc_raw: int
    get_price: int
    ts_utc: str


def query_pool_state(
    host: str,
    port: int,
    from_hex: str,
    pool_hex: str,
    encode_call,
) -> tuple[int, int, int]:
    sys.path.insert(0, str(CONTRACTS_SETH))
    from request_withdraw_to_solana_from_seth import query_contract_raw  # noqa: E402

    def q(fn: str) -> int:
        call_hex = encode_call(fn, [], [])
        raw = query_contract_raw(host, port, from_hex, pool_hex, call_hex)
        out = _extract_hex_output(raw or "")
        if not out or len(out) < 64:
            return 0
        return _decode_uint256_word(out, 0)

    return q("reserveSETH()"), q("reservesUSDC()"), q("getPrice()")


def snapshot(
    label: str,
    host: str,
    port: int,
    from_hex: str,
    pool_hex: str,
    encode_call,
) -> PoolSnapshot:
    rs, ru, gp = query_pool_state(host, port, from_hex, pool_hex, encode_call)
    return PoolSnapshot(
        label=label,
        reserve_seth=rs,
        reserves_usdc_raw=ru,
        get_price=gp,
        ts_utc=datetime.now(timezone.utc).isoformat(),
    )


def run_inbound(
    rpc_url: str,
    amount_usdc: float,
    seth_recipient: str,
    cwd: Path,
) -> tuple[bool, str]:
    env = {**os.environ, "RPC_URL": rpc_url}
    cmd = [
        "node",
        str(cwd / "scripts" / "test-inbound-lock.js"),
        "--amount-usdc",
        str(amount_usdc),
        "--seth-recipient",
        seth_recipient,
    ]
    p = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    ok = p.returncode == 0 and "[inbound] signature:" in (p.stdout or "")
    tail = (p.stdout or "") + ("\n" + p.stderr if p.stderr else "")
    return ok, tail[-2000:]


def run_outbound(
    user_key: str,
    amount_seth: int,
    gas_limit: int,
    recipient_hex_64: str,
    bridge: str,
    cwd: Path,
) -> tuple[bool, str]:
    env = {**os.environ, "USER_PRIVATE_KEY": user_key}
    cmd = [
        sys.executable,
        str(cwd / "test-outbound-lock.py"),
        "--amount-seth",
        str(amount_seth),
        "--gas-limit-call",
        str(gas_limit),
        "--solana-recipient-hex",
        recipient_hex_64,
        "--bridge",
        bridge,
    ]
    p = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    ok = p.returncode == 0 and "after totalWithdrawRequests=" in (p.stdout or "")
    tail = (p.stdout or "") + ("\n" + p.stderr if p.stderr else "")
    return ok, tail[-2000:]


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--inbound-runs", type=int, default=20)
    ap.add_argument("--outbound-runs", type=int, default=20)
    ap.add_argument("--amount-usdc", type=float, default=1.0)
    ap.add_argument("--amount-seth", type=int, default=1)
    ap.add_argument("--gas-limit-call", type=int, default=50_000_000)
    ap.add_argument(
        "--solana-recipient-hex",
        default="1111111111111111111111111111111111111111111111111111111111111111",
    )
    ap.add_argument("--out-dir", default=str(CONTRACTS_SETH))
    args = ap.parse_args()

    env_map = load_dotenv(RELAYER_ENV)
    rpc = env_map.get("SOLANA_RPC_URL") or os.environ.get("RPC_URL", "")
    user_key = (
        env_map.get("RELAYER_PRIVATE_KEY")
        or env_map.get("USER_PRIVATE_KEY")
        or os.environ.get("USER_PRIVATE_KEY", "")
    )
    if not user_key:
        print("ERROR: RELAYER_PRIVATE_KEY / USER_PRIVATE_KEY missing in relayer/.env", file=sys.stderr)
        return 1
    if not user_key.startswith("0x"):
        user_key = "0x" + user_key
    if not rpc:
        print("ERROR: SOLANA_RPC_URL missing", file=sys.stderr)
        return 1

    dep = json.loads(DEPLOY.read_text(encoding="utf-8"))
    host = str(dep.get("host") or env_map.get("SETH_HOST", "35.197.170.240"))
    port = int(dep.get("port") or env_map.get("SETH_PORT", "23001"))
    bridge = dep["SethBridge"]
    pool_b = dep["PoolB"]
    deployer = dep["deployer"].replace("0x", "").lower()
    seth_recipient = dep["relayer"]

    sys.path.insert(0, str(CONTRACTS_SETH))
    from deploy_seth import encode_call  # noqa: E402

    started = datetime.now(timezone.utc).isoformat()
    snapshots: list[PoolSnapshot] = []
    inbound_results: list[dict] = []
    outbound_results: list[dict] = []

    snapshots.append(snapshot("initial (before any test)", host, port, deployer, pool_b.replace("0x", "").lower(), encode_call))

    # --- 入金 x N ---
    for i in range(1, args.inbound_runs + 1):
        ok, log = run_inbound(rpc, args.amount_usdc, seth_recipient, CONTRACTS_SOLANA)
        sig_m = re.search(r"\[inbound\] signature:\s*(\S+)", log)
        inbound_results.append(
            {
                "index": i,
                "ok": ok,
                "signature": sig_m.group(1) if sig_m else None,
                "log_tail": log[-800:] if log else "",
            }
        )
        print(f"[inbound {i}/{args.inbound_runs}] ok={ok}")

    snapshots.append(snapshot(f"after {args.inbound_runs} inbound (Solana→Seth)", host, port, deployer, pool_b.replace("0x", "").lower(), encode_call))

    # --- 出金 x N ---
    for i in range(1, args.outbound_runs + 1):
        ok, log = run_outbound(
            user_key,
            args.amount_seth,
            args.gas_limit_call,
            args.solana_recipient_hex,
            bridge,
            CONTRACTS_SETH,
        )
        tx_m = re.search(r"\[outbound\] tx=(\S+)", log)
        outbound_results.append(
            {
                "index": i,
                "ok": ok,
                "tx": tx_m.group(1) if tx_m else None,
                "log_tail": log[-800:] if log else "",
            }
        )
        print(f"[outbound {i}/{args.outbound_runs}] ok={ok}")

    snapshots.append(snapshot(f"after {args.outbound_runs} outbound (Seth→Solana)", host, port, deployer, pool_b.replace("0x", "").lower(), encode_call))

    ended = datetime.now(timezone.utc).isoformat()

    report = {
        "title": "双池桥接测试报告（入金/出金 + Seth PoolB 储备）",
        "started_utc": started,
        "ended_utc": ended,
        "parameters": {
            "inbound_runs": args.inbound_runs,
            "outbound_runs": args.outbound_runs,
            "amount_usdc_per_inbound": args.amount_usdc,
            "amount_seth_per_outbound": args.amount_seth,
            "gas_limit_call": args.gas_limit_call,
            "seth_host": host,
            "seth_port": port,
            "SethBridge": bridge,
            "PoolB": pool_b,
        },
        "pool_snapshots": [asdict(s) for s in snapshots],
        "inbound_runs_detail": inbound_results,
        "outbound_runs_detail": outbound_results,
    }

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir)
    json_path = out_dir / f"dual_pool_test_report_{ts}.json"
    md_path = out_dir / f"dual_pool_test_report_{ts}.md"
    json_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    def fmt_snap(s: PoolSnapshot) -> str:
        return (
            f"| {s.label} | {s.reserve_seth} | {s.reserves_usdc_raw} | {s.get_price} | {s.ts_utc} |"
        )

    md_lines = [
        "# 双池桥接测试报告",
        "",
        f"- 开始（UTC）: {started}",
        f"- 结束（UTC）: {ended}",
        "",
        "## 参数",
        "",
        f"- 入金次数: {args.inbound_runs}，每次 **{args.amount_usdc} USDC**（Solana `process_revenue`）",
        f"- 出金次数: {args.outbound_runs}，每次 **{args.amount_seth} SETH**（`requestWithdrawToSolanaFromSETH`）",
        f"- Seth 节点: `http://{host}:{port}`",
        f"- **PoolB**: `{pool_b}`",
        f"- **SethBridge**: `{bridge}`",
        "",
        "## Seth 侧流动池（PoolB）变化",
        "",
        "| 阶段 | reserveSETH | reservesUSDC (raw, 6dp) | getPrice | 时间(UTC) |",
        "|------|-------------|---------------------------|----------|-----------|",
    ]
    for s in snapshots:
        md_lines.append(fmt_snap(s))
    md_lines.extend(
        [
            "",
            "说明：`reserveSETH` 与合约注释一致为整币 SETH；`reservesUSDC` 为 6 位小数 raw。",
            "",
            "## 入金明细（成功/失败 + 签名）",
            "",
        ]
    )
    for r in inbound_results:
        md_lines.append(f"- #{r['index']}: ok={r['ok']}, signature={r.get('signature')}")
    md_lines.extend(["", "## 出金明细", ""])
    for r in outbound_results:
        md_lines.append(f"- #{r['index']}: ok={r['ok']}, tx={r.get('tx')}")

    md_lines.extend(["", f"完整 JSON: `{json_path.name}`", ""])
    md_path.write_text("\n".join(md_lines), encoding="utf-8")

    print(f"\nWritten:\n  {json_path}\n  {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
