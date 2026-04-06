#!/usr/bin/env python3
"""
Seth 侧出金串行压测（按时长）：在指定时长内循环发起 requestWithdrawToSolanaFromSETH；
上一笔结束（成功或失败）后再发下一笔。

Nonce 策略：
  - 第一笔：nonce = get_nonce(bridge+user) + 1（与现有串行压测一致）
  - 成功：本地 nonce += 1
  - 失败：从链上重新查询 nonce_query_addr，nonce = get_nonce + 1

  cd contracts/seth
  set USER_PRIVATE_KEY=0x...
  python stress_outbound_serial_timed.py --amount-seth 10
  # 默认 4 小时；其它时长: --duration-sec <秒>（如 6h=21600, 1h=3600）

环境: SETH_HOST, SETH_PORT, USER_PRIVATE_KEY / WITHDRAW_USER_PRIVATE_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from deploy_seth import SethClient, encode_call
from request_withdraw_to_solana_from_seth import parse_hex32

from stress_outbound_serial import (
    get_total_wr_stable,
    pool_snapshot_stable,
    send_transaction_with_nonce,
)


@dataclass
class AttemptRecord:
    attempt: int
    t_elapsed_sec: float
    nonce: int
    outcome: str  # "ok" | "fail"
    reason: str
    tx_hash: str | None
    receipt_ok: bool | None
    receipt_status: int | None
    before_wr: int | None
    after_wr: int | None


def main() -> int:
    p = argparse.ArgumentParser(
        description="Seth outbound serial stress for a fixed duration (nonce: chain sync on fail)"
    )
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument("--bridge", default=None)
    p.add_argument("--pool", default=None)
    p.add_argument("--user-key", default=os.environ.get("USER_PRIVATE_KEY") or os.environ.get("WITHDRAW_USER_PRIVATE_KEY"))
    p.add_argument("--amount-seth", type=int, default=10)
    p.add_argument("--min-susdc-raw", type=int, default=0)
    p.add_argument("--gas-limit-call", type=int, default=50_000_000)
    p.add_argument("--receipt-timeout", type=int, default=600)
    p.add_argument(
        "--duration-sec",
        type=int,
        default=4 * 3600,
        help="Stop starting new txs after this many seconds (default 4h = 14400)",
    )
    p.add_argument("--query-retries", type=int, default=3)
    p.add_argument("--query-retry-wait-ms", type=int, default=250)
    p.add_argument("--post-receipt-review-sec", type=float, default=1.5)
    p.add_argument("--sleep-after-attempt-sec", type=float, default=0.3, help="Pause after each attempt before next")
    p.add_argument(
        "--report-dir",
        default=None,
        help="Directory for Markdown report (default: <script_dir>/doc)",
    )
    p.add_argument(
        "--solana-recipient-hex",
        default="1111111111111111111111111111111111111111111111111111111111111111",
    )
    args = p.parse_args()

    if args.duration_sec < 1:
        raise SystemExit("ERROR: --duration-sec must be >= 1")
    if not args.user_key:
        raise SystemExit("ERROR: set USER_PRIVATE_KEY or --user-key")
    pk = args.user_key if args.user_key.startswith("0x") else ("0x" + args.user_key)

    dep = Path(__file__).resolve().parent / "deployment-info.json"
    if args.bridge:
        bridge = args.bridge.replace("0x", "").lower()
    elif dep.is_file():
        bridge = json.loads(dep.read_text(encoding="utf-8"))["SethBridge"].replace("0x", "").lower()
    else:
        raise SystemExit("ERROR: use --bridge or deployment-info.json")

    if args.pool:
        poolb = args.pool.replace("0x", "").lower()
    elif dep.is_file():
        poolb = json.loads(dep.read_text(encoding="utf-8"))["PoolB"].replace("0x", "").lower()
    else:
        raise SystemExit("ERROR: use --pool or deployment-info.json")

    report_dir = Path(args.report_dir) if args.report_dir else Path(__file__).resolve().parent / "doc"
    report_dir.mkdir(parents=True, exist_ok=True)

    sol32 = parse_hex32(args.solana_recipient_hex)
    client = SethClient(args.host, args.port)
    user_addr = client.get_address(pk.replace("0x", ""))

    input_hex = encode_call(
        "requestWithdrawToSolanaFromSETH(bytes32,uint256)",
        ["bytes32", "uint256"],
        [sol32, args.min_susdc_raw],
    )

    nonce_query_addr = bridge + user_addr
    local_nonce = client.get_nonce(nonce_query_addr) + 1

    q_wait = max(0.0, args.query_retry_wait_ms / 1000.0)
    start_mono = time.monotonic()
    start_wall = datetime.now()
    deadline = start_mono + float(args.duration_sec)

    records: list[AttemptRecord] = []
    ok_count = 0
    fail_count = 0
    nonce_resync_count = 0
    attempt_idx = 0

    print(
        f"[timed-stress] host={args.host}:{args.port} bridge=0x{bridge} poolB=0x{poolb}\n"
        f"[timed-stress] duration_sec={args.duration_sec} amount_seth={args.amount_seth} prepayment=0 "
        f"nonce_query_addr={nonce_query_addr} initial_nonce={local_nonce}"
    )

    while time.monotonic() < deadline:
        attempt_idx += 1
        attempt_nonce = local_nonce
        t0 = time.monotonic() - start_mono

        tag = f"[{attempt_idx}]"
        before_wr = get_total_wr_stable(args.host, args.port, user_addr, bridge, args.query_retries, q_wait)
        before_pool = pool_snapshot_stable(args.host, args.port, user_addr, poolb, args.query_retries, q_wait)
        print(
            f"{tag} t={t0:.1f}s nonce={attempt_nonce} "
            f"before_WR={before_wr} pool reserveSETH={before_pool[0]} reservesUSDC_raw={before_pool[1]}"
        )

        txh: str | None = None
        rec_ok: bool | None = None
        rec_st: int | None = None
        after_wr: int | None = None
        reason = ""

        try:
            print(f"{tag} send nonce={attempt_nonce}")
            txh = send_transaction_with_nonce(
                client=client,
                private_key_hex=pk,
                nonce=attempt_nonce,
                to_hex=bridge,
                amount=args.amount_seth,
                gas_limit=args.gas_limit_call,
                gas_price=1,
                step=8,
                input_hex=input_hex,
                prepayment=0,
            )
            if not txh:
                reason = "send failed (no tx hash)"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(
                        attempt_idx,
                        t0,
                        attempt_nonce,
                        "fail",
                        reason,
                        None,
                        None,
                        None,
                        before_wr,
                        None,
                    )
                )
                print(f"{tag} FAIL {reason} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            ok_rc, st = client.wait_for_receipt(txh, timeout=args.receipt_timeout)
            rec_ok = ok_rc
            rec_st = st
            if not ok_rc:
                reason = "receipt wait timed out"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(attempt_idx, t0, attempt_nonce, "fail", reason, txh, rec_ok, rec_st, before_wr, None)
                )
                print(f"{tag} FAIL {reason} tx={txh} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            if st == 5:
                reason = "receipt status=5"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(attempt_idx, t0, attempt_nonce, "fail", reason, txh, rec_ok, rec_st, before_wr, None)
                )
                print(f"{tag} FAIL {reason} tx={txh} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            after_wr = get_total_wr_stable(args.host, args.port, user_addr, bridge, args.query_retries, q_wait)
            after_pool = pool_snapshot_stable(args.host, args.port, user_addr, poolb, args.query_retries, q_wait)

            if after_wr <= before_wr:
                time.sleep(max(0.0, args.post_receipt_review_sec))
                after_wr2 = get_total_wr_stable(args.host, args.port, user_addr, bridge, args.query_retries, q_wait)
                after_pool2 = pool_snapshot_stable(args.host, args.port, user_addr, poolb, args.query_retries, q_wait)
                if after_wr2 > after_wr:
                    after_wr = after_wr2
                if (
                    after_pool2[0] is not None
                    and after_pool2[1] is not None
                    and (after_pool[0] is None or after_pool[1] is None)
                ):
                    after_pool = after_pool2

            if after_wr is None or after_wr <= before_wr:
                reason = f"request counter did not increase (before={before_wr} after={after_wr} receipt_status={st})"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(
                        attempt_idx,
                        t0,
                        attempt_nonce,
                        "fail",
                        reason,
                        txh,
                        rec_ok,
                        rec_st,
                        before_wr,
                        after_wr,
                    )
                )
                print(f"{tag} FAIL {reason} tx={txh} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            if (
                before_pool[0] is None
                or before_pool[1] is None
                or after_pool[0] is None
                or after_pool[1] is None
            ):
                reason = f"pool query incomplete before={before_pool} after={after_pool}"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(
                        attempt_idx,
                        t0,
                        attempt_nonce,
                        "fail",
                        reason,
                        txh,
                        rec_ok,
                        rec_st,
                        before_wr,
                        after_wr,
                    )
                )
                print(f"{tag} FAIL {reason} tx={txh} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            pool_ok = before_pool[0] != after_pool[0] or before_pool[1] != after_pool[1]
            if not pool_ok:
                reason = f"pool reserves unchanged before={before_pool} after={after_pool}"
                fail_count += 1
                local_nonce = client.get_nonce(nonce_query_addr) + 1
                nonce_resync_count += 1
                records.append(
                    AttemptRecord(
                        attempt_idx,
                        t0,
                        attempt_nonce,
                        "fail",
                        reason,
                        txh,
                        rec_ok,
                        rec_st,
                        before_wr,
                        after_wr,
                    )
                )
                print(f"{tag} FAIL {reason} tx={txh} -> resync nonce={local_nonce}")
                time.sleep(max(0.0, args.sleep_after_attempt_sec))
                continue

            local_nonce += 1
            ok_count += 1
            records.append(
                AttemptRecord(
                    attempt_idx,
                    t0,
                    attempt_nonce,
                    "ok",
                    "",
                    txh,
                    rec_ok,
                    rec_st,
                    before_wr,
                    after_wr,
                )
            )
            print(
                f"{tag} OK tx={txh} receipt_status={st} totalWithdrawRequests={after_wr} "
                f"pool reserveSETH {before_pool[0]}->{after_pool[0]} reservesUSDC_raw {before_pool[1]}->{after_pool[1]} "
                f"next_local_nonce={local_nonce}"
            )

        except Exception as e:
            reason = f"exception: {e!r}"
            fail_count += 1
            local_nonce = client.get_nonce(nonce_query_addr) + 1
            nonce_resync_count += 1
            records.append(
                AttemptRecord(
                    attempt_idx,
                    t0,
                    attempt_nonce,
                    "fail",
                    reason,
                    txh,
                    rec_ok,
                    rec_st,
                    before_wr,
                    after_wr,
                )
            )
            print(f"{tag} FAIL {reason} tx={txh or '(none)'} -> resync nonce={local_nonce}", file=sys.stderr)

        time.sleep(max(0.0, args.sleep_after_attempt_sec))

    end_wall = datetime.now()
    elapsed = time.monotonic() - start_mono

    stamp = start_wall.strftime("%Y%m%d_%H%M%S")
    report_path = report_dir / f"outbound_stress_serial_timed_report_{stamp}.md"

    lines: list[str] = [
        "# Seth 出金串行压测报告（按时长）",
        "",
        "## 参数",
        "",
        f"- 开始时间（本地）: {start_wall.isoformat(timespec='seconds')}",
        f"- 结束时间（本地）: {end_wall.isoformat(timespec='seconds')}",
        f"- 计划时长: {args.duration_sec} s ({args.duration_sec / 3600:.2f} h)",
        f"- 实际运行: {elapsed:.1f} s",
        f"- 节点: `{args.host}:{args.port}`",
        f"- SethBridge: `0x{bridge}`",
        f"- PoolB: `0x{poolb}`",
        f"- 每笔金额（SETH 整数）: {args.amount_seth}",
        f"- prepayment: 0",
        f"- receipt 超时: {args.receipt_timeout} s",
        f"- Nonce: 首笔 `get_nonce(bridge+user)+1`；成功 `+1`；失败自 `get_nonce+1` 重同步",
        "",
        "## 汇总",
        "",
        f"| 指标 | 值 |",
        f"|------|-----|",
        f"| 尝试笔数 | {len(records)} |",
        f"| 成功 | {ok_count} |",
        f"| 失败 | {fail_count} |",
        f"| 失败触发的 nonce 链上重同步次数 | {nonce_resync_count} |",
        "",
        "## 明细",
        "",
        "| # | t(s) | nonce | 结果 | receipt | 原因/备注 | tx |",
        "|---|------|-------|------|---------|-----------|-----|",
    ]

    for r in records:
        rs = "" if r.receipt_status is None else str(r.receipt_status)
        rtx = r.tx_hash or ""
        reason = r.reason.replace("|", "\\|")
        lines.append(
            f"| {r.attempt} | {r.t_elapsed_sec:.1f} | {r.nonce} | {r.outcome} | {rs} | {reason} | `{rtx}` |"
        )

    lines.extend(["", "---", f"*报告文件: `{report_path.name}`*", ""])

    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(
        f"[timed-stress] done elapsed={elapsed:.1f}s attempts={len(records)} OK={ok_count} FAIL={fail_count} "
        f"nonce_resyncs={nonce_resync_count}\n[timed-stress] report -> {report_path}"
    )
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
