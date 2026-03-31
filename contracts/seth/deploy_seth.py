#!/usr/bin/env python3
"""
Deploy Seth-side contracts (sUSDC -> SethBridge -> PoolB) using the same flow as
SethPub/clipy/cli.py: compile with solc, CREATE2 target address, step=6 deploy,
prepayment, then step=8 configuration calls.

Post-deploy (owner = deployer):
  - sUSDC.addMinter(SethBridge)
  - SethBridge.setPoolB(PoolB)
  - Treasury.setPoolB / setBridgeContract(SethBridge)
  - SethBridge.setTreasury(Treasury) — 35% path: Bridge → Treasury.injectFromBridge → PoolB
  - PoolB.transferOwnership(Treasury)

Environment:
  SETH_HOST, SETH_PORT — Seth node (default: 35.197.170.240:23001)
  DEPLOYER_PRIVATE_KEY — 0x-prefixed hex, funds deployment on Seth
  RELAYER_ADDRESS — optional; if unset, derived from RELAYER_PRIVATE_KEY (same as relayer/.env)

Usage:
  cd contracts/seth
  pip install -r requirements-seth-deploy.txt
  set DEPLOYER_PRIVATE_KEY=0x...
  set RELAYER_PRIVATE_KEY=0x...   # optional; defaults to deployer if unset
  python deploy_seth.py

Output:
  deployment-info.json — addresses to paste into relayer/.env (SETH_BRIDGE_ADDRESS, etc.)

Also deploys Treasury.sol. PoolB constructor sets treasury=Treasury (sole LP caller to PoolB).
Relayer flow: SethBridge mints sUSDC → Treasury → PoolB.addLiquidity.

Optional initial PoolB liquidity (Seth only, no Solana):
  python deploy_seth.py --bootstrap-pool-liquidity
  Optional: --inject-susdc-raw (6-decimal raw), --inject-seth (integer SETH count; 1 = 1 SETH, no sub-units).
  Large native sends are split across txs (Seth tx amount field is uint64).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import time
from pathlib import Path
from typing import Optional, Tuple

import requests
import solcx
from Crypto.Hash import keccak
from ecdsa import SECP256k1, SigningKey
from ecdsa.util import sigencode_string_canonize
from eth_abi import encode as eth_abi_encode
from eth_utils import to_checksum_address

# Match SethPub/clipy/cli.py
SOLC_VERSION = "0.8.30"
CONTRACTS_DIR = Path(__file__).resolve().parent


def install_solc() -> None:
    try:
        solcx.install_solc(SOLC_VERSION)
    except Exception:
        pass
    solcx.set_solc_version(SOLC_VERSION)


def compile_contract_file(name: str) -> dict:
    """Compile a single .sol file; return { 'abi', 'bin' } for the contract."""
    path = CONTRACTS_DIR / name
    if not path.is_file():
        raise FileNotFoundError(path)
    source = path.read_text(encoding="utf-8")
    install_solc()
    compiler_params = {
        "evm_version": "shanghai",
        "optimize": True,
        "optimize_runs": 200,
        "via_ir": True,
    }
    try:
        compiled = solcx.compile_source(
            source,
            output_values=["abi", "bin"],
            **compiler_params,
        )
    except Exception:
        compiler_params["via_ir"] = False
        compiled = solcx.compile_source(
            source,
            output_values=["abi", "bin"],
            **compiler_params,
        )
    stem = path.stem
    for key, val in compiled.items():
        if val.get("bin") and (key.endswith(":" + stem) or key.endswith(stem)):
            return val
    for _k, val in compiled.items():
        if val.get("bin"):
            return val
    raise RuntimeError(f"No bin in compile output: {list(compiled.keys())}")


def get_selector(signature: str) -> str:
    k = keccak.new(digest_bits=256)
    k.update(signature.encode("utf-8"))
    return k.digest()[:4].hex()


def calc_create2_address(sender: str, salt_hex: str, bytecode_hex: str) -> str:
    prefix = bytes.fromhex("ff")
    sender_bytes = bytes.fromhex(sender.replace("0x", ""))
    salt_bytes = bytes.fromhex(salt_hex.replace("0x", "").zfill(64))
    bytecode_bytes = bytes.fromhex(bytecode_hex.replace("0x", ""))
    k_code = keccak.new(digest_bits=256)
    k_code.update(bytecode_bytes)
    code_hash = k_code.digest()
    k_final = keccak.new(digest_bits=256)
    k_final.update(prefix + sender_bytes + salt_bytes + code_hash)
    return k_final.digest()[-20:].hex().lower()


def norm_addr(a: str) -> str:
    return a.replace("0x", "").lower()


def normalize_seth_status(status: Optional[int]) -> Optional[int]:
    """
    Seth newer gateways may return 10003/10005/100010 for legacy 3/5/10.
    Keep behavior compatible with old code paths.
    """
    if status is None:
        return None
    try:
        s = int(status)
    except Exception:
        return None
    if s in (10003, 10005, 100010):
        return s % 10000
    return s


class SethClient:
    """Minimal client aligned with SethPub/clipy/cli.py SethClient."""

    def __init__(self, host: str, port: int):
        self.base_url = f"http://{host}:{port}"
        self.tx_url = f"{self.base_url}/transaction"
        self.query_url = f"{self.base_url}/query_account"
        self.receipt_url = f"{self.base_url}/transaction_receipt"

    @staticmethod
    def _uint64_to_bytes(val: int) -> bytes:
        return struct.pack("<Q", val)

    @staticmethod
    def _hex_to_bytes(hex_str: str) -> bytes:
        if hex_str.startswith("0x"):
            hex_str = hex_str[2:]
        return bytes.fromhex(hex_str)

    def get_address(self, private_key_hex: str) -> str:
        if private_key_hex.startswith("0x"):
            private_key_hex = private_key_hex[2:]
        sk = SigningKey.from_string(bytes.fromhex(private_key_hex), curve=SECP256k1)
        pub_key = sk.verifying_key.to_string("uncompressed")[1:]
        k = keccak.new(digest_bits=256)
        k.update(pub_key)
        return k.digest()[-20:].hex()

    def get_balance(self, address: str) -> int:
        try:
            a = norm_addr(address)
            resp = requests.post(self.query_url, data={"address": a}, timeout=10)
            if resp.status_code == 200:
                return int(resp.json().get("balance", 0))
        except Exception:
            pass
        return 0

    def get_nonce(self, address: str) -> int:
        try:
            a = norm_addr(address)
            resp = requests.post(self.query_url, data={"address": a}, timeout=10)
            if resp.status_code == 200:
                return int(resp.json().get("nonce", 0))
        except Exception:
            pass
        return 0

    def compute_hash(
        self,
        nonce: int,
        pubkey_hex: str,
        to_hex: str,
        amount: int,
        gas_limit: int,
        gas_price: int,
        step: int,
        contract_code: str = "",
        input_hex: str = "",
        prepayment: int = 0,
        key: str = "",
        val: str = "",
    ) -> bytes:
        msg = bytearray()
        msg.extend(self._uint64_to_bytes(nonce))
        msg.extend(self._hex_to_bytes(pubkey_hex))
        msg.extend(self._hex_to_bytes(to_hex))
        msg.extend(self._uint64_to_bytes(amount))
        msg.extend(self._uint64_to_bytes(gas_limit))
        msg.extend(self._uint64_to_bytes(gas_price))
        msg.extend(self._uint64_to_bytes(step))
        if contract_code:
            msg.extend(self._hex_to_bytes(contract_code))
        if input_hex:
            msg.extend(self._hex_to_bytes(input_hex))
        if prepayment > 0:
            msg.extend(self._uint64_to_bytes(prepayment))
        if key:
            msg.extend(key.encode("utf-8"))
            if val:
                msg.extend(val.encode("utf-8"))
        k = keccak.new(digest_bits=256)
        k.update(msg)
        return k.digest()

    def send_transaction_auto(
        self,
        private_key_hex: str,
        to_hex: str,
        amount: int = 0,
        gas_limit: int = 5_000_000,
        gas_price: int = 1,
        step: int = 0,
        shard_id: int = 0,
        contract_code: str = "",
        input_hex: str = "",
        prepayment: int = 0,
        key: str = "",
        val: str = "",
    ) -> Optional[str]:
        if private_key_hex.startswith("0x"):
            private_key_hex = private_key_hex[2:]
        sk = SigningKey.from_string(bytes.fromhex(private_key_hex), curve=SECP256k1)
        pubkey_hex = sk.verifying_key.to_string("uncompressed").hex()
        my_addr = self.get_address(private_key_hex)
        if step == 8:
            my_addr = to_hex + my_addr
        nonce = self.get_nonce(my_addr) + 1
        tx_hash = self.compute_hash(
            nonce,
            pubkey_hex,
            to_hex,
            amount,
            gas_limit,
            gas_price,
            step,
            contract_code,
            input_hex,
            prepayment,
            key,
            val,
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
            "shard_id": str(shard_id),
            "type": str(step),
            "sign_r": signature[0:32].hex(),
            "sign_s": signature[32:64].hex(),
            "sign_v": "0",
        }
        if contract_code:
            data["bytes_code"] = contract_code
        if input_hex:
            data["input"] = input_hex
        if prepayment > 0:
            data["pepay"] = str(prepayment)
        if key:
            data["key"] = key
        if val:
            data["val"] = val
        try:
            resp = requests.post(self.tx_url, data=data, timeout=60)
            print(f"  tx response: {resp.text[:500]}")
            if "SignatureInvalid" in resp.text:
                data["sign_v"] = "1"
                resp = requests.post(self.tx_url, data=data, timeout=60)
                print(f"  tx response (v=1): {resp.text[:500]}")
            return tx_hash.hex()
        except Exception as e:
            print(f"  Send TX Error: {e}")
            return None

    def wait_for_receipt(self, tx_hash: str, timeout: int = 120) -> Tuple[bool, Optional[int]]:
        """Return (ok, status) where ok means terminal receipt received."""
        start = time.time()
        while time.time() - start < timeout:
            try:
                resp = requests.post(
                    self.receipt_url, data={"tx_hash": tx_hash}, timeout=10
                )
                if resp.status_code == 200:
                    data = resp.json()
                    status = normalize_seth_status(data.get("status"))
                    # Match relayer/sethClient.js: 1,3,10 = still in flight (10 = not indexed yet)
                    if status is not None and status not in (1, 3, 10):
                        return True, int(status)
            except Exception:
                pass
            time.sleep(1)
        return False, None


def encode_call(signature: str, types: list, args: list) -> str:
    sel = get_selector(signature)
    body = eth_abi_encode(types, args).hex()
    return sel + body


# Seth tx wire format: native `amount` is uint64; split large injects.
MAX_U64_AMOUNT = 2**64 - 1


def parse_inject_native_seth(amount_str: str) -> int:
    """Positive integer: N means N SETH. No sub-units; no conversion."""
    s = (amount_str or "").strip()
    if not s:
        raise ValueError("empty --inject-seth")
    if not s.isdigit():
        raise ValueError("--inject-seth must be a positive integer (SETH count, e.g. 1 = 1 SETH)")
    v = int(s)
    if v < 1:
        raise ValueError("--inject-seth must be >= 1")
    return v


def inject_chunks(total_susdc_raw: int, total_seth_native: int) -> list[tuple[int, int]]:
    """Proportional (sUSDC raw, SETH count) chunks; each tx native amount fits Seth uint64 field."""
    if total_seth_native < 1 or total_susdc_raw < 1:
        raise ValueError("inject amounts must be >= 1")
    chunks: list[tuple[int, int]] = []
    rem_seth = total_seth_native
    rem_susdc = total_susdc_raw
    while rem_seth > 0:
        chunk_seth = min(rem_seth, MAX_U64_AMOUNT)
        if chunk_seth == rem_seth:
            chunk_susdc = rem_susdc
        else:
            chunk_susdc = (rem_susdc * chunk_seth) // rem_seth
        chunks.append((chunk_susdc, chunk_seth))
        rem_seth -= chunk_seth
        rem_susdc -= chunk_susdc
    return chunks


# Step=8 contract calls: treat only 0 and 2 as success (same convention as deploy_contract).
_CONFIG_TX_OK = (0, 2)


def require_seth_tx_ok(label: str, tx_hash: str, status: Optional[int]) -> None:
    """Require terminal success for post-deploy / bootstrap txs (see _CONFIG_TX_OK)."""
    if status is None:
        raise RuntimeError(f"{label}: missing receipt status tx={tx_hash}")
    if status not in _CONFIG_TX_OK:
        raise RuntimeError(
            f"{label}: receipt status={status} (expected 0 or 2). tx={tx_hash}. "
            "Try higher --gas-limit-call (e.g. 8000000)."
        )


def deploy_contract(
    client: SethClient,
    deployer_pk: str,
    deployer_addr: str,
    deploy_code: str,
    salt: str,
    prepayment: int,
    gas_limit: int,
    label: str,
) -> str:
    target = calc_create2_address(deployer_addr, salt, deploy_code)
    print(f"[Deploy] {label} -> CREATE2 address {target}")
    txh = client.send_transaction_auto(
        deployer_pk,
        target,
        step=6,
        contract_code=deploy_code,
        prepayment=prepayment,
        gas_limit=gas_limit,
    )
    if not txh:
        raise RuntimeError(f"{label}: send_transaction failed")
    # Large contracts (SethBridge/PoolB) may stay on status=10 (indexing) longer than 120s on Seth.
    ok, st = client.wait_for_receipt(txh, timeout=600)
    if not ok:
        raise RuntimeError(f"{label}: receipt timeout for tx {txh}")
    if st == 5:
        raise RuntimeError(
            f"{label}: Seth rejected deploy (kTxInvalidAddress status=5). "
            "Check bytecode length / prepayment / node."
        )
    if st not in (0, 2, None):
        print(f"  Warning: receipt status={st} (expected 0 consensus success)")
    print(f"  OK {label} at {target} (tx {txh})")
    return target


def main() -> int:
    p = argparse.ArgumentParser(description="Deploy Seth bridge stack (cli.py style)")
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument(
        "--deployer-key",
        default=os.environ.get("DEPLOYER_PRIVATE_KEY"),
        help="Hex private key (with 0x). Env: DEPLOYER_PRIVATE_KEY",
    )
    p.add_argument(
        "--relayer-key",
        default=os.environ.get("RELAYER_PRIVATE_KEY"),
        help="Relayer key; if omitted, same as deployer. Env: RELAYER_PRIVATE_KEY",
    )
    p.add_argument(
        "--relayer-address",
        default=os.environ.get("RELAYER_ADDRESS"),
        help="20-byte hex relayer address; overrides key-derived address",
    )
    p.add_argument("--salt-susdc", default="00", help="CREATE2 salt (hex, padded internally)")
    p.add_argument("--salt-bridge", default="01")
    p.add_argument("--salt-treasury", default="03", help="CREATE2 salt for Treasury.sol")
    p.add_argument("--salt-pool", default="02")
    p.add_argument("--prepayment", type=int, default=10_000_000)
    p.add_argument("--gas-limit-deploy", type=int, default=5_000_000)
    p.add_argument(
        "--gas-limit-call",
        type=int,
        default=5_000_000,
        help="Gas limit for step=8 config and bootstrap calls (default 5M; low values may yield status=5 on Seth).",
    )
    p.add_argument(
        "--output",
        default=str(CONTRACTS_DIR / "deployment-info.json"),
        help="Write deployment addresses JSON",
    )
    p.add_argument(
        "--bootstrap-pool-liquidity",
        action="store_true",
        help=(
            "After config: add deployer as sUSDC minter, mint sUSDC to Treasury, "
            "then Treasury.injectToPoolB (native SETH). Seth-only; no Solana/relayer runtime."
        ),
    )
    p.add_argument(
        "--mint-susdc-raw",
        type=int,
        default=None,
        help="sUSDC raw (6 decimals) minted to Treasury; default = --inject-susdc-raw. Env: SETH_MINT_SUSDC_RAW",
    )
    p.add_argument(
        "--inject-susdc-raw",
        type=int,
        default=int(os.environ.get("SETH_INJECT_SUSDC_RAW", "1000000")),
        help="sUSDC raw (6 decimals) sent in injectToPoolB; default 1e6 = 1 sUSDC",
    )
    p.add_argument(
        "--inject-seth",
        type=str,
        default=os.environ.get("SETH_INJECT_SETH", "1").strip() or "1",
        help=(
            "SETH amount to inject (positive integer; 1 = 1 SETH, no sub-units or conversion). "
            "Env: SETH_INJECT_SETH. Default: 1."
        ),
    )
    args = p.parse_args()

    env_mint = os.environ.get("SETH_MINT_SUSDC_RAW", "").strip()
    if args.mint_susdc_raw is None:
        args.mint_susdc_raw = int(env_mint) if env_mint else None
    if args.mint_susdc_raw is None:
        args.mint_susdc_raw = args.inject_susdc_raw

    try:
        inject_seth_native = parse_inject_native_seth(args.inject_seth)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if not args.deployer_key:
        print("Set DEPLOYER_PRIVATE_KEY or pass --deployer-key", file=sys.stderr)
        return 1

    deployer_pk = args.deployer_key.strip()
    if not deployer_pk.startswith("0x"):
        deployer_pk = "0x" + deployer_pk

    relayer_pk = (args.relayer_key or "").strip() or deployer_pk
    if not relayer_pk.startswith("0x"):
        relayer_pk = "0x" + relayer_pk

    client = SethClient(args.host, args.port)
    deployer_addr = client.get_address(deployer_pk)
    if args.relayer_address:
        relayer_addr = norm_addr(args.relayer_address)
    else:
        relayer_addr = client.get_address(relayer_pk)

    bal = client.get_balance(deployer_addr)
    print(f"Deployer {deployer_addr} balance (native): {bal}")
    if bal < 1:
        print("Warning: very low balance; deployment may fail.", file=sys.stderr)

    print("Compiling sUSDC.sol ...")
    c_susdc = compile_contract_file("sUSDC.sol")
    print("Compiling SethBridge.sol ...")
    c_bridge = compile_contract_file("SethBridge.sol")
    print("Compiling Treasury.sol ...")
    c_treasury = compile_contract_file("Treasury.sol")
    print("Compiling PoolB.sol ...")
    c_pool = compile_contract_file("PoolB.sol")

    bin_susdc = c_susdc["bin"]
    if not bin_susdc:
        raise RuntimeError("sUSDC bin empty")

    # Creation bytecode from solc + ABI-encoded constructor args (same pattern as SethPub cli.py).
    bridge_bin_runtime = c_bridge["bin"]
    treasury_bin_runtime = c_treasury["bin"]
    pool_bin_runtime = c_pool["bin"]
    if not bridge_bin_runtime or not treasury_bin_runtime or not pool_bin_runtime:
        raise RuntimeError("SethBridge, Treasury or PoolB bin empty")

    # --- 1) sUSDC (no constructor params beyond default) ---
    deploy_susdc = bin_susdc
    addr_susdc = deploy_contract(
        client,
        deployer_pk,
        deployer_addr,
        deploy_susdc,
        args.salt_susdc,
        args.prepayment,
        args.gas_limit_deploy,
        "sUSDC",
    )

    # --- 2) SethBridge(sUSDC, relayer) ---
    ctor_bridge = eth_abi_encode(
        ["address", "address"],
        [
            to_checksum_address("0x" + addr_susdc),
            to_checksum_address("0x" + relayer_addr),
        ],
    ).hex()
    deploy_bridge = bridge_bin_runtime + ctor_bridge
    addr_bridge = deploy_contract(
        client,
        deployer_pk,
        deployer_addr,
        deploy_bridge,
        args.salt_bridge,
        args.prepayment,
        args.gas_limit_deploy,
        "SethBridge",
    )

    # --- 3) Treasury(sUSDC, relayer) ---
    ctor_treasury = eth_abi_encode(
        ["address", "address"],
        [
            to_checksum_address("0x" + addr_susdc),
            to_checksum_address("0x" + relayer_addr),
        ],
    ).hex()
    deploy_treasury = treasury_bin_runtime + ctor_treasury
    addr_treasury = deploy_contract(
        client,
        deployer_pk,
        deployer_addr,
        deploy_treasury,
        args.salt_treasury,
        args.prepayment,
        args.gas_limit_deploy,
        "Treasury",
    )

    # --- 4) PoolB(sUSDC, treasury=Treasury) — only Treasury may addLiquidity; bridge routes via Treasury
    ctor_pool = eth_abi_encode(
        ["address", "address"],
        [
            to_checksum_address("0x" + addr_susdc),
            to_checksum_address("0x" + addr_treasury),
        ],
    ).hex()
    deploy_pool = pool_bin_runtime + ctor_pool
    addr_pool = deploy_contract(
        client,
        deployer_pk,
        deployer_addr,
        deploy_pool,
        args.salt_pool,
        args.prepayment,
        args.gas_limit_deploy,
        "PoolB",
    )

    # --- 5) Post-deploy configuration ---
    print("[Config] sUSDC.addMinter(SethBridge)")
    inp = encode_call(
        "addMinter(address)", ["address"], [to_checksum_address("0x" + addr_bridge)]
    )
    tx1 = client.send_transaction_auto(
        deployer_pk,
        addr_susdc,
        step=8,
        input_hex=inp,
        gas_limit=args.gas_limit_call,
    )
    if not tx1:
        raise RuntimeError("addMinter send failed")
    ok1, st1 = client.wait_for_receipt(tx1)
    if not ok1:
        raise RuntimeError("addMinter receipt timeout")
    print(f"  addMinter receipt status={st1} tx={tx1}")
    require_seth_tx_ok("addMinter(SethBridge)", tx1, st1)

    print("[Config] SethBridge.setPoolB(PoolB)")
    inp2 = encode_call(
        "setPoolB(address)", ["address"], [to_checksum_address("0x" + addr_pool)]
    )
    tx2 = client.send_transaction_auto(
        deployer_pk,
        addr_bridge,
        step=8,
        input_hex=inp2,
        gas_limit=args.gas_limit_call,
    )
    if not tx2:
        raise RuntimeError("setPoolB send failed")
    ok2, st2 = client.wait_for_receipt(tx2)
    if not ok2:
        raise RuntimeError("setPoolB receipt timeout")
    print(f"  setPoolB receipt status={st2} tx={tx2}")
    require_seth_tx_ok("SethBridge.setPoolB", tx2, st2)

    print("[Config] Treasury.setPoolB(PoolB)")
    inp_tpool = encode_call(
        "setPoolB(address)", ["address"], [to_checksum_address("0x" + addr_pool)]
    )
    tx_tpool = client.send_transaction_auto(
        deployer_pk,
        addr_treasury,
        step=8,
        input_hex=inp_tpool,
        gas_limit=args.gas_limit_call,
    )
    if not tx_tpool:
        raise RuntimeError("Treasury setPoolB send failed")
    ok_tpool, st_tpool = client.wait_for_receipt(tx_tpool)
    if not ok_tpool:
        raise RuntimeError("Treasury setPoolB receipt timeout")
    print(f"  Treasury setPoolB receipt status={st_tpool} tx={tx_tpool}")
    require_seth_tx_ok("Treasury.setPoolB", tx_tpool, st_tpool)

    print("[Config] Treasury.setBridgeContract(SethBridge)")
    inp_tbr = encode_call(
        "setBridgeContract(address)",
        ["address"],
        [to_checksum_address("0x" + addr_bridge)],
    )
    tx_tbr = client.send_transaction_auto(
        deployer_pk,
        addr_treasury,
        step=8,
        input_hex=inp_tbr,
        gas_limit=args.gas_limit_call,
    )
    if not tx_tbr:
        raise RuntimeError("Treasury setBridgeContract send failed")
    ok_tbr, st_tbr = client.wait_for_receipt(tx_tbr)
    if not ok_tbr:
        raise RuntimeError("Treasury setBridgeContract receipt timeout")
    print(f"  Treasury setBridgeContract receipt status={st_tbr} tx={tx_tbr}")
    require_seth_tx_ok("Treasury.setBridgeContract", tx_tbr, st_tbr)

    print("[Config] SethBridge.setTreasury(Treasury)")
    inp_bt = encode_call(
        "setTreasury(address)", ["address"], [to_checksum_address("0x" + addr_treasury)]
    )
    tx_bt = client.send_transaction_auto(
        deployer_pk,
        addr_bridge,
        step=8,
        input_hex=inp_bt,
        gas_limit=args.gas_limit_call,
    )
    if not tx_bt:
        raise RuntimeError("SethBridge setTreasury send failed")
    ok_bt, st_bt = client.wait_for_receipt(tx_bt)
    if not ok_bt:
        raise RuntimeError("SethBridge setTreasury receipt timeout")
    print(f"  SethBridge setTreasury receipt status={st_bt} tx={tx_bt}")
    require_seth_tx_ok("SethBridge.setTreasury", tx_bt, st_bt)

    print("[Config] PoolB.transferOwnership(Treasury)")
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
        gas_limit=args.gas_limit_call,
    )
    if not tx_po:
        raise RuntimeError("PoolB transferOwnership send failed")
    ok_po, st_po = client.wait_for_receipt(tx_po)
    if not ok_po:
        raise RuntimeError("PoolB transferOwnership receipt timeout")
    print(f"  PoolB.transferOwnership receipt status={st_po} tx={tx_po}")
    require_seth_tx_ok("PoolB.transferOwnership(Treasury)", tx_po, st_po)

    if args.bootstrap_pool_liquidity:
        if args.inject_susdc_raw < 1:
            print("ERROR: --inject-susdc-raw must be >= 1", file=sys.stderr)
            return 1
        if args.mint_susdc_raw < args.inject_susdc_raw:
            print(
                "ERROR: --mint-susdc-raw must be >= --inject-susdc-raw (Treasury needs enough minted balance).",
                file=sys.stderr,
            )
            return 1

        print(
            f"[Bootstrap] mint sUSDC raw (to Treasury)={args.mint_susdc_raw}, "
            f"inject sUSDC raw={args.inject_susdc_raw}, "
            f"SETH={args.inject_seth} → {inject_seth_native} (1 = 1 SETH)"
        )

        print("[Bootstrap] sUSDC.addMinter(deployer) (Seth-only; no Solana step)")
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
            raise RuntimeError("addMinter(deployer) send failed")
        ok_am, st_am = client.wait_for_receipt(tx_am, timeout=600)
        if not ok_am:
            raise RuntimeError("addMinter(deployer) receipt timeout")
        print(f"  addMinter(deployer) receipt status={st_am} tx={tx_am}")
        require_seth_tx_ok("addMinter(deployer)", tx_am, st_am)

        print(f"[Bootstrap] sUSDC.mint(Treasury, mint_susdc_raw={args.mint_susdc_raw})")
        inp_mint = encode_call(
            "mint(address,uint256)",
            ["address", "uint256"],
            [
                to_checksum_address("0x" + addr_treasury),
                args.mint_susdc_raw,
            ],
        )
        tx_mint = client.send_transaction_auto(
            deployer_pk,
            addr_susdc,
            step=8,
            input_hex=inp_mint,
            gas_limit=args.gas_limit_call,
        )
        if not tx_mint:
            raise RuntimeError("mint(Treasury) send failed")
        ok_mint, st_mint = client.wait_for_receipt(tx_mint, timeout=600)
        if not ok_mint:
            raise RuntimeError("mint(Treasury) receipt timeout")
        print(f"  mint receipt status={st_mint} tx={tx_mint}")
        require_seth_tx_ok("sUSDC.mint(Treasury)", tx_mint, st_mint)

        parts = inject_chunks(args.inject_susdc_raw, inject_seth_native)
        if len(parts) > 1:
            print(
                f"[Bootstrap] Splitting inject into {len(parts)} txs "
                f"(Seth tx amount field max {MAX_U64_AMOUNT} SETH per tx)"
            )
        inj_gas = max(2_000_000, args.gas_limit_call)
        for i, (c_susdc, c_seth) in enumerate(parts, start=1):
            print(
                f"[Bootstrap] Treasury.injectToPoolB part {i}/{len(parts)}: "
                f"sUSDC raw={c_susdc}, SETH={c_seth}"
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
            ok_inj, st_inj = client.wait_for_receipt(tx_inj, timeout=600)
            if not ok_inj:
                raise RuntimeError("injectToPoolB receipt timeout")
            print(f"  injectToPoolB receipt status={st_inj} tx={tx_inj}")
            require_seth_tx_ok("Treasury.injectToPoolB", tx_inj, st_inj)

    notes = [
        "Set relayer/.env SETH_BRIDGE_ADDRESS to SethBridge (0x + address).",
        "RELAYER_PRIVATE_KEY must match `relayer` address above.",
        "35% PoolB path: Bridge mints sUSDC → Treasury → PoolB; SethBridge.setTreasury must be set (deploy does).",
    ]
    if args.bootstrap_pool_liquidity:
        notes.append(
            "Initial PoolB liquidity: deployer was added as sUSDC minter, sUSDC minted to Treasury, injectToPoolB executed (Seth-side only)."
        )

    out = {
        "network": "seth",
        "host": args.host,
        "port": args.port,
        "sUSDC": "0x" + addr_susdc,
        "SethBridge": "0x" + addr_bridge,
        "Treasury": "0x" + addr_treasury,
        "PoolB": "0x" + addr_pool,
        "relayer": "0x" + relayer_addr,
        "deployer": "0x" + deployer_addr,
        "notes": notes,
    }
    Path(args.output).write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\nWritten:", args.output)
    print("\n--- relayer/.env (example) ---")
    print(f"SETH_HOST={args.host}")
    print(f"SETH_PORT={args.port}")
    print(f"SETH_BRIDGE_ADDRESS=0x{addr_bridge}")
    print("--- end ---\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
