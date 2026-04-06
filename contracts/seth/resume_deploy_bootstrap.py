#!/usr/bin/env python3
"""
Resume after deploy_seth.py failed mid-way (e.g. PoolB.transferOwnership status=5).
Runs transferOwnership + bootstrap (addMinter deployer, mint Treasury, injectToPoolB).

Example (addresses from failed deploy output):
  python resume_deploy_bootstrap.py \\
    --susdc 508fb20e0046f69b43c2daf61d0690a972e133b6 \\
    --bridge edc0169471e1b2261ae0b20ba4bc69edbc95a5b0 \\
    --treasury 8c6bb90d7389c039047fe73ae3a7dd0c4c7ef495 \\
    --pool bde6f924f7333ba3039ec48a4ef460ffde491950 \\
    --mint-susdc-raw 1000000000000 --inject-susdc-raw 1000000000 --inject-seth 100000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from eth_utils import to_checksum_address

from deploy_seth import (
    SethClient,
    encode_call,
    inject_chunks,
    parse_inject_native_seth,
    require_seth_tx_ok,
)

CONTRACTS_DIR = Path(__file__).resolve().parent


def main() -> int:
    p = argparse.ArgumentParser(description="Resume PoolB ownership + pool bootstrap")
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument("--deployer-key", default=os.environ.get("DEPLOYER_PRIVATE_KEY"))
    p.add_argument("--susdc", required=True)
    p.add_argument("--bridge", required=True)
    p.add_argument("--treasury", required=True)
    p.add_argument("--pool", required=True)
    p.add_argument("--gas-limit-call", type=int, default=15_000_000)
    p.add_argument("--mint-susdc-raw", type=int, default=1_000_000_000_000)
    p.add_argument("--inject-susdc-raw", type=int, default=1_000_000_000)
    p.add_argument("--inject-seth", type=str, default="100000")
    p.add_argument("--output", default=str(CONTRACTS_DIR / "deployment-info.json"))
    args = p.parse_args()

    if not args.deployer_key:
        print("Set DEPLOYER_PRIVATE_KEY", file=sys.stderr)
        return 1

    deployer_pk = args.deployer_key.strip()
    if not deployer_pk.startswith("0x"):
        deployer_pk = "0x" + deployer_pk

    def norm(x: str) -> str:
        return x.replace("0x", "").lower()

    addr_susdc = norm(args.susdc)
    addr_bridge = norm(args.bridge)
    addr_treasury = norm(args.treasury)
    addr_pool = norm(args.pool)

    try:
        inject_seth_native = parse_inject_native_seth(args.inject_seth)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if args.mint_susdc_raw < args.inject_susdc_raw:
        print("ERROR: mint must be >= inject", file=sys.stderr)
        return 1

    client = SethClient(args.host, args.port)
    deployer_addr = client.get_address(deployer_pk.replace("0x", ""))
    gl = args.gas_limit_call

    print("[Resume] PoolB.transferOwnership(Treasury)")
    inp_po = encode_call(
        "transferOwnership(address)",
        ["address"],
        [to_checksum_address("0x" + addr_treasury)],
    )
    tx_po = client.send_transaction_auto(
        deployer_pk,
        addr_pool,
        step=8,
        input_hex=inp_po,
        gas_limit=gl,
    )
    if not tx_po:
        raise RuntimeError("transferOwnership send failed")
    ok_po, st_po = client.wait_for_receipt(tx_po, timeout=600)
    if not ok_po:
        raise RuntimeError("transferOwnership receipt timeout")
    print(f"  receipt status={st_po} tx={tx_po}")
    require_seth_tx_ok("PoolB.transferOwnership(Treasury)", tx_po, st_po)

    print("[Bootstrap] sUSDC.addMinter(deployer)")
    inp_am = encode_call(
        "addMinter(address)",
        ["address"],
        [to_checksum_address("0x" + deployer_addr)],
    )
    tx_am = client.send_transaction_auto(deployer_pk, addr_susdc, step=8, input_hex=inp_am, gas_limit=gl)
    if not tx_am:
        raise RuntimeError("addMinter(deployer) send failed")
    ok_am, st_am = client.wait_for_receipt(tx_am, timeout=600)
    if not ok_am:
        raise RuntimeError("addMinter(deployer) receipt timeout")
    print(f"  receipt status={st_am} tx={tx_am}")
    require_seth_tx_ok("addMinter(deployer)", tx_am, st_am)

    print(f"[Bootstrap] sUSDC.mint(Treasury, {args.mint_susdc_raw})")
    inp_mint = encode_call(
        "mint(address,uint256)",
        ["address", "uint256"],
        [to_checksum_address("0x" + addr_treasury), args.mint_susdc_raw],
    )
    tx_mint = client.send_transaction_auto(deployer_pk, addr_susdc, step=8, input_hex=inp_mint, gas_limit=gl)
    if not tx_mint:
        raise RuntimeError("mint send failed")
    ok_mint, st_mint = client.wait_for_receipt(tx_mint, timeout=600)
    if not ok_mint:
        raise RuntimeError("mint receipt timeout")
    print(f"  receipt status={st_mint} tx={tx_mint}")
    require_seth_tx_ok("sUSDC.mint(Treasury)", tx_mint, st_mint)

    parts = inject_chunks(args.inject_susdc_raw, inject_seth_native)
    inj_gas = max(2_000_000, gl)
    for i, (c_susdc, c_seth) in enumerate(parts, start=1):
        print(f"[Bootstrap] Treasury.injectToPoolB part {i}/{len(parts)}: sUSDC raw={c_susdc}, SETH={c_seth}")
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
        ok_inj, st_inj = client.wait_for_receipt(tx_inj, timeout=600)
        if not ok_inj:
            raise RuntimeError("injectToPoolB receipt timeout")
        print(f"  receipt status={st_inj} tx={tx_inj}")
        require_seth_tx_ok("Treasury.injectToPoolB", tx_inj, st_inj)

    out = {
        "network": "seth",
        "host": args.host,
        "port": args.port,
        "sUSDC": "0x" + addr_susdc,
        "SethBridge": "0x" + addr_bridge,
        "Treasury": "0x" + addr_treasury,
        "PoolB": "0x" + addr_pool,
        "deployer": "0x" + deployer_addr,
        "notes": ["Resumed via resume_deploy_bootstrap.py"],
    }
    Path(args.output).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\nWritten:", args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
