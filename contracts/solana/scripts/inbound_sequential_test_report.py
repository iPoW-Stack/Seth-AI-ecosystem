#!/usr/bin/env python3
"""
顺序入金测试（每笔等待 Relayer DB 为 completed 后再发下一笔），并记录 Seth PoolB 流动性。

依赖:
  pip install pymysql
  Node: contracts/solana 下已安装依赖；Relayer 与 MySQL 已启动。

环境（可由 ../relayer/.env 读取）:
  SOLANA_RPC_URL / RPC_URL
  DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD

用法:
  cd contracts/solana
  python scripts/inbound_sequential_test_report.py --runs 10 --amount-usdc 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SOLANA_DIR = SCRIPTS_DIR.parent
REPO_ROOT = SOLANA_DIR.parent.parent
RELAYER_ENV = REPO_ROOT / "relayer" / ".env"
SETH_DIR = REPO_ROOT / "contracts" / "seth"
DEPLOY_INFO = SETH_DIR / "deployment-info.json"


def load_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
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


def pool_snapshot(host: str, port: int, from_hex: str, pool_hex: str) -> dict:
    sys.path.insert(0, str(SETH_DIR))
    from deploy_seth import encode_call  # noqa: E402
    from request_withdraw_to_solana_from_seth import query_contract_raw  # noqa: E402

    def q(fn: str) -> int:
        call_hex = encode_call(fn, [], [])
        raw = query_contract_raw(host, port, from_hex, pool_hex, call_hex)
        out = _extract_hex_output(raw or "")
        if not out or len(out) < 64:
            return 0
        return _decode_uint256_word(out, 0)

    rs = q("reserveSETH()")
    ru = q("reservesUSDC()")
    gp = q("getPrice()")
    return {
        "reserveSETH": rs,
        "reservesUSDC_raw": ru,
        "getPrice": gp,
        "ts_utc": datetime.now(timezone.utc).isoformat(),
    }


def run_one_inbound(rpc_url: str, amount_usdc: float, seth_recipient: str) -> tuple[bool, str, str]:
    env = {**os.environ, "RPC_URL": rpc_url}
    cmd = [
        "node",
        str(SOLANA_DIR / "scripts" / "test-inbound-lock.js"),
        "--amount-usdc",
        str(amount_usdc),
        "--seth-recipient",
        seth_recipient,
    ]
    p = subprocess.run(
        cmd,
        cwd=str(SOLANA_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=240,
    )
    out = (p.stdout or "") + (p.stderr or "")
    m = re.search(r"\[inbound\] signature:\s*(\S+)", out)
    sig = m.group(1) if m else ""
    return p.returncode == 0 and bool(sig), sig, out[-1500:]


def wait_db_completed(conn, signature: str, poll_sec: float, timeout_sec: float) -> dict:
    try:
        import pymysql  # noqa: WPS433
    except ImportError:
        raise SystemExit("pip install pymysql") from None

    deadline = time.time() + timeout_sec
    last: dict | None = None
    t0 = time.time()
    last_log = t0
    while time.time() < deadline:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT status, seth_tx_hash, processed_at, updated_at, last_error
                FROM cross_chain_messages
                WHERE solana_tx_sig = %s
                """,
                (signature,),
            )
            row = cur.fetchone()
        if row:
            status = row[0]
            last = {
                "status": status,
                "seth_tx_hash": row[1],
                "processed_at": row[2].isoformat() if row[2] else None,
                "updated_at": row[3].isoformat() if row[3] else None,
                "last_error": row[4],
            }
            if status == "completed":
                last["wait_seconds"] = round(time.time() - t0, 2)
                return last
            if status == "failed":
                raise RuntimeError(f"message failed in DB: {last}")
        now = time.time()
        if now - last_log >= 30:
            st = last.get("status") if last else "(no row yet)"
            print(f"    ... still waiting ({int(now - t0)}s elapsed, status={st})")
            last_log = now
        time.sleep(poll_sec)
    raise TimeoutError(
        f"timeout waiting for completed: sig={signature} last={last}"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=10)
    ap.add_argument("--amount-usdc", type=float, default=1.0)
    ap.add_argument("--poll-sec", type=float, default=3.0)
    ap.add_argument(
        "--db-timeout-sec",
        type=float,
        default=1800.0,
        help="Max wait per run for cross_chain_messages.status=completed (default 30min)",
    )
    ap.add_argument("--out-dir", default=str(SOLANA_DIR))
    args = ap.parse_args()

    env_map = load_dotenv(RELAYER_ENV)
    rpc = env_map.get("SOLANA_RPC_URL") or os.environ.get("RPC_URL", "")
    if not rpc:
        print("ERROR: SOLANA_RPC_URL / RPC_URL missing", file=sys.stderr)
        return 1

    dep = json.loads(DEPLOY_INFO.read_text(encoding="utf-8"))
    host = str(dep.get("host") or "35.197.170.240")
    port = int(dep.get("port") or 23001)
    pool_b = dep["PoolB"].replace("0x", "").lower()
    deployer = dep["deployer"].replace("0x", "").lower()
    seth_recipient = dep["relayer"]

    db_conf = {
        "host": env_map.get("DB_HOST", "127.0.0.1"),
        "port": int(env_map.get("DB_PORT", "3306")),
        "user": env_map.get("DB_USER", "root"),
        "password": env_map.get("DB_PASSWORD", ""),
        "database": env_map.get("DB_NAME", "bridge_relayer"),
    }

    try:
        import pymysql  # noqa: WPS433
    except ImportError:
        print("ERROR: pip install pymysql", file=sys.stderr)
        return 1

    conn = pymysql.connect(
        host=db_conf["host"],
        port=db_conf["port"],
        user=db_conf["user"],
        password=db_conf["password"],
        database=db_conf["database"],
        cursorclass=pymysql.cursors.Cursor,
    )

    started = datetime.now(timezone.utc).isoformat()
    pool_before = pool_snapshot(host, port, deployer, pool_b)
    rows_out: list[dict] = []
    pool_prev = dict(pool_before)

    try:
        for i in range(1, args.runs + 1):
            print(f"\n=== Run {i}/{args.runs} send inbound ===")
            ok, sig, log_tail = run_one_inbound(rpc, args.amount_usdc, seth_recipient)
            if not ok:
                print(log_tail)
                raise RuntimeError(f"inbound send failed run {i}")

            print(f"  solana sig: {sig}")
            print(f"  waiting DB status=completed ...")
            db_row = wait_db_completed(conn, sig, args.poll_sec, args.db_timeout_sec)
            print(f"  DB completed: seth_tx={db_row.get('seth_tx_hash')}")

            pool_after = pool_snapshot(host, port, deployer, pool_b)
            delta = {
                "reserveSETH": pool_after["reserveSETH"] - pool_prev["reserveSETH"],
                "reservesUSDC_raw": pool_after["reservesUSDC_raw"]
                - pool_prev["reservesUSDC_raw"],
            }
            rows_out.append(
                {
                    "run": i,
                    "solana_signature": sig,
                    "db": db_row,
                    "pool_after": pool_after,
                    "pool_delta_from_previous": delta,
                }
            )
            pool_prev = dict(pool_after)
            print(
                f"  pool: reserveSETH={pool_after['reserveSETH']} "
                f"reservesUSDC_raw={pool_after['reservesUSDC_raw']} "
                f"(delta SETH {delta['reserveSETH']}, raw {delta['reservesUSDC_raw']})"
            )
    finally:
        conn.close()

    ended = datetime.now(timezone.utc).isoformat()
    report = {
        "title": "顺序入金测试报告（等待 DB completed + Seth PoolB）",
        "started_utc": started,
        "ended_utc": ended,
        "parameters": {
            "runs": args.runs,
            "amount_usdc": args.amount_usdc,
            "seth_recipient": seth_recipient,
            "pool_b": dep["PoolB"],
            "db_host": db_conf["host"],
        },
        "pool_before_first_run": pool_before,
        "runs": rows_out,
    }

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir)
    jpath = out_dir / f"inbound_sequential_report_{ts}.json"
    mpath = out_dir / f"inbound_sequential_report_{ts}.md"
    jpath.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    lines = [
        "# 顺序入金测试报告",
        "",
        f"- 开始: {started}",
        f"- 结束: {ended}",
        f"- 笔数: {args.runs}，每笔 **{args.amount_usdc} USDC**",
        f"- PoolB: `{dep['PoolB']}`",
        "",
        "## 初始池子（第一笔前）",
        "",
        f"- reserveSETH: {pool_before['reserveSETH']}",
        f"- reservesUSDC_raw: {pool_before['reservesUSDC_raw']}",
        f"- getPrice: {pool_before['getPrice']}",
        "",
        "## 每笔完成后池子",
        "",
        "| # | Solana 签名 | Seth tx | reserveSETH | reservesUSDC_raw | ΔSETH | Δraw | wait_s |",
        "|---|-------------|---------|-------------|------------------|-------|------|--------|",
    ]
    for r in rows_out:
        p = r["pool_after"]
        d = r.get("pool_delta_from_previous") or {}
        stx = (r.get("db") or {}).get("seth_tx_hash") or ""
        w = (r.get("db") or {}).get("wait_seconds")
        lines.append(
            f"| {r['run']} | `{r['solana_signature'][:16]}...` | `{str(stx)[:16]}...` | "
            f"{p['reserveSETH']} | {p['reservesUSDC_raw']} | {d.get('reserveSETH', '')} | "
            f"{d.get('reservesUSDC_raw', '')} | {w} |"
        )
    lines.extend(["", f"完整 JSON: `{jpath.name}`", ""])
    mpath.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nWritten:\n  {jpath}\n  {mpath}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
