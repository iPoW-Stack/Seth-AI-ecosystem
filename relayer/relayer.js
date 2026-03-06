require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { ethers } = require('ethers');
const bs58 = require('bs58');
const Database = require('./db/database');

// ==================== 消息类型定义 ====================
const MESSAGE_TYPES = {
    CROSS_CHAIN_TRANSFER: 1,    // 普通跨链转账
    REVENUE_SETTLEMENT: 2,      // 收入分账 (15-50-35)
    TUITION_PAYMENT: 3,         // 博士学费支付
    REFERRAL_SETUP: 4,          // 设置推荐关系
    MONTHLY_SETTLEMENT: 5,      // 月底清算
};

// 产品类型
const PRODUCT_TYPES = {
    CLOUD_MINING: 1,            // 云算力
    DOCTORATE_TUITION: 2,       // 博士学费
    SMART_DEVICE: 3,            // 智能设备
};

// ==================== 配置 ====================
const CONFIG = {
    // Solana 配置
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        commitment: 'confirmed',
        pollInterval: parseInt(process.env.SOLANA_POLL_INTERVAL) || 5000,
    },
    // Seth 配置
    seth: {
        rpcUrl: process.env.SETH_RPC_URL,
        bridgeAddress: process.env.SETH_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
        chainId: parseInt(process.env.SETH_CHAIN_ID) || 1,
    },
    // 数据库配置
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'bridge_relayer',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS) || 10,
    },
    // Relayer 配置
    relayer: {
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryInterval: parseInt(process.env.RETRY_INTERVAL) || 60000, // 1分钟
        batchSize: parseInt(process.env.BATCH_SIZE) || 10,
        confirmations: parseInt(process.env.SETH_CONFIRMATIONS) || 1,
    }
};

// Seth 合约 ABI
const BRIDGE_ABI = [
    "function injectEcosystemFunds(bytes32 solanaTxSig, uint256 amountSUSDC, uint256 amountSETH) external payable",
    "function executeUnlock(bytes32 solanaTxSig, address recipient, uint256 amount) external",
    "function processedTxs(bytes32) external view returns (bool)",
    "function trustedRelayer() external view returns (address)",
    "function poolB() external view returns (address)",
    "function getBridgeState() external view returns (uint256, uint256, uint256)"
];

// PoolB 合约 ABI (获取 SETH 价格)
const POOLB_ABI = [
    "function getPrice() external view returns (uint256)",
    "function getPoolState() external view returns (uint256, uint256, uint256, uint256, uint256, uint256, uint256)"
];

// ==================== Relayer 类 ====================
class BridgeRelayer {
    constructor() {
        this.db = null;
        this.solanaConn = null;
        this.sethProvider = null;
        this.sethWallet = null;
        this.bridgeContract = null;
        this.isRunning = false;
        this.isShuttingDown = false;
        this.retryTimer = null;
        this.pollTimer = null;
        this.settlementTimer = null;    // 月底清算定时器
        this.stats = {
            totalProcessed: 0,
            totalFailed: 0,
            totalRevenueProcessed: 0,   // 总处理收入
            totalCommissionDistributed: 0, // 总分发佣金
            lastProcessedAt: null
        };
    }

    /**
     * 初始化 Relayer
     */
    async initialize() {
        console.log('[Relayer] Initializing...');
        
        // 1. 初始化数据库
        this.db = new Database(CONFIG.database);
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }

        // 2. 初始化 Solana 连接
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, CONFIG.solana.commitment);
        console.log('[Relayer] Solana connection established');

        // 3. 初始化 Seth 连接
        this.sethProvider = new ethers.providers.JsonRpcProvider(CONFIG.seth.rpcUrl);
        this.sethWallet = new ethers.Wallet(CONFIG.seth.privateKey, this.sethProvider);
        this.bridgeContract = new ethers.Contract(
            CONFIG.seth.bridgeAddress, 
            BRIDGE_ABI, 
            this.sethWallet
        );

        // 4. 验证 Relayer 权限
        const trustedRelayer = await this.bridgeContract.trustedRelayer();
        if (trustedRelayer.toLowerCase() !== this.sethWallet.address.toLowerCase()) {
            throw new Error(`Relayer address mismatch. Expected: ${trustedRelayer}, Got: ${this.sethWallet.address}`);
        }
        console.log(`[Relayer] Seth connection established. Relayer: ${this.sethWallet.address}`);

        // 5. 更新数据库中的 Relayer 状态
        await this.db.updateRelayerStatus({
            relayerAddress: this.sethWallet.address
        });

        console.log('[Relayer] Initialization complete');
    }

    /**
     * 启动 Relayer
     */
    async start() {
        if (this.isRunning) {
            console.log('[Relayer] Already running');
            return;
        }

        this.isRunning = true;
        this.isShuttingDown = false;
        
        console.log('[Relayer] Starting...');
        console.log(`[Relayer] Listening to Solana Program: ${CONFIG.solana.programId}`);

        await this.db.setRelayerActive(true);

        // 启动 Solana 事件监听
        this.startSolanaListener();

        // 启动重试调度器
        this.startRetryScheduler();

        // 启动统计报告
        this.startStatsReporter();

        // 处理启动时可能遗留的待处理消息
        await this.processPendingMessages();

        console.log('[Relayer] Started successfully');
    }

    /**
     * 停止 Relayer
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        console.log('[Relayer] Stopping...');
        this.isShuttingDown = true;
        this.isRunning = false;

        // 停止定时器
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        await this.db.setRelayerActive(false);
        console.log('[Relayer] Stopped');
    }

    /**
     * 优雅关闭
     */
    async shutdown() {
        console.log('[Relayer] Initiating graceful shutdown...');
        await this.stop();
        await this.db.close();
        console.log('[Relayer] Shutdown complete');
    }

    // ==================== Solana 监听 ====================

    /**
     * 启动 Solana 事件监听
     */
    startSolanaListener() {
        const programId = new PublicKey(CONFIG.solana.programId);
        
        // 使用 onLogs 监听程序日志
        this.solanaConn.onLogs(
            programId,
            async (logs, ctx) => {
                if (this.isShuttingDown) return;
                await this.handleSolanaLogs(logs, ctx);
            },
            CONFIG.solana.commitment
        );

        // 同时使用轮询作为备份机制
        this.pollTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.pollSolanaTransactions();
        }, CONFIG.solana.pollInterval);
    }

    /**
     * 处理 Solana 日志
     */
    async handleSolanaLogs(logs, ctx) {
        try {
            // 过滤错误交易
            if (logs.err) {
                return;
            }

            const logString = logs.logs.join(' ');
            
            // 检查是否包含 CrossChainLock 事件
            if (!logString.includes('CrossChainLock') && !logString.includes('Program data:')) {
                return;
            }

            const txSignature = ctx.signature;
            console.log(`[Relayer] Detected potential cross-chain tx: ${txSignature}`);

            // 检查是否已处理
            const alreadyProcessed = await this.db.isProcessed(txSignature);
            if (alreadyProcessed) {
                console.log(`[Relayer] Transaction ${txSignature} already processed`);
                return;
            }

            // 解析交易详情
            const messageData = await this.parseSolanaTransaction(txSignature);
            if (!messageData) {
                console.warn(`[Relayer] Failed to parse transaction: ${txSignature}`);
                return;
            }

            // 存储到数据库
            const savedMessage = await this.db.insertMessage(messageData);
            if (savedMessage) {
                console.log(`[Relayer] Saved new message: ${txSignature} -> ${messageData.recipientEth}`);
                await this.db.logOperation(savedMessage.id, 'detect', { txSignature });
                
                // 立即处理新消息
                await this.processMessage(savedMessage);
            }

        } catch (error) {
            console.error('[Relayer] Error handling Solana logs:', error.message);
        }
    }

    /**
     * 轮询 Solana 交易（备份机制）
     */
    async pollSolanaTransactions() {
        try {
            const status = await this.db.getRelayerStatus();
            const programId = new PublicKey(CONFIG.solana.programId);
            
            // 获取最近的签名
            const signatures = await this.solanaConn.getSignaturesForAddress(
                programId,
                {
                    limit: 10,
                    until: status?.last_processed_signature || undefined
                },
                CONFIG.solana.commitment
            );

            for (const sig of signatures.reverse()) {
                if (sig.err) continue;
                
                const alreadyProcessed = await this.db.isProcessed(sig.signature);
                if (alreadyProcessed) continue;

                const messageData = await this.parseSolanaTransaction(sig.signature);
                if (!messageData) continue;

                const savedMessage = await this.db.insertMessage(messageData);
                if (savedMessage) {
                    console.log(`[Relayer] Polled new message: ${sig.signature}`);
                    await this.db.logOperation(savedMessage.id, 'detect', { source: 'poll' });
                    await this.processMessage(savedMessage);
                }

                // 更新最后处理的签名
                await this.db.updateRelayerStatus({
                    lastProcessedSignature: sig.signature
                });
            }
        } catch (error) {
            console.error('[Relayer] Error polling Solana transactions:', error.message);
        }
    }

    /**
     * 解析 Solana 交易
     */
    async parseSolanaTransaction(txSignature) {
        try {
            const txDetails = await this.solanaConn.getParsedTransaction(
                txSignature, 
                { maxSupportedTransactionVersion: 0 }
            );

            if (!txDetails || !txDetails.meta) {
                return null;
            }

            // 提取事件数据
            // Anchor 事件格式：Program log: <base64 encoded data>
            let amount = null;
            let recipientEth = null;
            let senderSolana = null;

            // 解析日志中的事件数据
            const logMessages = txDetails.meta.logMessages || [];
            for (const log of logMessages) {
                // 尝试解析 Anchor 事件
                // 格式: Program log: <base64 data>
                if (log.includes('Program log:')) {
                    const base64Data = log.split('Program log:')[1]?.trim();
                    if (base64Data) {
                        try {
                            // 解析事件数据
                            const eventData = this.parseAnchorEvent(base64Data);
                            if (eventData) {
                                amount = eventData.amount || amount;
                                recipientEth = eventData.recipientEth || recipientEth;
                                senderSolana = eventData.sender || senderSolana;
                            }
                        } catch (e) {
                            // 忽略解析错误
                        }
                    }
                }

                // 尝试从日志文本中提取
                // 示例格式: "CrossChainLock: amount=1000000, recipient=0x..."
                if (log.includes('CrossChainLock')) {
                    const amountMatch = log.match(/amount[=:\s]+(\d+)/i);
                    const recipientMatch = log.match(/recipient[=:\s]+(0x[a-fA-F0-9]{40})/i);
                    
                    if (amountMatch) amount = BigInt(amountMatch[1]);
                    if (recipientMatch) recipientEth = recipientMatch[1];
                }
            }

            // 从交易账户中获取发送者
            if (!senderSolana && txDetails.transaction?.message?.accountKeys?.length > 0) {
                senderSolana = txDetails.transaction.message.accountKeys[0].pubkey?.toString() || 
                               txDetails.transaction.message.accountKeys[0].toString();
            }

            // 如果没有从日志中解析到数据，尝试从指令数据中解析
            if (!amount || !recipientEth) {
                const parsedData = this.parseInstructionData(txDetails);
                if (parsedData) {
                    amount = parsedData.amount || amount;
                    recipientEth = parsedData.recipientEth || recipientEth;
                    senderSolana = parsedData.sender || senderSolana;
                }
            }

            if (!amount || !recipientEth) {
                console.warn(`[Relayer] Could not parse amount/recipient from ${txSignature}`);
                return null;
            }

            // 转换 Solana 签名为 bytes32
            const sigBytes = bs58.decode(txSignature);
            const solanaTxSigBytes32 = ethers.utils.keccak256(
                ethers.utils.hexZeroPad(ethers.utils.hexlify(sigBytes), 32)
            );

            return {
                solanaTxSig: txSignature,
                solanaTxSigBytes32,
                amount: amount.toString(),
                recipientEth,
                senderSolana: senderSolana || 'unknown',
                solanaBlockTime: txDetails.blockTime
            };

        } catch (error) {
            console.error(`[Relayer] Error parsing transaction ${txSignature}:`, error.message);
            return null;
        }
    }

    /**
     * 解析 Anchor 事件数据
     */
    parseAnchorEvent(base64Data) {
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Anchor 事件格式：
            // 前8字节是事件discriminator
            // 后面是事件数据
            if (buffer.length < 8) return null;

            // 读取事件数据
            let offset = 8;
            
            // CrossChainLock 事件结构：
            // amount: u64 (8 bytes)
            // recipient_eth: [u8; 20] (20 bytes)
            // sender: Pubkey (32 bytes)
            
            // 注意：实际解析需要根据 Anchor IDL 进行
            // 这里提供基本框架
            
            if (buffer.length >= offset + 8 + 20) {
                const amount = buffer.readBigUInt64LE(offset);
                offset += 8;
                
                const recipientEthBytes = buffer.slice(offset, offset + 20);
                const recipientEth = '0x' + recipientEthBytes.toString('hex');
                offset += 20;
                
                // 可能需要读取更多数据
                
                return {
                    amount: amount.toString(),
                    recipientEth
                };
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 从指令数据中解析
     */
    parseInstructionData(txDetails) {
        try {
            const instructions = txDetails.transaction?.message?.instructions || [];
            
            for (const ix of instructions) {
                // 查找目标程序的指令
                if (ix.programId?.toString() === CONFIG.solana.programId) {
                    const data = Buffer.from(ix.data, 'base64');
                    
                    // Anchor 指令格式：
                    // 前8字节是指令discriminator
                    // 后面是指令参数
                    
                    if (data.length >= 8 + 8 + 20) {
                        let offset = 8; // 跳过 discriminator
                        
                        const amount = data.readBigUInt64LE(offset);
                        offset += 8;
                        
                        const recipientEthBytes = data.slice(offset, offset + 20);
                        const recipientEth = '0x' + recipientEthBytes.toString('hex');
                        
                        return {
                            amount: amount.toString(),
                            recipientEth
                        };
                    }
                }
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    // ==================== 消息处理 ====================

    /**
     * 处理待处理消息
     */
    async processPendingMessages() {
        try {
            const messages = await this.db.getPendingMessages(CONFIG.relayer.batchSize);
            console.log(`[Relayer] Found ${messages.length} pending messages`);

            for (const message of messages) {
                if (this.isShuttingDown) break;
                await this.processMessage(message);
            }
        } catch (error) {
            console.error('[Relayer] Error processing pending messages:', error.message);
        }
    }

    /**
     * 处理单条消息 - 注入 35% 生态资金到 PoolB
     */
    async processMessage(message) {
        const { id, solana_tx_sig, solana_tx_sig_bytes32, amount, recipient_eth } = message;

        try {
            // 标记为处理中
            await this.db.markAsProcessing(id);
            await this.db.logOperation(id, 'process', { attempt: message.retry_count + 1 });

            console.log(`[Relayer] Processing message ${id}: ${solana_tx_sig}`);
            console.log(`[Relayer]   Amount: ${amount} (35% ecosystem funds)`);

            // 检查合约是否已处理（可能被其他relayer处理了）
            const alreadyProcessedOnChain = await this.bridgeContract.processedTxs(solana_tx_sig_bytes32);
            if (alreadyProcessedOnChain) {
                console.log(`[Relayer] Message ${id} already processed on chain`);
                await this.db.markAsCompleted(id, { txHash: null, blockNumber: null });
                return;
            }

            // 获取 PoolB 价格来计算需要的 SETH 数量
            const poolBAddress = await this.bridgeContract.poolB();
            const poolBContract = new ethers.Contract(poolBAddress, POOLB_ABI, this.sethProvider);
            
            // 获取当前 SETH 价格 (1 SETH = ? sUSDC)
            const sethPrice = await poolBContract.getPrice();
            console.log(`[Relayer] Current SETH price: ${ethers.utils.formatEther(sethPrice)} sUSDC`);
            
            // 计算需要的 SETH 数量：amountSETH = amountSUSDC / price
            // 这里我们注入等值的 SETH（1:1 价值比例）
            const amountSUSDC = ethers.BigNumber.from(amount);
            const amountSETH = amountSUSDC.mul(ethers.utils.parseEther("1")).div(sethPrice);
            
            console.log(`[Relayer] Injecting to PoolB:`);
            console.log(`[Relayer]   sUSDC: ${ethers.utils.formatEther(amountSUSDC)}`);
            console.log(`[Relayer]   SETH: ${ethers.utils.formatEther(amountSETH)}`);

            // 检查 Relayer 是否有足够的原生 SETH
            const relayerBalance = await this.sethProvider.getBalance(this.sethWallet.address);
            if (relayerBalance.lt(amountSETH)) {
                throw new Error(`Insufficient SETH balance. Need: ${ethers.utils.formatEther(amountSETH)}, Have: ${ethers.utils.formatEther(relayerBalance)}`);
            }

            // 执行跨链注入到 PoolB
            const tx = await this.bridgeContract.injectEcosystemFunds(
                solana_tx_sig_bytes32,
                amountSUSDC,
                amountSETH,
                {
                    gasLimit: ethers.utils.hexlify(300000),
                    value: amountSETH  // 发送原生 SETH
                }
            );

            console.log(`[Relayer] Seth tx sent: ${tx.hash}`);

            // 等待确认
            const receipt = await tx.wait(CONFIG.relayer.confirmations);

            if (receipt.status === 1) {
                console.log(`[Relayer] Seth tx confirmed: ${tx.hash}`);
                console.log(`[Relayer] Successfully injected ${ethers.utils.formatEther(amountSUSDC)} sUSDC to PoolB`);
                
                await this.db.markAsCompleted(id, {
                    txHash: tx.hash,
                    blockNumber: receipt.blockNumber
                });

                this.stats.totalProcessed++;
                this.stats.totalRevenueProcessed += parseFloat(ethers.utils.formatEther(amountSUSDC));
                this.stats.lastProcessedAt = new Date();
            } else {
                throw new Error('Transaction reverted on chain');
            }

        } catch (error) {
            console.error(`[Relayer] Error processing message ${id}:`, error.message);
            
            this.stats.totalFailed++;
            
            // 检查是否是可重试的错误
            const isRetryable = this.isRetryableError(error);
            
            if (isRetryable) {
                const result = await this.db.markAsFailed(id, error.message, CONFIG.relayer.maxRetries);
                console.log(`[Relayer] Message ${id} marked for retry (${result.retry_count}/${CONFIG.relayer.maxRetries})`);
            } else {
                // 不可重试的错误，直接标记为失败
                await this.db.markAsFailed(id, `Non-retryable: ${error.message}`, 0);
                console.log(`[Relayer] Message ${id} marked as permanently failed`);
            }
        }
    }

    /**
     * 判断错误是否可重试
     */
    isRetryableError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        
        // 不可重试的错误
        const nonRetryablePatterns = [
            'already processed',
            'transaction already processed',
            'invalid recipient',
            'invalid amount',
            'insufficient funds',
            'nonce too low',
        ];

        for (const pattern of nonRetryablePatterns) {
            if (errorMessage.includes(pattern)) {
                return false;
            }
        }

        // 可重试的错误
        const retryablePatterns = [
            'network',
            'timeout',
            'connection',
            'rate limit',
            'gas price',
            'replacement transaction',
            'nonce too high',
            'underpriced',
        ];

        for (const pattern of retryablePatterns) {
            if (errorMessage.includes(pattern)) {
                return true;
            }
        }

        // 默认可重试
        return true;
    }

    // ==================== 重试调度器 ====================

    /**
     * 启动重试调度器
     */
    startRetryScheduler() {
        this.retryTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.processRetries();
        }, CONFIG.relayer.retryInterval);

        console.log('[Relayer] Retry scheduler started');
    }

    /**
     * 处理待重试的消息
     */
    async processRetries() {
        try {
            const messages = await this.db.getPendingRetries(CONFIG.relayer.batchSize);
            
            if (messages.length === 0) {
                return;
            }

            console.log(`[Relayer] Processing ${messages.length} retry messages`);

            for (const message of messages) {
                if (this.isShuttingDown) break;
                
                console.log(`[Relayer] Retrying message ${message.id} (attempt ${message.retry_count + 1})`);
                await this.db.logOperation(message.id, 'retry', { attempt: message.retry_count + 1 });
                await this.processMessage(message);
            }
        } catch (error) {
            console.error('[Relayer] Error processing retries:', error.message);
        }
    }

    // ==================== 统计报告 ====================

    /**
     * 启动统计报告
     */
    startStatsReporter() {
        setInterval(async () => {
            if (this.isShuttingDown) return;
            
            try {
                const dbStats = await this.db.getStats();
                console.log('[Relayer] Stats:', {
                    ...dbStats,
                    sessionProcessed: this.stats.totalProcessed,
                    sessionFailed: this.stats.totalFailed,
                    lastProcessed: this.stats.lastProcessedAt
                });
            } catch (error) {
                console.error('[Relayer] Error getting stats:', error.message);
            }
        }, 60000); // 每分钟报告一次
    }
}

// ==================== 主程序入口 ====================

async function main() {
    const relayer = new BridgeRelayer();

    // 处理进程信号
    process.on('SIGINT', async () => {
        console.log('\n[Relayer] Received SIGINT');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n[Relayer] Received SIGTERM');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('uncaughtException', (error) => {
        console.error('[Relayer] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[Relayer] Unhandled rejection at:', promise, 'reason:', reason);
    });

    try {
        await relayer.initialize();
        await relayer.start();
    } catch (error) {
        console.error('[Relayer] Failed to start:', error);
        process.exit(1);
    }
}

// 如果直接运行此文件
if (require.main === module) {
    main();
}

module.exports = BridgeRelayer;