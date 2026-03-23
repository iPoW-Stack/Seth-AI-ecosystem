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

# Install latest version
avm install 0.29.0
avm use 0.29.0

# Verify installation
anchor --version
```

### 3. Install Node.js Dependencies

```bash
cd contracts/solana
npm install
```

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

### Step 3: Deploy Program

```bash
# Deploy to devnet
anchor deploy --provider.cluster devnet

# Deploy to mainnet
# anchor deploy --provider.cluster mainnet
```

### Step 4: Create DIRM Token

```bash
# Create DIRM token
npm run dirm:create

# Or run manually
node scripts/create-dirm.js
```

Example output:
```
DIRM Mint: xxxxx...
Deployer account: xxxxx...
```

### Step 5: Full Deployment (Optional)

Run the full deployment script, including:
- Create DIRM token
- Create necessary accounts
- Initialize Bridge

```bash
npm run deploy:full
```

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
│   ├── deploy.js            # Full deployment script
│   └── create-dirm.js       # DIRM token creation script
└── target/                   # Build output
    ├── deploy/
    ├── idl/
    └── verifier/
```

## Contact Support

If you have questions, please contact the development team or submit an Issue on GitHub.