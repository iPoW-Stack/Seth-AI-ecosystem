# Seth-Solana Cross-Chain Bridge Relayer

Seth-Solana cross-chain bridge Relayer implementation based on the TrustRelayer security model.

## Important Notes

**SETH is the native token of Seth chain (similar to ETH), not an ERC20 token.**

- Pool B uses native SETH for trading
- Treasury contract receives and sends native SETH via `msg.value`
- Users can buy and sell native SETH through Pool B

## Revenue Split Flow (15-50-35)

**Important: Revenue split logic is completed on Solana chain**

When users pay USDC on Solana chain:

```
Total Amount (100%)
│
├── 15% Promotion Commission (Real-time Distribution)
│ ├── 10% → L1 Referrer
│ └── 5% → L2 Referrer
│
├── 50% Operational Reserve (End-of-Month Settlement)
│ ├── 5% → Team Incentive Wallet
│ └── 45% → Project Multi-sig Wallet
│
└── 35% Ecosystem Fund (Cross-Chain to Seth)
└── → Relayer → SethBridge.injectEcosystemFunds() → Pool B
```

**35% Ecosystem Fund directly injected into Pool B:**
1. Relayer listens to Solana's `RevenueProcessed` event
2. Calculate required SETH amount (based on Pool B current price)
3. Call `SethBridge.injectEcosystemFunds()` to inject liquidity
4. Pool B receives sUSDC + SETH liquidity, supporting SETH price

### Solana Chain Responsibilities
- Revenue collection
- 15-50-35 split calculation
- L1/L2 commission real-time distribution
- End-of-month settlement disbursement
- Trigger 35% cross-chain transfer

### Seth Chain Responsibilities
- Receive 35% ecosystem fund
- Mint sUSDC
- Inject into Pool B to support SETH price

## Architecture Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│    Solana       │      │    Relayer      │      │     Seth        │
│  Bridge Program │─────▶│   (Node.js)     │─────▶│  Bridge Contract│
│                 │      │                 │      │                 │
│  - Lock Event   │      │  - Event Listen │      │  - ExecuteUnlock│
│  - SPL Token    │      │  - PostgreSQL   │      │  - Mint sUSDC   │
└─────────────────┘      │  - Retry Logic  │      └─────────────────┘
                         └─────────────────┘
```

## Features

- **Event Listening**: Real-time listening to Solana Bridge program's CrossChainLock events
- **Message Persistence**: PostgreSQL storage for cross-chain messages, supports resume from breakpoint
- **Automatic Retry**: Automatic retry for failed messages with exponential backoff strategy
- **State Tracking**: Complete message state management and operation logs
- **Graceful Shutdown**: SIGINT/SIGTERM signal handling to ensure no message loss

## Directory Structure

```
relayer/
├── db/
│ ├── init.sql # Database initialization script
│ └── database.js # Database operation class
├── relayer.js # Relayer main program
├── package.json # Project dependencies
├── .env.example # Environment variable example
└── README.md # This document
```

## Quick Start

### 1. Install Dependencies

```bash
cd relayer
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
# Edit .env file with actual configuration
```

### 3. Initialize Database

Use a **new** PostgreSQL database (empty schema). There are no migration scripts; `init.sql` is the full schema.

```bash
# Create database
createdb -U postgres bridge_relayer

# Execute initialization script
psql -U postgres -d bridge_relayer -f db/init.sql
```

### 4. Start Relayer

```bash
# Production environment
npm start

# Development environment (with hot reload)
npm run dev
```

## Database Table Structure

### cross_chain_messages

| Field | Type | Description |
|------|------|------|
| id | SERIAL | Primary key |
| solana_tx_sig | VARCHAR(88) | Solana transaction signature |
| solana_tx_sig_bytes32 | VARCHAR(66) | Converted bytes32 format |
| amount | BIGINT | Cross-chain amount |
| recipient_eth | VARCHAR(42) | Seth recipient address |
| sender_solana | VARCHAR(44) | Solana sender address |
| status | VARCHAR(20) | Status: pending/processing/completed/failed |
| retry_count | INTEGER | Retry count |
| max_retries | INTEGER | Maximum retry count |
| last_error | TEXT | Last error message |
| seth_tx_hash | VARCHAR(66) | Seth chain transaction hash |
| seth_block_number | BIGINT | Seth chain block number |
| created_at | TIMESTAMP | Creation time |
| processed_at | TIMESTAMP | Processing completion time |
| next_retry_at | TIMESTAMP | Next retry time |

### relayer_status Table

| Field | Type | Description |
|------|------|------|
| id | SERIAL | Primary key |
| relayer_address | VARCHAR(42) | Relayer Seth address |
| last_processed_slot | BIGINT | Last processed Solana slot |
| last_processed_signature | VARCHAR(88) | Last processed transaction signature |
| is_active | BOOLEAN | Is active |
| started_at | TIMESTAMP | Start time |
| updated_at | TIMESTAMP | Update time |

### operation_logs Table

| Field | Type | Description |
|------|------|------|
| id | SERIAL | Primary key |
| message_id | INTEGER | Related message ID |
| operation | VARCHAR(50) | Operation type |
| details | JSONB | Operation details |
| created_at | TIMESTAMP | Creation time |

## Message State Flow

```
                    ┌──────────────┐
                    │   pending    │◀──────────┐
                    └──────┬───────┘           │
                           │                   │
                    Process Failed              Retry Time Reached
                           │                   │
                           ▼                   │
                    ┌──────────────┐           │
                    │  processing  │───────────┘
                    └──────┬───────┘
                           │
                     completed
                           │
                           ▼
                    ┌──────────────┐
                    │   completed  │
                    └──────────────┘

                    Exceed Max Retries
                           │
                           ▼
                    ┌──────────────┐
                    │    failed    │
                    └──────────────┘
```

## Retry Strategy

Relayer uses **exponential backoff**strategy for failure retries:

- 1st retry: Immediately
- 2nd retry: 2 minutes later
- 3rd retry: 4 minutes later
- 4th retry: 8 minutes later
- 5th retry: 16 minutes later
- Maximum wait time: 30 minutes

## Error Classification

### Retryable Errors

- Network timeout
- Connection errors
- RPC rate limiting
- Gas price too high
- Nonce issues

### Non-Retryable Errors

- Transaction already processed
- Invalid recipient address
- Invalid amount
- Insufficient balance

## Monitoring and Logs

Relayer outputs statistics every minute:

```
[Relayer] Stats: {
  pending: 0,
  processing: 1,
  completed: 100,
  failed: 2,
  total: 103,
  sessionProcessed: 50,
  sessionFailed: 1,
  lastProcessedAt: 2024-01-15T10:30:00.000Z
}
```

## Security Considerations

1. **Private Key Protection**: Never commit RELAYER_PRIVATE_KEY to code repository
2. **Database Security**: Use strong password to protect PostgreSQL database
3. **Network Isolation**: Deploy Relayer in private network
4. **Monitoring & Alerts**: Set up alerts for Relayer status and failed messages

## Production Deployment Recommendations

### Use PM2 for Process Management

```bash
# Install PM2
npm install -g pm2

# Start
pm2 start relayer.js --name bridge-relayer

# Setup auto-start
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
CMD ["node", "relayer.js"]
```

### Environment Variable Management

Recommended environment variable management tools:
- Docker Secrets
- Kubernetes Secrets
- AWS Secrets Manager
- HashiCorp Vault

## Fault Recovery

### Recovery After Restart

After restart, Relayer will automatically:
1. Check pending messages in database
2. Process all messages in pending status
3. Process messages requiring retry

### Data Backup

Regularly backup PostgreSQL database:

```bash
pg_dump -U postgres bridge_relayer > backup.sql
```

## API Extensions

Can extend Relayer with API endpoints:

```javascript
const express = require('express');
const app = express();

app.get('/stats', async (req, res) => {
    const stats = await db.getStats();
    res.json(stats);
});

app.get('/messages/:status', async (req, res) => {
    const messages = await db.getPendingMessages(100);
    res.json(messages);
});
```

## License

MIT