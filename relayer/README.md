# Seth-Solana Cross-Chain Bridge Relayer

A bidirectional cross-chain relayer service connecting **Seth Chain** (EVM) and **Solana**, enabling seamless asset transfers between the two networks.

## Important Notes

**SETH is the native token of Seth Chain (similar to ETH), NOT an ERC20 token.**
- PoolB uses native SETH for trading
- Treasury contract receives and sends native SETH via `msg.value`
- Users can buy/sell native SETH through PoolB

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Cross-Chain Bridge Architecture                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    Solana (Anchor)                              Seth Chain (EVM)             │
│   ┌────────────────┐                          ┌────────────────┐            │
│   │ Seth Bridge    │                          │ PoolB          │            │
│   │ ├─ process_    │     Solana → Seth       │ ├─ buySETH()   │            │
│   │ │  revenue()   │◄────────────────────────┤ ├─ sellSETH()  │            │
│   │ ├─ DIRM Swap   │                         │ └─ sUSDC       │            │
│   │ └─ sUSDC (SPL) │     Seth → Solana       │                │            │
│   │                │────────────────────────► │                │            │
│   └───────┬────────┘                          └────────────────┘            │
│           │                                                                  │
│           │ Events                                                           │
│           ▼                                                                  │
│   ┌────────────────┐                                                         │
│   │    Relayer     │                                                         │
│   │   (Node.js)    │                                                         │
│   ├────────────────┤                                                         │
│   │ • Event Listen │                                                         │
│   │ • Price Service│                                                         │
│   │ • Fee Calc     │                                                         │
│   │ • PostgreSQL   │                                                         │
│   └────────────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Bidirectional Cross-Chain Flows

### 1. Solana → Seth (Buy SETH)

When a user pays USDC on Solana to buy SETH:

```
User Payment (USDC) on Solana
         │
         ▼
┌─────────────────────────────────────────────┐
│         Solana: process_revenue()           │
│                                             │
│  Revenue Distribution (15-50-35):           │
│  ├── 10% → L1 Referrer Commission           │
│  ├── 5%  → L2 Referrer Commission           │
│  ├── 5%  → Team Wallet                      │
│  ├── 45% → Project Wallet                   │
│  └── 35% → Cross-chain to Seth (Ecosystem)  │
└─────────────────────────────────────────────┘
         │
         │ Relayer detects RevenueProcessed event
         ▼
┌─────────────────────────────────────────────┐
│         Seth: injectEcosystemFunds()        │
│                                             │
│  • Mint sUSDC to user                       │
│  • Inject liquidity into PoolB              │
└─────────────────────────────────────────────┘
```

### 2. Seth → Solana (Sell SETH)

When a user sells SETH on Seth to receive sUSDC on Solana:

```
User calls sellSETH(solanaRecipient) on PoolB
         │
         ▼
┌─────────────────────────────────────────────┐
│         Seth: PoolB.sellSETH()              │
│                                             │
│  • User sends native SETH                   │
│  • Calculate sUSDC output amount            │
│  • Burn sUSDC from user                     │
│  • Emit SwapExecuted(isBuySETH=false)       │
└─────────────────────────────────────────────┘
         │
         │ Relayer detects SwapExecuted event
         ▼
┌─────────────────────────────────────────────┐
│    Solana: process_seth_withdrawal()        │
│                                             │
│  • Verify withdrawal message (replay prot.) │
│  • Calculate cross-chain fee                │
│  • Mint (amount - fee) sUSDC to user        │
│  • Mint fee sUSDC to relayer (gas subsidy)  │
└─────────────────────────────────────────────┘
```

## Cross-Chain Fee Calculation

When processing Seth → Solana withdrawals, a cross-chain fee is charged to cover Solana gas costs:

```
Exchange Rate Chain:
┌─────────────────────────────────────────────────────────────────┐
│  SOL/SETH = (SOL/USDC) × (USDC/sUSDC) ÷ (SETH/sUSDC)            │
│                                                                 │
│  • SOL/USDC   → CoinGecko / Jupiter Price API                  │
│  • USDC/sUSDC → DIRM Pool Reserves (Solana)                    │
│  • SETH/sUSDC → PoolB Reserves (Seth)                          │
└─────────────────────────────────────────────────────────────────┘

Fee Formula:
┌─────────────────────────────────────────────────────────────────┐
│  Fee = (Estimated Gas Units × Gas Price) × (SETH/SOL Rate)      │
│        × (sUSDC/SETH Rate) × (1 + Markup%)                      │
│                                                                 │
│  Example:                                                       │
│  • Gas: 200,000 compute units × 0.000005 SOL = 0.001 SOL        │
│  • SOL/SETH rate: 0.067 SETH per SOL                           │
│  • sUSDC/SETH rate: 2500 sUSDC per SETH                        │
│  • Fee = 0.001 × 0.067 × 2500 × 1.10 = 0.18 sUSDC              │
└─────────────────────────────────────────────────────────────────┘
```

## User Address Mapping

For Seth → Solana withdrawals, users need to register their Solana address:

```javascript
// Register Solana address for Seth user
await registerAddressMapping({
    sethUser: '0x...',           // Seth address
    solanaAddress: '...',        // Solana public key
    signature: '...'             // Proof of ownership
});
```

## Directory Structure

```
relayer/
├── relayer.js                    # Solana → Seth relayer
├── seth-withdrawal-relayer.js    # Seth → Solana relayer
├── unified-relayer.js            # Unified bidirectional relayer
├── price-service.js              # Cross-chain price oracle
├── sethClient.js                 # Seth RPC client
├── register-address.js           # User address mapping utility
│
├── db/
│   ├── init.sql                  # Database schema
│   ├── migrate-add-fields.sql    # Schema migrations
│   ├── migrate-add-seth-withdrawal.sql
│   ├── migrate-add-user-address-mapping.sql
│   └── database.js               # Database operations
│
└── test-*.js                     # Test scripts
```

## Database Schema

### cross_chain_messages (Solana → Seth)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| solana_tx_sig | VARCHAR(88) | Solana transaction signature |
| amount | BIGINT | Cross-chain amount |
| sender_solana | VARCHAR(44) | Sender Solana address |
| recipient_seth | VARCHAR(42) | Recipient Seth address |
| status | VARCHAR(20) | pending/processing/completed/failed |
| seth_tx_hash | VARCHAR(66) | Seth transaction hash |
| retry_count | INTEGER | Retry attempts |
| created_at | TIMESTAMP | Creation time |

### seth_withdrawal_messages (Seth → Solana)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| seth_tx_hash | VARCHAR(66) | Seth transaction hash |
| seth_user | VARCHAR(42) | Seth user address |
| solana_recipient | VARCHAR(44) | Solana recipient address |
| susdc_amount | BIGINT | sUSDC amount |
| cross_chain_fee | BIGINT | Fee charged |
| status | VARCHAR(20) | pending/processing/completed/failed |
| solana_tx_sig | VARCHAR(88) | Solana transaction signature |

### user_address_mapping (Address Mapping)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| seth_address | VARCHAR(42) | Seth address |
| solana_address | VARCHAR(44) | Solana address |
| created_at | TIMESTAMP | Registration time |

### relayer_status (Relayer State)

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| last_solana_slot | BIGINT | Last processed Solana slot |
| last_seth_block | BIGINT | Last processed Seth block |
| is_active | BOOLEAN | Relayer status |

## Quick Start

### 1. Install Dependencies

```bash
cd relayer
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

Required environment variables:

```bash
# Seth Chain
SETH_RPC_URL=https://...
POOL_B_ADDRESS=0x...

# Solana
SOLANA_RPC_URL=https://...
SOLANA_BRIDGE_PROGRAM_ID=...
SOLANA_SUSDC_MINT=...
SOLANA_RELAYER_KEYPAIR_PATH=./relayer-keypair.json

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=seth_bridge
DB_USER=postgres
DB_PASSWORD=...

# Price Service
COINGECKO_API_KEY=...
FEE_MARKUP_PERCENT=10
```

### 3. Initialize Database

```bash
createdb -U postgres seth_bridge
psql -U postgres -d seth_bridge -f db/init.sql
psql -U postgres -d seth_bridge -f db/migrate-add-fields.sql
psql -U postgres -d seth_bridge -f db/migrate-add-seth-withdrawal.sql
psql -U postgres -d seth_bridge -f db/migrate-add-user-address-mapping.sql
```

### 4. Run Relayer

```bash
# Solana → Seth only
node relayer.js

# Seth → Solana only
node seth-withdrawal-relayer.js

# Bidirectional (both directions)
node unified-relayer.js
```

## Message State Machine

```
                    ┌──────────────┐
                    │   pending    │◀──────────┐
                    └──────┬───────┘           │
                           │                   │
                    Process Failed       Retry Time Reached
                           │                   │
                           ▼                   │
                    ┌──────────────┐           │
                    │  processing  │───────────┘
                    └──────┬───────┘
                           │
                    Process Success
                           │
                           ▼
                    ┌──────────────┐
                    │   completed  │
                    └──────────────┘

                    Max Retries Exceeded
                           │
                           ▼
                    ┌──────────────┐
                    │    failed    │
                    └──────────────┘
```

## Retry Strategy

The relayer uses **exponential backoff** for failed transactions:

| Retry # | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 2 minutes |
| 3 | 4 minutes |
| 4 | 8 minutes |
| 5 | 16 minutes |
| Max | 30 minutes |

## Production Deployment

### Using PM2

```bash
npm install -g pm2

# Start unified relayer
pm2 start unified-relayer.js --name bridge-relayer

# Setup auto-restart on boot
pm2 startup
pm2 save
```

### Docker Deployment

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "unified-relayer.js"]
```

```bash
docker build -t seth-relayer .
docker run -d --name relayer \
  --env-file .env \
  -v ./relayer-keypair.json:/app/relayer-keypair.json \
  seth-relayer
```

## Monitoring

The relayer outputs statistics every minute:

```
[Relayer] Stats: {
  direction: 'Solana → Seth',
  pending: 0,
  processing: 1,
  completed: 100,
  failed: 2,
  total: 103,
  lastProcessedSlot: 123456789,
  lastProcessedBlock: 9876543
}

[Relayer] Stats: {
  direction: 'Seth → Solana',
  pending: 0,
  processing: 0,
  completed: 50,
  failed: 0,
  total: 50,
  lastSethBlock: 9876543,
  totalFeesCollected: '15000000'
}
```

## Security Considerations

1. **Private Key Protection**: Never commit `RELAYER_PRIVATE_KEY` or keypair files
2. **Database Security**: Use strong passwords for PostgreSQL
3. **Network Isolation**: Deploy relayer in private network when possible
4. **Monitoring & Alerts**: Set up alerts for relayer health and failed messages
5. **Replay Protection**: Transaction hashes are stored on-chain to prevent double-spending

## Error Handling

### Retriable Errors
- Network timeouts
- RPC rate limiting
- High gas prices
- Nonce issues

### Non-retriable Errors
- Transaction already processed
- Invalid recipient address
- Invalid amount
- Insufficient balance

## License

MIT