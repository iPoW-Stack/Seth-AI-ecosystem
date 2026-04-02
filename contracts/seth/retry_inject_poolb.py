#!/usr/bin/env python3
"""Single Treasury.injectToPoolB with high gas (Seth large native send)."""
import json
import os
import sys
from pathlib import Path

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))
from deploy_seth import SethClient, encode_call, require_seth_tx_ok  # noqa: E402

def main() -> int:
    dep = json.loads((CONTRACTS_DIR / "deployment-info.json").read_text(encoding="utf-8"))
    pk = os.environ.get("DEPLOYER_PRIVATE_KEY", "").strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk
    tre = dep["Treasury"].replace("0x", "").lower()
    client = SethClient(dep["host"], int(dep["port"]))
    c_susdc = int(os.environ.get("INJECT_SUSDC_RAW", "50000000000"))
    c_seth = int(os.environ.get("INJECT_SETH", "5000000"))
    gas = int(os.environ.get("INJECT_GAS", "300000000"))
    inp = encode_call(
        "injectToPoolB(uint256,uint256)",
        ["uint256", "uint256"],
        [c_susdc, c_seth],
    )
    print(f"injectToPoolB susdc_raw={c_susdc} SETH={c_seth} gas={gas}")
    tx = client.send_transaction_auto(
        pk, tre, amount=c_seth, gas_limit=gas, gas_price=1, step=8, input_hex=inp
    )
    if not tx:
        return 1
    ok, st = client.wait_for_receipt(tx, timeout=600)
    print(f"receipt ok={ok} status={st} tx={tx}")
    if ok and st in (0, 2):
        require_seth_tx_ok("inject", tx, st)
    return 0 if ok and st in (0, 2) else 1

if __name__ == "__main__":
    raise SystemExit(main())
