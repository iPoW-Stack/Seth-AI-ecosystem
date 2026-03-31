#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from pathlib import Path

from eth_abi import decode as eth_abi_decode
from eth_abi import encode as eth_abi_encode
from eth_utils import to_checksum_address

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))
sys.path.insert(0, str(CONTRACTS_DIR.parent.parent / "relayer"))

from deploy_seth import SethClient, compile_contract_file, deploy_contract, encode_call  # noqa: E402
from request_withdraw_to_solana_from_seth import query_contract_raw, _extract_hex_output  # noqa: E402


def main() -> int:
    host = os.environ.get("SETH_HOST", "35.197.170.240")
    port = int(os.environ.get("SETH_PORT", "23001"))
    deployer_pk = (
        os.environ.get("DEPLOYER_PRIVATE_KEY")
        or os.environ.get("USER_PRIVATE_KEY")
        or os.environ.get("RELAYER_PRIVATE_KEY")
        or ""
    ).strip()
    if not deployer_pk:
        print("ERROR: set DEPLOYER_PRIVATE_KEY or USER_PRIVATE_KEY or RELAYER_PRIVATE_KEY", file=sys.stderr)
        return 1
    if not deployer_pk.startswith("0x"):
        deployer_pk = "0x" + deployer_pk

    client = SethClient(host, port)
    deployer_addr = client.get_address(deployer_pk)
    print("Seth:", f"{host}:{port}")
    print("deployer:", "0x" + deployer_addr, "balance:", client.get_balance(deployer_addr))

    compiled = compile_contract_file("ProbeMultiReturn.sol")
    contract_addr = deploy_contract(
        client,
        deployer_pk,
        deployer_addr,
        compiled["bin"],
        "cafe01",
        10_000_000,
        5_000_000,
        "ProbeMultiReturn",
    )
    print("probe:", "0x" + contract_addr)

    request_id = 7
    user = to_checksum_address("0x742bf979105179e44aed27baf37d66ef73cc3d88")
    recipient = bytes.fromhex("bb" * 32)
    susdc_amount = 123456789
    created_at = 1710000000
    processed = True

    set_input = encode_call(
        "setRequest(uint256,address,bytes32,uint256,uint256,bool)",
        ["uint256", "address", "bytes32", "uint256", "uint256", "bool"],
        [request_id, user, recipient, susdc_amount, created_at, processed],
    )
    tx_hash = client.send_transaction_auto(
        deployer_pk,
        contract_addr,
        amount=0,
        gas_limit=8_000_000,
        gas_price=1,
        step=8,
        input_hex=set_input,
    )
    ok, st = client.wait_for_receipt(tx_hash, 300)
    print("setRequest tx=", tx_hash, "receipt=", ok, st)
    if not ok:
        print("ERROR: setRequest failed")
        return 2

    # Single-return sanity check first.
    ping_raw = query_contract_raw(host, port, deployer_addr, contract_addr, encode_call("pingValue()", [], []))
    ping_out = _extract_hex_output(ping_raw or "")
    amt_raw = query_contract_raw(host, port, deployer_addr, contract_addr, encode_call("getAmount(uint256)", ["uint256"], [request_id]))
    amt_out = _extract_hex_output(amt_raw or "")
    print("single_return:")
    print("  pingValue raw =", ping_raw, "out_len =", len(ping_out) if ping_out else 0)
    print("  getAmount raw =", amt_raw, "out_len =", len(amt_out) if amt_out else 0)

    get_input = encode_call("getRequest(uint256)", ["uint256"], [request_id])
    raw = query_contract_raw(host, port, deployer_addr, contract_addr, get_input)
    out = _extract_hex_output(raw or "")
    if not out:
        print("ERROR: multi-return query_contract returned empty output")
        print("raw:", raw)
        return 3

    decoded = eth_abi_decode(
        ["address", "bytes32", "uint256", "uint256", "bool"],
        bytes.fromhex(out),
    )
    print("decoded:")
    print("  user =", decoded[0])
    print("  solanaRecipient =", "0x" + decoded[1].hex())
    print("  susdcAmount =", int(decoded[2]))
    print("  createdAt =", int(decoded[3]))
    print("  processed =", bool(decoded[4]))

    # Also test JS SethClient-like extraction for parity.
    from sethClient import SethClient as JsSethClient  # type: ignore

    js = JsSethClient(host, port)
    out_norm = out.lower().replace("0x", "")
    user_dec = js._decodeAddress(out_norm, 0)
    recipient_dec = js._decodeBytes32(out_norm, 1)
    susdc_dec = js._decodeUint256(out_norm, 2)
    created_dec = js._decodeUint256(out_norm, 3)
    processed_dec = js._decodeUint256(out_norm, 4) != 0
    print("decoded_by_js_style:")
    print("  user =", user_dec)
    print("  solanaRecipient =", recipient_dec)
    print("  susdcAmount =", int(susdc_dec))
    print("  createdAt =", int(created_dec))
    print("  processed =", bool(processed_dec))

    exp_recipient = "0x" + ("bb" * 32)
    if (
        decoded[0].lower() == user.lower()
        and ("0x" + decoded[1].hex()).lower() == exp_recipient
        and int(decoded[2]) == susdc_amount
        and int(decoded[3]) == created_at
        and bool(decoded[4]) is processed
    ):
        print("RESULT: multi-return query decode works")
        return 0

    print("RESULT: mismatch in decoded values")
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
