# Seth-Solana Bridge Deployment Guide

This document describes how to deploy DIRM token, Bridge and revenue distribution contracts on Solana chain.

## Prerequisites

### 1. Install Solana CLI

```bash
# macOS / Linux
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Configure environment variables
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify installation
solana --version
```

### 2. Install Anchor

```bash
# Using AVM (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

# Install a version matching Cargo.toml (e.g. 0.32.x for this repo)
avm install 0.32.1
avm use 0.32.1

# Verify installation
anchor --version
```

### 3. Install Node.js Dependencies

```bash
cd contracts/solana
npm install
```

### WSL (Windows)

Install tooling **inside WSL** (Ubuntu, etc.), not only on Windows. Match **Anchor** to this workspace (`anchor-lang` **0.32.x** in `Cargo.toml`), e.g. `avm install 0.32.1` and `avm use 0.32.1` after installing [AVM](https://www.anchor-lang.com/docs/installation).

**One-shot devnet deploy** (adjust drive letter `d` if your repo is elsewhere):

```bash
cd /mnt/d/code/blockchain/iPoW-Stack/Seth-AI-ecosystem/contracts/solana

# Point CLI at devnet (airdrop / balance); deploy still uses RPC from Anchor.toml
solana config set --url devnet
solana config set --keypair ./deployer-keypair.json

solana-keygen pubkey ./deployer-keypair.json   # note address
solana airdrop 2 <PASTE_ADDRESS_HERE>          # repeat if "insufficient funds"

npm install
npm run deploy:devnet:init
```

`deploy:devnet:init` runs `anchor build`, `anchor deploy` (both programs), writes `deployment-info.json`, then `initialize-bridge.js`.

Use the same `deployer-keypair.json` and `target/deploy/*-keypair.json` as on Windows — paths like `/mnt/d/...` are the same files as `D:\...`.

**Where “deployment memory” lives**

- This chat does **not** remember past deployments. Keep a record yourself.
- After a successful run, `deployment-info.json` is written in this directory. Commit it (or a redacted copy) if you want the repo to remember program IDs for your team.
- On-chain truth: `solana program show <PROGRAM_ID>` on the RPC you use.

## Configuration

### 1. Configure Solana Network

```bash
# Devnet
solana config set --url devnet

# Mainnet
# solana config set --url mainnet-beta
```

### 2. Configure Deployer Keypair

Deployer keypair is configured in `deployer-keypair.json`.

**⚠️ Important: Replace with a new secure keypair before mainnet deployment!**

```bash
# View deployer address
solana-keygen pubkey ./deployer-keypair.json
```

### 3. Get SOL (Devnet)

```bash
# Request airdrop
solana airdrop 2 $(solana-keygen pubkey ./deployer-keypair.json)

# View balance
solana balance
```

## Deployment Steps

### Step 1: Build Anchor Program

```bash
cd contracts/solana

# Build
anchor build

# Verify build
ls target/verifier/seth-bridge.so
```

### Step 2: Get Program ID

```bash
# Generate new program keypair (first deployment)
solana-keygen new -o target/deploy/seth_bridge-keypair.json --no-passphrase

# Get program ID
anchor keys list

# Update program ID in Anchor.toml and src/lib.rs
```

### Step 3: Deploy programs (dev)

`Anchor.toml` sets the RPC (e.g. Helius devnet). Deploy **seth_bridge** and **dirm** and write `deployment-info.json`:

```bash
# Build + deploy both programs; optional: --init runs bridge initialize on-chain
npm run deploy:devnet
npm run deploy:devnet:init

# Equivalent to npm run deploy:devnet:init
npm run deploy:full
```

Or manually:

```bash
anchor build
anchor deploy
node scripts/initialize-bridge.js
```

### Step 4: Pool / sUSDC (optional)

`npm run pool:init` initializes the DIRM pool on-chain. It needs `SUSDC_MINT` or a `susdc-token-info.json` at the repo root (see `initialize-pool.js`).

## Revenue Distribution Configuration

After Bridge deployment, 15-50-35 distribution is automatically configured:

```
Total Amount (100%)
    │
    ├── 15% Referral Commission (real-time distribution)
    │   ├── 10% → L1 Referrer
    │   └── 5%  → L2 Referrer
    │
    ├── 50% Operations Reserve (monthly settlement)
    │   ├── 5%  → Team Incentive Wallet
    │   └── 45% → Project Multi-sig Wallet
    │
    └── 35% Ecosystem Funds (cross-chain to Seth)
        └── → Seth Treasury
```

## Post-Deployment Configuration

### 1. Update Relayer Configuration

Update in `relayer/.env`:

```env
SOLANA_PROGRAM_ID=<deployed program ID>
SOLANA_RPC_URL=https://api.devnet.solana.com
SETH_TREASURY_ADDRESS=<Seth Treasury address>
```

### 2. Set Seth Treasury Address

```bash
# Using Anchor CLI
anchor run set-treasury -- --treasury <Seth Treasury address>
```

### 3. Configure Referral System

Users can set their referrer by calling the `set_referrer` instruction.

## Testing

### Local Testing

```bash
# Start local test validator
solana-test-validator

# Run tests
anchor test --skip-local-validator
```

### Devnet Testing

```bash
anchor test --provider.cluster devnet
```

## Verify Deployment

```bash
# Check if program is deployed successfully
solana program show <PROGRAM_ID>

# Check account status
spl-token accounts --owner <DEPLOYER_ADDRESS>
```

## Upgrade

```bash
# Build new version
anchor build

# Upgrade program
solana program deploy target/verifier/seth-bridge.so \
    --program-id target/deploy/seth_bridge-keypair.json \
    --upgrade-authority ./deployer-keypair.json
```

## Security Considerations

1. **Key Protection**: Never commit private keys to the repository
2. **Before Mainnet**: Replace all keys with multi-sig or hardware wallet
3. **Permission Management**: Set appropriate upgrade authority
4. **Audit**: Conduct security audit before mainnet deployment

## Troubleshooting

### Build Failure

```bash
# Clean and rebuild
anchor clean
anchor build
```

### Deployment Failure - Insufficient Balance

```bash
# Check balance
solana balance

# Request airdrop (devnet)
solana airdrop 2
```

### Program ID Mismatch

```bash
# Regenerate keypair
rm target/deploy/seth_bridge-keypair.json
anchor keys list

# Update program ID in code
```

## File Structure

```
contracts/solana/
├── Anchor.toml              # Anchor configuration
├── Cargo.toml               # Rust project configuration
├── deployer-keypair.json    # Deployer keypair (⚠️ replace before mainnet)
├── package.json             # Node.js dependencies
├── src/
│   ├── lib.rs               # Main program entry
│   ├── constants.rs         # Constants definition
│   ├── errors.rs            # Error definition
│   ├── events.rs            # Event definition
│   ├── state.rs             # Data structure
│   ├── bridge.rs            # Bridge module
│   └── revenue.rs           # Revenue distribution module
├── scripts/
│   ├── deploy-devnet.js     # Build, deploy, write deployment-info.json; --init for bridge
│   ├── initialize-bridge.js
│   └── initialize-pool.js
└── target/                   # Build output
    ├── deploy/
    ├── idl/
    └── verifier/
```

## Contact Support

If you have questions, please contact the development team or submit an Issue on GitHub.