# Seth-Solana Bridge 部署指南

本文档介绍如何在 Solana 链上部署 DIRM 代币、Bridge 和分账合约。

## 前置要求

### 1. 安装 Solana CLI

```bash
# macOS / Linux
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# 配置环境变量
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 验证安装
solana --version
```

### 2. 安装 Anchor

```bash
# 使用 AVM (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

# 安装最新版本
avm install 0.29.0
avm use 0.29.0

# 验证安装
anchor --version
```

### 3. 安装 Node.js 依赖

```bash
cd contracts/solana
npm install
```

## 配置

### 1. 配置 Solana 网络

```bash
# 开发网
solana config set --url devnet

# 主网
# solana config set --url mainnet-beta
```

### 2. 配置部署者密钥

部署者密钥已配置在 `deployer-keypair.json`。

**⚠️ 重要：主网部署前请更换为新的安全密钥！**

```bash
# 查看部署者地址
solana-keygen pubkey ./deployer-keypair.json
```

### 3. 获取 SOL (开发网)

```bash
# 请求空投
solana airdrop 2 $(solana-keygen pubkey ./deployer-keypair.json)

# 查看余额
solana balance
```

## 部署步骤

### 步骤 1: 构建 Anchor 程序

```bash
cd contracts/solana

# 构建
anchor build

# 验证构建
ls target/verifier/seth-bridge.so
```

### 步骤 2: 获取程序 ID

```bash
# 生成新的程序 keypair (首次部署)
solana-keygen new -o target/deploy/seth_bridge-keypair.json --no-passphrase

# 获取程序 ID
anchor keys list

# 更新 Anchor.toml 和 src/lib.rs 中的程序 ID
```

### 步骤 3: 部署程序

```bash
# 部署到 devnet
anchor deploy --provider.cluster devnet

# 部署到 mainnet
# anchor deploy --provider.cluster mainnet
```

### 步骤 4: 创建 DIRM 代币

```bash
# 创建 DIRM 代币
npm run dirm:create

# 或手动执行
node scripts/create-dirm.js
```

输出示例：
```
DIRM Mint: xxxxx...
部署者账户: xxxxx...
```

### 步骤 5: 完整部署 (可选)

运行完整部署脚本，包括：
- 创建 DIRM 代币
- 创建必要账户
- 初始化 Bridge

```bash
npm run deploy:full
```

## 分账配置

Bridge 部署后会自动配置 15-50-35 分账：

```
总金额 (100%)
    │
    ├── 15% 推广佣金 (实时分发)
    │   ├── 10% → L1 推荐人
    │   └── 5%  → L2 推荐人
    │
    ├── 50% 运营储备 (月底清算)
    │   ├── 5%  → 团队激励钱包
    │   └── 45% → 项目方多签钱包
    │
    └── 35% 生态资金 (跨链到 Seth)
        └── → Seth Treasury
```

## 部署后配置

### 1. 更新 Relayer 配置

在 `relayer/.env` 中更新：

```env
SOLANA_PROGRAM_ID=<部署后的程序ID>
SOLANA_RPC_URL=https://api.devnet.solana.com
SETH_TREASURY_ADDRESS=<Seth Treasury 地址>
```

### 2. 设置 Seth Treasury 地址

```bash
# 使用 Anchor CLI
anchor run set-treasury -- --treasury <Seth Treasury 地址>
```

### 3. 配置推荐关系系统

用户可以通过调用 `set_referrer` 指令设置推荐人。

## 测试

### 本地测试

```bash
# 启动本地测试网
solana-test-validator

# 运行测试
anchor test --skip-local-validator
```

### 开发网测试

```bash
anchor test --provider.cluster devnet
```

## 验证部署

```bash
# 检查程序是否部署成功
solana program show <PROGRAM_ID>

# 检查账户状态
spl-token accounts --owner <DEPLOYER_ADDRESS>
```

## 升级

```bash
# 构建新版本
anchor build

# 升级程序
solana program deploy target/verifier/seth-bridge.so \
    --program-id target/deploy/seth_bridge-keypair.json \
    --upgrade-authority ./deployer-keypair.json
```

## 安全注意事项

1. **密钥保护**: 永远不要将私钥提交到代码库
2. **主网部署前**: 更换所有密钥为多签或硬件钱包
3. **权限管理**: 设置合理的 upgrade authority
4. **审计**: 主网部署前进行安全审计

## 故障排除

### 构建失败

```bash
# 清理并重新构建
anchor clean
anchor build
```

### 部署失败 - 余额不足

```bash
# 检查余额
solana balance

# 请求空投 (开发网)
solana airdrop 2
```

### 程序 ID 不匹配

```bash
# 重新生成 keypair
rm target/deploy/seth_bridge-keypair.json
anchor keys list

# 更新代码中的程序 ID
```

## 文件结构

```
contracts/solana/
├── Anchor.toml              # Anchor 配置
├── Cargo.toml               # Rust 项目配置
├── deployer-keypair.json    # 部署者密钥 (⚠️ 主网前更换)
├── package.json             # Node.js 依赖
├── src/
│   ├── lib.rs               # 主程序入口
│   ├── constants.rs         # 常量定义
│   ├── errors.rs            # 错误定义
│   ├── events.rs            # 事件定义
│   ├── state.rs             # 数据结构
│   ├── bridge.rs            # Bridge 模块
│   └── revenue.rs           # Revenue 分账模块
├── scripts/
│   ├── deploy.js            # 完整部署脚本
│   └── create-dirm.js       # DIRM 代币创建脚本
└── target/                   # 构建输出
    ├── deploy/
    ├── idl/
    └── verifier/
```

## 联系支持

如有问题，请联系开发团队或在 GitHub 提交 Issue。