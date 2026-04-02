#!/usr/bin/env python3
"""Resume Seth deploy after setTreasury timeout: setTreasury, PoolB.transferOwnership, bootstrap."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from eth_utils import to_checksum_address

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))

from deploy_seth import (  # noqa: E402
    SethClient,
    encode_call,
    inject_chunks,
    require_seth_tx_ok,
    parse_inject_native_seth,
)
from request_withdraw_to_solana_from_seth import (  # noqa: E402
    query_contract_raw,
    _extract_hex_output,
    _decode_uint256_word,
)


def decode_address_from_query(raw: str) -> str | None:
    out = _extract_hex_output(raw or "")
    if not out or len(out) < 64:
        return None
    return "0x" + out[-40:]


def main() -> int:
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument("--deployer-key", default=os.environ.get("DEPLOYER_PRIVATE_KEY"))
    p.add_argument("--gas-limit-call", type=int, default=50_000_000)
    p.add_argument("--mint-susdc-raw", type=int, default=1_000_000_000_000)
    p.add_argument("--inject-susdc-raw", type=int, default=100_000_000_000)
    p.add_argument("--inject-seth", type=str, default="10000000")
    p.add_argument("--susdc", required=True)
    p.add_argument("--bridge", required=True)
    p.add_argument("--treasury", required=True)
    p.add_argument("--pool", required=True)
    args = p.parse_args()

    pk = args.deployer_key.strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk

    addr_susdc = args.susdc.replace("0x", "").lower()
    addr_bridge = args.bridge.replace("0x", "").lower()
    addr_treasury = args.treasury.replace("0x", "").lower()
    addr_pool = args.pool.replace("0x", "").lower()

    client = SethClient(args.host, args.port)
    deployer_addr = client.get_address(pk.replace("0x", ""))

    # treasury() on bridge
    q_t = encode_call("treasury()", [], [])
    raw_t = query_contract_raw(args.host, args.port, deployer_addr, addr_bridge, q_t)
    cur_t = decode_address_from_query(raw_t or "")
    want_t = "0x" + addr_treasury
    print(f"Bridge.treasury() = {cur_t} (want {want_t})")

    if not cur_t or cur_t.lower() != want_t.lower():
        print("[1] SethBridge.setTreasury")
        inp_bt = encode_call(
            "setTreasury(address)", ["address"], [to_checksum_address(want_t)]
        )
        tx_bt = client.send_transaction_auto(
            pk, addr_bridge, step=8, input_hex=inp_bt, gas_limit=args.gas_limit_call
        )
        if not tx_bt:
            raise SystemExit("setTreasury send failed")
        ok_bt, st_bt = client.wait_for_receipt(tx_bt, timeout=600)
        if not ok_bt:
            raise SystemExit("setTreasury receipt timeout")
        print(f"  status={st_bt} tx={tx_bt}")
        require_seth_tx_ok("SethBridge.setTreasury", tx_bt, st_bt)
    else:
        print("[1] setTreasury already set, skip")

    # owner() on pool — if Treasury, skip transfer
    q_o = encode_call("owner()", [], [])
    raw_o = query_contract_raw(args.host, args.port, deployer_addr, addr_pool, q_o)
    cur_o = decode_address_from_query(raw_o or "")
    want_o = want_t
    print(f"PoolB.owner() = {cur_o} (want {want_o})")

    if not cur_o or cur_o.lower() != want_o.lower():
        print("[2] PoolB.transferOwnership(Treasury)")
        inp_po = encode_call(
            "transferOwnership(address)",
            ["address"],
            [to_checksum_address(want_o)],
        )
        tx_po = client.send_transaction_auto(
            pk, addr_pool, step=8, input_hex=inp_po, gas_limit=args.gas_limit_call
        )
        if not tx_po:
            raise SystemExit("transferOwnership send failed")
        ok_po, st_po = client.wait_for_receipt(tx_po, timeout=600)
        if not ok_po:
            raise SystemExit("transferOwnership receipt timeout")
        print(f"  status={st_po} tx={tx_po}")
        require_seth_tx_ok("PoolB.transferOwnership", tx_po, st_po)
    else:
        print("[2] ownership already Treasury, skip")

    inject_seth_native = parse_inject_native_seth(args.inject_seth)
    if args.mint_susdc_raw < args.inject_susdc_raw:
        raise SystemExit("mint must be >= inject")

    print("[3] Bootstrap: addMinter(deployer), mint, injectToPoolB")
    inp_am = encode_call(
        "addMinter(address)",
        ["address"],
        [to_checksum_address("0x" + deployer_addr)],
    )
    tx_am = client.send_transaction_auto(
        pk, addr_susdc, step=8, input_hex=inp_am, gas_limit=args.gas_limit_call
    )
    if not tx_am:
        raise SystemExit("addMinter failed")
    ok_am, st_am = client.wait_for_receipt(tx_am, timeout=600)
    if not ok_am:
        raise SystemExit("addMinter receipt timeout")
    require_seth_tx_ok("addMinter(deployer)", tx_am, st_am)
    print(f"  addMinter ok tx={tx_am}")

    inp_mint = encode_call(
        "mint(address,uint256)",
        ["address", "uint256"],
        [to_checksum_address("0x" + addr_treasury), args.mint_susdc_raw],
    )
    tx_mint = client.send_transaction_auto(
        pk, addr_susdc, step=8, input_hex=inp_mint, gas_limit=args.gas_limit_call
    )
    if not tx_mint:
        raise SystemExit("mint failed")
    ok_m, st_m = client.wait_for_receipt(tx_mint, timeout=600)
    if not ok_m:
        raise SystemExit("mint timeout")
    require_seth_tx_ok("mint(Treasury)", tx_mint, st_m)
    print(f"  mint ok tx={tx_mint}")

    from deploy_seth import MAX_U64_AMOUNT  # noqa: E402

    parts = inject_chunks(args.inject_susdc_raw, inject_seth_native)
    inj_gas = max(2_000_000, args.gas_limit_call)
    for i, (c_susdc, c_seth) in enumerate(parts, start=1):
        print(f"  inject part {i}/{len(parts)}: susdc_raw={c_susdc} SETH={c_seth}")
        inp_inj = encode_call(
            "injectToPoolB(uint256,uint256)",
            ["uint256", "uint256"],
            [c_susdc, c_seth],
        )
        tx_inj = client.send_transaction_auto(
            pk,
            addr_treasury,
            amount=c_seth,
            gas_limit=inj_gas,
            gas_price=1,
            step=8,
            input_hex=inp_inj,
        )
        if not tx_inj:
            raise SystemExit("injectToPoolB send failed")
        ok_i, st_i = client.wait_for_receipt(tx_inj, timeout=600)
        if not ok_i:
            raise SystemExit("injectToPoolB receipt timeout")
        require_seth_tx_ok("Treasury.injectToPoolB", tx_inj, st_i)
        print(f"  inject ok tx={tx_inj}")

    out = {
        "network": "seth",
        "host": args.host,
        "port": args.port,
        "sUSDC": "0x" + addr_susdc,
        "SethBridge": "0x" + addr_bridge,
        "Treasury": "0x" + addr_treasury,
        "PoolB": "0x" + addr_pool,
        "relayer": "0x" + deployer_addr,
        "deployer": "0x" + deployer_addr,
        "notes": [
            "Completed via complete_partial_deploy.py after deploy timeout.",
            "mint_susdc_raw=%s inject_susdc_raw=%s inject_seth=%s"
            % (args.mint_susdc_raw, args.inject_susdc_raw, inject_seth_native),
        ],
    }
    Path(CONTRACTS_DIR / "deployment-info.json").write_text(
        json.dumps(out, indent=2), encoding="utf-8"
    )
    print("Written deployment-info.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
