#!/usr/bin/env python3
"""
Call SethBridge.processCrossChainMessageV2 (same wire format as deploy_seth.py).

  processCrossChainMessageV2(
    bytes32 solanaTxSig,
    uint256 ecosystemAmount,
    uint256 amountSETH,
    address recipient
  ) external payable onlyRelayer

Contract note: PoolB/Treasury allow sUSDC-only inject (amountSETH=0) or SETH-only
(ecosystemAmount=0 with amountSETH>0 on V2). V1 still requires ecosystemAmount > 0.

Usage:
  cd contracts/seth
  pip install -r requirements-seth-deploy.txt
  set RELAYER_PRIVATE_KEY=0x...   # must be trustedRelayer on SethBridge
  python call_process_cross_chain_v2.py

Optional:
  python call_process_cross_chain_v2.py --amount-seth 1
  python call_process_cross_chain_v2.py --solana-tx-sig 0x...   # fixed bytes32 instead of random
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))

from deploy_seth import SethClient, encode_call  # noqa: E402
from eth_utils import to_checksum_address  # noqa: E402


DEFAULT_RECIPIENT = "0x07271b59cE0165da5b66022a401029A2110E9761"


def parse_bytes32_hex(s: str) -> bytes:
    h = s.strip().lower().replace("0x", "")
    if len(h) != 64:
        raise ValueError("solanaTxSig must be 32 bytes (64 hex chars)")
    return bytes.fromhex(h)


def main() -> int:
    p = argparse.ArgumentParser(description="Call processCrossChainMessageV2 on SethBridge")
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument(
        "--bridge",
        default=None,
        help="SethBridge 40-hex address; default from deployment-info.json SethBridge",
    )
    p.add_argument(
        "--relayer-key",
        default=os.environ.get("RELAYER_PRIVATE_KEY")
        or os.environ.get("DEPLOYER_PRIVATE_KEY"),
        help="Hex private key of trustedRelayer (0x...). Env: RELAYER_PRIVATE_KEY",
    )
    p.add_argument("--ecosystem-amount", type=int, default=350000, help="6-decimal raw sUSDC")
    p.add_argument("--amount-seth", type=int, default=0, help="Native SETH count (integer)")
    p.add_argument("--recipient", default=DEFAULT_RECIPIENT)
    p.add_argument(
        "--solana-tx-sig",
        default=None,
        help="Optional fixed bytes32 (64 hex). Default: random 32 bytes",
    )
    p.add_argument("--gas-limit-call", type=int, default=5_000_000)
    args = p.parse_args()

    if not args.relayer_key:
        print("ERROR: Set RELAYER_PRIVATE_KEY or --relayer-key", file=sys.stderr)
        return 1

    pk = args.relayer_key.strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk

    dep = CONTRACTS_DIR / "deployment-info.json"
    if args.bridge:
        addr_bridge = args.bridge.replace("0x", "").lower()
    elif dep.is_file():
        j = json.loads(dep.read_text(encoding="utf-8"))
        addr_bridge = j["SethBridge"].replace("0x", "").lower()
    else:
        print("ERROR: pass --bridge or create deployment-info.json", file=sys.stderr)
        return 1

    if args.solana_tx_sig:
        solana_tx_sig = parse_bytes32_hex(args.solana_tx_sig)
    else:
        solana_tx_sig = secrets.token_bytes(32)

    recipient = to_checksum_address(
        args.recipient if args.recipient.startswith("0x") else "0x" + args.recipient
    )

    inp = encode_call(
        "processCrossChainMessageV2(bytes32,uint256,uint256,address)",
        ["bytes32", "uint256", "uint256", "address"],
        [
            solana_tx_sig,
            args.ecosystem_amount,
            args.amount_seth,
            recipient,
        ],
    )

    client = SethClient(args.host, args.port)
    print(f"Seth: {args.host}:{args.port}")
    print(f"SethBridge: 0x{addr_bridge}")
    print(f"solanaTxSig: 0x{solana_tx_sig.hex()}")
    print(f"ecosystemAmount: {args.ecosystem_amount}")
    print(f"amountSETH: {args.amount_seth}")
    print(f"recipient: {recipient}")

    txh = client.send_transaction_auto(
        pk,
        addr_bridge,
        amount=args.amount_seth,
        gas_limit=args.gas_limit_call,
        gas_price=1,
        step=8,
        input_hex=inp,
    )
    if not txh:
        print("ERROR: send failed", file=sys.stderr)
        return 1
    ok, st = client.wait_for_receipt(txh)
    if not ok:
        print("ERROR: receipt timeout", file=sys.stderr)
        return 1
    print(f"receipt status={st} tx={txh}")
    if st == 5:
        print("ERROR: status=5 (likely reverted — try --amount-seth 1)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
