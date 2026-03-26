/**
 * Seth Withdrawal Relayer - Listens for SwapExecuted events on Seth and processes withdrawals on Solana
 * 
 * Flow:
 * 1. Listen for PoolB.SwapExecuted events where isBuySETH = false (user selling SETH)
 * 2. Lookup user's registered Solana address from database
 * 3. Store withdrawal message in database
 * 4. Call Solana bridge process_seth_withdrawal to mint sUSDC to user
 * 5. User can then swap sUSDC to USDC via DIRM if desired
 */

const { ethers } = require('ethers');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
const pg = require('pg');
const { PriceService } = require('./price-service');
const BN = require('bn.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// PoolB ABI - the events and functions we need
const POOL_B_ABI = [
    'event SwapExecuted(address indexed user, bool isBuySETH, uint256 amountIn, uint256 amountOut, uint256 price, uint256 timestamp)'
];

// Anchor instruction discriminator for process_seth_withdrawal
// Calculated from: sha256("global:process_seth_withdrawal")[0..8]
const PROCESS_SETH_WITHDRAWAL_DISCRIMINATOR = null; // Will be loaded from IDL

class SethWithdrawalRelayer {
    constructor() {
        // Seth connection
        this.sethProvider = new ethers.JsonRpcProvider(
            process.env.SETH_RPC_URL || `http://${process.env.SETH_HOST || '35.184.150.163'}:${process.env.SETH_PORT || 23001}`
        );
        this.poolBContract = new ethers.Contract(
            process.env.POOL_B_ADDRESS,
            POOL_B_ABI,
            this.sethProvider
        );
        
        // Seth relayer wallet (optional - for logging/verification purposes)
        if (process.env.SETH_RELAYER_PRIVATE_KEY) {
            this.sethRelayerWallet = new ethers.Wallet(
                process.env.SETH_RELAYER_PRIVATE_KEY,
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
        this.programId = new PublicKey(process.env.SOLANA_BRIDGE_PROGRAM_ID);
        this.susdcMint = new PublicKey(process.env.SOLANA_SUSDC_MINT);
        
        // Price service for cross-chain fee calculation
        this.priceService = new PriceService();
        
        // Fee configuration
        this.feeMarkupPercent = parseInt(process.env.FEE_MARKUP_PERCENT) || 10;
        this.estimatedGasUnits = BigInt(process.env.ESTIMATED_GAS_UNITS || '200000');
        
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
     * Anchor uses: sha256("global:<instruction_name>")[0..8]
     */
    getInstructionDiscriminator() {
        if (this._discriminator) return this._discriminator;
        
        // Try loading from IDL first
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
        
        // Decode config: skip 8-byte discriminator, then read fields
        // Config layout: owner(32) + seth_treasury(32) + team_wallet(32) + project_wallet(32) + vault_authority(32) + relayer(32) + ...
        const data = accountInfo.data;
        const relayerOffset = 8 + 32 * 5; // discriminator + 5 pubkeys before relayer
        const configRelayer = new PublicKey(data.slice(relayerOffset, relayerOffset + 32));
        
        if (!configRelayer.equals(this.solanaRelayerKeypair.publicKey)) {
            console.warn(`[SethWithdrawalRelayer] WARNING: Solana relayer ${this.solanaRelayerAddress} is NOT the registered relayer ${configRelayer.toString()}`);
            console.warn('[SethWithdrawalRelayer] Withdrawal transactions will fail unless the relayer is updated');
        } else {
            console.log(`[SethWithdrawalRelayer] Verified: relayer is correctly registered in bridge config`);
        }
        
        // Also extract the bump from config for vault authority PDA signing
        const bumpOffset = relayerOffset + 32; // right after relayer pubkey
        this.configBump = data[bumpOffset];
        console.log(`[SethWithdrawalRelayer] Config bump: ${this.configBump}`);
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
        
        // Load last processed block from database
        try {
            const result = await this.dbPool.query(
                'SELECT last_seth_block FROM relayer_status LIMIT 1'
            );
            if (result.rows.length > 0 && result.rows[0].last_seth_block) {
                this.lastProcessedBlock = BigInt(result.rows[0].last_seth_block);
                console.log(`[SethWithdrawalRelayer] Resuming from block ${this.lastProcessedBlock}`);
            } else {
                const currentBlock = BigInt(await this.sethProvider.getBlockNumber());
                this.lastProcessedBlock = currentBlock - 10n;
                console.log(`[SethWithdrawalRelayer] Starting from block ${this.lastProcessedBlock}`);
            }
        } catch (error) {
            console.warn('[SethWithdrawalRelayer] Could not load last block from DB:', error.message);
            const currentBlock = BigInt(await this.sethProvider.getBlockNumber());
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
        
        console.log(`[SethWithdrawalRelayer] Querying blocks ${fromBlock} to ${toBlock}`);
        
        // Query SwapExecuted events
        const filter = this.poolBContract.filters.SwapExecuted();
        const events = await this.poolBContract.queryFilter(filter, fromBlock, toBlock);
        
        for (const event of events) {
            if (this.isShuttingDown) break;
            await this.processSwapEvent(event);
        }
        
        // Update last processed block
        await this.updateLastProcessedBlock(toBlock);
        this.lastProcessedBlock = toBlock;
    }
    
    // ==================== Event Processing ====================
    
    async processSwapEvent(event) {
        const { user, isBuySETH, amountIn, amountOut, price } = event.args;
        const txHash = event.transactionHash;
        const blockNumber = event.blockNumber;
        
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
        
        // Get Solana recipient address from user mapping
        const solanaRecipient = await this.getSolanaAddressForUser(user);
        if (!solanaRecipient) {
            console.warn(`[SethWithdrawalRelayer] No Solana address mapping for user ${user}, storing as pending_mapping`);
            // Store in database with special status so it can be retried when mapping is added
            await this.dbPool.query(`
                INSERT INTO seth_withdrawal_messages 
                (seth_tx_hash, seth_user, solana_recipient, susdc_amount, seth_amount_in, seth_price, seth_block_timestamp, status, last_error)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_mapping', 'No Solana address mapping found')
                ON CONFLICT (seth_tx_hash) DO NOTHING
            `, [
                txHash,
                user.toLowerCase(),
                '', // empty - no mapping yet
                amountOut.toString(),
                amountIn.toString(),
                price.toString(),
                Math.floor(Date.now() / 1000)
            ]);
            return;
        }
        
        // Store in database
        await this.dbPool.query(`
            INSERT INTO seth_withdrawal_messages 
            (seth_tx_hash, seth_user, solana_recipient, susdc_amount, seth_amount_in, seth_price, seth_block_timestamp, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
            ON CONFLICT (seth_tx_hash) DO NOTHING
        `, [
            txHash,
            user.toLowerCase(),
            solanaRecipient,
            amountOut.toString(),
            amountIn.toString(),
            price.toString(),
            Math.floor(Date.now() / 1000)
        ]);
        
        // Process withdrawal on Solana
        await this.executeWithdrawal(txHash, user, solanaRecipient, amountOut);
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
                txHash,
                sethUser,
                solanaRecipient,
                susdcAmount
            );
            
            // Update status to completed
            await this.dbPool.query(`
                UPDATE seth_withdrawal_messages 
                SET status = 'completed', solana_tx_sig = $1, processed_at = NOW()
                WHERE seth_tx_hash = $2
            `, [solanaTxSig, txHash]);
            
            // Update user mapping stats
            await this.dbPool.query(`
                UPDATE user_address_mapping 
                SET total_withdrawals = total_withdrawals + 1,
                    total_withdrawn_amount = total_withdrawn_amount + $1,
                    last_used_at = NOW()
                WHERE seth_address = $2
            `, [susdcAmount.toString(), sethUser.toLowerCase()]);
            
            this.stats.totalProcessed++;
            this.stats.lastProcessedAt = new Date();
            
            console.log(`[SethWithdrawalRelayer] Withdrawal completed: solana_tx=${solanaTxSig}`);
        } catch (error) {
            console.error(`[SethWithdrawalRelayer] Failed to process withdrawal for ${txHash}:`, error.message);
            
            const retryCount = await this.incrementRetryCount(txHash, error.message);
            
            if (retryCount >= this.maxRetries) {
                console.error(`[SethWithdrawalRelayer] Max retries (${this.maxRetries}) reached for ${txHash}`);
            }
            
            this.stats.totalFailed++;
        }
    }
    
    // ==================== Solana Address Mapping ====================
    
    /**
     * Query the Solana address for a Seth user from the database
     */
    async getSolanaAddressForUser(sethUser) {
        try {
            const normalizedAddress = sethUser.toLowerCase();
            
            const result = await this.dbPool.query(
                `SELECT solana_address FROM user_address_mapping 
                 WHERE seth_address = $1 AND is_active = true`,
                [normalizedAddress]
            );
            
            if (result.rows.length > 0) {
                return result.rows[0].solana_address;
            }
            
            return null;
        } catch (error) {
            console.error(`[SethWithdrawalRelayer] Error querying user address mapping:`, error.message);
            return null;
        }
    }
    
    // ==================== Cross-Chain Fee ====================
    
    /**
     * Calculate cross-chain fee based on current exchange rates
     */
    async calculateCrossChainFee() {
        try {
            const feeInfo = await this.priceService.estimateCrossChainFee(
                'seth-to-solana',
                this.estimatedGasUnits
            );
            
            const sethFee = feeInfo.sethFee || BigInt(0);
            const sethPerSusdc = feeInfo.exchangeRate?.sethPerSusdc || BigInt(1e18);
            
            // sUSDC fee = SETH fee * sUSDC/SETH (sUSDC is 6 decimals)
            const susdcFee = (sethFee * BigInt(1e6)) / sethPerSusdc;
            
            const minFee = BigInt(process.env.MIN_CROSS_CHAIN_FEE_SUSDC || '100'); // 0.0001 USDC
            return susdcFee > minFee ? susdcFee : minFee;
            
        } catch (error) {
            console.error('[SethWithdrawalRelayer] Failed to calculate cross-chain fee:', error.message);
            return BigInt(process.env.DEFAULT_CROSS_CHAIN_FEE_SUSDC || '1000'); // 0.001 USDC
        }
    }
    
    // ==================== Solana Transaction Execution ====================
    
    /**
     * Build and send process_seth_withdrawal transaction on Solana
     */
    async processWithdrawalOnSolana(txHash, sethUser, solanaRecipient, susdcAmount) {
        // 1. Calculate cross-chain fee
        const crossChainFee = await this.calculateCrossChainFee();
        const susdcBigInt = BigInt(susdcAmount.toString());
        
        // Ensure fee doesn't exceed amount (cap at 10%)
        const fee = crossChainFee < susdcBigInt ? crossChainFee : susdcBigInt / BigInt(10);
        const netAmount = susdcBigInt - fee;
        
        console.log(`[SethWithdrawalRelayer] Processing withdrawal on Solana:`, {
            grossAmount: susdcBigInt.toString(),
            fee: fee.toString(),
            netAmount: netAmount.toString(),
            recipient: solanaRecipient
        });
        
        // 2. Derive all PDAs and accounts
        const recipientPubkey = new PublicKey(solanaRecipient);
        
        // Convert txHash to bytes32
        const sethTxHashBytes = Buffer.from(txHash.replace('0x', ''), 'hex');
        
        // Convert sethUser to bytes20
        const sethUserBytes = Buffer.from(sethUser.replace('0x', '').toLowerCase().padStart(40, '0'), 'hex');
        
        // Config PDA
        const [configPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('config')],
            this.programId
        );
        
        // Withdrawal message PDA (for replay protection)
        const [withdrawalMessagePDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('seth_withdrawal'), sethTxHashBytes],
            this.programId
        );
        
        // Vault authority PDA (mint authority for sUSDC)
        const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault_authority')],
            this.programId
        );
        
        // 3. Get or create user's sUSDC associated token account
        const userSusdcAccount = await getAssociatedTokenAddress(
            this.susdcMint,
            recipientPubkey
        );
        
        // Get relayer's sUSDC associated token account (for fee collection)
        const relayerSusdcAccount = await getAssociatedTokenAddress(
            this.susdcMint,
            this.solanaRelayerKeypair.publicKey
        );
        
        // 4. Build instruction data
        const discriminator = this.getInstructionDiscriminator();
        
        // Encode args: seth_tx_hash ([u8;32]) + seth_user ([u8;20]) + susdc_amount (u64) + cross_chain_fee (u64)
        const instructionData = Buffer.alloc(8 + 32 + 20 + 8 + 8);
        let offset = 0;
        
        // Discriminator (8 bytes)
        discriminator.copy(instructionData, offset);
        offset += 8;
        
        // seth_tx_hash (32 bytes)
        sethTxHashBytes.copy(instructionData, offset);
        offset += 32;
        
        // seth_user (20 bytes)
        sethUserBytes.copy(instructionData, offset);
        offset += 20;
        
        // susdc_amount (u64 little endian)
        instructionData.writeBigUInt64LE(susdcBigInt, offset);
        offset += 8;
        
        // cross_chain_fee (u64 little endian)
        instructionData.writeBigUInt64LE(fee, offset);
        
        // 5. Build account metas (must match ProcessSethWithdrawal struct order)
        const keys = [
            { pubkey: this.solanaRelayerKeypair.publicKey, isSigner: true, isWritable: true },  // relayer
            { pubkey: configPDA, isSigner: false, isWritable: false },                           // config
            { pubkey: withdrawalMessagePDA, isSigner: false, isWritable: true },                 // withdrawal_message (init)
            { pubkey: recipientPubkey, isSigner: false, isWritable: false },                     // solana_recipient
            { pubkey: this.susdcMint, isSigner: false, isWritable: true },                       // susdc_mint
            { pubkey: userSusdcAccount, isSigner: false, isWritable: true },                     // user_susdc_account
            { pubkey: relayerSusdcAccount, isSigner: false, isWritable: true },                  // relayer_susdc_account
            { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },                   // vault_authority
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },                    // token_program
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },             // system_program
        ];
        
        const instruction = new TransactionInstruction({
            programId: this.programId,
            keys,
            data: instructionData,
        });
        
        // 6. Build transaction with compute budget
        const transaction = new Transaction();
        
        // Add compute budget instruction (optional but recommended)
        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 })
        );
        
        // Check if user's ATA exists, if not create it
        const userAtaExists = await this.checkTokenAccountExists(userSusdcAccount);
        if (!userAtaExists) {
            console.log(`[SethWithdrawalRelayer] Creating ATA for recipient: ${solanaRecipient}`);
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    this.solanaRelayerKeypair.publicKey,   // payer
                    userSusdcAccount,                       // ata
                    recipientPubkey,                         // owner
                    this.susdcMint                           // mint
                )
            );
        }
        
        // Check if relayer's ATA exists, if not create it
        const relayerAtaExists = await this.checkTokenAccountExists(relayerSusdcAccount);
        if (!relayerAtaExists) {
            console.log(`[SethWithdrawalRelayer] Creating ATA for relayer fee collection`);
            transaction.add(
                createAssociatedTokenAccountInstruction(
                    this.solanaRelayerKeypair.publicKey,     // payer
                    relayerSusdcAccount,                     // ata
                    this.solanaRelayerKeypair.publicKey,     // owner
                    this.susdcMint                            // mint
                )
            );
        }
        
        // Add the main withdrawal instruction
        transaction.add(instruction);
        
        // 7. Send and confirm transaction
        console.log(`[SethWithdrawalRelayer] Sending Solana transaction...`);
        
        const txSig = await sendAndConfirmTransaction(
            this.solanaConnection,
            transaction,
            [this.solanaRelayerKeypair],
            {
                commitment: 'confirmed',
                maxRetries: 3,
            }
        );
        
        console.log(`[SethWithdrawalRelayer] Solana transaction confirmed: ${txSig}`);
        return txSig;
    }
    
    /**
     * Check if a token account exists on-chain
     */
    async checkTokenAccountExists(tokenAccountAddress) {
        try {
            await getAccount(this.solanaConnection, tokenAccountAddress);
            return true;
        } catch (error) {
            return false;
        }
    }
    
    // ==================== Retry Logic ====================
    
    /**
     * Start retry scheduler - periodically checks for failed messages to retry
     */
    startRetryScheduler() {
        this.retryTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.retryFailedMessages();
        }, this.retryInterval);
        
        console.log(`[SethWithdrawalRelayer] Retry scheduler started (interval: ${this.retryInterval}ms)`);
    }
    
    /**
     * Retry failed withdrawal messages with exponential backoff
     */
    async retryFailedMessages() {
        try {
            // 1. Retry messages that failed with retryable errors
            const failedResult = await this.dbPool.query(`
                SELECT * FROM seth_withdrawal_messages 
                WHERE status = 'failed' 
                AND retry_count < $1
                AND (next_retry_at IS NULL OR next_retry_at <= NOW())
                ORDER BY created_at ASC
                LIMIT 10
            `, [this.maxRetries]);
            
            if (failedResult.rows.length > 0) {
                console.log(`[SethWithdrawalRelayer] Retrying ${failedResult.rows.length} failed withdrawal(s)`);
            }
            
            for (const row of failedResult.rows) {
                if (this.isShuttingDown) break;
                
                console.log(`[SethWithdrawalRelayer] Retrying withdrawal ${row.seth_tx_hash} (attempt ${row.retry_count + 1}/${this.maxRetries})`);
                
                await this.executeWithdrawal(
                    row.seth_tx_hash,
                    row.seth_user,
                    row.solana_recipient,
                    BigInt(row.susdc_amount)
                );
                
                this.stats.totalRetried++;
            }
            
            // 2. Retry messages that were pending_mapping (no Solana address at the time)
            const pendingMappingResult = await this.dbPool.query(`
                SELECT m.* FROM seth_withdrawal_messages m
                INNER JOIN user_address_mapping u ON u.seth_address = m.seth_user AND u.is_active = true
                WHERE m.status = 'pending_mapping'
                ORDER BY m.created_at ASC
                LIMIT 10
            `);
            
            if (pendingMappingResult.rows.length > 0) {
                console.log(`[SethWithdrawalRelayer] Found ${pendingMappingResult.rows.length} withdrawal(s) with new address mappings`);
            }
            
            for (const row of pendingMappingResult.rows) {
                if (this.isShuttingDown) break;
                
                const solanaRecipient = await this.getSolanaAddressForUser(row.seth_user);
                if (!solanaRecipient) continue;
                
                console.log(`[SethWithdrawalRelayer] Processing previously unmapped withdrawal ${row.seth_tx_hash} -> ${solanaRecipient}`);
                
                // Update the solana_recipient and status
                await this.dbPool.query(`
                    UPDATE seth_withdrawal_messages 
                    SET solana_recipient = $1, status = 'pending', last_error = NULL, retry_count = 0
                    WHERE seth_tx_hash = $2
                `, [solanaRecipient, row.seth_tx_hash]);
                
                await this.executeWithdrawal(
                    row.seth_tx_hash,
                    row.seth_user,
                    solanaRecipient,
                    BigInt(row.susdc_amount)
                );
            }
            
        } catch (error) {
            console.error('[SethWithdrawalRelayer] Error in retry scheduler:', error.message);
        }
    }
    
    /**
     * Increment retry count with exponential backoff
     */
    async incrementRetryCount(txHash, errorMessage) {
        const result = await this.dbPool.query(`
            UPDATE seth_withdrawal_messages 
            SET status = 'failed', 
                last_error = $1, 
                retry_count = retry_count + 1,
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
            console.error('[SethWithdrawalRelayer] Error updating last processed block:', error.message);
        }
    }
    
    // ==================== Shutdown ====================
    
    async shutdown() {
        console.log('[SethWithdrawalRelayer] Initiating graceful shutdown...');
        this.isShuttingDown = true;
        
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        
        await this.dbPool.end();
        console.log('[SethWithdrawalRelayer] Shutdown complete');
    }
}

// ==================== Main Entry ====================

if (require.main === module) {
    const relayer = new SethWithdrawalRelayer();
    
    process.on('SIGINT', async () => {
        console.log('\n[SethWithdrawalRelayer] Received SIGINT');
        await relayer.shutdown();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('\n[SethWithdrawalRelayer] Received SIGTERM');
        await relayer.shutdown();
        process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
        console.error('[SethWithdrawalRelayer] Uncaught exception:', error);
    });
    
    process.on('unhandledRejection', (reason) => {
        console.error('[SethWithdrawalRelayer] Unhandled rejection:', reason);
    });
    
    relayer.start().catch(err => {
        console.error('[SethWithdrawalRelayer] Failed to start:', err);
        process.exit(1);
    });
}

module.exports = { SethWithdrawalRelayer };
