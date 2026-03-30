/**
 * BSC-Solana 高并发跨链桥 Relayer V2
 * 
 * 优化特性：
 * 1. 消息队列机制 - 内存队列 + 数据库持久化
 * 2. 批量处理 - 并发处理多条消息
 * 3. 工作池模式 - 多个 worker 并发处理
 * 4. 限流和背压控制 - 防止系统过载
 * 5. 优雅降级 - 高负载时自动调整
 * 6. 健康检查和监控
 * 7. 死信队列 - 处理永久失败的消息
 * 8. Nonce 管理 - 防止 nonce 冲突
 */

require('dotenv').config({ path: '.env.bsc' });
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const Database = require('./db/database');
const BscClient = require('./bscClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');
const EventEmitter = require('events');

// ==================== 配置 ====================
const CONFIG = {
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        commitment: 'confirmed',
        pollInterval: parseInt(process.env.SOLANA_POLL_INTERVAL) || 3000,
        proxy: process.env.SOLANA_HTTP_PROXY || process.env.SOLANA_PROXY || null,
        // 并发获取交易详情的并发数
        fetchConcurrency: parseInt(process.env.SOLANA_FETCH_CONCURRENCY) || 5,
    },
    bsc: {
        rpcUrl: process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
        bridgeAddress: process.env.BSC_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
        proxy: process.env.BSC_HTTP_PROXY || process.env.BSC_PROXY || null,
        injectNativeWei: process.env.BSC_INJECT_NATIVE_WEI || '1',
        gasLimit: parseInt(process.env.BSC_GAS_LIMIT) || 1000000,
        gasPrice: process.env.BSC_GAS_PRICE || null,
    },
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'bridge_relayer_bsc',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS) || 20,
    },
    relayer: {
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryInterval: parseInt(process.env.RETRY_INTERVAL) || 60000,
        batchSize: parseInt(process.env.BATCH_SIZE) || 20,
        confirmationBlocks: parseInt(process.env.CONFIRMATION_BLOCKS) || 3,
        // 高并发配置
        workerCount: parseInt(process.env.WORKER_COUNT) || 5,           // worker 数量
        queueSize: parseInt(process.env.QUEUE_SIZE) || 1000,            // 内存队列大小
        txConcurrency: parseInt(process.env.TX_CONCURRENCY) || 3,       // 同时发送交易数
        maxPollRate: parseInt(process.env.MAX_POLL_RATE) || 100,        // 每秒最大轮询数
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 10000,
    }
};

// ==================== 消息队列类 ====================
class MessageQueue extends EventEmitter {
    constructor(maxSize = 1000) {
        super();
        this.queue = [];
        this.maxSize = maxSize;
        this.processing = new Set();
        this.deadLetterQueue = [];
        this.stats = {
            enqueued: 0,
            dequeued: 0,
            completed: 0,
            failed: 0,
            deadLettered: 0
        };
    }

    enqueue(message) {
        if (this.queue.length >= this.maxSize) {
            console.warn('[Queue] Queue full, rejecting message:', message.solana_tx_sig);
            return false;
        }

        if (this.processing.has(message.solana_tx_sig)) {
            return false;
        }

        // 检查是否已在队列中
        const exists = this.queue.some(m => m.solana_tx_sig === message.solana_tx_sig);
        if (exists) {
            return false;
        }

        this.queue.push(message);
        this.stats.enqueued++;
        this.emit('message', message);
        return true;
    }

    dequeue() {
        if (this.queue.length === 0) {
            return null;
        }

        const message = this.queue.shift();
        this.processing.add(message.solana_tx_sig);
        this.stats.dequeued++;
        return message;
    }

    acknowledge(solanaTxSig) {
        this.processing.delete(solanaTxSig);
        this.stats.completed++;
    }

    moveToDeadLetter(message, reason) {
        this.processing.delete(message.solana_tx_sig);
        this.deadLetterQueue.push({ ...message, reason, timestamp: Date.now() });
        this.stats.deadLettered++;
        this.stats.failed++;
        this.emit('deadLetter', message, reason);
    }

    requeue(message) {
        this.processing.delete(message.solana_tx_sig);
        this.queue.unshift(message); // 优先处理
        this.emit('requeue', message);
    }

    get length() {
        return this.queue.length;
    }

    get processingCount() {
        return this.processing.size;
    }

    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            processingCount: this.processing.size,
            deadLetterLength: this.deadLetterQueue.length
        };
    }
}

// ==================== Nonce 管理器 ====================
class NonceManager {
    constructor(provider, address) {
        this.provider = provider;
        this.address = address;
        this.currentNonce = null;
        this.pendingNonces = new Map(); // txHash -> nonce
        this.lock = false;
    }

    async initialize() {
        this.currentNonce = await this.provider.getTransactionCount(this.address);
        console.log(`[NonceManager] Initialized with nonce: ${this.currentNonce}`);
    }

    async getNextNonce() {
        while (this.lock) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        this.lock = true;
        try {
            if (this.currentNonce === null) {
                await this.initialize();
            }
            const nonce = this.currentNonce++;
            return nonce;
        } finally {
            this.lock = false;
        }
    }

    async refreshNonce() {
        const onChainNonce = await this.provider.getTransactionCount(this.address);
        if (onChainNonce > this.currentNonce) {
            console.log(`[NonceManager] Refreshing nonce from ${this.currentNonce} to ${onChainNonce}`);
            this.currentNonce = onChainNonce;
        }
    }

    releaseNonce(nonce) {
        // Nonce 已使用，无需释放
    }
}

// ==================== 限流器 ====================
class RateLimiter {
    constructor(maxRequestsPerSecond) {
        this.maxRps = maxRequestsPerSecond;
        this.tokens = maxRequestsPerSecond;
        this.lastRefill = Date.now();
        this.interval = 1000 / maxRequestsPerSecond;
    }

    async acquire() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        
        if (elapsed >= 1000) {
            this.tokens = this.maxRps;
            this.lastRefill = now;
        }

        if (this.tokens > 0) {
            this.tokens--;
            return true;
        }

        // 等待下一个 token
        const waitTime = this.interval - (now - this.lastRefill);
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        return this.acquire();
    }

    getStats() {
        return {
            tokens: this.tokens,
            maxRps: this.maxRps
        };
    }
}

// ==================== 高并发 Relayer 类 ====================
class HighConcurrencyBscRelayer {
    constructor() {
        this.db = null;
        this.solanaConn = null;
        this.bscClient = null;
        this.relayerAddress = null;
        
        // 高并发组件
        this.messageQueue = new MessageQueue(CONFIG.relayer.queueSize);
        this.nonceManager = null;
        this.rateLimiter = new RateLimiter(CONFIG.relayer.maxPollRate);
        
        // 控制标志
        this.isRunning = false;
        this.isShuttingDown = false;
        
        // 定时器
        this.timers = {
            poll: null,
            retry: null,
            health: null,
            stats: null,
            nonce: null
        };
        
        // 工作池
        this.workers = [];
        this.activeTxCount = 0;
        
        // 统计
        this.stats = {
            startTime: null,
            totalDetected: 0,
            totalProcessed: 0,
            totalFailed: 0,
            totalRevenueProcessed: 0,
            avgProcessTime: 0,
            processTimes: []
        };

        // 绑定队列事件
        this.setupQueueEvents();
    }

    setupQueueEvents() {
        this.messageQueue.on('deadLetter', (message, reason) => {
            console.error(`[Relayer] Message moved to dead letter: ${message.solana_tx_sig}, reason: ${reason}`);
        });

        this.messageQueue.on('message', (message) => {
            this.dispatchToWorker();
        });
    }

    async initialize() {
        console.log('[RelayerV2] Initializing high-concurrency relayer...');
        
        // 1. 初始化数据库
        this.db = new Database(CONFIG.database);
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }
        await this.db.runMigrations();

        // 2. 初始化 Solana 连接
        const connOptions = { commitment: CONFIG.solana.commitment };
        if (CONFIG.solana.proxy) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connOptions.httpsAgent = new HttpsProxyAgent(CONFIG.solana.proxy);
        }
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, connOptions);

        // 3. 初始化 BSC 客户端
        this.bscClient = new BscClient(
            CONFIG.bsc.rpcUrl,
            CONFIG.bsc.privateKey,
            CONFIG.bsc.proxy
        );
        
        const bscConnected = await this.bscClient.verifyConnection();
        if (!bscConnected) {
            const fallbackConnected = await this.bscClient.connectToFallbackRpc();
            if (!fallbackConnected) {
                throw new Error('Failed to connect to BSC network');
            }
        }
        
        this.relayerAddress = this.bscClient.relayerAddress;

        // 4. 初始化 Nonce 管理器
        this.nonceManager = new NonceManager(this.bscClient.provider, this.relayerAddress);
        await this.nonceManager.initialize();

        // 5. 验证余额
        const balance = await this.bscClient.getBalance(this.relayerAddress);
        console.log(`[RelayerV2] Relayer balance: ${await this.bscClient.getBalanceInBNB(this.relayerAddress)} tBNB`);

        // 6. 更新数据库状态
        await this.db.updateRelayerStatus({ relayerAddress: this.relayerAddress });

        // 7. 初始化工作池
        this.initWorkerPool();

        console.log('[RelayerV2] Initialization complete');
        console.log(`[RelayerV2] Configuration:`);
        console.log(`  - Workers: ${CONFIG.relayer.workerCount}`);
        console.log(`  - Queue size: ${CONFIG.relayer.queueSize}`);
        console.log(`  - TX concurrency: ${CONFIG.relayer.txConcurrency}`);
        console.log(`  - Batch size: ${CONFIG.relayer.batchSize}`);
    }

    initWorkerPool() {
        for (let i = 0; i < CONFIG.relayer.workerCount; i++) {
            this.workers.push({
                id: i,
                busy: false,
                processed: 0
            });
        }
        console.log(`[RelayerV2] Worker pool initialized with ${this.workers.length} workers`);
    }

    async start() {
        if (this.isRunning) return;

        this.isRunning = true;
        this.isShuttingDown = false;
        this.stats.startTime = new Date();

        console.log('[RelayerV2] Starting...');
        console.log(`[RelayerV2] Solana Program: ${CONFIG.solana.programId}`);
        console.log(`[RelayerV2] BSC Bridge: ${CONFIG.bsc.bridgeAddress}`);

        await this.db.setRelayerActive(true);

        // 启动各个组件
        this.startSolanaListener();
        this.startRetryScheduler();
        this.startHealthCheck();
        this.startStatsReporter();
        this.startNonceRefresher();

        // 处理启动时遗留的消息
        await this.loadPendingMessages();

        console.log('[RelayerV2] Started successfully');
    }

    async stop() {
        if (!this.isRunning) return;

        console.log('[RelayerV2] Stopping...');
        this.isShuttingDown = true;
        this.isRunning = false;

        // 停止所有定时器
        for (const [name, timer] of Object.entries(this.timers)) {
            if (timer) {
                clearInterval(timer);
                clearTimeout(timer);
                this.timers[name] = null;
            }
        }

        // 等待正在处理的交易完成
        while (this.activeTxCount > 0) {
            console.log(`[RelayerV2] Waiting for ${this.activeTxCount} transactions to complete...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await this.db.setRelayerActive(false);
        console.log('[RelayerV2] Stopped');
    }

    async shutdown() {
        console.log('[RelayerV2] Initiating graceful shutdown...');
        await this.stop();
        await this.db.close();
        console.log('[RelayerV2] Shutdown complete');
    }

    // ==================== Solana 监听 ====================

    startSolanaListener() {
        const programId = new PublicKey(CONFIG.solana.programId);

        // WebSocket 实时监听
        this.solanaConn.onLogs(
            programId,
            async (logs, ctx) => {
                if (this.isShuttingDown) return;
                await this.handleSolanaLogs(logs, ctx);
            },
            CONFIG.solana.commitment
        );

        // 轮询备份机制
        this.timers.poll = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.pollSolanaTransactions();
        }, CONFIG.solana.pollInterval);

        console.log('[RelayerV2] Solana listener started');
    }

    async handleSolanaLogs(logs, ctx) {
        try {
            await this.rateLimiter.acquire();

            if (logs.err) return;

            const logString = logs.logs.join(' ');
            if (!logString.includes('Program data:')) {
                return;
            }

            // onLogs callback: logs = { err, logs, signature }
            const txSignature = logs.signature;
            
            // 快速检查是否已处理
            const alreadyProcessed = await this.db.isProcessed(txSignature);
            if (alreadyProcessed) return;

            // 异步解析交易，不阻塞
            this.parseAndQueueTransaction(txSignature, 'websocket');

        } catch (error) {
            console.error('[RelayerV2] Error handling logs:', error.message);
        }
    }

    async pollSolanaTransactions() {
        try {
            await this.rateLimiter.acquire();

            const status = await this.db.getRelayerStatus();
            const programId = new PublicKey(CONFIG.solana.programId);

            const signatures = await this.solanaConn.getSignaturesForAddress(
                programId,
                { limit: CONFIG.relayer.batchSize, until: status?.last_processed_signature || undefined },
                CONFIG.solana.commitment
            );

            // 并发处理签名
            const chunks = this.chunkArray(signatures.reverse(), CONFIG.solana.fetchConcurrency);
            
            for (const chunk of chunks) {
                if (this.isShuttingDown) break;

                const promises = chunk.map(sig => 
                    this.parseAndQueueTransaction(sig.signature, 'poll')
                        .catch(err => console.error(`[RelayerV2] Error parsing ${sig.signature}:`, err.message))
                );

                await Promise.allSettled(promises);

                // 更新最后处理的签名
                if (chunk.length > 0) {
                    const lastSig = chunk[chunk.length - 1].signature;
                    await this.db.updateRelayerStatus({ lastProcessedSignature: lastSig });
                }
            }

        } catch (error) {
            console.error('[RelayerV2] Error polling transactions:', error.message);
        }
    }

    async parseAndQueueTransaction(txSignature, source) {
        try {
            // 检查是否已在队列或已处理
            if (this.messageQueue.processing.has(txSignature)) return;

            const existingMsg = await this.db.getMessageBySig(txSignature);
            if (existingMsg && existingMsg.status === 'completed') return;

            const messageData = await this.parseSolanaTransaction(txSignature);
            if (!messageData) return;

            // 保存到数据库
            const savedMessage = await this.db.insertMessage(messageData);
            if (!savedMessage) return; // 可能已存在

            // 加入内存队列
            const queued = this.messageQueue.enqueue(savedMessage);
            
            if (queued) {
                this.stats.totalDetected++;
                console.log(`[RelayerV2] Queued message from ${source}: ${txSignature} (queue: ${this.messageQueue.length})`);
            }

            await this.db.logOperation(savedMessage.id, 'detect', { source });

        } catch (error) {
            console.error(`[RelayerV2] Error parsing transaction ${txSignature}:`, error.message);
        }
    }

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
                // Anchor events (emit!) are in "Program data:" lines, NOT "Program log:"
                if (log.includes('Program data:')) {
                    const base64Data = log.split('Program data:')[1]?.trim();
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

            if (!amount) {
                const parsedData = this.parseInstructionData(txDetails);
                if (parsedData) {
                    amount = parsedData.amount || amount;
                    recipientEth = parsedData.recipientEth || recipientEth;
                    senderSolana = parsedData.sender || senderSolana;
                }
            }

            // amount is required, recipientEth is optional (not needed for PoolB injection)
            if (!amount) return null;

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
            console.error(`[RelayerV2] Error parsing transaction ${txSignature}:`, error.message);
            return null;
        }
    }

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

    // ==================== 工作池调度 ====================

    async dispatchToWorker() {
        // 检查交易并发限制
        if (this.activeTxCount >= CONFIG.relayer.txConcurrency) {
            return;
        }

        // 找到空闲 worker
        const worker = this.workers.find(w => !w.busy);
        if (!worker) return;

        // 从队列获取消息
        const message = this.messageQueue.dequeue();
        if (!message) return;

        worker.busy = true;
        this.activeTxCount++;

        // 异步处理，不阻塞
        this.processMessageAsync(message, worker)
            .catch(err => console.error(`[Worker${worker.id}] Unhandled error:`, err))
            .finally(() => {
                worker.busy = false;
                this.activeTxCount--;
                // 尝试处理下一条消息
                this.dispatchToWorker();
            });
    }

    async processMessageAsync(message, worker) {
        const startTime = Date.now();

        try {
            await this.db.markAsProcessing(message.id);
            console.log(`[Worker${worker.id}] Processing: ${message.solana_tx_sig}`);

            const amountFromSolana = BigInt(message.amount);

            // 动态计算配对的 BNB 数量
            // 查询 PoolB 当前价格，计算需要配对的 BNB
            const amountBNB = await this.calculateNativeAmount(amountFromSolana);

            const inputData = this.bscClient.encodeInjectEcosystemFunds(
                message.solana_tx_sig_bytes32,
                amountFromSolana,
                amountBNB
            );

            // 获取 nonce
            const nonce = await this.nonceManager.getNextNonce();

            const txOptions = {
                gasLimit: CONFIG.bsc.gasLimit,
                value: amountBNB.toString(),
                nonce: nonce
            };

            if (CONFIG.bsc.gasPrice) {
                txOptions.gasPrice = CONFIG.bsc.gasPrice;
            }

            const result = await this.bscClient.sendContractCall(
                CONFIG.bsc.bridgeAddress,
                inputData,
                txOptions
            );

            if (result.success) {
                console.log(`[Worker${worker.id}] TX sent: ${result.txHash}`);

                // 等待确认
                const receipt = await this.bscClient.waitReceipt(result.txHash, 30, 2000);

                if (receipt && receipt.status === 0) {
                    throw new Error(`Transaction reverted: ${result.txHash}`);
                }

                await this.db.markAsCompleted(message.id, {
                    txHash: result.txHash,
                    blockNumber: receipt?.blockNumber || 0
                });

                this.messageQueue.acknowledge(message.solana_tx_sig);
                worker.processed++;
                this.stats.totalProcessed++;
                this.stats.totalRevenueProcessed += Number(amountFromSolana) / 1e6;

                // 记录处理时间
                const processTime = Date.now() - startTime;
                this.stats.processTimes.push(processTime);
                if (this.stats.processTimes.length > 100) {
                    this.stats.processTimes.shift();
                }
                this.stats.avgProcessTime = this.stats.processTimes.reduce((a, b) => a + b, 0) / this.stats.processTimes.length;

                console.log(`[Worker${worker.id}] Completed in ${processTime}ms: ${result.txHash}`);
            } else {
                throw new Error(result.error || 'Transaction failed');
            }

        } catch (error) {
            console.error(`[Worker${worker.id}] Error: ${error.message}`);
            this.stats.totalFailed++;

            const isRetryable = this.isRetryableError(error);
            const retryCount = message.retry_count || 0;

            if (isRetryable && retryCount < CONFIG.relayer.maxRetries) {
                // 刷新 nonce 并重试
                await this.nonceManager.refreshNonce();
                
                await this.db.markAsFailed(message.id, error.message, CONFIG.relayer.maxRetries);
                console.log(`[Worker${worker.id}] Will retry (attempt ${retryCount + 1}/${CONFIG.relayer.maxRetries})`);
            } else {
                // 移到死信队列
                this.messageQueue.moveToDeadLetter(message, error.message);
                await this.db.markAsFailed(message.id, `Permanent failure: ${error.message}`, 0);
            }
        }
    }

    isRetryableError(error) {
        const msg = error.message?.toLowerCase() || '';

        // Only truly permanent errors should be non-retryable
        const nonRetryable = [
            'already processed',
            'invalid recipient',
            'invalid amount',
        ];

        if (nonRetryable.some(p => msg.includes(p))) return false;

        // Contract reverts should be retried (could be transient gas/state issues)
        return true;
    }

    // ==================== 重试调度器 ====================

    startRetryScheduler() {
        this.timers.retry = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.processRetries();
        }, CONFIG.relayer.retryInterval);

        console.log('[RelayerV2] Retry scheduler started');
    }

    async processRetries() {
        try {
            const messages = await this.db.getPendingRetries(CONFIG.relayer.batchSize);
            if (messages.length === 0) return;

            console.log(`[RelayerV2] Loading ${messages.length} messages for retry`);

            for (const message of messages) {
                // 重新加入队列
                this.messageQueue.enqueue(message);
            }
        } catch (error) {
            console.error('[RelayerV2] Error processing retries:', error.message);
        }
    }

    async loadPendingMessages() {
        try {
            const messages = await this.db.getPendingMessages(CONFIG.relayer.batchSize);
            console.log(`[RelayerV2] Loading ${messages.length} pending messages`);

            for (const message of messages) {
                this.messageQueue.enqueue(message);
            }
        } catch (error) {
            console.error('[RelayerV2] Error loading pending messages:', error.message);
        }
    }

    // ==================== 健康检查 ====================

    startHealthCheck() {
        this.timers.health = setInterval(() => {
            this.performHealthCheck();
        }, CONFIG.relayer.healthCheckInterval);

        console.log('[RelayerV2] Health check started');
    }

    async performHealthCheck() {
        try {
            // 检查队列状态
            const queueStats = this.messageQueue.getStats();

            // 检查 worker 状态
            const busyWorkers = this.workers.filter(w => w.busy).length;

            // 检查 BSC 连接
            const blockNumber = await this.bscClient.getBlockNumber();

            // 检查余额
            const balance = await this.bscClient.getBalance(this.relayerAddress);
            const balanceBNB = Number(balance) / 1e18;

            const health = {
                timestamp: new Date().toISOString(),
                queue: queueStats,
                workers: {
                    total: this.workers.length,
                    busy: busyWorkers,
                    activeTx: this.activeTxCount
                },
                bsc: {
                    blockNumber,
                    balance: balanceBNB
                },
                stats: {
                    uptime: this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0,
                    processed: this.stats.totalProcessed,
                    failed: this.stats.totalFailed,
                    avgProcessTime: Math.round(this.stats.avgProcessTime)
                }
            };

            // 警告检查
            if (balanceBNB < 0.1) {
                console.warn(`[HealthCheck] LOW BALANCE: ${balanceBNB.toFixed(4)} tBNB`);
            }

            if (queueStats.deadLetterLength > 10) {
                console.warn(`[HealthCheck] Dead letter queue growing: ${queueStats.deadLetterLength}`);
            }

            // 输出健康状态
            console.log(`[HealthCheck] OK - Block: ${blockNumber}, Queue: ${queueStats.queueLength}, Active: ${this.activeTxCount}, Balance: ${balanceBNB.toFixed(4)} tBNB`);

            return health;

        } catch (error) {
            console.error('[HealthCheck] Failed:', error.message);
            return { status: 'unhealthy', error: error.message };
        }
    }

    // ==================== Nonce 刷新 ====================

    startNonceRefresher() {
        this.timers.nonce = setInterval(async () => {
            await this.nonceManager.refreshNonce();
        }, 30000); // 每30秒刷新一次

        console.log('[RelayerV2] Nonce refresher started');
    }

    // ==================== 统计报告 ====================

    startStatsReporter() {
        this.timers.stats = setInterval(() => {
            this.reportStats();
        }, 60000);

        console.log('[RelayerV2] Stats reporter started');
    }

    reportStats() {
        const uptime = this.stats.startTime ? Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000) : 0;
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);

        console.log('[RelayerV2] === Stats Report ===');
        console.log(`  Uptime: ${hours}h ${minutes}m`);
        console.log(`  Processed: ${this.stats.totalProcessed}`);
        console.log(`  Failed: ${this.stats.totalFailed}`);
        console.log(`  Revenue: ${this.stats.totalRevenueProcessed.toFixed(2)} USDC`);
        console.log(`  Avg Process Time: ${Math.round(this.stats.avgProcessTime)}ms`);
        console.log(`  Queue: ${this.messageQueue.length} pending, ${this.messageQueue.processingCount} processing`);
        console.log(`  Workers: ${this.workers.filter(w => w.busy).length}/${this.workers.length} busy`);
        console.log('[RelayerV2] =====================');
    }

    // ==================== Native Amount Calculation ====================

    /**
     * 从 PoolB 链上读取真实储备量，按当前价格比例计算配对的 BNB 数量
     * 公式: amountBNB = amountSUSDC * reserveSETH / reservesUSDC
     * 初始价格 0.01 sUSDC/BNB，后续由套利机器人维持
     */
    async calculateNativeAmount(amountSUSDC) {
        const fallback = BigInt(CONFIG.bsc.injectNativeWei);

        try {
            const poolBAddress = await this.getPoolBAddress();
            if (!poolBAddress) {
                console.warn('[RelayerV2] PoolB address not available, using fallback');
                return fallback;
            }

            const getPoolStateSelector = createKeccakHash('keccak256')
                .update('getPoolState()')
                .digest('hex')
                .slice(0, 8);

            const result = await this.bscClient.callContract(poolBAddress, '0x' + getPoolStateSelector);

            if (!result.success || !result.data || result.data.length < 194) {
                console.warn('[RelayerV2] PoolB getPoolState failed, using fallback');
                return fallback;
            }

            const data = result.data.replace(/^0x/, '');
            const reserveSETH = BigInt('0x' + data.slice(0, 64));
            const reservesUSDC = BigInt('0x' + data.slice(64, 128));

            if (reservesUSDC === 0n) {
                console.warn('[RelayerV2] PoolB sUSDC reserve is 0, using fallback');
                return fallback;
            }

            const amountBNB = (amountSUSDC * reserveSETH) / reservesUSDC;

            const price = Number(reservesUSDC) / Number(reserveSETH);
            console.log(`[RelayerV2] PoolB price: 1 BNB = ${price.toFixed(6)} sUSDC`);
            console.log(`  Reserves: ${reserveSETH} BNB / ${reservesUSDC} sUSDC`);
            console.log(`  Injecting: ${amountSUSDC} sUSDC, Paired BNB: ${amountBNB} wei`);

            if (amountBNB === 0n) return fallback;
            return amountBNB;
        } catch (error) {
            console.warn(`[RelayerV2] calculateNativeAmount error: ${error.message}, using fallback`);
            return fallback;
        }
    }

    async getPoolBAddress() {
        if (this._poolBAddress) return this._poolBAddress;

        try {
            const selector = createKeccakHash('keccak256')
                .update('poolB()')
                .digest('hex')
                .slice(0, 8);

            const result = await this.bscClient.callContract(
                CONFIG.bsc.bridgeAddress,
                '0x' + selector
            );

            if (result.success && result.data && result.data.length >= 66) {
                const data = result.data.replace(/^0x/, '');
                this._poolBAddress = '0x' + data.slice(24, 64);
                console.log(`[RelayerV2] PoolB address: ${this._poolBAddress}`);
                return this._poolBAddress;
            }
        } catch (error) {
            console.warn(`[RelayerV2] Failed to get PoolB address: ${error.message}`);
        }
        return null;
    }

    // ==================== 工具方法 ====================

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    // 获取当前状态（供外部调用）
    getStatus() {
        return {
            isRunning: this.isRunning,
            queue: this.messageQueue.getStats(),
            workers: {
                total: this.workers.length,
                busy: this.workers.filter(w => w.busy).length,
                stats: this.workers.map(w => ({ id: w.id, processed: w.processed }))
            },
            stats: {
                ...this.stats,
                uptime: this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0
            },
            config: {
                workerCount: CONFIG.relayer.workerCount,
                queueSize: CONFIG.relayer.queueSize,
                txConcurrency: CONFIG.relayer.txConcurrency
            }
        };
    }
}

// ==================== 主程序入口 ====================

async function main() {
    const relayer = new HighConcurrencyBscRelayer();

    process.on('SIGINT', async () => {
        console.log('\n[RelayerV2] Received SIGINT');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n[RelayerV2] Received SIGTERM');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('uncaughtException', (error) => {
        console.error('[RelayerV2] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('[RelayerV2] Unhandled rejection:', reason);
    });

    try {
        await relayer.initialize();
        await relayer.start();
    } catch (error) {
        console.error('[RelayerV2] Failed to start:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { HighConcurrencyBscRelayer, MessageQueue, NonceManager, RateLimiter };