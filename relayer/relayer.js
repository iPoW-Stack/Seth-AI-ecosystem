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
        
        // 1. Initialize database (test connection + run migrations)
        this.db = new Database(CONFIG.database);
        await this.db.initialize();

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
        // Note: onLogs callback signature is (logs, slot) where logs has { err, logs, signature }
        this.solanaConn.onLogs(
            programId,
            async (logs, slot) => {
                if (this.isShuttingDown) return;
                await this.handleSolanaLogs(logs, slot);
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
     * Only polls for NEW transactions since last check
     */
    async pollSolanaTransactions() {
        try {
            const status = await this.db.getRelayerStatus();
            const programId = new PublicKey(CONFIG.solana.programId);
            
            // Get the last processed signature to only fetch new transactions
            const until = status?.last_processed_signature;
            
            const signatures = await this.solanaConn.getSignaturesForAddress(
                programId,
                { limit: 5, until: until || undefined },
                CONFIG.solana.commitment
            );

            // Process oldest first (reverse order)
            const sortedSigs = signatures.reverse();
            
            // Update last processed signature to the newest one BEFORE processing
            // This prevents re-processing on next poll cycle
            if (sortedSigs.length > 0) {
                const newestSig = sortedSigs[sortedSigs.length - 1].signature;
                await this.db.updateRelayerStatus({
                    lastProcessedSignature: newestSig
                });
            }

            for (const sig of sortedSigs) {
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
                    console.log(`[Relayer] Polled new message: ${sig.signature}`);
                    await this.db.logOperation(savedMessage.id, 'detect', { source: 'poll' });
                    await this.processMessage(savedMessage);
                }
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
            console.log(`[Relayer] Fetching transaction details for ${txSignature}...`);
            
            const txDetails = await this.solanaConn.getParsedTransaction(
                txSignature, 
                { maxSupportedTransactionVersion: 0 }
            );

            if (!txDetails) {
                console.log(`[Relayer] No tx details for ${txSignature}`);
                return null;
            }
            
            if (!txDetails.meta) {
                console.log(`[Relayer] No tx meta for ${txSignature}`);
                return null;
            }
            
            console.log(`[Relayer] Got tx details, logMessages: ${txDetails.meta.logMessages?.length || 0}`);

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
                                    console.log(`[Relayer] Found RevenueProcessed: amount=${eventData.amount}, recipient=${eventData.recipientEth}`);
                                    amount = eventData.amount || amount;
                                    teamFunds = eventData.teamFunds || teamFunds;
                                    recipientEth = eventData.recipientEth || recipientEth;
                                    senderSolana = eventData.user || senderSolana;
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

            if (!amount) {
                const parsedData = this.parseInstructionData(txDetails);
                if (parsedData) {
                    amount = parsedData.amount || amount;
                    recipientEth = parsedData.recipientEth || recipientEth;
                    senderSolana = parsedData.sender || senderSolana;
                }
            }
            
            // Fallback: Try to read from CrossChainMessage account
            if (!amount) {
                const accountData = await this.parseCrossChainMessageAccount(txDetails);
                if (accountData) {
                    console.log(`[Relayer] Found CrossChainMessage account data`);
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
            console.error(`[Relayer] Error parsing transaction ${txSignature}:`, error.message);
            console.error(`[Relayer] Error stack:`, error.stack);
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
                
                console.log(`[Relayer] Found CrossChainMessage account: ${pubkey.toBase58()}`);
                
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
                
                console.log(`[Relayer] Parsed CrossChainMessage: amount=${amount}, teamFunds=${teamFunds}, recipient=${recipientEth}`);
                
                return {
                    sender: sender.toBase58(),
                    amount: amount.toString(),
                    teamFunds: teamFunds.toString(),
                    recipientEth
                };
            }
            
            return null;
        } catch (error) {
            console.error(`[Relayer] Error parsing CrossChainMessage account:`, error.message);
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
            // 动态计算配对的 SETH 数量，基于 PoolB 当前价格
            const amountSETH = await this.calculateNativeAmount(ecosystemAmount);
            
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
                { gasLimit: 1000000, gasPrice: 1, amount: amountSETH.toString() }
            );

            // Check if Seth reports "already processed" → treat as success
            const errMsg = result.success ? null : (result.error || 'Transaction failed');
            if (errMsg && errMsg.toLowerCase().includes('already processed')) {
                console.log(`[Relayer] SethBridge reports already processed for message ${id}, marking as completed`);
                await this.db.markAsCompleted(id, {
                    txHash: result.txHash || 'already-processed',
                    blockNumber: 0
                });
                this.stats.totalProcessed++;
                this.stats.lastProcessedAt = new Date();
                return;
            }

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
                // Check if receipt shows "already processed" revert → treat as success
                if (receipt?.revertReason && receipt.revertReason.toLowerCase().includes('already processed')) {
                    console.log(`[Relayer] Receipt shows already processed for message ${id}, marking as completed`);
                    await this.db.markAsCompleted(id, { txHash: result.txHash, blockNumber: receipt.nonce || 0 });
                    this.stats.totalProcessed++;
                    this.stats.lastProcessedAt = new Date();
                    return;
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
     * 从 PoolB 链上读取真实储备量，按当前价格比例计算配对的 SETH 数量
     * 公式: amountSETH = amountSUSDC * reserveSETH / reservesUSDC
     * 初始价格 0.01 sUSDC/SETH，后续由套利机器人维持
     */
    async calculateNativeAmount(amountSUSDC) {
        const fallback = BigInt(CONFIG.seth.injectNativeWei);

        try {
            // 1. 获取 PoolB 地址（从 SethBridge.poolB() 读取）
            const poolBAddress = await this.getPoolBAddress();
            if (!poolBAddress) {
                console.warn('[Relayer] PoolB address not available, using fallback');
                return fallback;
            }

            // 2. 调用 PoolB.getPoolState() 获取储备量
            const getPoolStateSelector = createKeccakHash('keccak256')
                .update('getPoolState()')
                .digest('hex')
                .slice(0, 8);

            // SethClient.queryContract(fromHex, contractAddress, inputData)
            const response = await this.sethClient.queryContract(
                this.relayerAddress.replace('0x', ''),
                poolBAddress.replace('0x', ''),
                '0x' + getPoolStateSelector
            );

            if (!response || typeof response !== 'string' || response.length < 194) {
                console.warn('[Relayer] PoolB getPoolState failed, using fallback');
                return fallback;
            }

            // 解码: 每个 uint256 占 64 hex 字符
            const data = response.replace(/^0x/, '');
            const reserveSETH = BigInt('0x' + data.slice(0, 64));
            const reservesUSDC = BigInt('0x' + data.slice(64, 128));

            if (reservesUSDC === 0n) {
                console.warn('[Relayer] PoolB sUSDC reserve is 0, using fallback');
                return fallback;
            }

            // 3. 按当前池子价格比例计算: amountSETH = amountSUSDC * reserveSETH / reservesUSDC
            const amountSETH = (amountSUSDC * reserveSETH) / reservesUSDC;

            const price = Number(reservesUSDC) / Number(reserveSETH);
            console.log(`[Relayer] PoolB price: 1 SETH = ${price.toFixed(6)} sUSDC`);
            console.log(`  Reserves: ${reserveSETH} SETH / ${reservesUSDC} sUSDC`);
            console.log(`  Injecting: ${amountSUSDC} sUSDC raw (${Number(amountSUSDC) / 1e6} sUSDC)`);
            console.log(`  Paired SETH: ${amountSETH.toString()} wei (${Number(amountSETH) / 1e18} SETH)`);

            if (amountSETH === 0n) {
                console.warn('[Relayer] Calculated SETH is 0, using fallback');
                return fallback;
            }

            return amountSETH;
        } catch (error) {
            console.warn(`[Relayer] calculateNativeAmount error: ${error.message}, using fallback`);
            return fallback;
        }
    }

    /**
     * 从 SethBridge 合约读取 PoolB 地址（缓存）
     */
    async getPoolBAddress() {
        if (this._poolBAddress) return this._poolBAddress;

        try {
            const selector = createKeccakHash('keccak256')
                .update('poolB()')
                .digest('hex')
                .slice(0, 8);

            const response = await this.sethClient.queryContract(
                this.relayerAddress.replace('0x', ''),
                CONFIG.seth.bridgeAddress.replace('0x', ''),
                '0x' + selector
            );

            if (response && typeof response === 'string') {
                const data = response.replace(/^0x/, '');
                if (data.length >= 64) {
                    this._poolBAddress = '0x' + data.slice(24, 64);
                    console.log(`[Relayer] PoolB address: ${this._poolBAddress}`);
                    return this._poolBAddress;
                }
            }
        } catch (error) {
            console.warn(`[Relayer] Failed to get PoolB address: ${error.message}`);
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