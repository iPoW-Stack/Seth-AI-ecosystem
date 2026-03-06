#!/bin/bash
# Solana 合约 Docker 部署脚本
# 使用方法: docker run -it --rm -v $(pwd):/app solanalabs/solana:latest /app/docker-deploy.sh

set -e

# 配置
CLUSTER="devnet"
PROGRAM_NAME="seth_bridge"

echo "=== Solana 合约部署 (Docker) ==="

# 检查密钥文件
if [ ! -f "/app/deployer-keypair.json" ]; then
    echo "生成新的部署密钥..."
    solana-keygen new --no-passphrase -o /app/deployer-keypair.json
fi

# 配置 Solana
solana config set --url $CLUSTER
solana config set --keypair /app/deployer-keypair.json

# 获取地址和余额
ADDRESS=$(solana address)
echo "部署者地址: $ADDRESS"

# 请求空投
echo "请求测试 SOL..."
solana airdrop 2
solana airdrop 2
solana balance

# 生成程序密钥
echo "生成程序密钥..."
mkdir -p /app/target/deploy
solana-keygen new --no-passphrase -o /app/target/deploy/${PROGRAM_NAME}-keypair.json --force

# 获取程序 ID
PROGRAM_ID=$(solana-keygen pubkey /app/target/deploy/${PROGRAM_NAME}-keypair.json)
echo "程序 ID: $PROGRAM_ID"

# 更新 lib.rs 中的程序 ID
if [ -f "/app/src/lib.rs" ]; then
    sed -i "s/declare_id!\(\".*\"\)/declare_id!\(\"${PROGRAM_ID}\"\)/" /app/src/lib.rs
    echo "已更新 src/lib.rs 中的程序 ID"
fi

# 更新 Anchor.toml
if [ -f "/app/Anchor.toml" ]; then
    sed -i "s/seth_bridge = \".*\"/seth_bridge = \"${PROGRAM_ID}\"/" /app/Anchor.toml
    echo "已更新 Anchor.toml 中的程序 ID"
fi

# 构建
echo "构建合约..."
cd /app
anchor build

# 部署
echo "部署合约..."
anchor deploy --provider.cluster $CLUSTER

echo ""
echo "=== 部署完成 ==="
echo "程序 ID: $PROGRAM_ID"
echo ""
echo "请将此 ID 更新到 relayer 配置中"