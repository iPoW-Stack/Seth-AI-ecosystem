#!/usr/bin/env python3
"""
Seth 侧出金压力测试（串行）：逐笔发起 requestWithdrawToSolanaFromSETH，等待 Seth 回执，
若合约侧判定成功则校验 PoolB 储备是否变化；异常时打印该笔交易哈希。

不依赖 Relayer / Solana；仅 Seth 合约与 PoolB 状态。

  cd contracts/seth
  set USER_PRIVATE_KEY=0x...
  python stress_outbound_serial.py --runs 20 --amount-seth 10

环境: SETH_HOST, SETH_PORT, USER_PRIVATE_KEY / WITHDRAW_USER_PRIVATE_KEY
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import requests
from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize

from deploy_seth import DEFAULT_CONTRACT_PREPAYMENT, SethClient, encode_call
from request_withdraw_to_solana_from_seth import (
    get_total_withdraw_requests,
    parse_hex32,
    query_contract_raw,
    _decode_uint256_word,
    _extract_hex_output,
)


def send_transaction_with_nonce(
    client: SethClient,
    private_key_hex: str,
    nonce: int,
    to_hex: str,
    amount: int,
    gas_limit: int,
    gas_price: int,
    step: int,
    input_hex: str = "",
    prepayment: int = 0,
) -> str | None:
    pk = private_key_hex[2:] if private_key_hex.startswith("0x") else private_key_hex
    sk = SigningKey.from_string(bytes.fromhex(pk), curve=SECP256k1)
    pubkey_hex = sk.verifying_key.to_string("uncompressed").hex()
    tx_hash = client.compute_hash(
        nonce,
        pubkey_hex,
        to_hex,
        amount,
        gas_limit,
        gas_price,
        step,
        contract_code="",
        input_hex=input_hex,
        prepayment=prepayment,
        key="",
        val="",
    )
    signature = sk.sign_digest_deterministic(
        tx_hash, hashfunc=hashlib.sha256, sigencode=sigencode_string_canonize
    )
    data = {
        "nonce": str(nonce),
        "pubkey": pubkey_hex,
        "to": to_hex,
        "amount": str(amount),
        "gas_limit": str(gas_limit),
        "gas_price": str(gas_price),
        "shard_id": "0",
        "type": str(step),
        "sign_r": signature[0:32].hex(),
        "sign_s": signature[32:64].hex(),
        "sign_v": "0",
    }
    if input_hex:
        data["input"] = input_hex
    if prepayment > 0:
        data["pepay"] = str(prepayment)
    try:
        resp = requests.post(client.tx_url, data=data, timeout=60)
        print(f"  tx response: {resp.text[:500]}")
        if "SignatureInvalid" in resp.text:
            data["sign_v"] = "1"
            resp = requests.post(client.tx_url, data=data, timeout=60)
            print(f"  tx response (v=1): {resp.text[:500]}")
        return tx_hash.hex()
    except Exception as e:
        print(f"  Send TX Error: {e}")
        return None


def pool_snapshot(
    host: str,
    port: int,
    from_hex: str,
    pool_hex: str,
) -> tuple[int | None, int | None, int | None]:
    def q(fn: str) -> int | None:
        call_hex = encode_call(fn, [], [])
        raw = query_contract_raw(host, port, from_hex, pool_hex, call_hex)
        out = _extract_hex_output(raw or "")
        if not out or len(out) < 64:
            return None
        return _decode_uint256_word(out, 0)

    rs = q("reserveSETH()")
    ru = q("reservesUSDC()")
    gp = q("getPrice()")
    if rs is None:
        rs = q("reserveSETH()")
    if gp is None:
        gp = q("getPrice()")
    return rs, ru, gp


def get_total_wr_stable(
    host: str,
    port: int,
    user_addr: str,
    bridge: str,
    retries: int,
    wait_sec: float,
) -> int:
    vals: list[int] = []
    for i in range(max(1, retries)):
        vals.append(get_total_withdraw_requests(host, port, user_addr, bridge))
        if i < retries - 1:
            time.sleep(wait_sec)
    # Prefer last two consistent samples.
    if len(vals) >= 2 and vals[-1] == vals[-2]:
        return vals[-1]
    # Fallback: choose max to avoid transient backward reads (e.g. 0 glitches).
    return max(vals)


def pool_snapshot_stable(
    host: str,
    port: int,
    user_addr: str,
    poolb: str,
    retries: int,
    wait_sec: float,
) -> tuple[int | None, int | None, int | None]:
    last = pool_snapshot(host, port, user_addr, poolb)
    for i in range(1, max(1, retries)):
        time.sleep(wait_sec)
        cur = pool_snapshot(host, port, user_addr, poolb)
        # Two consecutive complete snapshots -> stable enough.
        if (
            last[0] is not None
            and last[1] is not None
            and cur[0] is not None
            and cur[1] is not None
            and last[0] == cur[0]
            and last[1] == cur[1]
        ):
            return cur
        # If current is complete and previous incomplete, prefer current.
        if cur[0] is not None and cur[1] is not None and (last[0] is None or last[1] is None):
            last = cur
        else:
            last = cur
    return last


def main() -> int:
    p = argparse.ArgumentParser(description="Seth outbound serial stress (contract state only)")
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument("--bridge", default=None)
    p.add_argument("--pool", default=None, help="PoolB; default from deployment-info.json")
    p.add_argument("--user-key", default=os.environ.get("USER_PRIVATE_KEY") or os.environ.get("WITHDRAW_USER_PRIVATE_KEY"))
    p.add_argument("--amount-seth", type=int, default=10)
    p.add_argument("--min-susdc-raw", type=int, default=0)
    p.add_argument("--gas-limit-call", type=int, default=50_000_000)
    p.add_argument("--receipt-timeout", type=int, default=600)
    p.add_argument("--runs", type=int, default=20)
    p.add_argument(
        "--nonce",
        type=int,
        default=None,
        help="Fixed nonce for this run (e.g. resend when a prior tx never landed). "
        "If unset, first nonce is get_nonce(bridge+user)+1 then incremented locally.",
    )
    p.add_argument("--query-retries", type=int, default=3, help="Retry count for counter/pool reads")
    p.add_argument("--query-retry-wait-ms", type=int, default=250, help="Wait between query retries (ms)")
    p.add_argument("--post-receipt-review-sec", type=float, default=1.5, help="Recheck window after receipt")
    p.add_argument(
        "--solana-recipient-hex",
        default="1111111111111111111111111111111111111111111111111111111111111111",
        help="64 hex chars (32 bytes) Solana pubkey raw for withdraw request",
    )
    args = p.parse_args()

    if args.runs < 1:
        raise SystemExit("ERROR: --runs must be >= 1")
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

    sol32 = parse_hex32(args.solana_recipient_hex)
    client = SethClient(args.host, args.port)
    user_addr = client.get_address(pk.replace("0x", ""))

    input_hex = encode_call(
        "requestWithdrawToSolanaFromSETH(bytes32,uint256)",
        ["bytes32", "uint256"],
        [sol32, args.min_susdc_raw],
    )

    ok_count = 0
    fail_count = 0
    # First nonce follows the original client behavior:
    # step=8 uses nonce query address "to + myAddress".
    nonce_query_addr = bridge + user_addr
    if args.nonce is not None:
        local_nonce = args.nonce
        chain_next = client.get_nonce(nonce_query_addr) + 1
        print(
            f"[stress] fixed nonce={local_nonce} (node get_nonce+1 for same key would be {chain_next}; "
            f"mismatch may mean already advanced or wrong resend)"
        )
    else:
        local_nonce = client.get_nonce(nonce_query_addr) + 1

    print(
        f"[stress] host={args.host}:{args.port} bridge=0x{bridge} poolB=0x{poolb}\n"
        f"[stress] runs={args.runs} amount_seth={args.amount_seth} prepayment=0 (disabled) "
        f"nonce_query_addr={nonce_query_addr} local_nonce_start={local_nonce}"
    )

    for i in range(1, args.runs + 1):
        tag = f"[{i}/{args.runs}]"
        q_wait = max(0.0, args.query_retry_wait_ms / 1000.0)
        before_wr = get_total_wr_stable(args.host, args.port, user_addr, bridge, args.query_retries, q_wait)
        before_pool = pool_snapshot_stable(args.host, args.port, user_addr, poolb, args.query_retries, q_wait)
        print(f"{tag} before totalWithdrawRequests={before_wr} pool reserveSETH={before_pool[0]} reservesUSDC_raw={before_pool[1]}")

        txh: str | None = None
        try:
            print(f"{tag} send nonce={local_nonce}")
            txh = send_transaction_with_nonce(
                client=client,
                private_key_hex=pk,
                nonce=local_nonce,
                to_hex=bridge,
                amount=args.amount_seth,
                gas_limit=args.gas_limit_call,
                gas_price=1,
                step=8,
                input_hex=input_hex,
                prepayment=0,
            )
            local_nonce += 1
            if not txh:
                print(f"{tag} ERROR send failed (no tx hash)")
                fail_count += 1
                continue

            ok_rc, st = client.wait_for_receipt(txh, timeout=args.receipt_timeout)
            if not ok_rc:
                print(f"{tag} ERROR receipt wait timed out tx={txh}")
                fail_count += 1
                continue
            if st == 5:
                print(f"{tag} ERROR receipt status=5 tx={txh}")
                fail_count += 1
                continue

            after_wr = get_total_wr_stable(args.host, args.port, user_addr, bridge, args.query_retries, q_wait)
            after_pool = pool_snapshot_stable(args.host, args.port, user_addr, poolb, args.query_retries, q_wait)

            if after_wr <= before_wr:
                # Review window: Seth index/query can lag briefly even after receipt.
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

            if after_wr <= before_wr:
                print(
                    f"{tag} ERROR request counter did not increase "
                    f"(before={before_wr} after={after_wr} receipt_status={st}) tx={txh}"
                )
                fail_count += 1
                continue

            if (
                before_pool[0] is None
                or before_pool[1] is None
                or after_pool[0] is None
                or after_pool[1] is None
            ):
                print(f"{tag} ERROR pool query incomplete before={before_pool} after={after_pool} tx={txh}")
                fail_count += 1
                continue

            pool_ok = before_pool[0] != after_pool[0] or before_pool[1] != after_pool[1]
            if not pool_ok:
                print(
                    f"{tag} ERROR pool reserves unchanged after successful withdraw "
                    f"before={before_pool} after={after_pool} tx={txh}"
                )
                fail_count += 1
                continue

            print(
                f"{tag} OK tx={txh} receipt_status={st} totalWithdrawRequests={after_wr} "
                f"pool reserveSETH {before_pool[0]}->{after_pool[0]} reservesUSDC_raw {before_pool[1]}->{after_pool[1]}"
            )
            ok_count += 1

        except Exception as e:
            h = txh or "(no tx hash)"
            print(f"{tag} EXCEPTION {e!r} tx={h}", file=sys.stderr)
            fail_count += 1

        time.sleep(0.3)

    print(f"[stress] done OK={ok_count} FAIL={fail_count}")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
