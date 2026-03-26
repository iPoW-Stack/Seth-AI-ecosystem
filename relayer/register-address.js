/**
 * Register User Address Mapping
 * 
 * Registers a mapping between a Seth address and a Solana address.
 * This is required for Seth -> Solana withdrawals.
 * 
 * Usage:
 *   node register-address.js --seth 0x1234... --solana AbCd...
 *   node register-address.js --list
 *   node register-address.js --remove --seth 0x1234...
 */

require('dotenv').config();
const pg = require('pg');

const dbPool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'bridge_relayer',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
});

/**
 * Validate Seth address format (0x + 40 hex chars)
 */
function isValidSethAddress(addr) {
    return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/**
 * Validate Solana address format (base58, 32-44 chars)
 */
function isValidSolanaAddress(addr) {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

/**
 * Register a new address mapping
 */
async function registerMapping(sethAddress, solanaAddress) {
    if (!isValidSethAddress(sethAddress)) {
        console.error(`Invalid Seth address: ${sethAddress}`);
        console.error('Expected format: 0x followed by 40 hex characters');
        process.exit(1);
    }
    
    if (!isValidSolanaAddress(solanaAddress)) {
        console.error(`Invalid Solana address: ${solanaAddress}`);
        console.error('Expected format: base58 string, 32-44 characters');
        process.exit(1);
    }
    
    const normalizedSeth = sethAddress.toLowerCase();
    
    try {
        const result = await dbPool.query(`
            INSERT INTO user_address_mapping (seth_address, solana_address)
            VALUES ($1, $2)
            ON CONFLICT (seth_address) 
            DO UPDATE SET 
                solana_address = $2,
                updated_at = NOW(),
                is_active = true
            RETURNING *
        `, [normalizedSeth, solanaAddress]);
        
        const row = result.rows[0];
        console.log('Address mapping registered successfully:');
        console.log(`  Seth:   ${row.seth_address}`);
        console.log(`  Solana: ${row.solana_address}`);
        console.log(`  Active: ${row.is_active}`);
        console.log(`  Time:   ${row.registered_at}`);
    } catch (error) {
        console.error('Failed to register mapping:', error.message);
        process.exit(1);
    }
}

/**
 * List all address mappings
 */
async function listMappings() {
    try {
        const result = await dbPool.query(`
            SELECT * FROM user_address_mapping 
            ORDER BY registered_at DESC
        `);
        
        if (result.rows.length === 0) {
            console.log('No address mappings found.');
            return;
        }
        
        console.log(`Found ${result.rows.length} address mapping(s):\n`);
        console.log('  Seth Address                              | Solana Address                             | Active | Withdrawals');
        console.log('  ' + '-'.repeat(42) + ' | ' + '-'.repeat(43) + ' | ' + '-'.repeat(6) + ' | ' + '-'.repeat(11));
        
        for (const row of result.rows) {
            console.log(`  ${row.seth_address} | ${row.solana_address.padEnd(43)} | ${row.is_active ? 'Yes   ' : 'No    '} | ${row.total_withdrawals || 0}`);
        }
    } catch (error) {
        console.error('Failed to list mappings:', error.message);
        process.exit(1);
    }
}

/**
 * Remove (deactivate) an address mapping
 */
async function removeMapping(sethAddress) {
    if (!isValidSethAddress(sethAddress)) {
        console.error(`Invalid Seth address: ${sethAddress}`);
        process.exit(1);
    }
    
    const normalizedSeth = sethAddress.toLowerCase();
    
    try {
        const result = await dbPool.query(`
            UPDATE user_address_mapping 
            SET is_active = false, updated_at = NOW()
            WHERE seth_address = $1
            RETURNING *
        `, [normalizedSeth]);
        
        if (result.rows.length === 0) {
            console.log(`No mapping found for Seth address: ${sethAddress}`);
        } else {
            console.log(`Address mapping deactivated for: ${sethAddress}`);
        }
    } catch (error) {
        console.error('Failed to remove mapping:', error.message);
        process.exit(1);
    }
}

/**
 * Lookup a Solana address by Seth address
 */
async function lookupMapping(sethAddress) {
    const normalizedSeth = sethAddress.toLowerCase();
    
    try {
        const result = await dbPool.query(`
            SELECT * FROM user_address_mapping 
            WHERE seth_address = $1 AND is_active = true
        `, [normalizedSeth]);
        
        if (result.rows.length === 0) {
            console.log(`No active mapping found for Seth address: ${sethAddress}`);
        } else {
            const row = result.rows[0];
            console.log(`Mapping found:`);
            console.log(`  Seth:        ${row.seth_address}`);
            console.log(`  Solana:      ${row.solana_address}`);
            console.log(`  Registered:  ${row.registered_at}`);
            console.log(`  Withdrawals: ${row.total_withdrawals || 0}`);
        }
    } catch (error) {
        console.error('Failed to lookup mapping:', error.message);
        process.exit(1);
    }
}

// Parse command line arguments
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log('Usage:');
        console.log('  Register:  node register-address.js --seth 0x... --solana AbCd...');
        console.log('  List:      node register-address.js --list');
        console.log('  Lookup:    node register-address.js --lookup --seth 0x...');
        console.log('  Remove:    node register-address.js --remove --seth 0x...');
        process.exit(0);
    }
    
    try {
        if (args.includes('--list')) {
            await listMappings();
        } else if (args.includes('--remove')) {
            const sethIdx = args.indexOf('--seth');
            if (sethIdx === -1 || !args[sethIdx + 1]) {
                console.error('--seth address required for --remove');
                process.exit(1);
            }
            await removeMapping(args[sethIdx + 1]);
        } else if (args.includes('--lookup')) {
            const sethIdx = args.indexOf('--seth');
            if (sethIdx === -1 || !args[sethIdx + 1]) {
                console.error('--seth address required for --lookup');
                process.exit(1);
            }
            await lookupMapping(args[sethIdx + 1]);
        } else {
            const sethIdx = args.indexOf('--seth');
            const solanaIdx = args.indexOf('--solana');
            
            if (sethIdx === -1 || !args[sethIdx + 1] || solanaIdx === -1 || !args[solanaIdx + 1]) {
                console.error('Both --seth and --solana addresses are required');
                console.error('Usage: node register-address.js --seth 0x... --solana AbCd...');
                process.exit(1);
            }
            
            await registerMapping(args[sethIdx + 1], args[solanaIdx + 1]);
        }
    } finally {
        await dbPool.end();
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
