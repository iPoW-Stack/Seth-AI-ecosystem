# BSC-Solana Cross-Chain Bridge Relayer

Based on the original Seth-Solana cross-chain bridge, added BSC testnet version for testing when BSC testnet is unstable.

## Version Description

| Version | File | Description | Use Case |
|------|------|------|---------|
| V1 | `bsc-relayer.js` | Basic version | Low concurrency, simple testing |
| V2 | `bsc-relayer-v2.js` | High-concurrency version | Production environment, high volume |

## Directory Structure

```
relayer/
├── relayer.js # Seth-Solana bridge (original version)
├── sethClient.js # Seth chain client (original version)
├── bsc-relayer.js # BSC-Solana bridge V1 (basic version)
├── bsc-relayer-v2.js # BSC-Solana bridge V2 (high-concurrency version)
├── bscClient.js # BSC testnet client
├── .env.example # Seth version config example
├── .env.bsc.example # BSC version config example
└── db/
└── database.js # Shared database module
```

## Quick Start

### 1. Install Dependencies

```bash
cd relayer
npm install
```

### 2. Configure BSC Relayer

```bash
# Copy configuration file
cp .env.bsc.example .env.bsc

# Edit configuration file
# Fill in your private key and contract address
nano .env.bsc
```

### 3. Create Database

```bash
# Create PostgreSQL database
createdb -U postgres bridge_relayer_bsc

# Initialize database tables
psql -U postgres -d bridge_relayer_bsc -f db/init.sql
```

### 4. Get Testnet tBNB

Get tBNB from BSC testnet faucet:
- https://testnet.binance.org/faucet-smart
- https://testnet.bscscan.com/faucet

### 5. Start Relayer

```bash
# Start BSC V1 version (Basic)
npm run start:bsc

# Start BSC V2 version (High-Concurrency)
npm run start:bsc:v2

# Or use development mode (auto-restart)
npm run dev:bsc      # V1
npm run dev:bsc:v2   # V2
```

## V2 High-Concurrency Version Features

### Architecture Design

```
                    ┌─────────────────────┐
                    │   Solana Blockchain     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Event Listener (WS+Poll) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    RateLimiter   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   MessageQueue  │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
    ┌─────▼─────┐       ┌─────▼─────┐       ┌─────▼─────┐
    │  Worker 0 │       │  Worker 1 │       │  Worker N │
    └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  NonceManager │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     BSC Blockchain      │
                    └─────────────────────┘
```

### Core Components

| Component | Class Name | Function |
|------|------|------|
| Message Queue | `MessageQueue` | Memory queue + Dead letter queue |
| NonceManager | `NonceManager` | Prevent nonce conflicts |
| Rate Limiter | `RateLimiter` | Token bucket rate limiting |
| Worker Pool | Worker Pool | Multi-worker concurrent processing |

### High-Concurrency Configuration并发配置

```env
# .env.bsc

# Number of workers (concurrent processing threads)
WORKER_COUNT=5

# Memory queue size
QUEUE_SIZE=1000

# Number of concurrent transactions
TX_CONCURRENCY=3

# Maximum polls per second
MAX_POLL_RATE=100

# Solana transaction fetch concurrency
SOLANA_FETCH_CONCURRENCY=5

# Health check interval (milliseconds)
HEALTH_CHECK_INTERVAL=10000
```

### Fault Tolerance Mechanism

1. **Message Persistence**: All messages stored in database first, then enter memory queue
2. **Dead Letter Queue**: Permanently failed messages moved to dead letter queue, no loss
3. **Automatic Retry**: Configurable retry count and exponential backoff
4. **Nonce Management**: Auto-refresh nonce to prevent transaction conflicts
5. **Health Check**: Regularly check system status and alert
6. **Graceful Shutdown**: Wait for processing transactions to complete before shutdown

## Configuration Description

### BSC Testnet Configuration

| Config Item | Description | Default Value |
|--------|------|--------|
| BSC_RPC_URL | BSC testnet RPC URL | https://data-seed-prebsc-1-s1.binance.org:8545/ |
| BSC_BRIDGE_ADDRESS | BSC bridge contract address | - |
| RELAYER_PRIVATE_KEY | Relayer private key | - |
| BSC_INJECT_NATIVE_WEI | Injected BNB amount (wei) | 1 |
| BSC_GAS_LIMIT | Gas Limit | 300000 |
| BSC_GAS_PRICE | Gas Price Gas Price (leave empty for auto) | - |

### Solana Configuration

| Config Item | Description | Default Value |
|--------|------|--------|
| SOLANA_RPC_URL | Solana RPC URL | https://api.devnet.solana.com |
| SOLANA_PROGRAM_ID | Solana Bridge Program ID | - |
| SOLANA_POLL_INTERVAL | Poll interval (ms) | 5000 |

### Database Configuration

| Config Item | Description | Default Value |
|--------|------|--------|
| DB_HOST | Database host | localhost |
| DB_PORT | Database port | 5432 |
| DB_NAME | Database name | bridge_relayer_bsc |
| DB_USER | Database user | postgres |
| DB_PASSWORD | Database password | - |

## BSC Testnet Information

- **Chain ID**: 97
- **RPC URLs**:
  - https://data-seed-prebsc-1-s1.binance.org:8545/
  - https://data-seed-prebsc-2-s1.binance.org:8545/
  - https://bsc-testnet.public.blastapi.io
  - https://bsc-testnet.publicnode.com
- **Block Explorer**: https://testnet.bscscan.com/

## Differences from Seth Version

| Feature | Seth Version | BSC Version |
|------|-----------|----------|
| Chain Type | Custom chain | Standard EVM chain |
| Transaction Format | Custom format | Standard EVM format |
| Client | sethClient.js | bscClient.js (ethers.js) |
| Configuration File | .env | .env.bsc |
| Database | bridge_relayer | bridge_relayer_bsc |

## Proxy Support

If you need to access BSC or Solana RPC through HTTP proxy:

```env
# .env.bsc
BSC_HTTP_PROXY=http://127.0.0.1:7890
SOLANA_HTTP_PROXY=http://127.0.0.1:7890
```

## Monitoring and Logs

### V1 Log Example

```
[BscRelayer] Initializing...
[BscRelayer] Solana connection established
[BscRelayer] BSC client initialized
[BscRelayer] Relayer address: 0x...
[BscRelayer] Started successfully
```

### V2 Log Example

```
[RelayerV2] Initializing high-concurrency relayer...
[RelayerV2] Worker pool initialized with 5 workers
[RelayerV2] Configuration:
  - Workers: 5
  - Queue size: 1000
  - TX concurrency: 3
[RelayerV2] Started successfully
[Worker0] Processing: 5abc123...
[Worker0] TX sent: 0x...
[Worker0] Completed in 2340ms: 0x...
[HealthCheck] OK - Block: 12345678, Queue: 5, Active: 2, Balance: 1.5000 tBNB
[RelayerV2] === Stats Report ===
  Uptime: 1h 30m
  Processed: 156
  Failed: 2
  Revenue: 1560.00 USDC
  Avg Process Time: 2100ms
```

## Performance Tuning Suggestions

### Low Load Scenario (< 10 TPS)
- `WORKER_COUNT=3`
- `TX_CONCURRENCY=2`
- `QUEUE_SIZE=100`

### Medium Load (10-50 TPS)
- `WORKER_COUNT=5`
- `TX_CONCURRENCY=3`
- `QUEUE_SIZE=500`

### High Load Scenario (> 50 TPS)
- `WORKER_COUNT=10`
- `TX_CONCURRENCY=5`
- `QUEUE_SIZE=1000`
- Consider increasing database connection pool size

## FAQ

### 1. BSC Connection Failed

BSC testnet RPC may be unstable. System will automatically try fallback RPCs. If all RPCs fail:
- Configure proxy
- Retry later
- Use private RPC node

### 2. Nonce Conflicts

V2 version has built-in Nonce Manager to automatically handle nonce conflicts. If issues persist:
- Keep TX_CONCURRENCY not exceeding 5
- Check if other programs are using the same account

### 3. Queue Backlog

If memory queue continues to grow：
- Increase `WORKER_COUNT`
- Increase `TX_CONCURRENCY`
- Check BSC network status

### 4. Transaction Failed

Check the following:
- Is contract address correct
- Does relayer have sufficient permissions
- Are gas settings reasonable
- Is balance sufficient

## Security Considerations

1. **Private Key Security**: Do not commit private keys to code repository
2. **Database Security**: Use strong password to protect PostgreSQL
3. **Network Security**: using firewall to restrict database access
4. **Testnet Tokens**: Only use test tokens on testnet
5. **Monitoring & Alerts**: Set up low balance alerts