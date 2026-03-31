#!/usr/bin/env python3
"""
Outbound test (Seth -> Solana):
Create a withdraw/lock request and query lock-style fields including lockRequestKey.

Usage:
  cd contracts/seth
  python test-outbound-lock.py --amount-seth 10 --solana-recipient-base58 GRuCu61Pfyub9CgYjnqQGq9aeGAUKAUZ9pBEpLExjDqy
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from request_withdraw_to_solana_from_seth import (
    get_total_withdraw_requests,
    get_withdraw_request,
    parse_hex32,
    solana_pubkey_bytes_from_base58,
    query_contract_raw,
    _extract_hex_output,
    _decode_uint256_word,
)
from deploy_seth import SethClient, encode_call, require_seth_tx_ok


def q_word(host: str, port: int, from_hex: str, bridge_hex: str, fn_sig: str, request_id: int) -> str | None:
    call_hex = encode_call(fn_sig, ["uint256"], [request_id])
    raw = query_contract_raw(host, port, from_hex, bridge_hex, call_hex)
    out = _extract_hex_output(raw or "")
    if not out or len(out) < 64:
        return None
    return out[:64]


def q_lock_key(host: str, port: int, from_hex: str, bridge_hex: str, request_id: int) -> str | None:
    for fn_sig in ("lockRequestKey(uint256)", "withdrawRequestKey(uint256)"):
        w = q_word(host, port, from_hex, bridge_hex, fn_sig, request_id)
        if w:
            return "0x" + w
    return None


def main() -> int:
    p = argparse.ArgumentParser(description="Seth outbound lock/withdraw request test")
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument("--bridge", default=None, help="SethBridge address; default from deployment-info.json")
    p.add_argument("--user-key", default=os.environ.get("USER_PRIVATE_KEY") or os.environ.get("WITHDRAW_USER_PRIVATE_KEY"))
    p.add_argument("--amount-seth", type=int, default=1)
    p.add_argument("--min-susdc-raw", type=int, default=0)
    p.add_argument("--gas-limit-call", type=int, default=5_000_000)
    p.add_argument("--solana-recipient-hex", default=None)
    p.add_argument("--solana-recipient-base58", default=None)
    args = p.parse_args()

    if not args.user_key:
        raise SystemExit("ERROR: set USER_PRIVATE_KEY or --user-key")
    pk = args.user_key if args.user_key.startswith("0x") else ("0x" + args.user_key)

    if args.solana_recipient_base58:
        sol32 = solana_pubkey_bytes_from_base58(args.solana_recipient_base58)
    elif args.solana_recipient_hex:
        sol32 = parse_hex32(args.solana_recipient_hex)
    else:
        raise SystemExit("ERROR: pass --solana-recipient-hex or --solana-recipient-base58")

    dep = Path(__file__).resolve().parent / "deployment-info.json"
    if args.bridge:
        bridge = args.bridge.replace("0x", "").lower()
    elif dep.is_file():
        bridge = json.loads(dep.read_text(encoding="utf-8"))["SethBridge"].replace("0x", "").lower()
    else:
        raise SystemExit("ERROR: use --bridge or create deployment-info.json")

    client = SethClient(args.host, args.port)
    user_addr = client.get_address(pk.replace("0x", ""))
    before = get_total_withdraw_requests(args.host, args.port, user_addr, bridge)
    print(f"[outbound] before totalWithdrawRequests={before}")

    input_hex = encode_call(
        "requestWithdrawToSolanaFromSETH(bytes32,uint256)",
        ["bytes32", "uint256"],
        [sol32, args.min_susdc_raw],
    )
    txh = client.send_transaction_auto(
        pk,
        bridge,
        amount=args.amount_seth,
        gas_limit=args.gas_limit_call,
        gas_price=1,
        step=8,
        input_hex=input_hex,
    )
    if not txh:
        raise SystemExit("ERROR: send failed")
    ok, st = client.wait_for_receipt(txh)
    if not ok:
        raise SystemExit("ERROR: receipt wait timed out")
    require_seth_tx_ok("requestWithdrawToSolanaFromSETH", txh, st)
    print(f"[outbound] tx={txh} status={st}")

    after = get_total_withdraw_requests(args.host, args.port, user_addr, bridge)
    print(f"[outbound] after totalWithdrawRequests={after}")
    if after <= before:
        raise SystemExit("ERROR: request counter did not increase")

    req = get_withdraw_request(args.host, args.port, user_addr, bridge, after)
    key = q_lock_key(args.host, args.port, user_addr, bridge, after)
    print(f"[outbound] request_id={after}")
    print(f"[outbound] request={req}")
    print(f"[outbound] lockRequestKey={key}")
    print("[outbound] relayer should unlock on Solana and then mark processed on Seth")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

