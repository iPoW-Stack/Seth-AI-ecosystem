#!/usr/bin/env python3
"""
Withdraw test: user calls SethBridge.requestWithdrawToSolanaFromSETH only
(native SETH → SethBridge direct call PoolB.sellSETH → bridge-held sUSDC → withdraw request).

  requestWithdrawToSolanaFromSETH(bytes32 solanaRecipient, uint256 minSUSDCOut) external payable

On-chain prerequisites:
  - SethBridge.treasury set; Treasury.bridgeContract and Treasury.poolB set;
  - Pool has enough reservesUSDC or sellSETH will fail.

Usage:
  cd contracts/seth
  pip install -r requirements-seth-deploy.txt
  # User key (must hold native SETH on Seth), not the relayer
  set USER_PRIVATE_KEY=0x...
  python request_withdraw_to_solana_from_seth.py --amount-seth 1 --solana-recipient-hex <64_hex>

Optional: Solana address as Base58 (requires pip install base58):
  python request_withdraw_to_solana_from_seth.py --amount-seth 1 --solana-recipient-base58 <pubkey>

Environment:
  SETH_HOST, SETH_PORT — same as deploy_seth

Optional — write initiating Seth tx + request snapshot to relayer Postgres (same DB as relayer):
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
  Requires: pip install psycopg2-binary (listed in requirements-seth-deploy.txt)
  Updates seth_withdraw_requests.initiating_seth_tx_hash (and merges user/sUSDC fields when known).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
import requests

CONTRACTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(CONTRACTS_DIR))

from deploy_seth import (  # noqa: E402
    SethClient,
    encode_call,
    require_seth_tx_ok,
)
from eth_utils import to_checksum_address  # noqa: E402


def _extract_hex_output(resp_text: str) -> str | None:
    if not resp_text:
        return None
    t = resp_text.strip().lower().replace("0x", "")
    if len(t) >= 64 and all(c in "0123456789abcdef" for c in t):
        return t
    return None


def _decode_uint256_word(hex_out: str, word_index: int = 0) -> int:
    start = word_index * 64
    end = start + 64
    if len(hex_out) < end:
        return 0
    return int(hex_out[start:end], 16)


def query_contract_raw(host: str, port: int, from_hex: str, address_hex: str, input_hex: str) -> str | None:
    url = f"http://{host}:{port}/query_contract"
    try:
        r = requests.post(
            url,
            data={
                "from": from_hex.replace("0x", "").lower(),
                "address": address_hex.replace("0x", "").lower(),
                "input": input_hex.replace("0x", "").lower(),
            },
            timeout=20,
        )
        if r.status_code == 200:
            return r.text
    except Exception:
        return None
    return None


def get_total_withdraw_requests(host: str, port: int, from_hex: str, bridge_hex: str) -> int:
    call_hex = encode_call("totalWithdrawRequests()", [], [])
    raw = query_contract_raw(host, port, from_hex, bridge_hex, call_hex)
    out = _extract_hex_output(raw or "")
    if not out:
        return 0
    return _decode_uint256_word(out, 0)


def get_withdraw_request(
    _host: str,
    _port: int,
    _from_hex: str,
    _bridge_hex: str,
    _request_id: int,
) -> dict | None:
    """Disabled: Seth does not support getWithdrawRequest(uint256) via query_contract. Use receipt events / relayer."""
    return None


def parse_hex32(s: str) -> bytes:
    h = s.strip().lower().replace("0x", "")
    if len(h) != 64:
        raise ValueError(
            "Expected 64 hex chars for a 32-byte pubkey (or use --solana-recipient-base58)"
        )
    return bytes.fromhex(h)


def solana_pubkey_bytes_from_base58(s: str) -> bytes:
    try:
        import base58  # type: ignore
    except ImportError as e:
        raise SystemExit(
            "Run: pip install base58\nor use --solana-recipient-hex <64_hex>"
        ) from e
    raw = base58.b58decode(s.strip())
    if len(raw) != 32:
        raise ValueError(f"Base58 decoded length must be 32 bytes, got {len(raw)}")
    return raw


def pool_amount_out(amount_in: int, reserve_in: int, reserve_out: int) -> int:
    """Same as PoolB.getAmountOut (no fee)."""
    if amount_in <= 0 or reserve_in == 0 or reserve_out == 0:
        return 0
    return (amount_in * reserve_out) // (reserve_in + amount_in)


def _normalize_seth_tx_hash(h: str) -> str:
    t = h.strip()
    if not t.startswith("0x"):
        t = "0x" + t
    return t.lower()


def record_withdraw_initiation_to_relayer_db(
    request_id: int,
    tx_hash: str,
    latest: dict | None,
    *,
    enabled: bool = True,
) -> None:
    """
    Upsert into relayer table seth_withdraw_requests so the initiating user tx is stored
    before or alongside relayer polling (same schema as relayer/db/init.sql).
    Skips silently if DB_HOST is unset. Prints a hint if psycopg2 is missing.
    """
    if not enabled or not os.environ.get("DB_HOST"):
        return
    try:
        import psycopg2  # type: ignore
    except ImportError:
        print(
            "[hint] pip install psycopg2-binary to record initiating_seth_tx_hash (DB_HOST is set)",
            file=sys.stderr,
        )
        return
    port = int(os.environ.get("DB_PORT", "5432"))
    dbname = os.environ.get("DB_NAME", "bridge_relayer")
    user = os.environ.get("DB_USER", "postgres")
    password = os.environ.get("DB_PASSWORD", "")
    txh = _normalize_seth_tx_hash(tx_hash)
    ua = latest.get("user") if latest else None
    sr = latest.get("solanaRecipient") if latest else None
    sa = latest.get("susdcAmount") if latest else None
    cat = latest.get("createdAt") if latest else None
    if sa is not None:
        sa = int(sa)
    if cat is not None:
        cat = int(cat)
    sql = """
        INSERT INTO seth_withdraw_requests (
            request_id, initiating_seth_tx_hash, user_address, solana_recipient, susdc_amount,
            created_at_onchain, onchain_processed, status
        ) VALUES (%s, %s, %s, %s, %s, %s, false, 'pending')
        ON CONFLICT (request_id) DO UPDATE SET
            initiating_seth_tx_hash = EXCLUDED.initiating_seth_tx_hash,
            user_address = COALESCE(EXCLUDED.user_address, seth_withdraw_requests.user_address),
            solana_recipient = COALESCE(EXCLUDED.solana_recipient, seth_withdraw_requests.solana_recipient),
            susdc_amount = COALESCE(EXCLUDED.susdc_amount, seth_withdraw_requests.susdc_amount),
            created_at_onchain = COALESCE(EXCLUDED.created_at_onchain, seth_withdraw_requests.created_at_onchain),
            updated_at = NOW()
    """
    try:
        conn = psycopg2.connect(
            host=os.environ["DB_HOST"],
            port=port,
            dbname=dbname,
            user=user,
            password=password,
            connect_timeout=8,
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    sql,
                    (request_id, txh, ua, sr, sa, cat),
                )
            conn.commit()
            print(f"[db] recorded initiating tx {txh} for request_id={request_id}")
        finally:
            conn.close()
    except Exception as e:
        print(f"[db] WARNING: could not write relayer DB: {e}", file=sys.stderr)


def run_legacy_withdraw(args: argparse.Namespace) -> int:
    """
    SethBridge.requestWithdrawToSolana(bytes32,uint256) — transferFrom sUSDC.
    Legacy fallback path for environments that prefer explicit sUSDC approval/transferFrom testing.
    """
    pk = args.user_key.strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk
    if args.solana_recipient_base58:
        sol32 = solana_pubkey_bytes_from_base58(args.solana_recipient_base58)
    elif args.solana_recipient_hex:
        sol32 = parse_hex32(args.solana_recipient_hex)
    else:
        print(
            "ERROR: pass --solana-recipient-hex or --solana-recipient-base58",
            file=sys.stderr,
        )
        return 1

    dep_path = CONTRACTS_DIR / "deployment-info.json"
    if args.bridge:
        addr_bridge = args.bridge.replace("0x", "").lower()
        addr_susdc = None
        if dep_path.is_file():
            j = json.loads(dep_path.read_text(encoding="utf-8"))
            addr_susdc = j.get("sUSDC", "").replace("0x", "").lower()
    elif dep_path.is_file():
        j = json.loads(dep_path.read_text(encoding="utf-8"))
        addr_bridge = j["SethBridge"].replace("0x", "").lower()
        addr_susdc = j["sUSDC"].replace("0x", "").lower()
    else:
        print("ERROR: use --bridge + deployment or deployment-info.json", file=sys.stderr)
        return 1
    if not addr_susdc:
        print("ERROR: sUSDC address missing from deployment-info.json", file=sys.stderr)
        return 1

    susdc_raw = int(args.susdc_raw)
    if susdc_raw < 1:
        print("ERROR: --susdc-raw must be >= 1", file=sys.stderr)
        return 1

    client = SethClient(args.host, args.port)
    user_addr = client.get_address(pk.replace("0x", ""))
    user_cs = to_checksum_address("0x" + user_addr)
    bridge_cs = to_checksum_address("0x" + addr_bridge)

    total_before = get_total_withdraw_requests(args.host, args.port, user_addr, addr_bridge)
    print(f"[legacy] Seth: {args.host}:{args.port} Bridge=0x{addr_bridge} sUSDC=0x{addr_susdc}")
    print(f"[legacy] User=0x{user_addr} susdc_raw={susdc_raw} totalWithdrawRequests(before)={total_before}")

    gl = args.gas_limit_call
    wt = 300

    if args.mint_first:
        print("[legacy] sUSDC.mint(user, amount) — caller must be minter")
        inp = encode_call(
            "mint(address,uint256)",
            ["address", "uint256"],
            [user_cs, susdc_raw],
        )
        tx = client.send_transaction_auto(pk, addr_susdc, step=8, input_hex=inp, gas_limit=gl)
        if not tx:
            print("ERROR: mint send failed", file=sys.stderr)
            return 1
        ok, st = client.wait_for_receipt(tx, wt)
        if not ok:
            print("ERROR: mint receipt timeout", file=sys.stderr)
            return 1
        require_seth_tx_ok("mint", tx, st)
        print(f"[legacy] mint ok tx={tx}")

    print("[legacy] sUSDC.approve(bridge, amount)")
    inp_ap = encode_call(
        "approve(address,uint256)",
        ["address", "uint256"],
        [bridge_cs, susdc_raw],
    )
    tx_ap = client.send_transaction_auto(pk, addr_susdc, step=8, input_hex=inp_ap, gas_limit=gl)
    if not tx_ap:
        print("ERROR: approve send failed", file=sys.stderr)
        return 1
    ok_ap, st_ap = client.wait_for_receipt(tx_ap, wt)
    if not ok_ap:
        print("ERROR: approve receipt timeout", file=sys.stderr)
        return 1
    require_seth_tx_ok("approve", tx_ap, st_ap)
    print(f"[legacy] approve ok tx={tx_ap}")

    print("[legacy] SethBridge.requestWithdrawToSolana(bytes32,uint256)")
    inp_w = encode_call(
        "requestWithdrawToSolana(bytes32,uint256)",
        ["bytes32", "uint256"],
        [sol32, susdc_raw],
    )
    tx_w = client.send_transaction_auto(
        pk, addr_bridge, amount=0, step=8, input_hex=inp_w, gas_limit=gl
    )
    if not tx_w:
        print("ERROR: requestWithdrawToSolana send failed", file=sys.stderr)
        return 1
    ok_w, st_w = client.wait_for_receipt(tx_w, wt)
    if not ok_w:
        print("ERROR: requestWithdrawToSolana receipt timeout", file=sys.stderr)
        return 1
    print(f"[legacy] receipt status={st_w} tx={tx_w}")
    if st_w == 5:
        print("ERROR: status=5", file=sys.stderr)
        return 1

    total_after = get_total_withdraw_requests(args.host, args.port, user_addr, addr_bridge)
    print(f"[legacy] totalWithdrawRequests (after): {total_after}")
    if total_after <= total_before:
        print("ERROR: counter did not increase", file=sys.stderr)
        return 1
    latest = get_withdraw_request(args.host, args.port, user_addr, addr_bridge, total_after)
    print(f"[legacy] withdraw request #{total_after}: {latest}")
    record_withdraw_initiation_to_relayer_db(
        total_after,
        tx_w,
        latest,
        enabled=not args.no_db,
    )
    print("[legacy] Next: relayer ENABLE_SETH_TO_SOLANA=true")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Call SethBridge.requestWithdrawToSolanaFromSETH (Seth → Solana withdraw request)"
        )
    )
    p.add_argument("--host", default=os.environ.get("SETH_HOST", "35.197.170.240"))
    p.add_argument("--port", type=int, default=int(os.environ.get("SETH_PORT", "23001")))
    p.add_argument(
        "--bridge",
        default=None,
        help="SethBridge address; default from deployment-info.json",
    )
    p.add_argument(
        "--user-key",
        default=os.environ.get("USER_PRIVATE_KEY")
        or os.environ.get("WITHDRAW_USER_PRIVATE_KEY"),
        help="User private key 0x... (must hold SETH). Env: USER_PRIVATE_KEY",
    )
    p.add_argument(
        "--amount-seth",
        type=int,
        default=1,
        help="Native SETH sent with tx (integer; relayer inject convention: 1 = 1 SETH)",
    )
    p.add_argument(
        "--solana-recipient-hex",
        default=None,
        help="Solana recipient 32-byte pubkey as 64 hex characters",
    )
    p.add_argument(
        "--solana-recipient-base58",
        default=None,
        help="Solana recipient Base58 pubkey (requires pip install base58)",
    )
    p.add_argument(
        "--min-susdc-raw",
        type=int,
        default=None,
        help=(
            "Swap min output (6-decimal raw). Default: 99%% of offline estimate from "
            "reserves (estimate only; may differ on-chain)"
        ),
    )
    p.add_argument(
        "--min-susdc-raw-exact",
        type=int,
        default=None,
        help="Set minSUSDCOut explicitly (overrides auto estimate)",
    )
    p.add_argument(
        "--reserve-seth",
        type=int,
        default=None,
        help="Offline estimate: PoolB.reserveSETH (if omitted, min may be 0 or use --min-susdc-raw-exact)",
    )
    p.add_argument(
        "--reserve-susdc",
        type=int,
        default=None,
        help="Offline estimate: PoolB.reservesUSDC (6-decimal raw)",
    )
    p.add_argument("--gas-limit-call", type=int, default=5_000_000)
    p.add_argument(
        "--no-db",
        action="store_true",
        help="Do not write initiating_seth_tx_hash to relayer Postgres (even if DB_HOST is set)",
    )
    p.add_argument(
        "--legacy",
        action="store_true",
        help=(
            "Use requestWithdrawToSolana (sUSDC transferFrom) instead of native SETH path; "
            "more reliable on Seth when payable path does not increment the counter."
        ),
    )
    p.add_argument(
        "--susdc-raw",
        type=int,
        default=1_000_000,
        help="Legacy: sUSDC amount (6-decimal raw), default 1e6 = 1 sUSDC",
    )
    p.add_argument(
        "--mint-first",
        action="store_true",
        help="Legacy: mint sUSDC to user first (user key must be sUSDC minter)",
    )
    args = p.parse_args()

    if not args.user_key:
        print("ERROR: set USER_PRIVATE_KEY or --user-key", file=sys.stderr)
        return 1

    pk = args.user_key.strip()
    if not pk.startswith("0x"):
        pk = "0x" + pk

    if args.legacy:
        args.user_key = pk
        return run_legacy_withdraw(args)

    if args.solana_recipient_base58:
        sol32 = solana_pubkey_bytes_from_base58(args.solana_recipient_base58)
    elif args.solana_recipient_hex:
        sol32 = parse_hex32(args.solana_recipient_hex)
    else:
        print(
            "ERROR: pass --solana-recipient-hex or --solana-recipient-base58",
            file=sys.stderr,
        )
        return 1

    dep = CONTRACTS_DIR / "deployment-info.json"
    if args.bridge:
        addr_bridge = args.bridge.replace("0x", "").lower()
    elif dep.is_file():
        j = json.loads(dep.read_text(encoding="utf-8"))
        addr_bridge = j["SethBridge"].replace("0x", "").lower()
    else:
        print("ERROR: use --bridge or create deployment-info.json", file=sys.stderr)
        return 1

    amount_seth = args.amount_seth
    if amount_seth < 1:
        print("ERROR: --amount-seth must be at least 1", file=sys.stderr)
        return 1

    if args.min_susdc_raw_exact is not None:
        min_out = args.min_susdc_raw_exact
    elif args.min_susdc_raw is not None:
        min_out = args.min_susdc_raw
    elif args.reserve_seth is not None and args.reserve_susdc is not None:
        est = pool_amount_out(amount_seth, args.reserve_seth, args.reserve_susdc)
        min_out = (est * 99) // 100
        print(f"[estimate] getAmountOut≈{est} raw → minSUSDCOut(99%)={min_out}")
    else:
        min_out = 0
        print(
            "[hint] No reserves provided; minSUSDCOut=0 (testnets only; on mainnet use "
            "--reserve-seth/--reserve-susdc or --min-susdc-raw-exact)"
        )

    inp = encode_call(
        "requestWithdrawToSolanaFromSETH(bytes32,uint256)",
        ["bytes32", "uint256"],
        [sol32, min_out],
    )

    client = SethClient(args.host, args.port)
    user_addr = client.get_address(pk.replace("0x", ""))
    bal = client.get_balance(user_addr)
    total_before = get_total_withdraw_requests(args.host, args.port, user_addr, addr_bridge)
    print(f"Seth: {args.host}:{args.port}")
    print(f"SethBridge: 0x{addr_bridge}")
    print(f"User: 0x{user_addr}  balance(SETH integer): {bal}")
    print(f"amount (native SETH): {amount_seth}")
    print(f"solanaRecipient (32 bytes): 0x{sol32.hex()}")
    print(f"minSUSDCOut (raw): {min_out}")
    print(f"totalWithdrawRequests (before): {total_before}")

    txh = client.send_transaction_auto(
        pk,
        addr_bridge,
        amount=amount_seth,
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
        print("ERROR: receipt wait timed out", file=sys.stderr)
        return 1
    print(f"receipt status={st} tx={txh}")
    if st == 5:
        print(
            "ERROR: status=5 (possible revert: check Pool liquidity, min slippage, bridge/pool config)",
            file=sys.stderr,
        )
        return 1
    total_after = get_total_withdraw_requests(args.host, args.port, user_addr, addr_bridge)
    print(f"totalWithdrawRequests (after): {total_after}")
    if total_after <= total_before:
        print(
            "ERROR: withdraw request not created (counter did not increase). "
            "Receipt consensus success != contract success on Seth.",
            file=sys.stderr,
        )
        print(
            "Hint: try legacy sUSDC path: "
            "python request_withdraw_to_solana_from_seth.py --legacy --mint-first "
            "--solana-recipient-hex <64_hex> --susdc-raw 1000000",
            file=sys.stderr,
        )
        return 1
    latest = get_withdraw_request(args.host, args.port, user_addr, addr_bridge, total_after)
    print(f"latest withdraw request #{total_after}: {latest}")
    record_withdraw_initiation_to_relayer_db(
        total_after,
        txh,
        latest,
        enabled=not args.no_db,
    )
    print(
        "Next: relayer polls withdrawRequests / Solana unlock (ENABLE_SETH_TO_SOLANA=true)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
