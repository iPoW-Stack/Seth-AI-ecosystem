/**
 * Seth-Solana Cross-chain Bridge Relayer
 * 
 * Uses TrustRelayer security model
 * Seth chain uses custom transaction format (no chainId)
 */

require('dotenv').config();
const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } = require('@solana/web3.js');
const { createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const Database = require('./db/database');
const SethClient = require('./sethClient');
const { Buffer } = require('buffer');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');
const fs = require('fs');
const crypto = require('crypto');

/** Anchor `emit!(RevenueProcessed { ... })` — first 8 bytes of sha256("event:RevenueProcessed") */
const REVENUE_PROCESSED_EVENT_DISCRIMINATOR = Buffer.from([
    181, 26, 199, 237, 159, 186, 73, 241,
]);
const PROCESS_REVENUE_INSTRUCTION_DISCRIMINATOR = crypto
    .createHash('sha256')
    .update('global:process_revenue')
    .digest()
    .subarray(0, 8);

// ==================== Configuration ====================
const CONFIG = {
    // Solana Configuration
    solana: {
        rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
        programId: process.env.SOLANA_PROGRAM_ID,
        relayerKeypairPath: process.env.SOLANA_RELAYER_KEYPAIR || '',
        usdcMint: process.env.SOLANA_USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
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
        // Native SETH to pair with ecosystem inject (integer; 1 = 1 SETH, no sub-units)
        // SethBridge.processCrossChainMessageV2: msg.value must cover amountSETH
        injectSethAmount:
            process.env.SETH_INJECT_SETH || process.env.SETH_INJECT_NATIVE_WEI || '0',
        reversePollInterval: parseInt(process.env.SETH_REVERSE_POLL_INTERVAL) || 15000,
        enableReverseRelay: String(process.env.ENABLE_SETH_TO_SOLANA || 'false').toLowerCase() === 'true',
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
        this.solanaRelayer = null;
        this.isRunning = false;
        this.isShuttingDown = false;
        this.retryTimer = null;
        this.pollTimer = null;
        this.sethReverseTimer = null;
        this.lastSeenWithdrawRequestId = 0;
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
        await this.db.initialize();

        // 2. Initialize Solana connection (with proxy support)
        const connOptions = { commitment: CONFIG.solana.commitment };
        if (CONFIG.solana.proxy) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connOptions.httpsAgent = new HttpsProxyAgent(CONFIG.solana.proxy);
        }
        this.solanaConn = new Connection(CONFIG.solana.rpcUrl, connOptions);
        console.log('[Relayer] Solana connection established');
        
        if (CONFIG.solana.relayerKeypairPath) {
            try {
                const raw = fs.readFileSync(CONFIG.solana.relayerKeypairPath, 'utf8');
                const secret = Uint8Array.from(JSON.parse(raw));
                this.solanaRelayer = Keypair.fromSecretKey(secret);
                console.log(`[Relayer] Solana relayer signer: ${this.solanaRelayer.publicKey.toBase58()}`);
            } catch (e) {
                console.warn(`[Relayer] Failed to load SOLANA_RELAYER_KEYPAIR: ${e.message}`);
            }
        }

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
        
        // Start Seth -> Solana reverse bridge polling
        this.startSethReversePolling();

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
        if (this.sethReverseTimer) {
            clearInterval(this.sethReverseTimer);
            this.sethReverseTimer = null;
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
     * Start Seth -> Solana reverse bridge polling
     */
    startSethReversePolling() {
        this.sethReverseTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.pollSethWithdrawRequests();
        }, CONFIG.seth.reversePollInterval);
        console.log('[Relayer] Seth reverse polling started');
    }

    /**
     * Poll SethBridge withdraw requests.
     * This is the entry for reverse bridge (SETH sUSDC -> Solana USDC).
     */
    async pollSethWithdrawRequests() {
        try {
            const total = await this.sethClient.getTotalWithdrawRequests(
                this.relayerAddress,
                CONFIG.seth.bridgeAddress
            );
            if (!Number.isFinite(total) || total <= this.lastSeenWithdrawRequestId) return;
            
            for (let requestId = this.lastSeenWithdrawRequestId + 1; requestId <= total; requestId++) {
                if (this.isShuttingDown) break;

                const gate = await this.db.getSethWithdrawByRequestId(CONFIG.seth.bridgeAddress, requestId);
                if (
                    gate &&
                    gate.status === 'pending' &&
                    gate.retry_count > 0 &&
                    gate.next_retry_at &&
                    new Date(gate.next_retry_at) > new Date()
                ) {
                    console.log(
                        `[Relayer] Withdraw request #${requestId} in retry backoff until ${gate.next_retry_at}`
                    );
                    continue;
                }

                const req = await this.sethClient.getWithdrawRequest(
                    this.relayerAddress,
                    CONFIG.seth.bridgeAddress,
                    requestId
                );
                if (!req) {
                    console.warn(
                        `[Relayer] getWithdrawRequest returned null for id=${requestId} (Seth query may have failed); will retry`
                    );
                    const failedRow = await this.db.markSethWithdrawFailed(
                        CONFIG.seth.bridgeAddress,
                        requestId,
                        'getWithdrawRequest returned null (query failed or HTTP 500)',
                        CONFIG.relayer.maxRetries
                    );
                    // Skip permanently bad historical ids so newer requests can still flow.
                    if (
                        failedRow &&
                        Number(failedRow.retry_count) >= Number(failedRow.max_retries || CONFIG.relayer.maxRetries)
                    ) {
                        console.warn(
                            `[Relayer] Skip stuck withdraw request #${requestId} after max retries, continue with newer ids`
                        );
                        this.lastSeenWithdrawRequestId = requestId;
                        continue;
                    }
                    // For transient errors, keep cursor in place and retry later.
                    break;
                }
                if (req.user === '0x0000000000000000000000000000000000000000') continue;
                if (req.processed) {
                    await this.db.upsertSethWithdrawRequest(CONFIG.seth.bridgeAddress, requestId, req, 'completed');
                    await this.db.markSethWithdrawCompleted(CONFIG.seth.bridgeAddress, requestId, null, null);
                    this.lastSeenWithdrawRequestId = requestId;
                    continue;
                }
                
                await this.handleSethWithdrawRequest(requestId, req);
                this.lastSeenWithdrawRequestId = requestId;
            }
        } catch (error) {
            console.error('[Relayer] Error polling Seth withdraw requests:', error.message);
        }
    }

    async handleSethWithdrawRequest(requestId, req) {
        const solanaRecipientHex = (req.solanaRecipient || '').replace(/^0x/, '');
        console.log(`[Relayer] Detected reverse withdraw request #${requestId}`);
        console.log(`[Relayer]   user=${req.user} susdcAmount=${req.susdcAmount}`);
        console.log(`[Relayer]   solanaRecipient(bytes32)=0x${solanaRecipientHex}`);

        const existingRow = await this.db.getSethWithdrawByRequestId(CONFIG.seth.bridgeAddress, requestId);
        const upserted = await this.db.upsertSethWithdrawRequest(CONFIG.seth.bridgeAddress, requestId, req, 'pending');
        if (!existingRow && upserted) {
            await this.db.logWithdrawOperation(upserted.id, 'detect', { requestId });
        }

        if (!CONFIG.seth.enableReverseRelay) {
            console.warn('[Relayer] Reverse relay disabled (ENABLE_SETH_TO_SOLANA=false), request kept pending');
            return;
        }

        const procRow = await this.db.markSethWithdrawProcessing(CONFIG.seth.bridgeAddress, requestId, req);
        await this.db.logWithdrawOperation(procRow.id, 'process', {
            attempt: (procRow.retry_count || 0) + 1,
        });

        try {
            const solanaUnlockSig = await this.processSethWithdrawToSolana(requestId, req);

            const inputData = this.encodeMarkWithdrawToSolanaProcessed(requestId);
            const result = await this.sethClient.sendContractCall(
                CONFIG.seth.privateKey,
                CONFIG.seth.bridgeAddress.replace('0x', ''),
                inputData,
                { gasLimit: 50000000, gasPrice: 1, amount: '0' }
            );
            if (!result.success) {
                throw new Error(result.error || `Failed to mark withdraw request #${requestId} processed`);
            }

            await this.db.markSethWithdrawCompleted(
                CONFIG.seth.bridgeAddress,
                requestId,
                solanaUnlockSig,
                result.txHash || null
            );
            console.log(`[Relayer] Marked withdraw request #${requestId} as processed on Seth`);
        } catch (error) {
            await this.db.markSethWithdrawFailed(CONFIG.seth.bridgeAddress, requestId, error.message, CONFIG.relayer.maxRetries);
            throw error;
        }
    }

    async processSethWithdrawToSolana(requestId, req) {
        if (!this.solanaRelayer) {
            throw new Error('SOLANA_RELAYER_KEYPAIR is required for reverse bridge unlock');
        }
        
        const amountBig = BigInt(req.susdcAmount || '0');
        if (amountBig <= 0n || amountBig > 0xffffffffffffffffn) {
            throw new Error(`Invalid reverse amount for request #${requestId}: ${req.susdcAmount}`);
        }
        
        const recipient = this.decodeSolanaRecipientPubkey(req.solanaRecipient);
        const programId = new PublicKey(CONFIG.solana.programId);
        const usdcMint = new PublicKey(CONFIG.solana.usdcMint);
        
        const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
        const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority')], programId);
        const [vaultTokenPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_token_account')], programId);
        const recipientTokenAccount = this.findAssociatedTokenAddress(recipient, usdcMint);
        const requestIdLe = Buffer.alloc(8);
        requestIdLe.writeBigUInt64LE(BigInt(requestId), 0);
        const bridgeAddressBytes = Buffer.from(
            CONFIG.seth.bridgeAddress.replace(/^0x/, '').padStart(40, '0'),
            'hex'
        );
        const [unlockReceiptPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('seth_unlock'), bridgeAddressBytes, requestIdLe],
            programId
        );
        
        // Ensure recipient ATA exists before unlock; otherwise anchor rejects with AccountNotInitialized.
        const ataInfo = await this.solanaConn.getAccountInfo(recipientTokenAccount, CONFIG.solana.commitment);
        if (!ataInfo) {
            const createAtaIx = createAssociatedTokenAccountInstruction(
                this.solanaRelayer.publicKey,
                recipientTokenAccount,
                recipient,
                usdcMint
            );
            const ataTx = new Transaction().add(createAtaIx);
            const ataSig = await this.solanaConn.sendTransaction(ataTx, [this.solanaRelayer], { skipPreflight: false });
            const ataConf = await this.solanaConn.confirmTransaction(ataSig, CONFIG.solana.commitment);
            if (ataConf?.value?.err) {
                throw new Error(`Create recipient ATA failed for request #${requestId}: ${JSON.stringify(ataConf.value.err)}`);
            }
            console.log(`[Relayer] Created recipient ATA for request #${requestId}: ${ataSig}`);
        }

        const requestKey =
            (await this.sethClient.getWithdrawRequestKey(this.relayerAddress, CONFIG.seth.bridgeAddress, requestId)) ||
            this.makeSethRequestHash(requestId);
        const ixData = this.encodeUnlockFromSeth(
            CONFIG.seth.bridgeAddress,
            requestId,
            amountBig,
            requestKey
        );
        
        const ix = new TransactionInstruction({
            programId,
            keys: [
                { pubkey: this.solanaRelayer.publicKey, isSigner: true, isWritable: true },
                { pubkey: configPda, isSigner: false, isWritable: false },
                { pubkey: vaultTokenPda, isSigner: false, isWritable: true },
                { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
                { pubkey: recipientTokenAccount, isSigner: false, isWritable: true },
                { pubkey: unlockReceiptPda, isSigner: false, isWritable: true },
                { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: ixData,
        });
        
        const tx = new Transaction().add(ix);
        const sig = await this.solanaConn.sendTransaction(tx, [this.solanaRelayer], { skipPreflight: false });
        const conf = await this.solanaConn.confirmTransaction(sig, CONFIG.solana.commitment);
        if (conf?.value?.err) {
            throw new Error(`Solana unlock tx failed for request #${requestId}: ${JSON.stringify(conf.value.err)}`);
        }
        
        console.log(`[Relayer] Solana unlock confirmed for request #${requestId}: ${sig}`);
        return sig;
    }

    decodeSolanaRecipientPubkey(bytes32Hex) {
        const raw = (bytes32Hex || '').replace(/^0x/, '');
        if (raw.length !== 64) {
            throw new Error(`Invalid solanaRecipient bytes32: ${bytes32Hex}`);
        }
        return new PublicKey(Buffer.from(raw, 'hex'));
    }

    findAssociatedTokenAddress(walletAddress, tokenMintAddress) {
        const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const [ata] = PublicKey.findProgramAddressSync(
            [walletAddress.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), tokenMintAddress.toBuffer()],
            ASSOCIATED_TOKEN_PROGRAM_ID
        );
        return ata;
    }

    encodeUnlockFromSeth(bridgeAddress, requestId, amount, sethTxHashBytes32) {
        // Anchor instruction discriminator: sha256("global:unlock_from_seth")[0..8] (not keccak)
        const discriminator = crypto.createHash('sha256').update('global:unlock_from_seth').digest().subarray(0, 8);
        const bridgeAddressWord = Buffer.alloc(20, 0);
        const bridgeAddressRaw = (bridgeAddress || '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(bridgeAddressRaw)) {
            throw new Error(`Invalid SETH_BRIDGE_ADDRESS for unlock_from_seth: ${bridgeAddress}`);
        }
        Buffer.from(bridgeAddressRaw, 'hex').copy(bridgeAddressWord);
        const requestIdLe = Buffer.alloc(8);
        requestIdLe.writeBigUInt64LE(BigInt(requestId), 0);
        const amountLe = Buffer.alloc(8);
        amountLe.writeBigUInt64LE(BigInt(amount), 0);
        const hash = Buffer.from((sethTxHashBytes32 || '').replace(/^0x/, '').padStart(64, '0'), 'hex');
        return Buffer.concat([discriminator, bridgeAddressWord, requestIdLe, amountLe, hash]);
    }

    makeSethRequestHash(requestId) {
        const bridge = (CONFIG.seth.bridgeAddress || '').replace(/^0x/, '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(bridge)) {
            throw new Error(`Invalid SETH_BRIDGE_ADDRESS for request hash: ${CONFIG.seth.bridgeAddress}`);
        }
        const reqWord = BigInt(requestId).toString(16).padStart(64, '0');
        const payloadHex = bridge + reqWord;
        return '0x' + createKeccakHash('keccak256').update(Buffer.from(payloadHex, 'hex')).digest('hex');
    }

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
            if (!this.isWhitelistedLockTransaction(txDetails)) {
                return null;
            }

            let amount = null;
            let recipientEth = null;
            let senderSolana = null;

            const logMessages = txDetails.meta.logMessages || [];
            for (const log of logMessages) {
                // Anchor emits #[event] as `Program data: <base64>` (sol_log_data), not `Program log:`.
                // Parsing arbitrary `Program log:` base64 misaligns offsets and yields garbage u64s.
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

            if (!amount || !recipientEth) {
                // console.warn(`[Relayer] Could not parse amount/recipient from ${txSignature}`);
                return null;
            }

            const normalizedAmount = this.normalizeDbBigInt(amount, 'amount', txSignature);
            if (normalizedAmount === null) return null;
            // Convert Solana signature to bytes32
            const sigBytes = bs58.decode(txSignature);
            const solanaTxSigBytes32 = '0x' + createKeccakHash('keccak256')
                .update(Buffer.concat([Buffer.alloc(32), sigBytes.slice(0, 32)]))
                .digest('hex');

            return {
                solanaTxSig: txSignature,
                solanaTxSigBytes32,
                amount: normalizedAmount.toString(),
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
     * Parse RevenueProcessed from raw Anchor event bytes (Program data payload).
     * Must match `contracts/solana/src/events.rs` (Borsh): no product_type field.
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
            const originalAmount = buffer.readBigUInt64LE(offset);
            offset += 8;
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
                originalAmount: originalAmount.toString(),
                recipientEth,
                sender,
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
                    const data = this.decodeProgramInstructionData(ix.data);
                    if (!data || data.length < 8) continue;
                    if (!data.slice(0, 8).equals(PROCESS_REVENUE_INSTRUCTION_DISCRIMINATOR)) continue;
                    
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

    decodeProgramInstructionData(dataStr) {
        if (typeof dataStr !== 'string' || dataStr.length === 0) return null;
        try {
            return bs58.decode(dataStr);
        } catch {}
        try {
            return Buffer.from(dataStr, 'base64');
        } catch {}
        return null;
    }

    isWhitelistedLockTransaction(txDetails) {
        const logMessages = txDetails.meta?.logMessages || [];
        const hasProcessRevenueLog = logMessages.some((log) => log.includes('Instruction: ProcessRevenue'));
        if (!hasProcessRevenueLog) return false;

        const hasRevenueEvent = logMessages.some((log) => {
            if (!log.includes('Program data:')) return false;
            const rest = log.split('Program data:')[1]?.trim();
            const base64Data = rest ? rest.split(/\s+/)[0] : '';
            if (!base64Data) return false;
            try {
                const buf = Buffer.from(base64Data, 'base64');
                return !!this.parseRevenueProcessedEventBuffer(buf);
            } catch {
                return false;
            }
        });
        if (!hasRevenueEvent) return false;

        const instructions = txDetails.transaction?.message?.instructions || [];
        const hasProcessRevenueIx = instructions.some((ix) => {
            if (ix.programId?.toString() !== CONFIG.solana.programId) return false;
            const data = this.decodeProgramInstructionData(ix.data);
            return !!(data && data.length >= 8 && data.slice(0, 8).equals(PROCESS_REVENUE_INSTRUCTION_DISCRIMINATOR));
        });

        return hasProcessRevenueIx;
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
     * Distribution scheme (10-5-0-50-35):
     * - L1 Commission (10%) -> Solana real-time transfer to referrer
     * - L2 Commission (5%)  -> Solana real-time transfer to L2 referrer
     * - Project Reserve (50%) -> Solana real-time transfer to Gnosis Safe
     * - Cross-chain Ecosystem (35%) -> Cross-chain to PoolB (amount field)
     */
    async processMessage(message) {
        const { id, solana_tx_sig, solana_tx_sig_bytes32, amount, recipient_eth } = message;

        try {
            await this.db.markAsProcessing(id);
            await this.db.logOperation(id, 'process', { attempt: message.retry_count + 1 });

            console.log(`[Relayer] Processing message ${id}: ${solana_tx_sig}`);
            console.log(`[Relayer]   Ecosystem Amount (35%): ${amount}`);
            console.log(`[Relayer]   Recipient: ${recipient_eth}`);

            // Cross-chain fund processing:
            // SethBridge.processCrossChainMessageV2(bytes32,uint256,uint256,address)
            const ecosystemAmount = BigInt(amount || 0);
            const amountSETH = BigInt(CONFIG.seth.injectSethAmount);

            const inputData = this.encodeProcessCrossChainMessageV2(
                solana_tx_sig_bytes32,
                ecosystemAmount,
                amountSETH,
                recipient_eth
            );
            const selector = inputData.slice(0, 8);
            console.log(`[Relayer] Seth call: processCrossChainMessageV2 selector=0x${selector}`);
            console.log(`[Relayer]   ecosystemAmount=${ecosystemAmount.toString()} msg.value=${amountSETH.toString()}`);

            // Send transaction using SethClient
            const result = await this.sethClient.sendContractCall(
                CONFIG.seth.privateKey,
                CONFIG.seth.bridgeAddress.replace('0x', ''),
                inputData,
                { gasLimit: 50000000, gasPrice: 1, amount: amountSETH.toString() }
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
                if (!receipt) {
                    // No terminal receipt found in polling window, keep message retryable.
                    throw new Error(`Seth tx receipt timeout: ${result.txHash}`);
                }
                if (receipt?.status === 10) {
                    // kNotExists: transaction not found on node, treat as dropped, retry
                    throw new Error(`Seth tx not exists (status=10): ${result.txHash}`);
                }
                // Seth terminal failure (observed: status 5 + msg kTxInvalidAddress) — must not mark completed
                if (receipt?.status === 5) {
                    throw new Error(`Seth tx failed (status=5): ${JSON.stringify(receipt.raw)}`);
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
                // Terminal receipt only (status 10 = not indexed yet; SethClient marks done=false)
                if (r.done) return r;
            }
            await this.sleep(intervalMs);
        }
        return null;
    }

    /**
     * Encode processCrossChainMessageV2 function call
     * function processCrossChainMessageV2(bytes32,uint256,uint256,address)
     * @param solanaTxSigBytes32 Solana transaction signature (bytes32)
     * @param ecosystemAmount Ecosystem funds (35%) - inject to PoolB
     * @param amountSETH Native SETH amount (for PoolB liquidity)
     */
    encodeProcessCrossChainMessageV2(solanaTxSigBytes32, ecosystemAmount, amountSETH, recipient) {
        const sig = solanaTxSigBytes32.replace(/^0x/, '').padStart(64, '0');
        const ecoAmt = BigInt(ecosystemAmount).toString(16).padStart(64, '0');
        const amtSETH = BigInt(amountSETH).toString(16).padStart(64, '0');
        const recipientWord = (recipient || '0x0000000000000000000000000000000000000000')
            .replace(/^0x/, '')
            .toLowerCase()
            .padStart(64, '0');

        const selector = createKeccakHash('keccak256')
            .update('processCrossChainMessageV2(bytes32,uint256,uint256,address)')
            .digest('hex')
            .slice(0, 8);

        return selector + sig + ecoAmt + amtSETH + recipientWord;
    }
    
    encodeMarkWithdrawToSolanaProcessed(requestId) {
        const requestIdWord = BigInt(requestId).toString(16).padStart(64, '0');
        const selector = createKeccakHash('keccak256')
            .update('markWithdrawToSolanaProcessed(uint256)')
            .digest('hex')
            .slice(0, 8);
        return selector + requestIdWord;
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

            if (messages.length > 0) {
                console.log(`[Relayer] Processing ${messages.length} retry messages`);

                for (const message of messages) {
                    if (this.isShuttingDown) break;

                    console.log(`[Relayer] Retrying message ${message.id} (attempt ${message.retry_count + 1})`);
                    await this.db.logOperation(message.id, 'retry', { attempt: message.retry_count + 1 });
                    await this.processMessage(message);
                }
            }

            const withdrawRetries = await this.db.getPendingWithdrawRetries(
                CONFIG.seth.bridgeAddress,
                CONFIG.relayer.batchSize
            );
            if (withdrawRetries.length === 0) return;

            console.log(`[Relayer] Processing ${withdrawRetries.length} Seth→Solana withdraw retries`);

            for (const w of withdrawRetries) {
                if (this.isShuttingDown) break;

                const req = await this.sethClient.getWithdrawRequest(
                    this.relayerAddress,
                    CONFIG.seth.bridgeAddress,
                    w.request_id
                );
                if (!req) {
                    await this.db.markSethWithdrawFailed(
                        CONFIG.seth.bridgeAddress,
                        w.request_id,
                        'getWithdrawRequest returned null on retry',
                        CONFIG.relayer.maxRetries
                    );
                    continue;
                }
                if (req.user === '0x0000000000000000000000000000000000000000') continue;
                if (req.processed) {
                    await this.db.upsertSethWithdrawRequest(CONFIG.seth.bridgeAddress, w.request_id, req, 'completed');
                    await this.db.markSethWithdrawCompleted(CONFIG.seth.bridgeAddress, w.request_id, null, null);
                    continue;
                }

                await this.db.logWithdrawOperation(w.id, 'retry', { attempt: w.retry_count + 1 });
                try {
                    await this.handleSethWithdrawRequest(w.request_id, req);
                } catch (e) {
                    console.error(`[Relayer] Withdraw retry failed for request #${w.request_id}:`, e.message);
                }
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
                    inbound: {
                        pending: dbStats.pending,
                        processing: dbStats.processing,
                        completed: dbStats.completed,
                        failed: dbStats.failed,
                        total: dbStats.total,
                    },
                    withdraw: dbStats.withdraw,
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