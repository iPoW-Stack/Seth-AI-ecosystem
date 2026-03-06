# Seth-Solana Cross-Chain Bridge Relayer

基于 TrustRelayer 安全模型的 Seth-Solana 跨链桥 Relayer 实现。

## 重要说明

**SETH 是 Seth 链的原生代币（类似 ETH），不是 ERC20 代币。**

- 池B (PoolB) 使用原生 SETH 进行交易
- Treasury 合约通过 `msg.value` 接收和发送原生 SETH
- 用户可以通过 PoolB 买卖原生 SETH

## 分账流程 (15-50-35)

**重要：分账逻辑在 Solana 链上完成**

当用户在 Solana 链上支付 USDC 时：

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
        └── → Relayer → SethBridge.injectEcosystemFunds() → PoolB
```

**35% 生态资金直接注入 PoolB：**
1. Relayer 监听 Solana 的 `RevenueProcessed` 事件
2. 计算需要的 SETH 数量（基于 PoolB 当前价格）
3. 调用 `SethBridge.injectEcosystemFunds()` 注入流动性
4. PoolB 获得 sUSDC + SETH 流动性，支撑 SETH 价格

### Solana 链职责
- 收入归集
- 15-50-35 分账计算
- L1/L2 佣金实时分发
- 月底清算拨付
- 触发 35% 跨链

### Seth 链职责
- 接收 35% 生态资金
- 铸造 sUSDC
- 注入池B支撑 SETH 价格

## 架构概览

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│    Solana       │      │    Relayer      │      │     Seth        │
│  Bridge Program │─────▶│   (Node.js)     │─────▶│  Bridge Contract│
│                 │      │                 │      │                 │
│  - Lock Event   │      │  - Event Listen │      │  - ExecuteUnlock│
│  - SPL Token    │      │  - PostgreSQL   │      │  - Mint sUSDC   │
└─────────────────┘      │  - Retry Logic  │      └─────────────────┘
                         └─────────────────┘
```

## 功能特性

- **事件监听**: 实时监听 Solana Bridge 程序的 CrossChainLock 事件
- **消息持久化**: 使用 PostgreSQL 存储跨链消息，支持断点续传
- **失败重发**: 自动重试失败的消息，支持指数退避策略
- **状态追踪**: 完整的消息状态管理和操作日志
- **优雅关闭**: 支持 SIGINT/SIGTERM 信号处理，确保消息不丢失

## 目录结构

```
relayer/
├── db/
│   ├── init.sql       # 数据库初始化脚本
│   └── database.js    # 数据库操作类
├── relayer.js         # Relayer 主程序
├── package.json       # 项目依赖
├── .env.example       # 环境变量示例
└── README.md          # 本文档
```

## 快速开始

### 1. 安装依赖

```bash
cd relayer
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入实际配置
```

### 3. 初始化数据库

```bash
# 创建数据库
createdb -U postgres bridge_relayer

# 执行初始化脚本
psql -U postgres -d bridge_relayer -f db/init.sql
```

### 4. 启动 Relayer

```bash
# 生产环境
npm start

# 开发环境 (带热重载)
npm run dev
```

## 数据库表结构

### cross_chain_messages (跨链消息表)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| solana_tx_sig | VARCHAR(88) | Solana 交易签名 |
| solana_tx_sig_bytes32 | VARCHAR(66) | 转换后的 bytes32 格式 |
| amount | BIGINT | 跨链金额 |
| recipient_eth | VARCHAR(42) | Seth 接收地址 |
| sender_solana | VARCHAR(44) | Solana 发送者地址 |
| status | VARCHAR(20) | 状态: pending/processing/completed/failed |
| retry_count | INTEGER | 重试次数 |
| max_retries | INTEGER | 最大重试次数 |
| last_error | TEXT | 最后错误信息 |
| seth_tx_hash | VARCHAR(66) | Seth 链交易哈希 |
| seth_block_number | BIGINT | Seth 链区块号 |
| created_at | TIMESTAMP | 创建时间 |
| processed_at | TIMESTAMP | 处理完成时间 |
| next_retry_at | TIMESTAMP | 下次重试时间 |

### relayer_status (Relayer 状态表)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| relayer_address | VARCHAR(42) | Relayer Seth 地址 |
| last_processed_slot | BIGINT | 最后处理的 Solana slot |
| last_processed_signature | VARCHAR(88) | 最后处理的交易签名 |
| is_active | BOOLEAN | 是否活跃 |
| started_at | TIMESTAMP | 启动时间 |
| updated_at | TIMESTAMP | 更新时间 |

### operation_logs (操作日志表)

| 字段 | 类型 | 说明 |
|------|------|------|
| id | SERIAL | 主键 |
| message_id | INTEGER | 关联的消息 ID |
| operation | VARCHAR(50) | 操作类型 |
| details | JSONB | 操作详情 |
| created_at | TIMESTAMP | 创建时间 |

## 消息状态流转

```
                    ┌──────────────┐
                    │   pending    │◀──────────┐
                    └──────┬───────┘           │
                           │                   │
                    处理失败              重试时间到
                           │                   │
                           ▼                   │
                    ┌──────────────┐           │
                    │  processing  │───────────┘
                    └──────┬───────┘
                           │
                     处理成功
                           │
                           ▼
                    ┌──────────────┐
                    │   completed  │
                    └──────────────┘

                    超过最大重试次数
                           │
                           ▼
                    ┌──────────────┐
                    │    failed    │
                    └──────────────┘
```

## 重试策略

Relayer 使用**指数退避**策略进行失败重试：

- 第1次重试: 立即
- 第2次重试: 2分钟后
- 第3次重试: 4分钟后
- 第4次重试: 8分钟后
- 第5次重试: 16分钟后
- 最大等待时间: 30分钟

## 错误分类

### 可重试错误

- 网络超时
- 连接错误
- RPC 限流
- Gas 价格过高
- Nonce 问题

### 不可重试错误

- 交易已处理
- 无效的接收地址
- 无效的金额
- 余额不足

## 监控和日志

Relayer 每分钟输出统计信息：

```
[Relayer] Stats: {
  pending: 0,
  processing: 1,
  completed: 100,
  failed: 2,
  total: 103,
  sessionProcessed: 50,
  sessionFailed: 1,
  lastProcessedAt: 2024-01-15T10:30:00.000Z
}
```

## 安全注意事项

1. **私钥保护**: 永远不要将 `RELAYER_PRIVATE_KEY` 提交到代码库
2. **数据库安全**: 使用强密码保护 PostgreSQL 数据库
3. **网络隔离**: 建议将 Relayer 部署在私有网络中
4. **监控告警**: 设置告警监控 Relayer 状态和失败消息

## 生产部署建议

### 使用 PM2 管理进程

```bash
# 安装 PM2
npm install -g pm2

# 启动
pm2 start relayer.js --name bridge-relayer

# 设置开机自启
pm2 startup
pm2 save
```

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "relayer.js"]
```

### 环境变量管理

推荐使用环境变量管理工具：
- Docker Secrets
- Kubernetes Secrets
- AWS Secrets Manager
- HashiCorp Vault

## 故障恢复

### 重启后恢复

Relayer 重启后会自动：
1. 检查数据库中的待处理消息
2. 处理所有 `pending` 状态的消息
3. 处理需要重试的消息

### 数据备份

定期备份 PostgreSQL 数据库：

```bash
pg_dump -U postgres bridge_relayer > backup.sql
```

## API 扩展

可以通过扩展 Relayer 添加 API 接口：

```javascript
const express = require('express');
const app = express();

app.get('/stats', async (req, res) => {
    const stats = await db.getStats();
    res.json(stats);
});

app.get('/messages/:status', async (req, res) => {
    const messages = await db.getPendingMessages(100);
    res.json(messages);
});
```

## License

MIT