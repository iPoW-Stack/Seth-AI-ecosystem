#!/usr/bin/env bash
set -euo pipefail

export HOME=/root
export PATH=/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin

cd /mnt/d/code/blockchain/iPoW-Stack/Seth-AI-ecosystem/contracts/solana

RPC_URL="${ANCHOR_DEPLOY_RPC:-https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc}"
ATTEMPTS="${DEPLOY_ATTEMPTS:-8}"
SLEEP_SEC="${DEPLOY_RETRY_SEC:-45}"
TRY_TIMEOUT_SEC="${DEPLOY_TRY_TIMEOUT_SEC:-240}"

for ((i=1; i<=ATTEMPTS; i++)); do
  echo "[deploy-only] attempt ${i}/${ATTEMPTS}"
  if timeout "${TRY_TIMEOUT_SEC}" solana program deploy target/deploy/seth_bridge.so \
    --program-id target/deploy/seth_bridge-keypair.json \
    -k deployer-keypair.json \
    -u "$RPC_URL" \
    --use-rpc \
    --max-sign-attempts 25; then
    echo "[deploy-only] success"
    exit 0
  fi

  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "[deploy-only] failed, sleep ${SLEEP_SEC}s"
    sleep "$SLEEP_SEC"
  fi
done

echo "[deploy-only] failed after ${ATTEMPTS} attempts"
exit 1
