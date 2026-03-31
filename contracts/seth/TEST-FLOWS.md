# User Deposit/Withdraw Test Flows

This document describes how users should operate inbound/outbound bridge flows now, and which scripts to run.

## 1) Inbound (Solana -> Seth)

Meaning: user deposits USDC on Solana; relayer observes lock/revenue message and calls Seth bridge.

### Prerequisites
- Solana program deployed and initialized.
- User has Solana USDC ATA balance.
- Relayer is running and configured with valid `SETH_BRIDGE_ADDRESS`.

### Test script
- `contracts/solana/scripts/test-inbound-lock.js`

### Example
```bash
cd contracts/solana
node scripts/test-inbound-lock.js --amount-usdc 1 --seth-recipient 0x742bf979105179e44aed27baf37d66ef73cc3d88
```

Expected:
- Script prints Solana tx signature and cross-chain message PDA.
- Relayer logs should later show inbound detection and Seth call.

## 2) Outbound (Seth -> Solana)

Meaning: user requests withdraw on Seth; relayer polls Seth lock/withdraw request, unlocks on Solana, then marks request processed on Seth.

### Prerequisites
- Seth contracts deployed and initialized (PoolB/Treasury/Bridge wiring OK).
- User has native SETH for `requestWithdrawToSolanaFromSETH`.
- Solana relayer key is authorized and has enough SOL.
- Relayer is running with `ENABLE_SETH_TO_SOLANA=true`.

### Test script
- `contracts/seth/test-outbound-lock.py`

### Example
```bash
cd contracts/seth
python test-outbound-lock.py --amount-seth 10 --solana-recipient-base58 GRuCu61Pfyub9CgYjnqQGq9aeGAUKAUZ9pBEpLExjDqy
```

Expected:
- Script prints Seth tx hash, new `request_id`, and `lockRequestKey`.
- Relayer logs should show Seth request polling, Solana unlock tx, and Seth mark processed tx.

## Notes
- Seth events are for observability only; relayer main path uses getter polling for reliability.
- `lockRequestKey` and `withdrawRequestKey` use the same unique formula: `keccak256(address(this), requestId)`.
