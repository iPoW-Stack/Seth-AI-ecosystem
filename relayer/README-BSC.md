# BSC-Solana 跨链桥 Relayer

基于原有的 Seth-Solana 跨链桥，新增 BSC 测试网版本，用于在 BSC 测试网不稳定时进行测试。

## 版本说明

| 版本 | 文件 | 说明 | 适用场景 |
|------|------|------|---------|
| V1 | `bsc-relayer.js` | 基础版本 | 低并发、简单测试 |
| V2 | `bsc-relayer-v2.js` | 高并发版本 | 生产环境、大量用户 |

## 目录结构

```
relayer/
├── relayer.js           # Seth-Solana 跨链桥 (原版本)
├── sethClient.js        # Seth 链客户端 (原版本)
├── bsc-relayer.js       # BSC-Solana 跨链桥 V1 (基础版本)
├── bsc-relayer-v2.js    # BSC-Solana 跨链桥 V2 (高并发版本)
├── bscClient.js         # BSC 测试网客户端
├── .env.example         # Seth 版本配置示例
├── .env.bsc.example     # BSC 版本配置示例
└── db/
    └── database.js      # 共用的数据库模块
```

## 快速开始

### 1. 安装依赖

```bash
cd relayer
npm install
```

### 2. 配置 BSC Relayer

```bash
# 复制配置文件
cp .env.bsc.example .env.bsc

# 编辑配置文件
# 填入你的私钥和合约地址
nano .env.bsc
```

### 3. 创建数据库

```bash
# 创建 PostgreSQL 数据库
createdb -U postgres bridge_relayer_bsc

# 初始化数据库表
psql -U postgres -d bridge_relayer_bsc -f db/init.sql
```

### 4. 获取测试网 tBNB

从 BSC 测试网水龙头获取 tBNB:
- https://testnet.binance.org/faucet-smart
- https://testnet.bscscan.com/faucet

### 5. 启动 Relayer

```bash
# 启动 BSC V1 版本 (基础版)
npm run start:bsc

# 启动 BSC V2 版本 (高并发版)
npm run start:bsc:v2

# 或使用开发模式 (自动重启)
npm run dev:bsc      # V1
npm run dev:bsc:v2   # V2
```

## V2 高并发版本特性

### 架构设计

```
                    ┌─────────────────────┐
                    │   Solana 区块链     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   事件监听器 (WS+轮询) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    限流器 (RateLimiter)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   消息队列 (MessageQueue)  │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
    ┌─────▼─────┐       ┌─────▼─────┐       ┌─────▼─────┐
    │  Worker 0 │       │  Worker 1 │       │  Worker N │
    └─────┬─────┘       └─────┬─────┘       └─────┬─────┘
          │                    │                    │
          └────────────────────┼────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Nonce 管理器 (NonceManager) │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │     BSC 区块链      │
                    └─────────────────────┘
```

### 核心组件

| 组件 | 类名 | 功能 |
|------|------|------|
| 消息队列 | `MessageQueue` | 内存队列 + 死信队列 |
| Nonce 管理器 | `NonceManager` | 防止 nonce 冲突 |
| 限流器 | `RateLimiter` | 令牌桶限流 |
| 工作池 | Worker Pool | 多 worker 并发处理 |

### 高并发配置

```env
# .env.bsc

# Worker 数量（并发处理线程）
WORKER_COUNT=5

# 内存队列大小
QUEUE_SIZE=1000

# 同时发送的交易数量
TX_CONCURRENCY=3

# 每秒最大轮询数
MAX_POLL_RATE=100

# Solana 交易获取并发数
SOLANA_FETCH_CONCURRENCY=5

# 健康检查间隔 (毫秒)
HEALTH_CHECK_INTERVAL=10000
```

### 容错机制

1. **消息持久化**: 所有消息先存入数据库，再进入内存队列
2. **死信队列**: 永久失败的消息移入死信队列，不丢失
3. **自动重试**: 可配置重试次数和指数退避
4. **Nonce 管理**: 自动刷新 nonce，防止交易冲突
5. **健康检查**: 定期检查系统状态并告警
6. **优雅关闭**: 等待正在处理的交易完成后关闭

## 配置说明

### BSC 测试网配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| BSC_RPC_URL | BSC 测试网 RPC URL | https://data-seed-prebsc-1-s1.binance.org:8545/ |
| BSC_BRIDGE_ADDRESS | BSC 桥合约地址 | - |
| RELAYER_PRIVATE_KEY | Relayer 私钥 | - |
| BSC_INJECT_NATIVE_WEI | 注入的 BNB 数量 (wei) | 1 |
| BSC_GAS_LIMIT | Gas Limit | 300000 |
| BSC_GAS_PRICE | Gas Price (留空自动获取) | - |

### Solana 配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| SOLANA_RPC_URL | Solana RPC URL | https://api.devnet.solana.com |
| SOLANA_PROGRAM_ID | Solana Bridge Program ID | - |
| SOLANA_POLL_INTERVAL | 轮询间隔 (ms) | 5000 |

### 数据库配置

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| DB_HOST | 数据库主机 | localhost |
| DB_PORT | 数据库端口 | 5432 |
| DB_NAME | 数据库名称 | bridge_relayer_bsc |
| DB_USER | 数据库用户 | postgres |
| DB_PASSWORD | 数据库密码 | - |

## BSC 测试网信息

- **Chain ID**: 97
- **RPC URLs**:
  - https://data-seed-prebsc-1-s1.binance.org:8545/
  - https://data-seed-prebsc-2-s1.binance.org:8545/
  - https://bsc-testnet.public.blastapi.io
  - https://bsc-testnet.publicnode.com
- **区块浏览器**: https://testnet.bscscan.com/

## 与 Seth 版本的区别

| 特性 | Seth 版本 | BSC 版本 |
|------|-----------|----------|
| 链类型 | 自定义链 | 标准 EVM 链 |
| 交易格式 | 自定义格式 | 标准 EVM 格式 |
| 客户端 | sethClient.js | bscClient.js (ethers.js) |
| 配置文件 | .env | .env.bsc |
| 数据库 | bridge_relayer | bridge_relayer_bsc |

## 代理支持

如果需要通过 HTTP 代理访问 BSC 或 Solana RPC：

```env
# .env.bsc
BSC_HTTP_PROXY=http://127.0.0.1:7890
SOLANA_HTTP_PROXY=http://127.0.0.1:7890
```

## 监控和日志

### V1 日志示例

```
[BscRelayer] Initializing...
[BscRelayer] Solana connection established
[BscRelayer] BSC client initialized
[BscRelayer] Relayer address: 0x...
[BscRelayer] Started successfully
```

### V2 日志示例

```
[RelayerV2] Initializing high-concurrency relayer...
[RelayerV2] Worker pool initialized with 5 workers
[RelayerV2] Configuration:
  - Workers: 5
  - Queue size: 1000
  - TX concurrency: 3
[RelayerV2] Started successfully
[Worker0] Processing: 5abc123...
[Worker0] TX sent: 0x...
[Worker0] Completed in 2340ms: 0x...
[HealthCheck] OK - Block: 12345678, Queue: 5, Active: 2, Balance: 1.5000 tBNB
[RelayerV2] === Stats Report ===
  Uptime: 1h 30m
  Processed: 156
  Failed: 2
  Revenue: 1560.00 USDC
  Avg Process Time: 2100ms
```

## 性能调优建议

### 低负载场景 (< 10 TPS)
- `WORKER_COUNT=3`
- `TX_CONCURRENCY=2`
- `QUEUE_SIZE=100`

### 中等负载 (10-50 TPS)
- `WORKER_COUNT=5`
- `TX_CONCURRENCY=3`
- `QUEUE_SIZE=500`

### 高负载场景 (> 50 TPS)
- `WORKER_COUNT=10`
- `TX_CONCURRENCY=5`
- `QUEUE_SIZE=1000`
- 考虑增加数据库连接池大小

## 常见问题

### 1. 连接 BSC 失败

BSC 测试网 RPC 可能不稳定，系统会自动尝试备用 RPC。如果所有 RPC 都失败，请：
- 配置代理
- 稍后重试
- 使用私有 RPC 节点

### 2. Nonce 冲突

V2 版本已内置 Nonce 管理器，自动处理 nonce 冲突。如果仍有问题：
- 增加 `TX_CONCURRENCY` 不超过 5
- 检查是否有其他程序使用同一账户

### 3. 队列堆积

如果内存队列持续增长：
- 增加 `WORKER_COUNT`
- 增加 `TX_CONCURRENCY`
- 检查 BSC 网络状况

### 4. 交易失败

检查以下项目：
- 合约地址是否正确
- Relayer 是否有足够的权限
- Gas 设置是否合理
- 余额是否充足

## 安全注意事项

1. **私钥安全**: 不要将私钥提交到代码库
2. **数据库安全**: 使用强密码保护 PostgreSQL
3. **网络安全**: 考虑使用防火墙限制数据库访问
4. **测试网代币**: 只在测试网上使用测试代币
5. **监控告警**: 设置余额过低告警