#!/usr/bin/env python3
"""Multiple smaller Treasury.injectToPoolB calls."""
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
    # 10 x (10B raw sUSDC + 1M SETH) = 100B + 10M total
    n = int(os.environ.get("INJECT_PARTS", "10"))
    susdc_each = int(os.environ.get("SUSDC_EACH", "10000000000"))  # 10_000 USDC
    seth_each = int(os.environ.get("SETH_EACH", "1000000"))
    gas = int(os.environ.get("INJECT_GAS", "300000000"))
    for i in range(1, n + 1):
        inp = encode_call(
            "injectToPoolB(uint256,uint256)",
            ["uint256", "uint256"],
            [susdc_each, seth_each],
        )
        print(f"[{i}/{n}] inject susdc_raw={susdc_each} SETH={seth_each}")
        tx = client.send_transaction_auto(
            pk, tre, amount=seth_each, gas_limit=gas, gas_price=1, step=8, input_hex=inp
        )
        if not tx:
            print("send failed")
            return 1
        ok, st = client.wait_for_receipt(tx, timeout=600)
        print(f"  ok={ok} status={st} tx={tx}")
        if not ok or st not in (0, 2):
            print("FAILED")
            return 1
        require_seth_tx_ok("inject", tx, st)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
