/**
 * Seth-Solana 跨链桥 Relayer
 * 
 * 采用 TrustRelayer 安全模型
 * Seth 链使用自定义交易格式（无 chainId）
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const Database = require('./db/database');
const SethClient = require('./sethClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');

// ==================== 配置 ====================
const CONFIG = {
    // Solana 配置
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        commitment: 'confirmed',
        pollInterval: parseInt(process.env.SOLANA_POLL_INTERVAL) || 5000,
    },
    // Seth 配置 (使用自定义客户端)
    seth: {
        host: process.env.SETH_HOST || '35.184.150.163',
        port: parseInt(process.env.SETH_PORT) || 23001,
        bridgeAddress: process.env.SETH_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
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
        retryInterval: parseInt(process.env.RETRY_INTERVAL) || 60000,
        batchSize: parseInt(process.env.BATCH_SIZE) || 10,
    }
};

// ==================== Relayer 类 ====================
class BridgeRelayer {
    constructor() {
        this.db = null;
        this.solanaConn = null;
        this.sethClient = null;
        this.relayerAddress = null;
        this.isRunning = false;
        this.isShuttingDown = false;
        this.retryTimer = null;
        this.pollTimer = null;
        this.stats = {
            totalProcessed: 0,
            totalFailed: 0,
            totalRevenueProcessed: 0,
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

        // 3. 初始化 Seth 客户端
        this.sethClient = new SethClient(CONFIG.seth.host, CONFIG.seth.port);
        
        // 从私钥派生地址
        const privateKeyHex = CONFIG.seth.privateKey.startsWith('0x') 
            ? CONFIG.seth.privateKey.slice(2) 
            : CONFIG.seth.privateKey;
        const privateKey = Buffer.from(privateKeyHex, 'hex');
        const pubKeyBytes = secp256k1.publicKeyCreate(privateKey, false);
        this.relayerAddress = this.sethClient.deriveAddressFromPubkey(pubKeyBytes);
        
        console.log(`[Relayer] Seth client initialized`);
        console.log(`[Relayer] Relayer address: ${this.relayerAddress}`);

        // 4. 验证 Relayer 余额
        const balance = await this.sethClient.getBalance(this.relayerAddress);
        console.log(`[Relayer] Relayer balance: ${balance}`);

        // 5. 更新数据库中的 Relayer 状态
        await this.db.updateRelayerStatus({
            relayerAddress: this.relayerAddress
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
        if (!this.isRunning) return;

        console.log('[Relayer] Stopping...');
        this.isShuttingDown = true;
        this.isRunning = false;

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

        console.log('[Relayer] Solana listener started');
    }

    /**
     * 处理 Solana 日志
     */
    async handleSolanaLogs(logs, ctx) {
        try {
            if (logs.err) return;

            const logString = logs.logs.join(' ');
            
            if (!logString.includes('CrossChainLock') && !logString.includes('Program data:')) {
                return;
            }

            const txSignature = ctx.signature;
            console.log(`[Relayer] Detected potential cross-chain tx: ${txSignature}`);

            const alreadyProcessed = await this.db.isProcessed(txSignature);
            if (alreadyProcessed) {
                console.log(`[Relayer] Transaction ${txSignature} already processed`);
                return;
            }

            const messageData = await this.parseSolanaTransaction(txSignature);
            if (!messageData) {
                console.warn(`[Relayer] Failed to parse transaction: ${txSignature}`);
                return;
            }

            const savedMessage = await this.db.insertMessage(messageData);
            if (savedMessage) {
                console.log(`[Relayer] Saved new message: ${txSignature} -> ${messageData.recipientEth}`);
                await this.db.logOperation(savedMessage.id, 'detect', { txSignature });
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
            
            const signatures = await this.solanaConn.getSignaturesForAddress(
                programId,
                { limit: 10, until: status?.last_processed_signature || undefined },
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

            if (!txDetails || !txDetails.meta) return null;

            let amount = null;
            let recipientEth = null;
            let senderSolana = null;

            const logMessages = txDetails.meta.logMessages || [];
            for (const log of logMessages) {
                if (log.includes('Program log:')) {
                    const base64Data = log.split('Program log:')[1]?.trim();
                    if (base64Data) {
                        try {
                            const eventData = this.parseAnchorEvent(base64Data);
                            if (eventData) {
                                amount = eventData.amount || amount;
                                recipientEth = eventData.recipientEth || recipientEth;
                                senderSolana = eventData.sender || senderSolana;
                            }
                        } catch (e) {}
                    }
                }

                if (log.includes('CrossChainLock')) {
                    const amountMatch = log.match(/amount[=:\s]+(\d+)/i);
                    const recipientMatch = log.match(/recipient[=:\s]+(0x[a-fA-F0-9]{40})/i);
                    
                    if (amountMatch) amount = BigInt(amountMatch[1]);
                    if (recipientMatch) recipientEth = recipientMatch[1];
                }
            }

            if (!senderSolana && txDetails.transaction?.message?.accountKeys?.length > 0) {
                senderSolana = txDetails.transaction.message.accountKeys[0].pubkey?.toString() || 
                               txDetails.transaction.message.accountKeys[0].toString();
            }

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
            const solanaTxSigBytes32 = '0x' + createKeccakHash('keccak256')
                .update(Buffer.concat([Buffer.alloc(32), sigBytes.slice(0, 32)]))
                .digest('hex');

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
            if (buffer.length < 8) return null;

            let offset = 8;
            if (buffer.length >= offset + 8 + 20) {
                const amount = buffer.readBigUInt64LE(offset);
                offset += 8;
                
                const recipientEthBytes = buffer.slice(offset, offset + 20);
                const recipientEth = '0x' + recipientEthBytes.toString('hex');
                
                return { amount: amount.toString(), recipientEth };
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
                if (ix.programId?.toString() === CONFIG.solana.programId) {
                    const data = Buffer.from(ix.data, 'base64');
                    
                    if (data.length >= 8 + 8 + 20) {
                        let offset = 8;
                        const amount = data.readBigUInt64LE(offset);
                        offset += 8;
                        
                        const recipientEthBytes = data.slice(offset, offset + 20);
                        const recipientEth = '0x' + recipientEthBytes.toString('hex');
                        
                        return { amount: amount.toString(), recipientEth };
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
     * 处理单条消息 - 调用 Seth 链桥合约
     */
    async processMessage(message) {
        const { id, solana_tx_sig, solana_tx_sig_bytes32, amount, recipient_eth } = message;

        try {
            await this.db.markAsProcessing(id);
            await this.db.logOperation(id, 'process', { attempt: message.retry_count + 1 });

            console.log(`[Relayer] Processing message ${id}: ${solana_tx_sig}`);
            console.log(`[Relayer]   Amount: ${amount}`);
            console.log(`[Relayer]   Recipient: ${recipient_eth}`);

            // 编码合约调用数据
            // function: markCrossChainCompleted(bytes32 solanaTxSig, address recipient, uint256 amount)
            const inputData = this.encodeMarkCompleted(solana_tx_sig_bytes32, recipient_eth, amount);

            // 使用 SethClient 发送交易
            const result = await this.sethClient.sendContractCall(
                CONFIG.seth.privateKey,
                CONFIG.seth.bridgeAddress.replace('0x', ''),
                inputData,
                { gasLimit: 200000, gasPrice: 1 }
            );

            if (result.success) {
                console.log(`[Relayer] Seth tx sent: ${result.txHash}`);
                console.log(`[Relayer] Response: ${JSON.stringify(result.response)}`);
                
                await this.db.markAsCompleted(id, {
                    txHash: result.txHash,
                    blockNumber: result.nonce
                });

                this.stats.totalProcessed++;
                this.stats.totalRevenueProcessed += parseFloat(amount) / 1e18;
                this.stats.lastProcessedAt = new Date();
                
                console.log(`[Relayer] Successfully processed message ${id}`);
            } else {
                throw new Error(result.error || 'Transaction failed');
            }

        } catch (error) {
            console.error(`[Relayer] Error processing message ${id}:`, error.message);
            
            this.stats.totalFailed++;
            
            const isRetryable = this.isRetryableError(error);
            
            if (isRetryable) {
                const result = await this.db.markAsFailed(id, error.message, CONFIG.relayer.maxRetries);
                console.log(`[Relayer] Message ${id} marked for retry (${result.retry_count}/${CONFIG.relayer.maxRetries})`);
            } else {
                await this.db.markAsFailed(id, `Non-retryable: ${error.message}`, 0);
                console.log(`[Relayer] Message ${id} marked as permanently failed`);
            }
        }
    }

    /**
     * 编码 markCrossChainCompleted 函数调用
     * function markCrossChainCompleted(bytes32 solanaTxSig, address recipient, uint256 amount)
     */
    encodeMarkCompleted(solanaTxSig, recipient, amount) {
        // 移除 0x 前缀
        const sig = solanaTxSig.replace('0x', '');
        const addr = recipient.replace('0x', '').padStart(40, '0');
        const amt = BigInt(amount).toString(16).padStart(64, '0');
        
        // 函数选择器: keccak256("markCrossChainCompleted(bytes32,address,uint256)")[:4]
        const selector = 'a8b3f1c7'; // 需要根据实际合约计算
        
        return selector + sig + addr + amt;
    }

    /**
     * 判断错误是否可重试
     */
    isRetryableError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        
        const nonRetryablePatterns = [
            'already processed',
            'invalid recipient',
            'invalid amount',
            'insufficient funds',
        ];

        for (const pattern of nonRetryablePatterns) {
            if (errorMessage.includes(pattern)) return false;
        }

        const retryablePatterns = [
            'network',
            'timeout',
            'connection',
            'rate limit',
        ];

        for (const pattern of retryablePatterns) {
            if (errorMessage.includes(pattern)) return true;
        }

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
            
            if (messages.length === 0) return;

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
        }, 60000);
    }
}

// ==================== 主程序入口 ====================

async function main() {
    const relayer = new BridgeRelayer();

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
        console.error('[Relayer] Unhandled rejection:', reason);
    });

    try {
        await relayer.initialize();
        await relayer.start();
    } catch (error) {
        console.error('[Relayer] Failed to start:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = BridgeRelayer;