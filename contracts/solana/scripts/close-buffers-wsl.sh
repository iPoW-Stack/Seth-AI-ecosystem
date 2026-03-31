#!/usr/bin/env bash
set -euo pipefail

export HOME=/root
export PATH=/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin
cd /mnt/d/code/blockchain/iPoW-Stack/Seth-AI-ecosystem/contracts/solana

RPC_URL="https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc"

for a in \
  AhpEV2JHfxD2rBiwvebxiUxAXcwheeyWkRGF5JgpzwH8 \
  Ao6feXLQ4eBC2yzy1yo3msP7N3wUU7PfMYwAK5Q7KPEs \
  3Ms3mYX4rjD5ysqYb1asrhbRoGsiWoPkdah9trQr2aTH \
  6UNhvraErfHvFqe4xVbrAaCBt61pUwxjFwbzD4AKCYrf \
  F1wddfKseZJX77VhNrTiYzZJu6wLEzUX3b3Ht2uLirvG
do
  echo "[close] $a"
  solana program close "$a" -k deployer-keypair.json -u "$RPC_URL" || true
done
