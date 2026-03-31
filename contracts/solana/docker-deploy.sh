#!/bin/bash
# Solana contract Docker deployment script
# Usage: docker run -it --rm -v $(pwd):/app solanalabs/solana:latest /app/docker-deploy.sh

set -e

# Configuration
CLUSTER="devnet"
PROGRAM_NAME="seth_bridge"

echo "=== Solana Contract Deployment (Docker) ==="

# Check keypair file
if [ ! -f "/app/deployer-keypair.json" ]; then
    echo "Generating new deployer keypair..."
    solana-keygen new --no-passphrase -o /app/deployer-keypair.json
fi

# Configure Solana
solana config set --url $CLUSTER
solana config set --keypair /app/deployer-keypair.json

# Get address and balance
ADDRESS=$(solana address)
echo "Deployer address: $ADDRESS"

# Request airdrop
echo "Requesting test SOL..."
solana airdrop 2
solana airdrop 2
solana balance

# Generate program keypair
echo "Generating program keypair..."
mkdir -p /app/target/deploy
solana-keygen new --no-passphrase -o /app/target/deploy/${PROGRAM_NAME}-keypair.json --force

# Read program ID
PROGRAM_ID=$(solana-keygen pubkey /app/target/deploy/${PROGRAM_NAME}-keypair.json)
echo "Program ID: $PROGRAM_ID"

# Update program ID in lib.rs
if [ -f "/app/src/lib.rs" ]; then
    sed -i "s/declare_id!\(\".*\"\)/declare_id!\(\"${PROGRAM_ID}\"\)/" /app/src/lib.rs
    echo "Updated program ID in src/lib.rs"
fi

# Update Anchor.toml
if [ -f "/app/Anchor.toml" ]; then
    sed -i "s/seth_bridge = \".*\"/seth_bridge = \"${PROGRAM_ID}\"/" /app/Anchor.toml
    echo "Updated program ID in Anchor.toml"
fi

# Build
echo "Building contract..."
cd /app
anchor build

# Deploy
echo "Deploying contract..."
anchor deploy --provider.cluster $CLUSTER

echo ""
echo "=== Deployment Complete ==="
echo "Program ID: $PROGRAM_ID"
echo ""
echo "Please update relayer configuration with this ID"