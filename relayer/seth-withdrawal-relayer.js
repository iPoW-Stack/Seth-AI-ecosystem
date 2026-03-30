/**
 * Seth Withdrawal Relayer - Listens for SwapExecuted events on Seth and processes withdrawals on Solana
 * 
 * Flow:
 * 1. Listen for PoolB.SwapExecuted events where isBuySETH = false (user selling SETH)
 * 2. Extract Solana recipient from event's solanaRecipient field (bytes32)
 * 3. Store withdrawal message in database
 * 4. Call Solana bridge process_seth_withdrawal to mint sUSDC to user
 * 5. User can then swap sUSDC to USDC via DIRM if desired
 */

const { ethers } = require('ethers');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const pg = require('pg');
const { PriceService } = require('./price-service');
const fs = require('fs');
const path = require('path');

// Load .env first, then .env.bsc (BSC/Seth contract addresses)
require('dotenv').config();
require('dotenv').config({ path: path.join(__dirname, '.env.bsc') });

// PoolB ABI - the events and functions we need
const POOL_B_ABI = [
    'event SwapExecuted(address indexed user, bool isBuySETH, uint256 amountIn, uint256 amountOut, uint256 price, uint256 timestamp, bytes32 solanaRecipient)'
];

// Resolve env vars with fallbacks
const POOL_B_ADDRESS = process.env.POOL_B_ADDRESS || process.env.POOL_B_CONTRACT;
const SOLANA_BRIDGE_PROGRAM_ID = process.env.SOLANA_BRIDGE_PROGRAM_ID || process.env.SOLANA_PROGRAM_ID;
const SOLANA_SUSDC_MINT = process.env.SOLANA_SUSDC_MINT || process.env.SOLANA_SUSDC_MINT_ADDRESS;

class SethWithdrawalRelayer {
    constructor() {
        // Validate required config
        if (!POOL_B_ADDRESS) {
            throw new Error('POOL_B_ADDRESS must be set in .env or .env.bsc');
        }
        if (!SOLANA_BRIDGE_PROGRAM_ID) {
            throw new Error('SOLANA_BRIDGE_PROGRAM_ID (or SOLANA_PROGRAM_ID) must be set');
        }
        if (!SOLANA_SUSDC_MINT) {
            throw new Error('SOLANA_SUSDC_MINT must be set');
        }

        // Seth/BSC connection
        const sethRpc = process.env.SETH_RPC_URL || process.env.BSC_RPC_URL || `http://${process.env.SETH_HOST || '35.184.150.163'}:${process.env.SETH_PORT || 23001}`;
        this.sethProvider = new ethers.JsonRpcProvider(sethRpc);
        this.poolBContract = new ethers.Contract(
            POOL_B_ADDRESS,
            POOL_B_ABI,
            this.sethProvider
        );
        console.log(`[SethWithdrawalRelayer] PoolB: ${POOL_B_ADDRESS}`);
        console.log(`[SethWithdrawalRelayer] Seth RPC: ${sethRpc}`);

        // Seth relayer wallet (optional - for logging/verification purposes)
        if (process.env.SETH_RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY) {
            this.sethRelayerWallet = new ethers.Wallet(
                process.env.SETH_RELAYER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY,
                this.sethProvider
            );
            this.sethRelayerAddress = this.sethRelayerWallet.address;
            console.log(`[SethWithdrawalRelayer] Seth relayer address: ${this.sethRelayerAddress}`);
        } else {
            this.sethRelayerWallet = null;
            this.sethRelayerAddress = null;
            console.log('[SethWithdrawalRelayer] No Seth relayer wallet configured (read-only mode)');
        }

        // Solana connection
        this.solanaConnection = new Connection(
            process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
            'confirmed'
        );

        // Database
        this.dbPool = new pg.Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT) || 5432,
            database: process.env.DB_NAME || 'bridge_relayer',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || '',
        });

        // Load Solana relayer keypair (REQUIRED - must be registered in bridge config)
        this.solanaRelayerKeypair = this.loadSolanaRelayerKeypair();
        this.solanaRelayerAddress = this.solanaRelayerKeypair.publicKey.toString();
        console.log(`[SethWithdrawalRelayer] Solana relayer address: ${this.solanaRelayerAddress}`);

        // Solana program ID
        this.programId = new PublicKey(SOLANA_BRIDGE_PROGRAM_ID);
        this.susdcMint = new PublicKey(SOLANA_SUSDC_MINT);

        // Price service for cross-chain fee calculation
        this.priceService = new PriceService();

        // Fee configuration
        this.enableCrossChainFee = (process.env.ENABLE_CROSS_CHAIN_FEE === 'true');
        this.feeMarkupPercent = parseInt(process.env.FEE_MARKUP_PERCENT) || 10;
        this.estimatedGasUnits = BigInt(process.env.ESTIMATED_GAS_UNITS || '200000');
        console.log(`[SethWithdrawalRelayer] Cross-chain fee: ${this.enableCrossChainFee ? 'ENABLED' : 'DISABLED'}`);

        // Track last processed block
        this.lastProcessedBlock = 0n;

        // Retry configuration
        this.retryInterval = parseInt(process.env.WITHDRAWAL_RETRY_INTERVAL) || 60000;
        this.maxRetries = parseInt(process.env.MAX_RETRIES) || 5;
        this.retryTimer = null;

        // IDL / Discriminator cache
        this._discriminator = null;

        // Stats
        this.stats = {
            totalProcessed: 0,
            totalFailed: 0,
            totalRetried: 0,
            lastProcessedAt: null,
        };

        this.isShuttingDown = false;
    }

    // ==================== Initialization ====================

    /**
     * Ensure all required database tables and columns exist.
     * Auto-creates missing schema to avoid startup failures.
     */
    async ensureSchema() {
        console.log('[SethWithdrawalRelayer] Checking database schema...');

        // 1. Ensure seth_withdrawal_messages table exists
        try {
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS seth_withdrawal_messages (
                    id SERIAL PRIMARY KEY,
                    seth_tx_hash VARCHAR(66) NOT NULL UNIQUE,
                    seth_user VARCHAR(42) NOT NULL,
                    solana_recipient VARCHAR(50),
                    susdc_amount NUMERIC(78, 0) NOT NULL,
                    min_usdc_out NUMERIC(78, 0) DEFAULT 0,
                    actual_usdc_out NUMERIC(78, 0),
                    seth_amount_in NUMERIC(78, 0),
                    seth_price NUMERIC(78, 0),
                    seth_block_timestamp BIGINT,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    retry_count INTEGER DEFAULT 0,
                    max_retries INTEGER DEFAULT 5,
                    last_error TEXT,
                    solana_tx_sig VARCHAR(88),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    processed_at TIMESTAMP,
                    next_retry_at TIMESTAMP
                )
            `);
            console.log('[SethWithdrawalRelayer] seth_withdrawal_messages table OK');
        } catch (e) {
            console.warn('[SethWithdrawalRelayer] seth_withdrawal_messages check:', e.message);
        }

        // 2. Ensure user_address_mapping table exists
        try {
            await this.dbPool.query(`
                CREATE TABLE IF NOT EXISTS user_address_mapping (
                    id SERIAL PRIMARY KEY,
                    seth_address VARCHAR(42) NOT NULL UNIQUE,
                    solana_address VARCHAR(50) NOT NULL,
                    registered_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    last_used_at TIMESTAMP,
                    is_active BOOLEAN DEFAULT true,
                    signature VARCHAR(100),
                    total_withdrawals INTEGER DEFAULT 0,
                    total_withdrawn_amount NUMERIC(78, 0) DEFAULT 0
                )
            `);
            console.log('[SethWithdrawalRelayer] user_address_mapping table OK');
        } catch (e) {
            console.warn('[SethWithdrawalRelayer] user_address_mapping check:', e.message);
        }

        // 3. Ensure relayer_status has the required columns
        const columnsToAdd = [
            { name: 'last_seth_block', type: 'BIGINT DEFAULT 0' },
            { name: 'last_seth_tx_hash', type: 'VARCHAR(66)' },
        ];
        for (const col of columnsToAdd) {
            try {
                const check = await this.dbPool.query(
                    `SELECT 1 FROM information_schema.columns WHERE table_name='relayer_status' AND column_name=$1`,
                    [col.name]
                );
                if (check.rows.length === 0) {
                    console.log(`[SethWithdrawalRelayer] Adding column ${col.name} to relayer_status...`);
                    await this.dbPool.query(`ALTER TABLE relayer_status ADD COLUMN ${col.name} ${col.type}`);
                }
            } catch (e) {
                console.warn(`[SethWithdrawalRelayer] Column ${col.name} check:`, e.message);
            }
        }
        console.log('[SethWithdrawalRelayer] relayer_status columns OK');

        // 4. Ensure relayer_status has at least one row
        try {
            const countResult = await this.dbPool.query('SELECT COUNT(*) FROM relayer_status');
            if (parseInt(countResult.rows[0].count) === 0) {
                await this.dbPool.query('INSERT INTO relayer_status (is_active) VALUES (false)');
                console.log('[SethWithdrawalRelayer] Inserted default relayer_status row');
            }
        } catch (e) {
            console.warn('[SethWithdrawalRelayer] relayer_status row check:', e.message);
        }

        console.log('[SethWithdrawalRelayer] Schema check complete');
    }

    loadSolanaRelayerKeypair() {
        const keypairPath = process.env.SOLANA_RELAYER_KEYPAIR_PATH;
        if (keypairPath && fs.existsSync(keypairPath)) {
            const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
            return Keypair.fromSecretKey(new Uint8Array(secretKey));
        }
        throw new Error('Solana relayer keypair not found - set SOLANA_RELAYER_KEYPAIR_PATH');
    }

    /**
     * Load instruction discriminator from IDL or compute from Anchor convention
     */
    getInstructionDiscriminator() {
        if (this._discriminator) return this._discriminator;

        const idlPaths = [
            path.join(__dirname, '..', 'contracts', 'solana', 'target', 'idl', 'seth_bridge.json'),
            path.join(__dirname, 'seth_bridge.json'),
        ];

        for (const idlPath of idlPaths) {
            try {
                if (fs.existsSync(idlPath)) {
                    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
                    const ix = idl.instructions.find(i => i.name === 'process_seth_withdrawal');
                    if (ix && ix.discriminator) {
                        this._discriminator = Buffer.from(ix.discriminator);
                        console.log(`[SethWithdrawalRelayer] Loaded discriminator from IDL: ${this._discriminator.toString('hex')}`);
                        return this._discriminator;
                    }
                }
            } catch (e) {
                // Continue to next path
            }
        }

        // Fallback: compute using Anchor convention sha256("global:process_seth_withdrawal")[0..8]
        const crypto = require('crypto');
        const hash = crypto.createHash('sha256')
            .update('global:process_seth_withdrawal')
            .digest();
        this._discriminator = hash.slice(0, 8);
        console.log(`[SethWithdrawalRelayer] Computed discriminator: ${this._discriminator.toString('hex')}`);
        return this._discriminator;
    }

    /**
     * Verify that our Solana relayer address is registered in the bridge config
     */
    async verifyRelayerRegistered() {
        const [configPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('config')],
            this.programId
        );

        const accountInfo = await this.solanaConnection.getAccountInfo(configPDA);
        if (!accountInfo) {
            throw new Error('Bridge config not found on Solana');
        }

        const data = accountInfo.data;
        const relayerOffset = 8 + 32 * 5;
        const configRelayer = new PublicKey(data.slice(relayerOffset, relayerOffset + 32));

        if (!configRelayer.equals(this.solanaRelayerKeypair.publicKey)) {
            console.warn(`[SethWithdrawalRelayer] WARNING: Solana relayer ${this.solanaRelayerAddress} is NOT the registered relayer ${configRelayer.toString()}`);
        } else {
            console.log(`[SethWithdrawalRelayer] Verified: relayer is correctly registered in bridge config`);
        }
    }

    // ==================== Main Entry ====================

    async start() {
        console.log('[SethWithdrawalRelayer] Starting...');

        // Verify relayer registration
        try {
            await this.verifyRelayerRegistered();
        } catch (error) {
            console.warn('[SethWithdrawalRelayer] Could not verify relayer registration:', error.message);
        }

        // Load discriminator
        this.getInstructionDiscriminator();

        // Ensure the required columns exist in relayer_status
        await this.ensureSchema();

        // Load last processed block from database
        const currentBlock = BigInt(await this.sethProvider.getBlockNumber());
        try {
            const result = await this.dbPool.query(
                'SELECT last_seth_block FROM relayer_status LIMIT 1'
            );
            const savedBlock = result.rows[0]?.last_seth_block;
            // Only resume if saved block is meaningful (> 0 and within reasonable range)
            if (savedBlock && parseInt(savedBlock) > 0 && parseInt(savedBlock) < Number(currentBlock)) {
                this.lastProcessedBlock = BigInt(savedBlock);
                console.log(`[SethWithdrawalRelayer] Resuming from block ${this.lastProcessedBlock}`);
            } else {
                // Start from recent block to avoid scanning entire history
                this.lastProcessedBlock = currentBlock - 10n;
                console.log(`[SethWithdrawalRelayer] Starting from recent block ${this.lastProcessedBlock}`);
                // Save initial block to DB
                await this.updateLastProcessedBlock(this.lastProcessedBlock);
            }
        } catch (error) {
            console.warn('[SethWithdrawalRelayer] Could not load last block from DB:', error.message);
            this.lastProcessedBlock = currentBlock - 10n;
        }

        // Start polling loop
        this.pollLoop();

        // Start retry scheduler
        this.startRetryScheduler();

        console.log('[SethWithdrawalRelayer] Started successfully');
    }

    // ==================== Event Polling ====================

    async pollLoop() {
        while (!this.isShuttingDown) {
            try {
                await this.pollEvents();
            } catch (error) {
                console.error('[SethWithdrawalRelayer] Poll error:', error.message);
            }

            await new Promise(resolve => setTimeout(resolve, parseInt(process.env.POLL_INTERVAL_MS) || 5000));
        }
    }

    async pollEvents() {
        const currentBlock = BigInt(await this.sethProvider.getBlockNumber());
        const fromBlock = this.lastProcessedBlock + 1n;
        const toBlock = currentBlock - 3n; // 3 block confirmations

        if (fromBlock > toBlock) {
            return;
        }

        // Split into batches of 50000 blocks max (RPC limitation)
        const MAX_BLOCK_RANGE = 50000n;
        let batchStart = fromBlock;

        while (batchStart <= toBlock) {
            const batchEnd = batchStart + MAX_BLOCK_RANGE - 1n < toBlock
                ? batchStart + MAX_BLOCK_RANGE - 1n
                : toBlock;

            console.log(`[SethWithdrawalRelayer] Querying blocks ${batchStart} to ${batchEnd}`);

            try {
                const filter = this.poolBContract.filters.SwapExecuted();
                const events = await this.poolBContract.queryFilter(filter, batchStart, batchEnd);

                for (const event of events) {
                    if (this.isShuttingDown) break;
                    await this.processSwapEvent(event);
                }
            } catch (error) {
                console.error(`[SethWithdrawalRelayer] Error querying blocks ${batchStart}-${batchEnd}:`, error.message);
            }

            await this.updateLastProcessedBlock(batchEnd);
            this.lastProcessedBlock = batchEnd;
            batchStart = batchEnd + 1n;

            if (this.isShuttingDown) break;
        }
    }

    // ==================== Event Processing ====================

    async processSwapEvent(event) {
        const { user, isBuySETH, amountIn, amountOut, price, solanaRecipient } = event.args;
        const txHash = event.transactionHash;

        // Only process SETH sells (isBuySETH = false)
        if (isBuySETH) {
            return;
        }

        console.log(`[SethWithdrawalRelayer] Processing sell event: user=${user}, amountIn=${amountIn}, amountOut=${amountOut}, tx=${txHash}`);

        // Check if already processed
        const existing = await this.dbPool.query(
            'SELECT id FROM seth_withdrawal_messages WHERE seth_tx_hash = $1',
            [txHash]
        );
        if (existing.rows.length > 0) {
            console.log(`[SethWithdrawalRelayer] Already processed tx ${txHash}`);
            return;
        }

        // Get Solana recipient address from event (bytes32 -> base58 string)
        let solanaRecipientAddress = null;

        if (solanaRecipient && solanaRecipient !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
            try {
                const bs58 = require('bs58');
                const pubkeyBytes = Buffer.from(solanaRecipient.slice(2), 'hex');
                solanaRecipientAddress = bs58.encode(pubkeyBytes);
                console.log(`[SethWithdrawalRelayer] Solana recipient from event: ${solanaRecipientAddress}`);
            } catch (error) {
                console.warn(`[SethWithdrawalRelayer] Failed to decode solanaRecipient: ${error.message}`);
            }
        }

        // Fallback: try database mapping
        if (!solanaRecipientAddress) {
            solanaRecipientAddress = await this.getSolanaAddressForUser(user);
        }

        if (!solanaRecipientAddress) {
            console.warn(`[SethWithdrawalRelayer] No Solana address for user ${user}, storing as pending_mapping`);
            await this.dbPool.query(`
                INSERT INTO seth_withdrawal_messages 
                (seth_tx_hash, seth_user, solana_recipient, susdc_amount, seth_amount_in, seth_price, seth_block_timestamp, status, last_error)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_mapping', 'No Solana address found')
                ON CONFLICT (seth_tx_hash) DO NOTHING
            `, [txHash, user.toLowerCase(), '', amountOut.toString(), amountIn.toString(), price.toString(), Math.floor(Date.now() / 1000)]);
            return;
        }

        // Store in database
        await this.dbPool.query(`
            INSERT INTO seth_withdrawal_messages 
            (seth_tx_hash, seth_user, solana_recipient, susdc_amount, seth_amount_in, seth_price, seth_block_timestamp, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            ON CONFLICT (seth_tx_hash) DO NOTHING
        `, [txHash, user.toLowerCase(), solanaRecipientAddress, amountOut.toString(), amountIn.toString(), price.toString(), Math.floor(Date.now() / 1000)]);

        // Process withdrawal on Solana
        await this.executeWithdrawal(txHash, user, solanaRecipientAddress, amountOut);
    }

    /**
     * Execute the withdrawal - call Solana contract to mint sUSDC
     */
    async executeWithdrawal(txHash, sethUser, solanaRecipient, susdcAmount) {
        try {
            await this.dbPool.query(
                `UPDATE seth_withdrawal_messages SET status = 'processing' WHERE seth_tx_hash = $1`,
                [txHash]
            );

            const solanaTxSig = await this.processWithdrawalOnSolana(
                txHash, sethUser, solanaRecipient, susdcAmount
            );

            await this.dbPool.query(`
                UPDATE seth_withdrawal_messages 
                SET status = 'completed', solana_tx_sig = $1, processed_at = NOW()
                WHERE seth_tx_hash = $2
            `, [solanaTxSig, txHash]);

            this.stats.totalProcessed++;
            this.stats.lastProcessedAt = new Date();
            console.log(`[SethWithdrawalRelayer] Withdrawal completed: solana_tx=${solanaTxSig}`);
        } catch (error) {
            console.error(`[SethWithdrawalRelayer] Failed to process withdrawal for ${txHash}:`, error.message);
            await this.incrementRetryCount(txHash, error.message);
            this.stats.totalFailed++;
        }
    }

    // ==================== Solana Address Mapping ====================

    async getSolanaAddressForUser(sethUser) {
        try {
            const result = await this.dbPool.query(
                `SELECT solana_address FROM user_address_mapping 
                 WHERE seth_address = $1 AND is_active = true`,
                [sethUser.toLowerCase()]
            );
            return result.rows.length > 0 ? result.rows[0].solana_address : null;
        } catch (error) {
            console.error(`[SethWithdrawalRelayer] Error querying user mapping:`, error.message);
            return null;
        }
    }

    // ==================== Cross-Chain Fee ====================

    async calculateCrossChainFee() {
        try {
            const feeInfo = await this.priceService.estimateCrossChainFee(
                'seth-to-solana', this.estimatedGasUnits
            );
            const sethFee = feeInfo.sethFee || BigInt(0);
            const sethPerSusdc = feeInfo.exchangeRate?.sethPerSusdc || BigInt(1e18);
            const susdcFee = (sethFee * BigInt(1e6)) / sethPerSusdc;
            const minFee = BigInt(process.env.MIN_CROSS_CHAIN_FEE_SUSDC || '100');
            return susdcFee > minFee ? susdcFee : minFee;
        } catch (error) {
            console.error('[SethWithdrawalRelayer] Fee calculation failed:', error.message);
            return BigInt(process.env.DEFAULT_CROSS_CHAIN_FEE_SUSDC || '1000');
        }
    }

    // ==================== Solana Transaction Execution ====================

    async processWithdrawalOnSolana(txHash, sethUser, solanaRecipient, susdcAmount) {
        const susdcBigInt = BigInt(susdcAmount.toString());
        
        // Calculate fee based on ENABLE_CROSS_CHAIN_FEE switch
        let fee = 0n;
        if (this.enableCrossChainFee) {
            const crossChainFee = await this.calculateCrossChainFee();
            fee = crossChainFee < susdcBigInt ? crossChainFee : susdcBigInt / BigInt(10);
        }
        const netAmount = susdcBigInt - fee;

        console.log(`[SethWithdrawalRelayer] Solana withdrawal:`, {
            grossAmount: susdcBigInt.toString(), fee: fee.toString(),
            netAmount: netAmount.toString(), recipient: solanaRecipient,
            feeEnabled: this.enableCrossChainFee
        });

        const recipientPubkey = new PublicKey(solanaRecipient);
        const sethTxHashBytes = Buffer.from(txHash.replace('0x', ''), 'hex');
        const sethUserBytes = Buffer.from(sethUser.replace('0x', '').toLowerCase().padStart(40, '0'), 'hex');

        const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], this.programId);
        const [withdrawalMessagePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('seth_withdrawal'), sethTxHashBytes], this.programId
        );
        const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault_authority')], this.programId
        );

        const userSusdcAccount = await getAssociatedTokenAddress(this.susdcMint, recipientPubkey);
        const relayerSusdcAccount = await getAssociatedTokenAddress(this.susdcMint, this.solanaRelayerKeypair.publicKey);

        // Build instruction data
        const discriminator = this.getInstructionDiscriminator();
        const instructionData = Buffer.alloc(8 + 32 + 20 + 8 + 8);
        let offset = 0;
        discriminator.copy(instructionData, offset); offset += 8;
        sethTxHashBytes.copy(instructionData, offset); offset += 32;
        sethUserBytes.copy(instructionData, offset); offset += 20;
        instructionData.writeBigUInt64LE(susdcBigInt, offset); offset += 8;
        instructionData.writeBigUInt64LE(fee, offset);

        const keys = [
            { pubkey: this.solanaRelayerKeypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: configPDA, isSigner: false, isWritable: false },
            { pubkey: withdrawalMessagePDA, isSigner: false, isWritable: true },
            { pubkey: recipientPubkey, isSigner: false, isWritable: false },
            { pubkey: this.susdcMint, isSigner: false, isWritable: true },
            { pubkey: userSusdcAccount, isSigner: false, isWritable: true },
            { pubkey: relayerSusdcAccount, isSigner: false, isWritable: true },
            { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ];

        const instruction = new TransactionInstruction({
            programId: this.programId, keys, data: instructionData,
        });

        const transaction = new Transaction();
        transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));

        // Create ATA if needed
        if (!await this.checkTokenAccountExists(userSusdcAccount)) {
            console.log(`[SethWithdrawalRelayer] Creating ATA for recipient`);
            transaction.add(createAssociatedTokenAccountInstruction(
                this.solanaRelayerKeypair.publicKey, userSusdcAccount, recipientPubkey, this.susdcMint
            ));
        }
        if (!await this.checkTokenAccountExists(relayerSusdcAccount)) {
            console.log(`[SethWithdrawalRelayer] Creating ATA for relayer`);
            transaction.add(createAssociatedTokenAccountInstruction(
                this.solanaRelayerKeypair.publicKey, relayerSusdcAccount, this.solanaRelayerKeypair.publicKey, this.susdcMint
            ));
        }

        transaction.add(instruction);

        console.log(`[SethWithdrawalRelayer] Sending Solana transaction...`);
        const txSig = await sendAndConfirmTransaction(
            this.solanaConnection, transaction, [this.solanaRelayerKeypair],
            { commitment: 'confirmed', maxRetries: 3 }
        );
        console.log(`[SethWithdrawalRelayer] Solana tx confirmed: ${txSig}`);
        return txSig;
    }

    async checkTokenAccountExists(tokenAccountAddress) {
        try { await getAccount(this.solanaConnection, tokenAccountAddress); return true; } catch { return false; }
    }

    // ==================== Retry Logic ====================

    startRetryScheduler() {
        this.retryTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.retryFailedMessages();
        }, this.retryInterval);
        console.log(`[SethWithdrawalRelayer] Retry scheduler started (interval: ${this.retryInterval}ms)`);
    }

    async retryFailedMessages() {
        try {
            // Retry failed messages
            const failedResult = await this.dbPool.query(`
                SELECT * FROM seth_withdrawal_messages 
                WHERE status = 'failed' AND retry_count < $1
                AND (next_retry_at IS NULL OR next_retry_at <= NOW())
                ORDER BY created_at ASC LIMIT 10
            `, [this.maxRetries]);

            for (const row of failedResult.rows) {
                if (this.isShuttingDown) break;
                await this.executeWithdrawal(row.seth_tx_hash, row.seth_user, row.solana_recipient, BigInt(row.susdc_amount));
                this.stats.totalRetried++;
            }

            // Retry pending_mapping messages that now have mappings
            const pendingResult = await this.dbPool.query(`
                SELECT m.* FROM seth_withdrawal_messages m
                INNER JOIN user_address_mapping u ON u.seth_address = m.seth_user AND u.is_active = true
                WHERE m.status = 'pending_mapping'
                ORDER BY m.created_at ASC LIMIT 10
            `);

            for (const row of pendingResult.rows) {
                if (this.isShuttingDown) break;
                const solanaRecipient = await this.getSolanaAddressForUser(row.seth_user);
                if (!solanaRecipient) continue;
                await this.dbPool.query(`
                    UPDATE seth_withdrawal_messages 
                    SET solana_recipient = $1, status = 'pending', last_error = NULL, retry_count = 0
                    WHERE seth_tx_hash = $2
                `, [solanaRecipient, row.seth_tx_hash]);
                await this.executeWithdrawal(row.seth_tx_hash, row.seth_user, solanaRecipient, BigInt(row.susdc_amount));
            }
        } catch (error) {
            console.error('[SethWithdrawalRelayer] Retry scheduler error:', error.message);
        }
    }

    async incrementRetryCount(txHash, errorMessage) {
        const result = await this.dbPool.query(`
            UPDATE seth_withdrawal_messages 
            SET status = 'failed', last_error = $1, retry_count = retry_count + 1,
                next_retry_at = NOW() + INTERVAL '1 minute' * LEAST(POWER(2, retry_count), 30)
            WHERE seth_tx_hash = $2
            RETURNING retry_count
        `, [errorMessage, txHash]);
        return result.rows[0]?.retry_count || 0;
    }

    // ==================== Database Helpers ====================

    async updateLastProcessedBlock(blockNumber) {
        try {
            await this.dbPool.query(
                'UPDATE relayer_status SET last_seth_block = $1, updated_at = NOW()',
                [blockNumber.toString()]
            );
        } catch (error) {
            console.error('[SethWithdrawalRelayer] Error updating last block:', error.message);
        }
    }

    // ==================== Shutdown ====================

    async shutdown() {
        console.log('[SethWithdrawalRelayer] Shutting down...');
        this.isShuttingDown = true;
        if (this.retryTimer) { clearInterval(this.retryTimer); this.retryTimer = null; }
        await this.dbPool.end();
        console.log('[SethWithdrawalRelayer] Shutdown complete');
    }
}

// ==================== Main Entry ====================

if (require.main === module) {
    const relayer = new SethWithdrawalRelayer();

    process.on('SIGINT', async () => { await relayer.shutdown(); process.exit(0); });
    process.on('SIGTERM', async () => { await relayer.shutdown(); process.exit(0); });
    process.on('uncaughtException', (error) => { console.error('[SethWithdrawalRelayer] Uncaught:', error); });
    process.on('unhandledRejection', (reason) => { console.error('[SethWithdrawalRelayer] Rejection:', reason); });

    relayer.start().catch(err => {
        console.error('[SethWithdrawalRelayer] Failed to start:', err);
        process.exit(1);
    });
}

module.exports = { SethWithdrawalRelayer };