# Seth AI Ecosystem

A cross-chain bridge infrastructure connecting **Seth Chain** (EVM-compatible) and **Solana**, enabling seamless asset transfers between the two networks.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Seth AI Ecosystem                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────┐                         ┌──────────────────┐         │
│   │   Seth Chain     │                         │     Solana       │         │
│   │   (EVM)          │                         │   (Anchor)       │         │
│   ├──────────────────┤                         ├──────────────────┤         │
│   │ • PoolB          │◄────── Bridge ───────► │ • Seth Bridge    │         │
│   │ • sUSDC (ERC20)  │                         │ • DIRM (Swap)    │         │
│   │ • Treasury       │                         │ • sUSDC (SPL)    │         │
│   └──────────────────┘                         └──────────────────┘         │
│           ▲                                             ▲                    │
│           │                                             │                    │
│           └─────────────────┬───────────────────────────┘                    │
│                             │                                                │
│                    ┌────────▼────────┐                                      │
│                    │     Relayer     │                                      │
│                    │   (Node.js)     │                                      │
│                    ├─────────────────┤                                      │
│                    │ • Event Monitor │                                      │
│                    │ • Price Service │                                      │
│                    │ • Cross-chain   │                                      │
│                    │   Message Relay │                                      │
│                    └─────────────────┘                                      │
│                             │                                                │
│                    ┌────────▼────────┐                                      │
│                    │   PostgreSQL    │                                      │
│                    │   (Database)    │                                      │
│                    └─────────────────┘                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
seth-ai-ecosystem/
├── contracts/                 # Smart Contracts
│   ├── seth/                  # Seth Chain (Solidity)
│   │   ├── PoolB.sol          # SETH/sUSDC pricing pool
│   │   ├── sUSDC.sol          # Synthetic USDC token
│   │   ├── Treasury.sol       # Treasury management
│   │   └── SethBridge.sol     # Bridge contract
│   │
│   ├── solana/                # Solana Programs (Rust/Anchor)
│   │   ├── src/
│   │   │   ├── lib.rs         # Program entry point
│   │   │   ├── bridge.rs      # Bridge instructions
│   │   │   ├── withdrawal.rs  # Seth→Solana withdrawals
│   │   │   ├── revenue.rs     # Revenue distribution
│   │   │   └── state.rs       # Account structures
│   │   └── scripts/           # Deployment & test scripts
│   │
│   └── solana-rebate/         # Rebate Contract (Solana)
│
├── relayer/                   # Cross-chain Relayer Service
│   ├── relayer.js             # Solana→Seth relayer
│   ├── seth-withdrawal-relayer.js  # Seth→Solana relayer
│   ├── unified-relayer.js     # Unified relayer (both directions)
│   ├── price-service.js       # Cross-chain price oracle
│   ├── sethClient.js          # Seth RPC client
│   └── db/                    # Database migrations
│
└── README.md
```

## Key Components

### 1. Seth Chain Contracts
- **PoolB**: AMM pool for SETH/sUSDC trading with price discovery
- **sUSDC**: Synthetic USDC token (ERC20)
- **Treasury**: Manages protocol funds and liquidity

### 2. Solana Programs
- **Seth Bridge**: Main bridge program handling cross-chain messages
- **DIRM**: Decentralized swap pool for sUSDC/USDC on Solana
- **Withdrawal Module**: Processes Seth→Solana cross-chain withdrawals

### 3. Relayer Service
- Monitors events on both chains
- Relays cross-chain messages
- Calculates cross-chain fees based on real-time gas prices
- Manages replay protection via transaction hashes

## Cross-Chain Flows

### Solana → Seth (Buy SETH)
```
1. User calls process_revenue on Solana
2. USDC locked in Solana vault
3. Relayer detects event, calls Seth contract
4. sUSDC minted to user on Seth
```

### Seth → Solana (Sell SETH)
```
1. User calls sellSETH on PoolB (with solanaRecipient parameter)
2. sUSDC burned on Seth
3. Relayer detects SwapExecuted event
4. sUSDC minted to user on Solana (minus cross-chain fee)
```

## Cross-Chain Fee Calculation

Fees are calculated based on real-time gas prices:

```
Exchange Rate Chain:
┌─────────────────────────────────────────────────────────────┐
│  SOL/SETH = (SOL/USDC) × (USDC/sUSDC) ÷ (SETH/sUSDC)        │
│                                                             │
│  • SOL/USDC   → CoinGecko / Jupiter Price API              │
│  • USDC/sUSDC → DIRM Pool Reserves (Solana)                │
│  • SETH/sUSDC → PoolB Reserves (Seth)                      │
└─────────────────────────────────────────────────────────────┘

Fee = (Estimated Gas Cost) × (Exchange Rate) × (Markup %)
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Seth Contracts | Solidity ^0.8.20, EVM |
| Solana Programs | Rust, Anchor Framework |
| Relayer | Node.js, ethers.js, @solana/web3.js |
| Database | PostgreSQL |
| Price Oracle | CoinGecko API, Jupiter API |

## Getting Started

### Prerequisites
- Node.js >= 18
- Rust & Solana CLI (for Solana programs)
- PostgreSQL
- Seth Chain RPC endpoint
- Solana RPC endpoint

### Installation

```bash
# Install relayer dependencies
cd relayer
npm install

# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
psql -f db/init.sql
psql -f db/migrate-add-fields.sql
psql -f db/migrate-add-seth-withdrawal.sql
psql -f db/migrate-add-user-address-mapping.sql
```

### Running the Relayer

```bash
# Solana → Seth relayer
node relayer.js

# Seth → Solana relayer
node seth-withdrawal-relayer.js

# Or run unified relayer (both directions)
node unified-relayer.js
```

## Configuration

Key environment variables (see `.env.example`):

```bash
# Seth Chain
SETH_RPC_URL=https://...
POOL_B_ADDRESS=0x...

# Solana
SOLANA_RPC_URL=https://...
SOLANA_BRIDGE_PROGRAM_ID=...
SOLANA_SUSDC_MINT=...

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

## Security Model

- **Trustless Bridge**: Uses cryptographic proofs and relayer signatures
- **Replay Protection**: Transaction hashes stored on-chain to prevent double-spending
- **Fee Protection**: Fees calculated transparently with configurable markup
- **Relayer Authentication**: Only registered relayers can submit cross-chain messages

## License

MIT