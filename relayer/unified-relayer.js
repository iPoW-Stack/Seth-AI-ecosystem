/**
 * Unified Bridge Relayer - Handles both Solana->Seth and Seth->Solana
 * 
 * This relayer combines two directions:
 * 1. Solana -> Seth (Deposit): Listens to Solana RevenueProcessed events, calls Seth bridge
 * 2. Seth -> Solana (Withdrawal): Listens to Seth SwapExecuted events, calls Solana bridge
 * 
 * Usage:
 *   node unified-relayer.js
 *   node unified-relayer.js --deposit-only
 *   node unified-relayer.js --withdrawal-only
 */

require('dotenv').config();
const BridgeRelayer = require('./relayer');
const { SethWithdrawalRelayer } = require('./seth-withdrawal-relayer');

class UnifiedBridgeRelayer {
    constructor(options = {}) {
        this.options = {
            enableDeposit: options.enableDeposit !== false,
            enableWithdrawal: options.enableWithdrawal !== false,
        };
        
        this.depositRelayer = null;
        this.withdrawalRelayer = null;
        this.isRunning = false;
    }
    
    async initialize() {
        console.log('[UnifiedRelayer] Initializing...');
        console.log(`[UnifiedRelayer] Deposit (Solana->Seth): ${this.options.enableDeposit ? 'ENABLED' : 'DISABLED'}`);
        console.log(`[UnifiedRelayer] Withdrawal (Seth->Solana): ${this.options.enableWithdrawal ? 'ENABLED' : 'DISABLED'}`);
        
        // Initialize deposit relayer
        if (this.options.enableDeposit) {
            console.log('[UnifiedRelayer] Initializing deposit relayer...');
            this.depositRelayer = new BridgeRelayer();
            await this.depositRelayer.initialize();
        }
        
        // Initialize withdrawal relayer
        if (this.options.enableWithdrawal) {
            console.log('[UnifiedRelayer] Initializing withdrawal relayer...');
            this.withdrawalRelayer = new SethWithdrawalRelayer();
            // Withdrawal relayer initializes in start()
        }
        
        console.log('[UnifiedRelayer] Initialization complete');
    }
    
    async start() {
        if (this.isRunning) {
            console.log('[UnifiedRelayer] Already running');
            return;
        }
        
        this.isRunning = true;
        console.log('[UnifiedRelayer] Starting...');
        
        // Start deposit relayer
        if (this.depositRelayer) {
            console.log('[UnifiedRelayer] Starting deposit relayer (Solana->Seth)...');
            await this.depositRelayer.start();
        }
        
        // Start withdrawal relayer
        if (this.withdrawalRelayer) {
            console.log('[UnifiedRelayer] Starting withdrawal relayer (Seth->Solana)...');
            await this.withdrawalRelayer.start();
        }
        
        console.log('[UnifiedRelayer] All relayers started successfully');
        
        // Start stats reporter
        this.startStatsReporter();
    }
    
    async stop() {
        if (!this.isRunning) return;
        
        console.log('[UnifiedRelayer] Stopping...');
        this.isRunning = false;
        
        // Stop deposit relayer
        if (this.depositRelayer) {
            console.log('[UnifiedRelayer] Stopping deposit relayer...');
            await this.depositRelayer.stop();
        }
        
        // Stop withdrawal relayer
        if (this.withdrawalRelayer) {
            console.log('[UnifiedRelayer] Stopping withdrawal relayer...');
            await this.withdrawalRelayer.shutdown();
        }
        
        console.log('[UnifiedRelayer] Stopped');
    }
    
    async shutdown() {
        console.log('[UnifiedRelayer] Initiating graceful shutdown...');
        await this.stop();
        
        if (this.depositRelayer) {
            await this.depositRelayer.shutdown();
        }
        
        console.log('[UnifiedRelayer] Shutdown complete');
    }
    
    startStatsReporter() {
        setInterval(() => {
            if (!this.isRunning) return;
            
            console.log('\n[UnifiedRelayer] === Combined Stats ===');
            
            if (this.depositRelayer) {
                console.log('  Deposit (Solana->Seth):');
                console.log(`    Processed: ${this.depositRelayer.stats.totalProcessed}`);
                console.log(`    Failed: ${this.depositRelayer.stats.totalFailed}`);
                console.log(`    Revenue: $${this.depositRelayer.stats.totalRevenueProcessed.toFixed(2)}`);
                console.log(`    Last: ${this.depositRelayer.stats.lastProcessedAt || 'N/A'}`);
            }
            
            if (this.withdrawalRelayer) {
                console.log('  Withdrawal (Seth->Solana):');
                console.log(`    Processed: ${this.withdrawalRelayer.stats.totalProcessed}`);
                console.log(`    Failed: ${this.withdrawalRelayer.stats.totalFailed}`);
                console.log(`    Retried: ${this.withdrawalRelayer.stats.totalRetried}`);
                console.log(`    Last: ${this.withdrawalRelayer.stats.lastProcessedAt || 'N/A'}`);
            }
            
            console.log('');
        }, 120000); // Every 2 minutes
    }
}

// ==================== Main Entry ====================

async function main() {
    const args = process.argv.slice(2);
    
    const options = {
        enableDeposit: !args.includes('--withdrawal-only'),
        enableWithdrawal: !args.includes('--deposit-only'),
    };
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Unified Bridge Relayer');
        console.log('');
        console.log('Usage:');
        console.log('  node unified-relayer.js                 Run both deposit and withdrawal relayers');
        console.log('  node unified-relayer.js --deposit-only  Run only deposit relayer (Solana->Seth)');
        console.log('  node unified-relayer.js --withdrawal-only  Run only withdrawal relayer (Seth->Solana)');
        console.log('');
        console.log('Environment variables:');
        console.log('  See .env.example for all configuration options');
        process.exit(0);
    }
    
    const relayer = new UnifiedBridgeRelayer(options);
    
    // Graceful shutdown handlers
    process.on('SIGINT', async () => {
        console.log('\n[UnifiedRelayer] Received SIGINT');
        await relayer.shutdown();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('\n[UnifiedRelayer] Received SIGTERM');
        await relayer.shutdown();
        process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
        console.error('[UnifiedRelayer] Uncaught exception:', error);
    });
    
    process.on('unhandledRejection', (reason) => {
        console.error('[UnifiedRelayer] Unhandled rejection:', reason);
    });
    
    try {
        await relayer.initialize();
        await relayer.start();
    } catch (error) {
        console.error('[UnifiedRelayer] Failed to start:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = UnifiedBridgeRelayer;
