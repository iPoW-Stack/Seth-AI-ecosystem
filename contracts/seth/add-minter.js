#!/usr/bin/env node
/**
 * Add Deployer as sUSDC Minter
 * 
 * This script calls sUSDC.addMinter(deployer) to enable minting.
 * Must be called as owner before running inject-liquidity.js
 */

const path = require('path');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');
const { Buffer } = require('buffer');

const SethClient = require(path.join(__dirname, '../../relayer/sethClient.js'));

const CONFIG = {
    host: process.env.SETH_HOST || '35.197.170.240',
    port: parseInt(process.env.SETH_PORT || '23001'),
    privateKeyHex: process.env.DEPLOYER_PRIVATE_KEY,
    
    sUSDCAddr: '0x508fb20e0046f69b43c2daf61d0690a972e133b6',
};

// Helpers
function log(msg, color = '') {
    const colors = {
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        red: '\x1b[31m',
        cyan: '\x1b[36m',
        reset: '\x1b[0m',
    };
    const c = colors[color] || '';
    console.log(`${c}${msg}${colors.reset}`);
}

function deriveAddressFromPrivKey(privKeyHex) {
    if (privKeyHex.startsWith('0x')) privKeyHex = privKeyHex.slice(2);
    const privKey = Buffer.from(privKeyHex, 'hex');
    const pubKey = secp256k1.publicKeyCreate(privKey, false);
    const pubKeyBuf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey);
    const pubKeyWithoutPrefix = pubKeyBuf.slice(1);
    const hash = createKeccakHash('keccak256').update(pubKeyWithoutPrefix).digest();
    return '0x' + hash.slice(-20).toString('hex');
}

function normalizeAddress(addr) {
    if (addr.startsWith('0x')) addr = addr.slice(2);
    return addr.toLowerCase();
}

function encodeAddress(addr) {
    addr = normalizeAddress(addr);
    return addr.padStart(64, '0');
}

function getFunctionSig(signature) {
    const hash = createKeccakHash('keccak256').update(signature).digest();
    return hash.slice(0, 4).toString('hex');
}

async function waitForReceipt(client, txHash, maxAttempts = 60, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
        const receipt = await client.getTxReceipt(txHash);
        if (receipt && receipt.status !== undefined) {
            return [true, receipt.status];
        }
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return [false, null];
}

async function main() {
    log('\n========================================', 'cyan');
    log('    Add Deployer as sUSDC Minter', 'cyan');
    log('========================================\n', 'cyan');

    if (!CONFIG.privateKeyHex) {
        log('ERROR: DEPLOYER_PRIVATE_KEY not set', 'red');
        process.exit(1);
    }

    const client = new SethClient(CONFIG.host, CONFIG.port);
    const deployerAddr = deriveAddressFromPrivKey(CONFIG.privateKeyHex);

    log(`Deployer: ${deployerAddr}`);
    log(`sUSDC: ${CONFIG.sUSDCAddr}\n`);

    // Call sUSDC.addMinter(deployer)
    log('Adding deployer as minter...', 'yellow');
    
    const sig_addMinter = getFunctionSig('addMinter(address)');
    const encoded = '0x' + sig_addMinter + encodeAddress(normalizeAddress(deployerAddr));

    try {
        const result = await client.sendTransaction(CONFIG.privateKeyHex, {
            to: normalizeAddress(CONFIG.sUSDCAddr),
            step: 8,
            input: encoded,
            gas_limit: 100000,
            amount: 0
        });
        
        const txHash = result.txHash;
        log(`TX Hash: ${txHash}`, 'green');
        log(`Waiting for receipt...`);

        const [ok, status] = await waitForReceipt(client, txHash);
        if (!ok) {
            log(`ERROR: Receipt timeout`, 'red');
            process.exit(1);
        }

        if (status === 0) {
            log(`✓ Success! Deployer is now a minter.`, 'green');
        } else {
            log(`✗ Failed with status ${status}`, 'red');
            process.exit(1);
        }
    } catch (e) {
        log(`ERROR: ${e.message}`, 'red');
        process.exit(1);
    }

    log('\nYou can now run inject-liquidity.js', 'cyan');
}

main().catch((err) => {
    log(`FATAL ERROR: ${err.message}`, 'red');
    process.exit(1);
});
