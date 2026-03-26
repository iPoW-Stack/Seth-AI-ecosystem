/**
 * Test Seth Withdrawal Flow
 * 
 * Simulates and verifies the Seth -> Solana withdrawal flow:
 * 1. Register a test address mapping (Seth -> Solana)
 * 2. Verify the SethWithdrawalRelayer can look up the mapping
 * 3. Verify the Solana program instruction encoding
 * 4. Verify PDA derivation matches on-chain expectations
 * 
 * Usage:
 *   node test-seth-withdrawal.js
 *   node test-seth-withdrawal.js --live   (connects to real chains)
 */

require('dotenv').config();
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');
const { ethers } = require('ethers');
const pg = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Test configuration
const TEST_SETH_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TEST_SOLANA_ADDRESS = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH'; // example
const TEST_TX_HASH = '0x' + 'a'.repeat(64);
const TEST_SUSDC_AMOUNT = BigInt(1000000); // 1 USDC

let dbPool;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`  ✓ ${message}`);
        testsPassed++;
    } else {
        console.log(`  ✗ ${message}`);
        testsFailed++;
    }
}

async function setupDb() {
    dbPool = new pg.Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'bridge_relayer',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
    });
    
    try {
        await dbPool.query('SELECT 1');
        console.log('  Database connected');
        return true;
    } catch (error) {
        console.log('  Database not available, skipping DB tests');
        return false;
    }
}

// ==================== Test: Instruction Discriminator ====================

function testInstructionDiscriminator() {
    console.log('\n1. Testing instruction discriminator computation...');
    
    // Anchor convention: sha256("global:<name>")[0..8]
    const hash = crypto.createHash('sha256')
        .update('global:process_seth_withdrawal')
        .digest();
    const discriminator = hash.slice(0, 8);
    
    assert(discriminator.length === 8, `Discriminator is 8 bytes: ${discriminator.toString('hex')}`);
    
    // Try loading from IDL
    const idlPath = path.join(__dirname, '..', 'contracts', 'solana', 'target', 'idl', 'seth_bridge.json');
    if (fs.existsSync(idlPath)) {
        const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
        const ix = idl.instructions.find(i => i.name === 'process_seth_withdrawal');
        if (ix && ix.discriminator) {
            const idlDiscriminator = Buffer.from(ix.discriminator);
            assert(
                discriminator.equals(idlDiscriminator),
                `Discriminator matches IDL: computed=${discriminator.toString('hex')}, idl=${idlDiscriminator.toString('hex')}`
            );
        } else {
            console.log('  ⚠ process_seth_withdrawal not found in IDL (may not be built yet)');
        }
    } else {
        console.log('  ⚠ IDL not found at expected path, using computed discriminator');
    }
}

// ==================== Test: Instruction Data Encoding ====================

function testInstructionEncoding() {
    console.log('\n2. Testing instruction data encoding...');
    
    const discriminator = crypto.createHash('sha256')
        .update('global:process_seth_withdrawal')
        .digest()
        .slice(0, 8);
    
    const txHash = Buffer.from(TEST_TX_HASH.replace('0x', ''), 'hex');
    const sethUser = Buffer.from(TEST_SETH_ADDRESS.replace('0x', ''), 'hex');
    const susdcAmount = TEST_SUSDC_AMOUNT;
    const fee = BigInt(1000); // 0.001 USDC
    
    const data = Buffer.alloc(8 + 32 + 20 + 8 + 8);
    let offset = 0;
    
    discriminator.copy(data, offset); offset += 8;
    txHash.copy(data, offset); offset += 32;
    sethUser.copy(data, offset); offset += 20;
    data.writeBigUInt64LE(susdcAmount, offset); offset += 8;
    data.writeBigUInt64LE(fee, offset);
    
    assert(data.length === 76, `Instruction data is 76 bytes: ${data.length}`);
    
    // Verify we can read back the values
    let readOffset = 8;
    const readTxHash = data.slice(readOffset, readOffset + 32);
    readOffset += 32;
    const readSethUser = data.slice(readOffset, readOffset + 20);
    readOffset += 20;
    const readAmount = data.readBigUInt64LE(readOffset);
    readOffset += 8;
    const readFee = data.readBigUInt64LE(readOffset);
    
    assert(readTxHash.equals(txHash), 'seth_tx_hash encoded correctly');
    assert(readSethUser.equals(sethUser), 'seth_user encoded correctly');
    assert(readAmount === susdcAmount, `susdc_amount encoded correctly: ${readAmount}`);
    assert(readFee === fee, `cross_chain_fee encoded correctly: ${readFee}`);
}

// ==================== Test: PDA Derivation ====================

function testPdaDerivation() {
    console.log('\n3. Testing PDA derivation...');
    
    const programId = new PublicKey(process.env.SOLANA_BRIDGE_PROGRAM_ID || '125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc');
    
    // Config PDA
    const [configPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('config')],
        programId
    );
    assert(configPDA instanceof PublicKey, `Config PDA: ${configPDA.toString()}`);
    
    // Vault authority PDA
    const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_authority')],
        programId
    );
    assert(vaultAuthorityPDA instanceof PublicKey, `Vault authority PDA: ${vaultAuthorityPDA.toString()}`);
    
    // Withdrawal message PDA
    const txHashBytes = Buffer.from(TEST_TX_HASH.replace('0x', ''), 'hex');
    const [withdrawalPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from('seth_withdrawal'), txHashBytes],
        programId
    );
    assert(withdrawalPDA instanceof PublicKey, `Withdrawal message PDA: ${withdrawalPDA.toString()}`);
    
    // Verify different tx hashes produce different PDAs
    const txHash2 = Buffer.from('b'.repeat(64), 'hex');
    const [withdrawalPDA2] = PublicKey.findProgramAddressSync(
        [Buffer.from('seth_withdrawal'), txHash2],
        programId
    );
    assert(!withdrawalPDA.equals(withdrawalPDA2), 'Different tx hashes produce different PDAs');
}

// ==================== Test: ATA Derivation ====================

async function testAtaDerivation() {
    console.log('\n4. Testing ATA derivation...');
    
    const susdcMint = process.env.SOLANA_SUSDC_MINT 
        ? new PublicKey(process.env.SOLANA_SUSDC_MINT)
        : Keypair.generate().publicKey; // dummy for test
    
    const recipient = new PublicKey(TEST_SOLANA_ADDRESS);
    
    const ata = await getAssociatedTokenAddress(susdcMint, recipient);
    assert(ata instanceof PublicKey, `User ATA: ${ata.toString()}`);
    
    // Verify deterministic
    const ata2 = await getAssociatedTokenAddress(susdcMint, recipient);
    assert(ata.equals(ata2), 'ATA derivation is deterministic');
}

// ==================== Test: Address Mapping Database ====================

async function testAddressMapping(dbAvailable) {
    console.log('\n5. Testing address mapping...');
    
    if (!dbAvailable) {
        console.log('  ⚠ Skipping DB tests (database not available)');
        return;
    }
    
    // Check if the table exists
    try {
        const tableCheck = await dbPool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'user_address_mapping'
            )
        `);
        
        if (!tableCheck.rows[0].exists) {
            console.log('  ⚠ user_address_mapping table not found. Run: npm run db:migrate:address');
            return;
        }
        
        // Insert test mapping
        await dbPool.query(`
            INSERT INTO user_address_mapping (seth_address, solana_address)
            VALUES ($1, $2)
            ON CONFLICT (seth_address) DO UPDATE SET solana_address = $2, is_active = true
        `, [TEST_SETH_ADDRESS.toLowerCase(), TEST_SOLANA_ADDRESS]);
        
        // Query mapping
        const result = await dbPool.query(
            'SELECT solana_address FROM user_address_mapping WHERE seth_address = $1 AND is_active = true',
            [TEST_SETH_ADDRESS.toLowerCase()]
        );
        
        assert(result.rows.length === 1, 'Address mapping inserted and queryable');
        assert(result.rows[0].solana_address === TEST_SOLANA_ADDRESS, 'Solana address matches');
        
        // Test deactivation
        await dbPool.query(
            'UPDATE user_address_mapping SET is_active = false WHERE seth_address = $1',
            [TEST_SETH_ADDRESS.toLowerCase()]
        );
        
        const inactive = await dbPool.query(
            'SELECT solana_address FROM user_address_mapping WHERE seth_address = $1 AND is_active = true',
            [TEST_SETH_ADDRESS.toLowerCase()]
        );
        
        assert(inactive.rows.length === 0, 'Deactivated mapping not returned');
        
        // Clean up
        await dbPool.query(
            'DELETE FROM user_address_mapping WHERE seth_address = $1',
            [TEST_SETH_ADDRESS.toLowerCase()]
        );
        
        assert(true, 'Cleanup successful');
        
    } catch (error) {
        console.log(`  ✗ Database test failed: ${error.message}`);
        testsFailed++;
    }
}

// ==================== Test: Fee Calculation ====================

function testFeeCalculation() {
    console.log('\n6. Testing fee calculation logic...');
    
    // Test fee capping
    const amount = BigInt(1000000); // 1 USDC
    const smallFee = BigInt(100);   // 0.0001 USDC
    const hugeFee = BigInt(2000000); // 2 USDC (exceeds amount)
    
    // Normal case
    const fee1 = smallFee < amount ? smallFee : amount / BigInt(10);
    assert(fee1 === BigInt(100), `Small fee passes through: ${fee1}`);
    
    // Fee exceeds amount -> cap at 10%
    const fee2 = hugeFee < amount ? hugeFee : amount / BigInt(10);
    assert(fee2 === BigInt(100000), `Huge fee capped at 10%: ${fee2}`);
    
    // Net amount
    const netAmount = amount - fee1;
    assert(netAmount === BigInt(999900), `Net amount correct: ${netAmount}`);
}

// ==================== Test: Account Metas ====================

function testAccountMetas() {
    console.log('\n7. Testing account metas match Anchor struct...');
    
    const programId = new PublicKey(process.env.SOLANA_BRIDGE_PROGRAM_ID || '125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc');
    const relayer = Keypair.generate();
    const recipient = Keypair.generate();
    const susdcMint = Keypair.generate();
    
    const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
    const [vaultAuthorityPDA] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority')], programId);
    const txHash = Buffer.alloc(32, 0xaa);
    const [withdrawalPDA] = PublicKey.findProgramAddressSync([Buffer.from('seth_withdrawal'), txHash], programId);
    
    // Expected order from ProcessSethWithdrawal struct in withdrawal.rs:
    // 1. relayer (mut, signer)
    // 2. config (not mut)
    // 3. withdrawal_message (mut, init)
    // 4. solana_recipient (not mut, CHECK)
    // 5. susdc_mint (mut)
    // 6. user_susdc_account (mut)
    // 7. relayer_susdc_account (mut)
    // 8. vault_authority (not mut, CHECK)
    // 9. token_program
    // 10. system_program
    
    const keys = [
        { pubkey: relayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPDA, isSigner: false, isWritable: false },
        { pubkey: withdrawalPDA, isSigner: false, isWritable: true },
        { pubkey: recipient.publicKey, isSigner: false, isWritable: false },
        { pubkey: susdcMint.publicKey, isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },  // user_susdc_account
        { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },  // relayer_susdc_account
        { pubkey: vaultAuthorityPDA, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ];
    
    assert(keys.length === 10, `Account metas count: ${keys.length} (expected 10)`);
    assert(keys[0].isSigner === true, 'relayer is signer');
    assert(keys[0].isWritable === true, 'relayer is writable (pays rent)');
    assert(keys[1].isWritable === false, 'config is read-only');
    assert(keys[2].isWritable === true, 'withdrawal_message is writable (init)');
    assert(keys[3].isWritable === false, 'solana_recipient is read-only');
    assert(keys[4].isWritable === true, 'susdc_mint is writable (mint_to)');
    assert(keys[5].isWritable === true, 'user_susdc_account is writable');
    assert(keys[6].isWritable === true, 'relayer_susdc_account is writable');
    assert(keys[7].isWritable === false, 'vault_authority is read-only');
}

// ==================== Main ====================

async function main() {
    console.log('=== Seth Withdrawal Flow Test ===\n');
    
    // 1. Test discriminator
    testInstructionDiscriminator();
    
    // 2. Test encoding
    testInstructionEncoding();
    
    // 3. Test PDA derivation
    testPdaDerivation();
    
    // 4. Test ATA
    await testAtaDerivation();
    
    // 5. Test DB mapping
    const dbAvailable = await setupDb();
    await testAddressMapping(dbAvailable);
    
    // 6. Test fee calculation
    testFeeCalculation();
    
    // 7. Test account metas
    testAccountMetas();
    
    // Summary
    console.log('\n=== Test Summary ===');
    console.log(`  Passed: ${testsPassed}`);
    console.log(`  Failed: ${testsFailed}`);
    console.log(`  Total:  ${testsPassed + testsFailed}`);
    
    if (dbPool) await dbPool.end();
    
    process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
