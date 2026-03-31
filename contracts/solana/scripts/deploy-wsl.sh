#!/usr/bin/env bash
# Build and deploy seth_bridge to the cluster in Anchor.toml (e.g. devnet).
#
# From Windows (PowerShell):  .\scripts\deploy-via-wsl.ps1
# Inside WSL:
#   bash contracts/solana/scripts/deploy-wsl.sh
#   bash scripts/deploy-wsl.sh   # if cwd is contracts/solana
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="${HOME}/.local/share/solana/install/active_release/bin:${HOME}/.cargo/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

if ! command -v anchor >/dev/null 2>&1; then
  echo "[deploy-wsl] anchor not found; install anchor-cli 0.32.1 (matches Cargo.toml):"
  echo "  cargo install anchor-cli --version 0.32.1 --locked"
  exit 1
fi
if ! command -v solana >/dev/null 2>&1; then
  echo "[deploy-wsl] solana CLI not found; install Solana CLI first."
  exit 1
fi

echo "[deploy-wsl] anchor $(anchor --version)"
echo "[deploy-wsl] solana $(solana --version)"
echo "[deploy-wsl] building in $ROOT"

anchor build

# `anchor deploy` uses a TPU/WebSocket client; Helius often returns 429 there. Prefer JSON-RPC + --use-rpc.
# Override with: ANCHOR_DEPLOY_RPC='https://your-devnet-rpc' bash scripts/deploy-wsl.sh
RPC_URL="${ANCHOR_DEPLOY_RPC:-https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc}"
DEPLOY_ATTEMPTS="${DEPLOY_ATTEMPTS:-8}"
DEPLOY_RETRY_SEC="${DEPLOY_RETRY_SEC:-45}"

echo "[deploy-wsl] deploying seth_bridge via solana program deploy --use-rpc"
echo "[deploy-wsl] RPC: set ANCHOR_DEPLOY_RPC to override; default is Helius devnet from repo"

deploy_ok=0
i=1
while [ "$i" -le "$DEPLOY_ATTEMPTS" ]; do
  echo "[deploy-wsl] deploy attempt $i/$DEPLOY_ATTEMPTS ..."
  if solana program deploy target/deploy/seth_bridge.so \
    --program-id target/deploy/seth_bridge-keypair.json \
    -k deployer-keypair.json \
    -u "$RPC_URL" \
    --use-rpc \
    --max-sign-attempts 25; then
    deploy_ok=1
    break
  fi
  if [ "$i" -lt "$DEPLOY_ATTEMPTS" ]; then
    echo "[deploy-wsl] failed; sleep ${DEPLOY_RETRY_SEC}s (429/network cooldown) ..."
    sleep "$DEPLOY_RETRY_SEC"
  fi
  i=$((i + 1))
done

if [ "$deploy_ok" -ne 1 ]; then
  echo "[deploy-wsl] ERROR: deploy failed after $DEPLOY_ATTEMPTS attempts."
  echo "[deploy-wsl] Use a stable devnet HTTPS RPC: ANCHOR_DEPLOY_RPC='https://...' bash scripts/deploy-wsl.sh"
  exit 1
fi

echo "[deploy-wsl] seth_bridge done. (dirm is a separate program; deploy it only if you use it.)"
echo "[deploy-wsl] Optional: node scripts/initialize-bridge.js (idempotent if already initialized)"
