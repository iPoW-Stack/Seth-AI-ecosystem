/**
 * BSC-Solana High-Concurrency Cross-Chain Bridge Relayer V2
 * 
 * Optimized Features:
 * 1. Message Queue Mechanism - Memory queue + Database persistence
 * 2. Batch Processing - Concurrent processing of multiple messages
 * 3. Worker Pool Pattern - Multiple workers for concurrent processing
 * 4. Rate Limiting and Backpressure Control - Prevent system overload
 * 5. Graceful Degradation - Automatic adjustment under high load
 * 6. Health Check and Monitoring
 * 7. Dead Letter Queue - Handle permanently failed messages
 * 8. Nonce Management - Prevent nonce conflicts
 */

require('dotenv').config({ path: '.env.bsc' });
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const Database = require('./db/database');
const BscClient = require('./bscClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');
const EventEmitter = require('events');

/** Anchor `emit!(RevenueProcessed { ... })` — sha256("event:RevenueProcessed")[0..8] */
const REVENUE_PROCESSED_EVENT_DISCRIMINATOR = Buffer.from([
    181, 26, 199, 237, 159, 186, 73, 241,
]);

// ==================== Configuration ====================
const CONFIG = {
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        commitment: 'confirmed',
        pollInterval: parseInt(process.env.SOLANA_POLL_INTERVAL) || 3000,
        proxy: process.env.SOLANA_HTTP_PROXY || process.env.SOLANA_PROXY || null,
        // Concurrency level for fetching transaction details
        fetchConcurrency: parseInt(process.env.SOLANA_FETCH_CONCURRENCY) || 5,
    },
    bsc: {
        rpcUrl: process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
        bridgeAddress: process.env.BSC_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
        proxy: process.env.BSC_HTTP_PROXY || process.env.BSC_PROXY || null,
        injectNativeWei: process.env.BSC_INJECT_NATIVE_WEI || '1',
        gasLimit: parseInt(process.env.BSC_GAS_LIMIT) || 300000,
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
        // High-concurrency configuration
        workerCount: parseInt(process.env.WORKER_COUNT) || 5,           // Number of workers
        queueSize: parseInt(process.env.QUEUE_SIZE) || 1000,            // Memory queue size
        txConcurrency: parseInt(process.env.TX_CONCURRENCY) || 3,       // Concurrent transaction sending
        maxPollRate: parseInt(process.env.MAX_POLL_RATE) || 100,        // Maximum poll rate per second
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 10000, // Health check interval
    }
};

// ==================== Message Queue Class ====================
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

        // Check if already exists in the queue
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
        this.queue.unshift(message); // Prioritize processing
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

// ==================== Nonce Manager ====================
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
        // Nonce has already been used, no need to release
    }
}

// ==================== Rate Limiter ====================
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

        // Wait for the next token
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

// ==================== High-Concurrency Relayer Class ====================
class HighConcurrencyBscRelayer {
    constructor() {
        this.db = null;
        this.solanaConn = null;
        this.bscClient = null;
        this.relayerAddress = null;
        
        // High-concurrency components
        this.messageQueue = new MessageQueue(CONFIG.relayer.queueSize);
        this.nonceManager = null;
        this.rateLimiter = new RateLimiter(CONFIG.relayer.maxPollRate);
        
        // Control flags
        this.isRunning = false;
        this.isShuttingDown = false;
        
        // Timers
        this.timers = {
            poll: null,
            retry: null,
            health: null,
            stats: null,
            nonce: null
        };
        
        // Worker pool
        this.workers = [];
        this.activeTxCount = 0;
        
        // Statistics
        this.stats = {
            startTime: null,
            totalDetected: 0,
            totalProcessed: 0,
            totalFailed: 0,
            totalRevenueProcessed: 0,
            avgProcessTime: 0,
            processTimes: []
        };

        // Event handlers for the message queue
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
        
        // 1. Initialize database
        this.db = new Database(CONFIG.database);
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }
        await this.db.runMigrations();

        // 2. Initialize Solana connection
        const connOptions = { commitment: CONFIG.solana.commitment };
        if (CONFIG.solana.proxy) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connOptions.httpsAgent = new HttpsProxyAgent(CONFIG.solana.proxy);
        }
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, connOptions);

        // 3. Initialize BSC client
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

        // 4. Initialize Nonce manager
        this.nonceManager = new NonceManager(this.bscClient.provider, this.relayerAddress);
        await this.nonceManager.initialize();

        // 5. Verify balance
        const balance = await this.bscClient.getBalance(this.relayerAddress);
        console.log(`[RelayerV2] Relayer balance: ${await this.bscClient.getBalanceInBNB(this.relayerAddress)} tBNB`);

        // 6. Update database status
        await this.db.updateRelayerStatus({ relayerAddress: this.relayerAddress });

        // 7. Initialize worker pool
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

        // Start various components
        this.startSolanaListener();
        this.startRetryScheduler();
        this.startHealthCheck();
        this.startStatsReporter();
        this.startNonceRefresher();

        // Process pending messages left from previous runs
        await this.loadPendingMessages();

        console.log('[RelayerV2] Started successfully');
    }

    async stop() {
        if (!this.isRunning) return;

        console.log('[RelayerV2] Stopping...');
        this.isShuttingDown = true;
        this.isRunning = false;

        // Stop all timers
        for (const [name, timer] of Object.entries(this.timers)) {
            if (timer) {
                clearInterval(timer);
                clearTimeout(timer);
                this.timers[name] = null;
            }
        }

        // Wait for all active transactions to complete
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

    // ==================== Solana Listener ====================

    startSolanaListener() {
        const programId = new PublicKey(CONFIG.solana.programId);

        // WebSocket real-time listening
        this.solanaConn.onLogs(
            programId,
            async (logs, ctx) => {
                if (this.isShuttingDown) return;
                await this.handleSolanaLogs(logs, ctx);
            },
            CONFIG.solana.commitment
        );

        // Polling backup mechanism
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
            if (!logString.includes('CrossChainLock') && !logString.includes('Program data:')) {
                return;
            }

            const txSignature = ctx.signature;
            
            // Quickly check if already processed
            const alreadyProcessed = await this.db.isProcessed(txSignature);
            if (alreadyProcessed) return;

            // Asynchronously parse transaction, do not block
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

            // Concurrency handling of signatures
            const chunks = this.chunkArray(signatures.reverse(), CONFIG.solana.fetchConcurrency);
            
            for (const chunk of chunks) {
                if (this.isShuttingDown) break;

                const promises = chunk.map(sig => 
                    this.parseAndQueueTransaction(sig.signature, 'poll')
                        .catch(err => console.error(`[RelayerV2] Error parsing ${sig.signature}:`, err.message))
                );

                await Promise.allSettled(promises);

                // Update last processed signature
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
            // Check if already in queue or processed
            if (this.messageQueue.processing.has(txSignature)) return;

            const existingMsg = await this.db.getMessageBySig(txSignature);
            if (existingMsg && existingMsg.status === 'completed') return;

            const messageData = await this.parseSolanaTransaction(txSignature);
            if (!messageData) return;

            // Save to database
            const savedMessage = await this.db.insertMessage(messageData);
            if (!savedMessage) return; // Possible duplicate

            // Add to memory queue
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
                if (log.includes('Program data:')) {
                    const rest = log.split('Program data:')[1]?.trim();
                    const base64Data = rest ? rest.split(/\s+/)[0] : '';
                    if (base64Data) {
                        try {
                            const buf = Buffer.from(base64Data, 'base64');
                            const eventData = this.parseRevenueProcessedEventBuffer(buf);
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

            if (!amount || !recipientEth) return null;

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

    /**
     * Parse RevenueProcessed from `Program data` payload.
     * Matches `contracts/solana/src/events.rs` (Borsh): no team_funds field.
     */
    parseRevenueProcessedEventBuffer(buffer) {
        try {
            if (buffer.length < 8) return null;
            if (!buffer.slice(0, 8).equals(REVENUE_PROCESSED_EVENT_DISCRIMINATOR)) return null;

            let offset = 8;
            if (buffer.length < offset + 32) return null;
            const sender = new PublicKey(buffer.slice(offset, offset + 32)).toString();
            offset += 32;

            if (buffer.length < offset + 8 * 5) return null;
            offset += 8; // amount
            offset += 8; // commission_l1
            offset += 8; // commission_l2
            offset += 8; // project_funds
            const ecosystemFunds = buffer.readBigUInt64LE(offset);
            offset += 8;

            if (buffer.length < offset + 1) return null;
            const l1Tag = buffer.readUInt8(offset);
            offset += 1;
            if (l1Tag === 1) {
                if (buffer.length < offset + 32) return null;
                offset += 32;
            } else if (l1Tag !== 0) return null;

            if (buffer.length < offset + 1) return null;
            const l2Tag = buffer.readUInt8(offset);
            offset += 1;
            if (l2Tag === 1) {
                if (buffer.length < offset + 32) return null;
                offset += 32;
            } else if (l2Tag !== 0) return null;

            if (buffer.length < offset + 20 + 8) return null;
            const recipientEthBytes = buffer.slice(offset, offset + 20);
            const recipientEth = '0x' + recipientEthBytes.toString('hex');

            return {
                amount: ecosystemFunds.toString(),
                recipientEth,
                sender,
            };
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

    // ==================== Worker Pool Dispatch ====================

    async dispatchToWorker() {
        // Check transaction concurrency limit
        if (this.activeTxCount >= CONFIG.relayer.txConcurrency) {
            return;
        }

        // Find idle worker
        const worker = this.workers.find(w => !w.busy);
        if (!worker) return;

        // Get message from queue
        const message = this.messageQueue.dequeue();
        if (!message) return;

        worker.busy = true;
        this.activeTxCount++;

        // Asynchronously process, do not block
        this.processMessageAsync(message, worker)
            .catch(err => console.error(`[Worker${worker.id}] Unhandled error:`, err))
            .finally(() => {
                worker.busy = false;
                this.activeTxCount--;
                // Try processing next message
                this.dispatchToWorker();
            });
    }

    async processMessageAsync(message, worker) {
        const startTime = Date.now();

        try {
            await this.db.markAsProcessing(message.id);
            console.log(`[Worker${worker.id}] Processing: ${message.solana_tx_sig}`);

            const amountFromSolana = BigInt(message.amount);
            const amountBNB = BigInt(CONFIG.bsc.injectNativeWei);
            const inputData = this.bscClient.encodeInjectEcosystemFunds(
                message.solana_tx_sig_bytes32,
                amountFromSolana,
                amountBNB
            );

            // Get nonce
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

                // Wait for confirmation
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

                // Record processing time
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
                // Refresh nonce and retry
                await this.nonceManager.refreshNonce();
                
                await this.db.markAsFailed(message.id, error.message, CONFIG.relayer.maxRetries);
                console.log(`[Worker${worker.id}] Will retry (attempt ${retryCount + 1}/${CONFIG.relayer.maxRetries})`);
            } else {
                // Move to dead letter queue
                this.messageQueue.moveToDeadLetter(message, error.message);
                await this.db.markAsFailed(message.id, `Permanent failure: ${error.message}`, 0);
            }
        }
    }

    isRetryableError(error) {
        const msg = error.message?.toLowerCase() || '';

        const nonRetryable = [
            'already processed',
            'invalid recipient',
            'invalid amount',
            'insufficient funds',
            'revert',
        ];

        if (nonRetryable.some(p => msg.includes(p))) return false;

        const retryable = [
            'network',
            'timeout',
            'connection',
            'rate limit',
            'nonce',
            'underpriced',
        ];

        return retryable.some(p => msg.includes(p)) || true;
    }

    // ==================== Retry Scheduler ====================

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
                // Re-enqueue the message
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

    // ==================== Health Check ====================

    startHealthCheck() {
        this.timers.health = setInterval(() => {
            this.performHealthCheck();
        }, CONFIG.relayer.healthCheckInterval);

        console.log('[RelayerV2] Health check started');
    }

    async performHealthCheck() {
        try {
            // Check queue status
            const queueStats = this.messageQueue.getStats();

            // Check worker status
            const busyWorkers = this.workers.filter(w => w.busy).length;

            // Check BSC connection
            const blockNumber = await this.bscClient.getBlockNumber();

            // Check balance
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

            // Warning checks
            if (balanceBNB < 0.1) {
                console.warn(`[HealthCheck] LOW BALANCE: ${balanceBNB.toFixed(4)} tBNB`);
            }

            if (queueStats.deadLetterLength > 10) {
                console.warn(`[HealthCheck] Dead letter queue growing: ${queueStats.deadLetterLength}`);
            }

            // Log health status
            console.log(`[HealthCheck] OK - Block: ${blockNumber}, Queue: ${queueStats.queueLength}, Active: ${this.activeTxCount}, Balance: ${balanceBNB.toFixed(4)} tBNB`);

            return health;

        } catch (error) {
            console.error('[HealthCheck] Failed:', error.message);
            return { status: 'unhealthy', error: error.message };
        }
    }

    // ==================== Nonce Refresher ====================

    startNonceRefresher() {
        this.timers.nonce = setInterval(async () => {
            await this.nonceManager.refreshNonce();
        }, 30000); // Every 30 seconds

        console.log('[RelayerV2] Nonce refresher started');
    }

    // ==================== Stats Reporter ====================

    startStatsReporter() {
        this.timers.stats = setInterval(() => {
            this.reportStats();
        }, 60000); // Every 60 seconds

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

    // ==================== Utility Methods ====================

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    // Get current status (for external use, e.g. API endpoints, etc.)
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

// ==================== Main Program Entry ====================

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