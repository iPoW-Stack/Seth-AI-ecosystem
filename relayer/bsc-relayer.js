/**
 * BSC-Solana Cross-chain Bridge Relayer
 * 
 * Uses TrustRelayer security model
 * BSC testnet uses ethers.js for interaction
 * 
 * Differences from Seth version:
 * - Uses standard EVM-compatible BSC testnet
 * - Supports ethers.js standard transaction format
 * - Gas price and transaction confirmation mechanism consistent with standard EVM chains
 */

require('dotenv').config({ path: '.env.bsc' });
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const Database = require('./db/database');
const BscClient = require('./bscClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');

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
    // BSC Configuration (using ethers.js)
    bsc: {
        rpcUrl: process.env.BSC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/',
        bridgeAddress: process.env.BSC_BRIDGE_ADDRESS,
        privateKey: process.env.RELAYER_PRIVATE_KEY,
        proxy: process.env.BSC_HTTP_PROXY || process.env.BSC_PROXY || null,
        // Native BNB amount (wei) to inject to PoolB with ecosystem funds
        // Default 1 wei is for testing only; configure a reasonable value for production
        injectNativeWei: process.env.BSC_INJECT_NATIVE_WEI || '1',
        // Gas Configuration
        gasLimit: parseInt(process.env.BSC_GAS_LIMIT) || 1000000,
        gasPrice: process.env.BSC_GAS_PRICE || null, // null means auto-fetch
    },
    // Database Configuration
    database: {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'bridge_relayer_bsc',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS) || 10,
    },
    // Relayer Configuration
    relayer: {
        maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
        retryInterval: parseInt(process.env.RETRY_INTERVAL) || 60000,
        batchSize: parseInt(process.env.BATCH_SIZE) || 10,
        confirmationBlocks: parseInt(process.env.CONFIRMATION_BLOCKS) || 3,
    }
};

// ==================== BSC-Solana Relayer Class ====================
class BscBridgeRelayer {
    constructor() {
        this.db = null;
        this.solanaConn = null;
        this.bscClient = null;
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
        console.log('[BscRelayer] Initializing...');
        
        // 1. Initialize database
        this.db = new Database(CONFIG.database);
        const dbConnected = await this.db.testConnection();
        if (!dbConnected) {
            throw new Error('Failed to connect to database');
        }

        // Run database migrations
        try {
            await this.db.runMigrations();
            console.log('[BscRelayer] Database migrations completed');
        } catch (error) {
            console.warn('[BscRelayer] Database migration warning:', error.message);
        }

        // 2. Initialize Solana connection (with proxy support)
        const connOptions = { commitment: CONFIG.solana.commitment };
        if (CONFIG.solana.proxy) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connOptions.httpsAgent = new HttpsProxyAgent(CONFIG.solana.proxy);
        }
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, connOptions);
        console.log('[BscRelayer] Solana connection established');

        // 3. Initialize BSC client (with proxy support)
        this.bscClient = new BscClient(
            CONFIG.bsc.rpcUrl,
            CONFIG.bsc.privateKey,
            CONFIG.bsc.proxy
        );
        
        // Verify BSC connection
        const bscConnected = await this.bscClient.verifyConnection();
        if (!bscConnected) {
            console.warn('[BscRelayer] BSC connection verification failed, trying fallback...');
            const fallbackConnected = await this.bscClient.connectToFallbackRpc();
            if (!fallbackConnected) {
                throw new Error('Failed to connect to BSC network');
            }
        }
        
        this.relayerAddress = this.bscClient.relayerAddress;
        console.log(`[BscRelayer] BSC client initialized`);
        console.log(`[BscRelayer] Relayer address: ${this.relayerAddress}`);

        // 4. Verify Relayer balance
        const balance = await this.bscClient.getBalance(this.relayerAddress);
        const balanceBNB = await this.bscClient.getBalanceInBNB(this.relayerAddress);
        console.log(`[BscRelayer] Relayer balance: ${balanceBNB} tBNB (${balance} wei)`);

        // 5. Update Relayer status in database
        await this.db.updateRelayerStatus({
            relayerAddress: this.relayerAddress
        });

        console.log('[BscRelayer] Initialization complete');
    }

    /**
     * Start Relayer
     */
    async start() {
        if (this.isRunning) {
            console.log('[BscRelayer] Already running');
            return;
        }

        this.isRunning = true;
        this.isShuttingDown = false;
        
        console.log('[BscRelayer] Starting...');
        console.log(`[BscRelayer] Listening to Solana Program: ${CONFIG.solana.programId}`);
        console.log(`[BscRelayer] BSC Bridge Address: ${CONFIG.bsc.bridgeAddress}`);

        await this.db.setRelayerActive(true);

        // Start Solana event listener
        this.startSolanaListener();

        // Start retry scheduler
        this.startRetryScheduler();

        // Start stats reporter
        this.startStatsReporter();

        // Process pending messages on startup
        await this.processPendingMessages();

        console.log('[BscRelayer] Started successfully');
    }

    /**
     * Stop Relayer
     */
    async stop() {
        if (!this.isRunning) return;

        console.log('[BscRelayer] Stopping...');
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
        console.log('[BscRelayer] Stopped');
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        console.log('[BscRelayer] Initiating graceful shutdown...');
        await this.stop();
        await this.db.close();
        console.log('[BscRelayer] Shutdown complete');
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

        console.log('[BscRelayer] Solana listener started');
    }

    /**
     * Handle Solana logs
     * Note: onLogs callback signature is (logs: { err, logs, signature }, ctx: { slot })
     * The transaction signature is in the first parameter (logs.signature), not ctx
     */
    async handleSolanaLogs(logs, ctx) {
        try {
            if (logs.err) return;

            const logString = logs.logs?.join(' ') || '';
            
            // Check for RevenueProcessed event or program data
            if (!logString.includes('Program data:')) {
                return;
            }

            // Get signature - it's in logs.signature, not ctx
            // ctx only contains { slot }
            const txSignature = logs?.signature;
            if (!txSignature || typeof txSignature !== 'string') {
                // No valid signature, skip
                return;
            }
            
            console.log(`[BscRelayer] Detected potential cross-chain tx: ${txSignature}`);

            const alreadyProcessed = await this.db.isProcessed(txSignature);
            if (alreadyProcessed) {
                console.log(`[BscRelayer] Transaction ${txSignature} already processed`);
                return;
            }

            const messageData = await this.parseSolanaTransaction(txSignature);
            if (!messageData) {
                console.warn(`[BscRelayer] Failed to parse transaction: ${txSignature}`);
                return;
            }

            const savedMessage = await this.db.insertMessage(messageData);
            if (savedMessage) {
                console.log(`[BscRelayer] Saved new message: ${txSignature} -> ${messageData.recipientEth}`);
                await this.db.logOperation(savedMessage.id, 'detect', { txSignature });
                await this.processMessage(savedMessage);
            }

        } catch (error) {
            console.error('[BscRelayer] Error handling Solana logs:', error.message);
        }
    }

    /**
     * Poll Solana transactions (backup mechanism)
     * Only polls for NEW transactions since last check
     */
    async pollSolanaTransactions() {
        try {
            const status = await this.db.getRelayerStatus();
            const programId = new PublicKey(CONFIG.solana.programId);
            
            // Get the last processed signature for API cursor
            const until = status?.last_processed_signature;
            // Get the last processed slot for additional filtering
            const lastProcessedSlot = status?.last_processed_slot || 0;
            
            const signatures = await this.solanaConn.getSignaturesForAddress(
                programId,
                { limit: 10, until: until || undefined },
                CONFIG.solana.commitment
            );

            // Process oldest first (reverse order)
            const sortedSigs = signatures.reverse();
            
            // Filter out signatures at or before lastProcessedSlot (slot-based guard)
            const newSigs = sortedSigs.filter(sig => (sig.slot || 0) > lastProcessedSlot);

            if (newSigs.length === 0) return;

            // Update cursor to the newest signature BEFORE processing
            // This prevents re-processing on next poll cycle
            const newestSig = newSigs[newSigs.length - 1].signature;
            const newestSlot = newSigs[newSigs.length - 1].slot;
            await this.db.updateRelayerStatus({
                lastProcessedSignature: newestSig,
                lastProcessedSlot: newestSlot
            });

            for (const sig of newSigs) {
                if (sig.err) continue;
                
                const alreadyProcessed = await this.db.isProcessed(sig.signature);
                if (alreadyProcessed) continue;

                const messageData = await this.parseSolanaTransaction(sig.signature);
                if (!messageData) {
                    // Not a RevenueProcessed transaction, skip silently
                    continue;
                }

                const savedMessage = await this.db.insertMessage(messageData);
                if (savedMessage) {
                    console.log(`[BscRelayer] Polled new message: ${sig.signature} (slot: ${sig.slot})`);
                    await this.db.logOperation(savedMessage.id, 'detect', { source: 'poll', slot: sig.slot });
                    await this.processMessage(savedMessage);
                }
            }
        } catch (error) {
            console.error('[BscRelayer] Error polling Solana transactions:', error.message);
        }
    }

    /**
     * Parse Solana transaction
     */
    async parseSolanaTransaction(txSignature) {
        try {
            console.log(`[BscRelayer] Fetching transaction details for ${txSignature}...`);
            
            const txDetails = await this.solanaConn.getParsedTransaction(
                txSignature, 
                { maxSupportedTransactionVersion: 0 }
            );

            if (!txDetails) {
                console.log(`[BscRelayer] No tx details for ${txSignature}`);
                return null;
            }
            
            if (!txDetails.meta) {
                console.log(`[BscRelayer] No tx meta for ${txSignature}`);
                return null;
            }
            
            console.log(`[BscRelayer] Got tx details, logMessages: ${txDetails.meta.logMessages?.length || 0}`);

            let amount = null;
            let teamFunds = null;
            let recipientEth = null;
            let senderSolana = null;

            const logMessages = txDetails.meta.logMessages || [];
            
            // Get all known discriminators (no logging for performance)
            const allDiscriminators = this.getAllEventDiscriminators();
            
            for (const log of logMessages) {
                // Anchor events (emit!) are serialized as base64 in "Program data:" log lines
                // NOT in "Program log:" which contains text messages (msg!())
                if (log.includes('Program data:')) {
                    const base64Data = log.split('Program data:')[1]?.trim();
                    if (base64Data) {
                        try {
                            const debugBuffer = Buffer.from(base64Data, 'base64');
                            const discHex = debugBuffer.slice(0, 8).toString('hex');
                            const eventName = allDiscriminators[discHex];
                            
                            // Only process RevenueProcessed events
                            if (eventName === 'RevenueProcessed') {
                                const eventData = this.parseAnchorEvent(base64Data);
                                if (eventData) {
                                    console.log(`[BscRelayer] Found RevenueProcessed: amount=${eventData.amount}, recipient=${eventData.recipientEth}`);
                                    amount = eventData.amount || amount;
                                    teamFunds = eventData.teamFunds || teamFunds;
                                    recipientEth = eventData.recipientEth || recipientEth;
                                    senderSolana = eventData.sender || senderSolana;
                                }
                            }
                        } catch (e) {
                            // Silent fail for event parsing
                        }
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
            
            // Fallback: Try to read from CrossChainMessage account
            if (!amount || !recipientEth) {
                const accountData = await this.parseCrossChainMessageAccount(txDetails);
                if (accountData) {
                    console.log(`[BscRelayer] Found CrossChainMessage account data`);
                    amount = accountData.amount || amount;
                    teamFunds = accountData.teamFunds || teamFunds;
                    recipientEth = accountData.recipientEth || recipientEth;
                    senderSolana = accountData.sender || senderSolana;
                }
            }

            // amount is required, recipientEth is optional (not needed for PoolB injection)
            if (!amount) {
                // Not a RevenueProcessed transaction
                return null;
            }

            // Convert Solana signature to bytes32
            const sigBytes = bs58.decode(txSignature);
            const solanaTxSigBytes32 = '0x' + createKeccakHash('keccak256')
                .update(Buffer.concat([Buffer.alloc(32), sigBytes.slice(0, 32)]))
                .digest('hex');

            return {
                solanaTxSig: txSignature,
                solanaTxSigBytes32,
                amount: amount.toString(),
                teamFunds: teamFunds ? teamFunds.toString() : '0',
                recipientEth: recipientEth || '0x0000000000000000000000000000000000000000',
                senderSolana: senderSolana || 'unknown',
                solanaBlockTime: txDetails.blockTime
            };

        } catch (error) {
            console.error(`[BscRelayer] Error parsing transaction ${txSignature}:`, error.message);
            console.error(`[BscRelayer] Error stack:`, error.stack);
            return null;
        }
    }

    /**
     * Get all known event discriminators from IDL
     * Note: Anchor event discriminators are computed as sha256("event:event_name")[0:8]
     * But we use the values from the IDL to ensure accuracy
     */
    getAllEventDiscriminators() {
        // Discriminator values from seth_bridge.json IDL events section
        const idlEvents = {
            'CommissionWithdrawn': [254, 232, 110, 152, 180, 119, 151, 159],  // feee6e98b477979f
            'CrossChainCompleted': [31, 133, 249, 252, 26, 228, 226, 174],   // 1f85f9fc1ae4e2ae
            'MonthlySettlement': [96, 181, 30, 121, 119, 67, 84, 36],        // 60b51e7977c35424
            'ReferrerSet': [65, 187, 29, 205, 116, 229, 69, 154],            // 41bb1bcd74e5459a
            'RelayerUpdated': [166, 12, 250, 34, 211, 198, 204, 222],        // a60cfa22d3c6ccde
            'RevenueProcessed': [181, 26, 199, 237, 159, 186, 73, 241],      // b51ac7ed9fba49f1
        };
        
        const discriminators = {};
        for (const [name, bytes] of Object.entries(idlEvents)) {
            const hex = Buffer.from(bytes).toString('hex');
            discriminators[hex] = name;
        }
        return discriminators;
    }

    /**
     * Get RevenueProcessed event discriminator from IDL
     */
    getRevenueProcessedDiscriminator() {
        // From IDL: [181, 26, 199, 237, 159, 186, 73, 241] = b51ac7ed9fba49f1
        return Buffer.from([181, 26, 199, 237, 159, 186, 73, 241]);
    }

    /**
     * Parse Anchor event data (RevenueProcessed event)
     * 
     * RevenueProcessed event structure (updated with seth_recipient):
     * - 8 bytes: event discriminator
     * - 32 bytes: user (Pubkey)
     * - 8 bytes: amount (u64) - original amount
     * - 8 bytes: commission_l1 (u64)
     * - 8 bytes: commission_l2 (u64)
     * - 8 bytes: team_funds (u64) - 5% team funds
     * - 8 bytes: project_funds (u64)
     * - 8 bytes: ecosystem_funds (u64) - 30% ecosystem funds
     * - 1 byte: has_l1_referrer (bool)
     * - 32 bytes: l1_referrer (Option<Pubkey>) - only if has_l1_referrer
     * - 1 byte: has_l2_referrer (bool)
     * - 32 bytes: l2_referrer (Option<Pubkey>) - only if has_l2_referrer
     * - 1 byte: product_type (u8)
     * - 20 bytes: seth_recipient (EVM address)
     * - 8 bytes: timestamp (i64)
     * 
     * Minimum size with seth_recipient: 8 + 32 + 8*5 + 1 + 1 + 1 + 20 = 103 bytes (no referrers)
     * Minimum size without seth_recipient (old format): 8 + 32 + 8*5 + 1 + 1 + 1 + 8 = 87 bytes
     */
    parseAnchorEvent(base64Data) {
        try {
            const buffer = Buffer.from(base64Data, 'base64');
            
            // Minimum size check: at least discriminator
            if (buffer.length < 8) return null;

            // Check if this is a RevenueProcessed event by discriminator
            const discriminator = buffer.slice(0, 8);
            const expectedDiscriminator = this.getRevenueProcessedDiscriminator();
            
            if (!discriminator.equals(expectedDiscriminator)) {
                // Not a RevenueProcessed event, skip silently
                return null;
            }

            // Minimum size check: at least discriminator + user + amounts
            if (buffer.length < 8 + 32 + 8*5) return null;

            let offset = 8; // Skip discriminator
            
            // Read user (32 bytes)
            offset += 32;
            
            // Read amount (8 bytes)
            const amount = buffer.readBigUInt64LE(offset);
            offset += 8;
            
            // Read commission_l1 (8 bytes)
            offset += 8;
            
            // Read commission_l2 (8 bytes)
            offset += 8;
            
            // Read team_funds (8 bytes)
            const teamFunds = buffer.readBigUInt64LE(offset);
            offset += 8;
            
            // Read project_funds (8 bytes)
            offset += 8;
            
            // Read ecosystem_funds (8 bytes)
            const ecosystemFunds = buffer.readBigUInt64LE(offset);
            offset += 8;
            
            // Read l1_referrer (Option<Pubkey>)
            if (buffer.length < offset + 1) return null;
            const hasL1Referrer = buffer.readUInt8(offset) === 1;
            offset += 1;
            if (hasL1Referrer) {
                if (buffer.length < offset + 32) return null;
                offset += 32;
            }
            
            // Read l2_referrer (Option<Pubkey>)
            if (buffer.length < offset + 1) return null;
            const hasL2Referrer = buffer.readUInt8(offset) === 1;
            offset += 1;
            if (hasL2Referrer) {
                if (buffer.length < offset + 32) return null;
                offset += 32;
            }
            
            // Read product_type (1 byte)
            if (buffer.length < offset + 1) return null;
            const productType = buffer.readUInt8(offset);
            offset += 1;
            
            // Read seth_recipient (20 bytes EVM address)
            // Only if buffer has enough space (new format with seth_recipient)
            let recipientEth = null;
            const remainingBytes = buffer.length - offset;
            
            if (remainingBytes >= 20) {
                // New format: 20 bytes seth_recipient + 8 bytes timestamp
                const recipientEthBytes = buffer.slice(offset, offset + 20);
                recipientEth = '0x' + recipientEthBytes.toString('hex');
                // Don't increment offset, we're done
            } else if (remainingBytes >= 8) {
                // Old format: only 8 bytes timestamp, no seth_recipient
                // Skip this event as it doesn't have the recipient
                return null;
            } else {
                // Not enough data
                return null;
            }
            
            return { 
                amount: ecosystemFunds.toString(),
                teamFunds: teamFunds.toString(),
                originalAmount: amount.toString(),
                recipientEth,
                productType
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Parse CrossChainMessage account from transaction
     * This is a fallback when event parsing fails
     */
    async parseCrossChainMessageAccount(txDetails) {
        try {
            const programId = new PublicKey(CONFIG.solana.programId);
            
            // Find CrossChainMessage accounts created in this transaction
            const accountKeys = txDetails.transaction?.message?.accountKeys || [];
            
            for (const account of accountKeys) {
                const pubkey = account.pubkey || account;
                if (typeof pubkey === 'string') continue;
                
                // Check if this is a PDA owned by our program
                const accountInfo = await this.solanaConn.getAccountInfo(pubkey);
                if (!accountInfo || !accountInfo.owner.equals(programId)) continue;
                
                const data = accountInfo.data;
                
                // CrossChainMessage discriminator from IDL: [13, 175, 177, 236, 30, 82, 224, 162]
                const ccmDiscriminator = Buffer.from([13, 175, 177, 236, 30, 82, 224, 162]);
                
                if (data.length < 8 || !data.slice(0, 8).equals(ccmDiscriminator)) continue;
                
                console.log(`[BscRelayer] Found CrossChainMessage account: ${pubkey.toBase58()}`);
                
                // Parse CrossChainMessage (after 8-byte discriminator)
                let offset = 8;
                
                // sender: Pubkey (32 bytes)
                const sender = new PublicKey(data.slice(offset, offset + 32));
                offset += 32;
                
                // original_amount: u64
                const originalAmount = data.readBigUInt64LE(offset);
                offset += 8;
                
                // amount: u64 (ecosystem funds 30%)
                const amount = data.readBigUInt64LE(offset);
                offset += 8;
                
                // team_funds: u64
                const teamFunds = data.readBigUInt64LE(offset);
                offset += 8;
                
                // seth_recipient: [u8; 20]
                const recipientEth = '0x' + data.slice(offset, offset + 20).toString('hex');
                offset += 20;
                
                console.log(`[BscRelayer] Parsed CrossChainMessage: amount=${amount}, teamFunds=${teamFunds}, recipient=${recipientEth}`);
                
                return {
                    sender: sender.toBase58(),
                    amount: amount.toString(),
                    teamFunds: teamFunds.toString(),
                    recipientEth
                };
            }
            
            return null;
        } catch (error) {
            console.error(`[BscRelayer] Error parsing CrossChainMessage account:`, error.message);
            return null;
        }
    }

    /**
     * Parse instruction data
     * Note: This is a fallback for events, may not work with all instruction formats
     */
    parseInstructionData(txDetails) {
        try {
            const instructions = txDetails.transaction?.message?.instructions || [];
            
            for (const ix of instructions) {
                if (ix.programId?.toString() === CONFIG.solana.programId) {
                    const data = Buffer.from(ix.data, 'base64');
                    
                    // process_revenue instruction: 8 bytes discriminator + 8 bytes amount + 1 byte product_type + 20 bytes recipient
                    if (data.length >= 8 + 8 + 1 + 20) {
                        let offset = 8;
                        const amount = data.readBigUInt64LE(offset);
                        offset += 8;
                        
                        // Skip product_type
                        offset += 1;
                        
                        const recipientEthBytes = data.slice(offset, offset + 20);
                        const recipientEth = '0x' + recipientEthBytes.toString('hex');
                        
                        // Validate amount is reasonable (max 1 billion USDC with 6 decimals = 10^15)
                        if (amount > BigInt('1000000000000000')) {
                            // Amount too large, likely not a valid process_revenue instruction
                            continue;
                        }
                        
                        return { amount: amount.toString(), recipientEth };
                    }
                }
            }
            return null;
        } catch (error) {
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
            console.log(`[BscRelayer] Found ${messages.length} pending messages`);

            for (const message of messages) {
                if (this.isShuttingDown) break;
                await this.processMessage(message);
            }
        } catch (error) {
            console.error('[BscRelayer] Error processing pending messages:', error.message);
        }
    }

    /**
     * Process single message - call BSC bridge contract
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

            console.log(`[BscRelayer] Processing message ${id}: ${solana_tx_sig}`);
            console.log(`[BscRelayer]   Ecosystem Amount (30%): ${amount}`);
            console.log(`[BscRelayer]   Team Funds (5%): ${team_funds || 0}`);
            console.log(`[BscRelayer]   Recipient: ${recipient_eth}`);

            // Cross-chain fund processing:
            // BscBridge.processCrossChainMessage(bytes32 solanaTxSig, uint256 ecosystemAmount, uint256 teamFundsAmount, uint256 amountBNB)
            // - ecosystemAmount: 30% ecosystem funds -> inject to PoolB
            // - teamFundsAmount: 5% team funds -> to TeamPayroll (auto-swap to BNB via PoolB)
            // - amountBNB: native BNB (for PoolB liquidity pairing)
            const ecosystemAmount = BigInt(amount || 0);
            const teamFundsAmount = BigInt(team_funds || 0);
            // 动态计算配对的 BNB 数量，基于 PoolB 当前价格
            const amountBNB = await this.calculateNativeAmount(ecosystemAmount);
            
            const inputData = this.bscClient.encodeProcessCrossChainMessage(
                solana_tx_sig_bytes32, 
                ecosystemAmount, 
                teamFundsAmount, 
                amountBNB
            );
            const selector = inputData.slice(2, 10);
            console.log(`[BscRelayer] BSC call: processCrossChainMessage selector=0x${selector}`);
            console.log(`[BscRelayer]   ecosystemAmount=${ecosystemAmount.toString()} teamFundsAmount=${teamFundsAmount.toString()} msg.value=${amountBNB.toString()}`);

            // Build transaction options
            const txOptions = {
                gasLimit: CONFIG.bsc.gasLimit,
                value: amountBNB.toString()
            };
            
            // If Gas price is configured, use configured value
            if (CONFIG.bsc.gasPrice) {
                txOptions.gasPrice = CONFIG.bsc.gasPrice;
            }

            // Use BscClient to send transaction
            const result = await this.bscClient.sendContractCall(
                CONFIG.bsc.bridgeAddress,
                inputData,
                txOptions
            );

            if (result.success) {
                console.log(`[BscRelayer] BSC tx sent: ${result.txHash}`);
                console.log(`[BscRelayer] Explorer: https://testnet.bscscan.com/tx/${result.txHash}`);

                // Wait for transaction confirmation
                const receipt = await this.bscClient.waitReceipt(result.txHash, 30, 2000);
                
                if (receipt) {
                    console.log(`[BscRelayer] BSC tx confirmed in block ${receipt.blockNumber}`);
                    console.log(`[BscRelayer] Gas used: ${receipt.gasUsed}`);
                    
                    if (receipt.status === 0) {
                        throw new Error(`Transaction reverted on-chain (status=0): ${result.txHash}`);
                    }
                } else {
                    console.warn(`[BscRelayer] Could not get receipt for ${result.txHash}, assuming success`);
                }
                
                await this.db.markAsCompleted(id, {
                    txHash: result.txHash,
                    blockNumber: receipt?.blockNumber || 0
                });

                this.stats.totalProcessed++;
                // ecosystemAmount is 6 decimals (USDC), rough statistics only
                this.stats.totalRevenueProcessed += Number(ecosystemAmount) / 1e6;
                this.stats.lastProcessedAt = new Date();
                
                console.log(`[BscRelayer] Successfully processed message ${id}`);
            } else {
                throw new Error(result.error || 'Transaction failed');
            }

        } catch (error) {
            console.error(`[BscRelayer] Error processing message ${id}:`, error.message);
            
            this.stats.totalFailed++;
            
            const isRetryable = this.isRetryableError(error);
            
            if (isRetryable) {
                const result = await this.db.markAsFailed(id, error.message, CONFIG.relayer.maxRetries);
                console.log(`[BscRelayer] Message ${id} marked for retry (${result.retry_count}/${CONFIG.relayer.maxRetries})`);
            } else {
                await this.db.markAsFailed(id, `Non-retryable: ${error.message}`, 0);
                console.log(`[BscRelayer] Message ${id} marked as permanently failed`);
            }
        }
    }

    /**
     * Determine if error is retryable
     */
    isRetryableError(error) {
        const errorMessage = error.message?.toLowerCase() || '';
        
        // Only truly permanent errors should be non-retryable
        const nonRetryablePatterns = [
            'already processed',
            'invalid recipient',
            'invalid amount',
        ];

        for (const pattern of nonRetryablePatterns) {
            if (errorMessage.includes(pattern)) return false;
        }

        // Contract reverts should be retried (could be transient gas/state issues)
        // Network/nonce errors are always retryable
        return true;
    }

    // ==================== Native Amount Calculation ====================

    /**
     * 从 PoolB 链上读取真实储备量，按当前价格比例计算配对的 BNB 数量
     * 公式: amountBNB = amountSUSDC * reserveSETH / reservesUSDC
     * 这样添加流动性后池子价格保持不变
     * 初始价格 0.01 sUSDC/BNB，后续由套利机器人维持
     */
    async calculateNativeAmount(amountSUSDC) {
        const fallback = BigInt(CONFIG.bsc.injectNativeWei);

        try {
            // 1. 获取 PoolB 地址（从 SethBridge.poolB() 读取）
            const poolBAddress = await this.getPoolBAddress();
            if (!poolBAddress) {
                console.warn('[BscRelayer] PoolB address not available, using fallback');
                return fallback;
            }

            // 2. 调用 PoolB.getPoolState() 获取储备量
            // 返回 7 个 uint256: reserveSETH, reservesUSDC, price, totalTx, totalVolSETH, totalVolSUSDC, nativeBalance
            const getPoolStateSelector = createKeccakHash('keccak256')
                .update('getPoolState()')
                .digest('hex')
                .slice(0, 8);

            const result = await this.bscClient.callContract(poolBAddress, '0x' + getPoolStateSelector);

            if (!result.success || !result.data || result.data.length < 194) {
                console.warn('[BscRelayer] PoolB getPoolState failed, using fallback');
                return fallback;
            }

            // 解码: 去掉 0x 前缀，每个 uint256 占 64 hex 字符
            const data = result.data.replace(/^0x/, '');
            const reserveSETH = BigInt('0x' + data.slice(0, 64));
            const reservesUSDC = BigInt('0x' + data.slice(64, 128));

            if (reservesUSDC === 0n) {
                console.warn('[BscRelayer] PoolB sUSDC reserve is 0, using fallback');
                return fallback;
            }

            // 3. 按当前池子价格比例计算: amountBNB = amountSUSDC * reserveSETH / reservesUSDC
            const amountBNB = (amountSUSDC * reserveSETH) / reservesUSDC;

            const price = Number(reservesUSDC) / Number(reserveSETH);
            console.log(`[BscRelayer] PoolB price: 1 BNB = ${price.toFixed(6)} sUSDC`);
            console.log(`  Reserves: ${reserveSETH.toString()} BNB / ${reservesUSDC.toString()} sUSDC`);
            console.log(`  Injecting: ${amountSUSDC} sUSDC raw (${Number(amountSUSDC) / 1e6} sUSDC)`);
            console.log(`  Paired BNB: ${amountBNB.toString()} wei (${Number(amountBNB) / 1e18} BNB)`);

            if (amountBNB === 0n) {
                console.warn('[BscRelayer] Calculated BNB is 0, using fallback');
                return fallback;
            }

            return amountBNB;
        } catch (error) {
            console.warn(`[BscRelayer] calculateNativeAmount error: ${error.message}, using fallback`);
            return fallback;
        }
    }

    /**
     * 从 SethBridge 合约读取 PoolB 地址（缓存）
     */
    async getPoolBAddress() {
        if (this._poolBAddress) return this._poolBAddress;

        try {
            // poolB() 是 public 字段，selector = keccak256("poolB()")[:4]
            const selector = createKeccakHash('keccak256')
                .update('poolB()')
                .digest('hex')
                .slice(0, 8);

            const result = await this.bscClient.callContract(
                CONFIG.bsc.bridgeAddress,
                '0x' + selector
            );

            if (result.success && result.data && result.data.length >= 66) {
                // address 是 32 字节中的最后 20 字节
                const data = result.data.replace(/^0x/, '');
                this._poolBAddress = '0x' + data.slice(24, 64);
                console.log(`[BscRelayer] PoolB address: ${this._poolBAddress}`);
                return this._poolBAddress;
            }
        } catch (error) {
            console.warn(`[BscRelayer] Failed to get PoolB address: ${error.message}`);
        }
        return null;
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

        console.log('[BscRelayer] Retry scheduler started');
    }

    /**
     * Process pending retry messages
     */
    async processRetries() {
        try {
            const messages = await this.db.getPendingRetries(CONFIG.relayer.batchSize);
            
            if (messages.length === 0) return;

            console.log(`[BscRelayer] Processing ${messages.length} retry messages`);

            for (const message of messages) {
                if (this.isShuttingDown) break;
                
                console.log(`[BscRelayer] Retrying message ${message.id} (attempt ${message.retry_count + 1})`);
                await this.db.logOperation(message.id, 'retry', { attempt: message.retry_count + 1 });
                await this.processMessage(message);
            }
        } catch (error) {
            console.error('[BscRelayer] Error processing retries:', error.message);
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
                const bscBalance = await this.bscClient.getBalance(this.relayerAddress);
                const bscBalanceBNB = await this.bscClient.getBalanceInBNB(this.relayerAddress);
                
                console.log('[BscRelayer] Stats:', {
                    ...dbStats,
                    bscBalance: `${bscBalanceBNB} tBNB`,
                    sessionProcessed: this.stats.totalProcessed,
                    sessionFailed: this.stats.totalFailed,
                    lastProcessed: this.stats.lastProcessedAt
                });
            } catch (error) {
                console.error('[BscRelayer] Error getting stats:', error.message);
            }
        }, 60000);
    }
}

// ==================== Main Entry ====================

async function main() {
    const relayer = new BscBridgeRelayer();

    process.on('SIGINT', async () => {
        console.log('\n[BscRelayer] Received SIGINT');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n[BscRelayer] Received SIGTERM');
        await relayer.shutdown();
        process.exit(0);
    });

    process.on('uncaughtException', (error) => {
        console.error('[BscRelayer] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('[BscRelayer] Unhandled rejection:', reason);
    });

    try {
        await relayer.initialize();
        await relayer.start();
    } catch (error) {
        console.error('[BscRelayer] Failed to start:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = BscBridgeRelayer;