/**
 * Seth-Solana Cross-chain Bridge Relayer
 * 
 * Uses TrustRelayer security model
 * Seth chain uses custom transaction format (no chainId)
 */

require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const Database = require('./db/database');
const SethClient = require('./sethClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');

// ==================== Configuration ====================
const CONFIG = {
    // Solana Configuration
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        commitment: 'confirmed',
        pollInterval: parseInt(process.env.SOLANA_POLL_INTERVAL) || 5000,
        proxy: process.env.SOLANA_HTTP_PROXY || process.env.SOLANA_PROXY || null,
    },
    // Seth Configuration (using custom client)
    seth: {
        host: process.env.SETH_HOST || '35.184.150.163',
        port: parseInt(process.env.SETH_PORT) || 23001,
        bridgeAddress: process.env.SETH_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
        proxy: process.env.SETH_HTTP_PROXY || process.env.SETH_PROXY || null,
        // Native SETH amount (wei) to inject to PoolB with ecosystem funds
        // SethBridge.processCrossChainMessage requires amountSETH > 0 and msg.value >= amountSETH
        // Default 1 wei is for testing only; configure a reasonable value for production
        injectNativeWei: process.env.SETH_INJECT_NATIVE_WEI || '1',
    },
    // Database Configuration
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'bridge_relayer',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS) || 10,
    },
    // Relayer Configuration
    relayer: {
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryInterval: parseInt(process.env.RETRY_INTERVAL) || 60000,
        batchSize: parseInt(process.env.BATCH_SIZE) || 10,
    }
};

// PostgreSQL BIGINT is signed int64.
const MAX_DB_BIGINT = (1n << 63n) - 1n;

// ==================== Relayer Class ====================
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
     * Initialize Relayer
     */
    async initialize() {
        console.log('[Relayer] Initializing...');
        
        // 1. Initialize database
        this.db = new Database(CONFIG.database);
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }

        // 2. Initialize Solana connection (with proxy support)
        const connOptions = { commitment: CONFIG.solana.commitment };
        if (CONFIG.solana.proxy) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connOptions.httpsAgent = new HttpsProxyAgent(CONFIG.solana.proxy);
        }
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, connOptions);
        console.log('[Relayer] Solana connection established');

        // 3. Initialize Seth client (with proxy support)
        this.sethClient = new SethClient(CONFIG.seth.host, CONFIG.seth.port, CONFIG.seth.proxy);
        
        // Derive address from private key
        const privateKeyHex = CONFIG.seth.privateKey.startsWith('0x') 
            ? CONFIG.seth.privateKey.slice(2) 
            : CONFIG.seth.privateKey;
        const privateKey = Buffer.from(privateKeyHex, 'hex');
        const pubKeyBytes = secp256k1.publicKeyCreate(privateKey, false);
        this.relayerAddress = this.sethClient.deriveAddressFromPubkey(pubKeyBytes);
        
        console.log(`[Relayer] Seth client initialized`);
        console.log(`[Relayer] Relayer address: ${this.relayerAddress}`);

        // 4. Verify Relayer balance
        const balance = await this.sethClient.getBalance(this.relayerAddress);
        console.log(`[Relayer] Relayer balance: ${balance}`);

        // 5. Update Relayer status in database
        await this.db.updateRelayerStatus({
            relayerAddress: this.relayerAddress
        });

        console.log('[Relayer] Initialization complete');
    }

    /**
     * Start Relayer
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

        // Start Solana event listener
        this.startSolanaListener();

        // Start retry scheduler
        this.startRetryScheduler();

        // Start stats reporter
        this.startStatsReporter();

        // Process pending messages on startup
        await this.processPendingMessages();

        console.log('[Relayer] Started successfully');
    }

    /**
     * Stop Relayer
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
     * Graceful shutdown
     */
    async shutdown() {
        console.log('[Relayer] Initiating graceful shutdown...');
        await this.stop();
        await this.db.close();
        console.log('[Relayer] Shutdown complete');
    }

    // ==================== Solana Listener ====================

    /**
     * Start Solana event listener
     */
    startSolanaListener() {
        const programId = new PublicKey(CONFIG.solana.programId);
        
        // Use onLogs to listen for program logs
        this.solanaConn.onLogs(
            programId,
            async (logs, ctx) => {
                if (this.isShuttingDown) return;
                await this.handleSolanaLogs(logs, ctx);
            },
            CONFIG.solana.commitment
        );

        // Also use polling as backup mechanism
        this.pollTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.pollSolanaTransactions();
        }, CONFIG.solana.pollInterval);

        console.log('[Relayer] Solana listener started');
    }

    /**
     * Handle Solana logs
     */
    async handleSolanaLogs(logs, ctx) {
        try {
            if (logs.err) return;

            const logString = logs.logs.join(' ');
            
            if (!logString.includes('CrossChainLock') && !logString.includes('Program data:')) {
                return;
            }

            const txSignature = logs.signature;
            if (!txSignature) {
                console.warn('[Relayer] Skip log callback without signature');
                return;
            }
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
     * Poll Solana transactions (backup mechanism)
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
     * Parse Solana transaction
     */
    async parseSolanaTransaction(txSignature) {
        try {
            const txDetails = await this.solanaConn.getParsedTransaction(
                txSignature, 
                { maxSupportedTransactionVersion: 0 }
            );

            if (!txDetails || !txDetails.meta) return null;

            let amount = null;
            let teamFunds = null;
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
                                teamFunds = eventData.teamFunds || teamFunds;
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

            const normalizedAmount = this.normalizeDbBigInt(amount, 'amount', txSignature);
            if (normalizedAmount === null) return null;
            const normalizedTeamFunds = this.normalizeDbBigInt(teamFunds || 0n, 'team_funds', txSignature);
            if (normalizedTeamFunds === null) return null;

            // Convert Solana signature to bytes32
            const sigBytes = bs58.decode(txSignature);
            const solanaTxSigBytes32 = '0x' + createKeccakHash('keccak256')
                .update(Buffer.concat([Buffer.alloc(32), sigBytes.slice(0, 32)]))
                .digest('hex');

            return {
                solanaTxSig: txSignature,
                solanaTxSigBytes32,
                amount: normalizedAmount.toString(),
                teamFunds: normalizedTeamFunds.toString(),
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
     * Parse Anchor event data (RevenueProcessed event)
     * 
     * RevenueProcessed event structure:
     * - 8 bytes: event discriminator
     * - 32 bytes: user (Pubkey)
     * - 8 bytes: amount (u64) - original amount
     * - 8 bytes: commission_l1 (u64)
     * - 8 bytes: commission_l2 (u64)
     * - 8 bytes: team_funds (u64) - 5% team funds
     * - 8 bytes: project_funds (u64)
     * - 8 bytes: ecosystem_funds (u64) - 30% ecosystem funds
     * - 1 byte: has_l1_referrer (bool)
     * - 32 bytes: l1_referrer (Option<Pubkey>)
     * - 1 byte: has_l2_referrer (bool)
     * - 32 bytes: l2_referrer (Option<Pubkey>)
     * - 1 byte: product_type (u8)
     * - 8 bytes: timestamp (i64)
     */
    parseAnchorEvent(base64Data) {
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            if (buffer.length < 8) return null;

            let offset = 8; // Skip discriminator
            
            // Read user (32 bytes)
            if (buffer.length < offset + 32) return null;
            offset += 32;
            
            // Read amount (8 bytes)
            if (buffer.length < offset + 8) return null;
            const amount = buffer.readBigUInt64LE(offset);
            offset += 8;
            
            // Read commission_l1 (8 bytes)
            if (buffer.length < offset + 8) return null;
            offset += 8;
            
            // Read commission_l2 (8 bytes)
            if (buffer.length < offset + 8) return null;
            offset += 8;
            
            // Read team_funds (8 bytes) - 5% team funds
            let teamFunds = BigInt(0);
            if (buffer.length >= offset + 8) {
                teamFunds = buffer.readBigUInt64LE(offset);
            }
            offset += 8;
            
            // Read project_funds (8 bytes)
            if (buffer.length < offset + 8) return null;
            offset += 8;
            
            // Read ecosystem_funds (8 bytes) - 30% ecosystem funds
            let ecosystemFunds = amount;
            if (buffer.length >= offset + 8) {
                ecosystemFunds = buffer.readBigUInt64LE(offset);
            }
            offset += 8;
            
            // Read l1_referrer (Option<Pubkey>)
            if (buffer.length < offset + 1) return null;
            const hasL1Referrer = buffer.readUInt8(offset) === 1;
            offset += 1;
            if (hasL1Referrer && buffer.length >= offset + 32) {
                offset += 32;
            }
            
            // Read l2_referrer (Option<Pubkey>)
            if (buffer.length < offset + 1) return null;
            const hasL2Referrer = buffer.readUInt8(offset) === 1;
            offset += 1;
            if (hasL2Referrer && buffer.length >= offset + 32) {
                offset += 32;
            }
            
            // Read product_type (1 byte)
            if (buffer.length < offset + 1) return null;
            const productType = buffer.readUInt8(offset);
            offset += 1;
            
            // Read recipient (20 bytes) - if present
            let recipientEth = null;
            if (buffer.length >= offset + 20) {
                const recipientEthBytes = buffer.slice(offset, offset + 20);
                recipientEth = '0x' + recipientEthBytes.toString('hex');
            }
            
            return { 
                amount: ecosystemFunds.toString(), // 30% ecosystem funds
                teamFunds: teamFunds.toString(),   // 5% team funds
                originalAmount: amount.toString(),
                recipientEth,
                productType
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Parse instruction data
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

    /**
     * Normalize bigint-like value for PostgreSQL BIGINT.
     * Returns null when value is invalid/out-of-range so caller can skip that tx.
     */
    normalizeDbBigInt(value, fieldName, txSignature) {
        try {
            const n = typeof value === 'bigint' ? value : BigInt(value || 0);
            if (n < 0n || n > MAX_DB_BIGINT) {
                console.warn(`[Relayer] Skip tx ${txSignature}: ${fieldName} out of BIGINT range (${n.toString()})`);
                return null;
            }
            return n;
        } catch {
            console.warn(`[Relayer] Skip tx ${txSignature}: invalid ${fieldName}`);
            return null;
        }
    }

    // ==================== Message Processing ====================

    /**
     * Process pending messages
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
     * Process single message - call Seth bridge contract
     * 
     * Distribution scheme (10-5-5-50-30):
     * - L1 Commission (10%) -> Solana real-time transfer to referrer
     * - L2 Commission (5%)  -> Solana real-time transfer to L2 referrer
     * - Project Reserve (50%) -> Solana real-time transfer to Gnosis Safe
     * - Cross-chain Ecosystem (30%) -> Cross-chain to PoolB (amount field)
     * - Team Incentive (5%)  -> Cross-chain to TeamPayroll (team_funds field)
     */
    async processMessage(message) {
        const { id, solana_tx_sig, solana_tx_sig_bytes32, amount, recipient_eth, team_funds } = message;

        try {
            await this.db.markAsProcessing(id);
            await this.db.logOperation(id, 'process', { attempt: message.retry_count + 1 });

            console.log(`[Relayer] Processing message ${id}: ${solana_tx_sig}`);
            console.log(`[Relayer]   Ecosystem Amount (30%): ${amount}`);
            console.log(`[Relayer]   Team Funds (5%): ${team_funds || 0}`);
            console.log(`[Relayer]   Recipient: ${recipient_eth}`);

            // Cross-chain fund processing:
            // SethBridge.processCrossChainMessage(bytes32 solanaTxSig, uint256 ecosystemAmount, uint256 teamFundsAmount, uint256 amountSETH)
            // - ecosystemAmount: 30% ecosystem funds -> inject to PoolB
            // - teamFundsAmount: 5% team funds -> to TeamPayroll (auto-swap to SETH via PoolB)
            // - amountSETH: native SETH (for PoolB liquidity pairing)
            const ecosystemAmount = BigInt(amount || 0);
            const teamFundsAmount = BigInt(team_funds || 0);
            const amountSETH = BigInt(CONFIG.seth.injectNativeWei);
            
            const inputData = this.encodeProcessCrossChainMessage(
                solana_tx_sig_bytes32, 
                ecosystemAmount, 
                teamFundsAmount, 
                amountSETH
            );
            const selector = inputData.slice(0, 8);
            console.log(`[Relayer] Seth call: processCrossChainMessage selector=0x${selector}`);
            console.log(`[Relayer]   ecosystemAmount=${ecosystemAmount.toString()} teamFundsAmount=${teamFundsAmount.toString()} msg.value=${amountSETH.toString()}`);

            // Send transaction using SethClient
            const result = await this.sethClient.sendContractCall(
                CONFIG.seth.privateKey,
                CONFIG.seth.bridgeAddress.replace('0x', ''),
                inputData,
                { gasLimit: 200000, gasPrice: 1, amount: amountSETH.toString() }
            );

            if (result.success) {
                console.log(`[Relayer] Seth tx sent: ${result.txHash}`);
                console.log(`[Relayer] Response: ${JSON.stringify(result.response)}`);
                if (result.request) {
                    console.log(`[Relayer] Seth request: ${JSON.stringify(result.request)}`);
                }

                // Success doesn't mean on-chain: poll transaction_receipt for confirmation
                const receipt = await this.waitSethReceipt(result.txHash, 8, 1000);
                console.log(`[Relayer] Seth receipt: ${receipt ? JSON.stringify(receipt) : '(null)'}`);
                if (receipt?.status === 10) {
                    // kNotExists: transaction not found on node, treat as dropped, retry
                    throw new Error(`Seth tx not exists (status=10): ${result.txHash}`);
                }
                
                await this.db.markAsCompleted(id, {
                    txHash: result.txHash,
                    blockNumber: result.nonce
                });

                this.stats.totalProcessed++;
                // ecosystemAmount is 6 decimals (USDC), rough statistics only
                this.stats.totalRevenueProcessed += Number(ecosystemAmount) / 1e6;
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

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Poll Seth tx receipt
     * @param {string} txHash
     * @param {number} maxAttempts
     * @param {number} intervalMs
     */
    async waitSethReceipt(txHash, maxAttempts = 8, intervalMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            const r = await this.sethClient.getTxReceipt(txHash);
            if (r) {
                // done=true means terminal state; status=10 means not exists, return immediately for error handling
                if (r.done || r.status === 10) return r;
            }
            await this.sleep(intervalMs);
        }
        return null;
    }

    /**
     * Encode processCrossChainMessage function call
     * function processCrossChainMessage(bytes32 solanaTxSig, uint256 ecosystemAmount, uint256 teamFundsAmount, uint256 amountSETH)
     * @param solanaTxSigBytes32 Solana transaction signature (bytes32)
     * @param ecosystemAmount Ecosystem funds (30%) - inject to PoolB
     * @param teamFundsAmount Team funds (5%) - to TeamPayroll
     * @param amountSETH Native SETH amount (for PoolB liquidity)
     */
    encodeProcessCrossChainMessage(solanaTxSigBytes32, ecosystemAmount, teamFundsAmount, amountSETH) {
        const sig = solanaTxSigBytes32.replace(/^0x/, '').padStart(64, '0');
        const ecoAmt = BigInt(ecosystemAmount).toString(16).padStart(64, '0');
        const teamAmt = BigInt(teamFundsAmount).toString(16).padStart(64, '0');
        const amtSETH = BigInt(amountSETH).toString(16).padStart(64, '0');

        // selector = keccak256("processCrossChainMessage(bytes32,uint256,uint256,uint256)")[:4]
        const selector = createKeccakHash('keccak256')
            .update('processCrossChainMessage(bytes32,uint256,uint256,uint256)')
            .digest('hex')
            .slice(0, 8);

        return selector + sig + ecoAmt + teamAmt + amtSETH;
    }

    /**
     * Determine if error is retryable
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

    // ==================== Retry Scheduler ====================

    /**
     * Start retry scheduler
     */
    startRetryScheduler() {
        this.retryTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.processRetries();
        }, CONFIG.relayer.retryInterval);

        console.log('[Relayer] Retry scheduler started');
    }

    /**
     * Process pending retry messages
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

    // ==================== Stats Reporter ====================

    /**
     * Start stats reporter
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

// ==================== Main Entry ====================

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