# Solana 合约部署指南

## 前置条件

### 1. 安装 Solana CLI

**Windows (使用 PowerShell):**
```powershell
# 下载并安装 Solana
Invoke-WebRequest -Uri https://release.anza.xyz/stable/install | Invoke-Expression
```

**或者使用 WSL/Linux:**
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

**MacOS:**
```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

### 2. 验证安装
```bash
solana --version
anchor --version
```

## 部署步骤

### 1. 配置 Solana 测试网
```bash
# 设置为 devnet
solana config set --url devnet

# 查看当前配置
solana config get
```

### 2. 创建/导入部署密钥
```bash
# 如果没有密钥，生成新密钥
solana-keygen new -o ./deployer-keypair.json

# 或者导入现有密钥（如果有）
# solana-keygen recover -o ./deployer-keypair.json
```

### 3. 获取测试 SOL
```bash
# 查看当前地址
solana address

# 获取测试 SOL (空投)
solana airdrop 2

# 查看余额
solana balance
```

### 4. 更新程序 ID (重要!)

每次部署新程序需要新的 Program ID:

```bash
# 生成新的 program keypair
solana-keygen new -o target/deploy/seth_bridge-keypair.json --no-passphrase

# 获取新的 program ID
solana-keygen pubkey target/deploy/seth_bridge-keypair.json
```

将输出的 Program ID 更新到以下文件：
- `Anchor.toml` - 更新 `[programs.devnet]` 下的 `seth_bridge`
- `src/lib.rs` - 更新 `declare_id!()` 中的值

### 5. 构建合约
```bash
# 确保 Cargo.toml 中的程序名与 keypair 文件名匹配
# lib.name = "seth_bridge"

# 构建
anchor build
```

### 6. 部署到 Devnet
```bash
# 部署
anchor deploy --provider.cluster devnet

# 或者指定 program keypair
anchor deploy --provider.cluster devnet --program-keypair target/deploy/seth_bridge-keypair.json
```

## 部署后验证

### 1. 查看部署的程序
```bash
solana program show <PROGRAM_ID>
```

### 2. 验证程序
```bash
# 检查程序账户
solana account <PROGRAM_ID>
```

### 3. 获取程序 IDL
```bash
anchor idl init <PROGRAM_ID> -f target/idl/seth_bridge.json
```

## 常见问题

### 问题 1: 余额不足
```bash
# 多次请求空投
solana airdrop 2
solana airdrop 2
```

### 问题 2: 网络问题
```bash
# 使用特定的 RPC
solana config set --url https://api.devnet.solana.com
```

### 问题 3: Program ID 不匹配
确保以下位置的 Program ID 一致：
1. `Anchor.toml` 中的 `[programs.devnet]`
2. `src/lib.rs` 中的 `declare_id!()`
3. `target/deploy/seth_bridge-keypair.json` 对应的公钥

## 自动化部署脚本

创建 `scripts/deploy-devnet.sh`:
```bash
#!/bin/bash
set -e

echo "Building..."
anchor build

echo "Deploying to devnet..."
anchor deploy --provider.cluster devnet

echo "Done!"
```

## 费用估算

- 程序部署费用: 取决于程序大小 (约 5-10 SOL)
- 测试网免费通过空投获取

## 下一步

部署成功后:
1. 更新 relayer 配置中的 `SOLANA_PROGRAM_ID`
2. 使用 Anchor IDL 与前端集成
3. 调用初始化指令设置桥接参数