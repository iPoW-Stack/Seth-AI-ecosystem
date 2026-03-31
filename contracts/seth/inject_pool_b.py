#!/usr/bin/env python3
"""
Inject PoolB liquidity on an existing Seth deployment (same txs as deploy_seth.py bootstrap).

Reads addresses from deployment-info.json; uses deploy_seth.SethClient (Python signing — matches deploy).

  cd contracts/seth
  pip install -r requirements-seth-deploy.txt
  set DEPLOYER_PRIVATE_KEY=0x...
  python inject_pool_b.py --inject-susdc-raw 100000000 --inject-seth 100

Env: SETH_HOST, SETH_PORT, DEPLOYER_PRIVATE_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))

from deploy_seth import (  # noqa: E402
    SethClient,
    encode_call,
    inject_chunks,
    parse_inject_native_seth,
)
from eth_utils import to_checksum_address  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description="Mint sUSDC to Treasury + Treasury.injectToPoolB")
    p.add_argument(
        "--deployment",
        default=str(CONTRACTS_DIR / "deployment-info.json"),
        help="JSON with sUSDC, Treasury, PoolB",
    )
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument(
        "--inject-susdc-raw",
        type=int,
        default=100_000_000,
        help="sUSDC 6-decimal raw (100000000 = 100 sUSDC)",
    )
    p.add_argument(
        "--inject-seth",
        type=str,
        default="100",
        help="Native SETH count (integer; 1 = 1 SETH)",
    )
    p.add_argument(
        "--mint-susdc-raw",
        type=int,
        default=None,
        help="Mint to Treasury first; default = inject-susdc-raw",
    )
    p.add_argument("--deployer-key", default=os.environ.get("DEPLOYER_PRIVATE_KEY"))
    p.add_argument("--gas-limit-call", type=int, default=500_000)
    args = p.parse_args()

    mint_raw = args.mint_susdc_raw if args.mint_susdc_raw is not None else args.inject_susdc_raw
    if mint_raw < args.inject_susdc_raw:
        print("ERROR: --mint-susdc-raw must be >= --inject-susdc-raw", file=sys.stderr)
        return 1
    if args.inject_susdc_raw < 1:
        print("ERROR: --inject-susdc-raw must be >= 1", file=sys.stderr)
        return 1

    if not args.deployer_key:
        print("Set DEPLOYER_PRIVATE_KEY or --deployer-key", file=sys.stderr)
        return 1

    deployer_pk = args.deployer_key.strip()
    if not deployer_pk.startswith("0x"):
        deployer_pk = "0x" + deployer_pk

    try:
        inject_seth_native = parse_inject_native_seth(args.inject_seth)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    dep_path = Path(args.deployment)
    if not dep_path.is_file():
        print(f"ERROR: deployment file not found: {dep_path}", file=sys.stderr)
        return 1
    dep = json.loads(dep_path.read_text(encoding="utf-8"))
    addr_susdc = dep["sUSDC"].replace("0x", "").lower()
    addr_treasury = dep["Treasury"].replace("0x", "").lower()

    client = SethClient(args.host, args.port)
    deployer_addr = client.get_address(deployer_pk)
    print(f"Deployer {deployer_addr}")
    print(
        f"Mint raw={mint_raw} inject sUSDC raw={args.inject_susdc_raw} "
        f"SETH={inject_seth_native}"
    )

    print("[1/3] sUSDC.addMinter(deployer)")
    inp_am = encode_call(
        "addMinter(address)",
        ["address"],
        [to_checksum_address("0x" + deployer_addr)],
    )
    tx_am = client.send_transaction_auto(
        deployer_pk,
        addr_susdc,
        step=8,
        input_hex=inp_am,
        gas_limit=args.gas_limit_call,
    )
    if not tx_am:
        raise RuntimeError("addMinter send failed")
    ok_am, st_am = client.wait_for_receipt(tx_am)
    if not ok_am:
        raise RuntimeError("addMinter receipt timeout")
    print(f"  addMinter receipt status={st_am} tx={tx_am}")

    print(f"[2/3] sUSDC.mint(Treasury, {mint_raw})")
    inp_mint = encode_call(
        "mint(address,uint256)",
        ["address", "uint256"],
        [to_checksum_address("0x" + addr_treasury), mint_raw],
    )
    tx_mint = client.send_transaction_auto(
        deployer_pk,
        addr_susdc,
        step=8,
        input_hex=inp_mint,
        gas_limit=args.gas_limit_call,
    )
    if not tx_mint:
        raise RuntimeError("mint send failed")
    ok_mint, st_mint = client.wait_for_receipt(tx_mint)
    if not ok_mint:
        raise RuntimeError("mint receipt timeout")
    print(f"  mint receipt status={st_mint} tx={tx_mint}")

    parts = inject_chunks(args.inject_susdc_raw, inject_seth_native)
    inj_gas = max(2_000_000, args.gas_limit_call)
    if len(parts) > 1:
        print(f"[3/3] Treasury.injectToPoolB split into {len(parts)} txs")

    for i, (c_susdc, c_seth) in enumerate(parts, start=1):
        print(
            f"[3/3] Treasury.injectToPoolB part {i}/{len(parts)}: "
            f"sUSDC raw={c_susdc} SETH={c_seth}"
        )
        inp_inj = encode_call(
            "injectToPoolB(uint256,uint256)",
            ["uint256", "uint256"],
            [c_susdc, c_seth],
        )
        tx_inj = client.send_transaction_auto(
            deployer_pk,
            addr_treasury,
            amount=c_seth,
            gas_limit=inj_gas,
            gas_price=1,
            step=8,
            input_hex=inp_inj,
        )
        if not tx_inj:
            raise RuntimeError("injectToPoolB send failed")
        ok_inj, st_inj = client.wait_for_receipt(tx_inj)
        if not ok_inj:
            raise RuntimeError("injectToPoolB receipt timeout")
        if st_inj == 5:
            raise RuntimeError(
                "injectToPoolB status=5 — check deployer native balance (need 100 SETH), PoolB wiring."
            )
        print(f"  injectToPoolB receipt status={st_inj} tx={tx_inj}")

    print("Done.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
