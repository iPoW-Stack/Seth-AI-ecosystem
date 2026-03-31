#!/usr/bin/env node
/**
 * Inject PoolB liquidity via Treasury.injectToPoolB (owner only).
 *
 * Default deploy: PoolB.treasury is Treasury; relayer goes Bridge → Treasury.injectFromBridge → PoolB.
 * This script uses owner-only injectToPoolB (same PoolB path); fund Treasury with sUSDC first.
 *
 * Treasury pulls sUSDC from its own balance and forwards native SETH to PoolB.addLiquidity.
 *
 * Prerequisites:
 *   - PoolB.treasury == Treasury (see above)
 *   - Treasury holds enough sUSDC; Treasury.poolB set (deploy script does)
 *
 * Environment:
 *   SETH_HOST, SETH_PORT — Seth node (default: 35.197.170.240:23001)
 *   OWNER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY — Treasury owner (0x hex); must be sUSDC owner for bootstrap mint
 *   TREASURY_ADDRESS — Treasury contract (or deployment-info.json "Treasury")
 *   SUSDC_ADDRESS — sUSDC contract (or deployment-info.json "sUSDC")
 *   SETH_INJECT_SUSDC_RAW — sUSDC raw (6 decimals). Default 100000000 (= 100 sUSDC)
 *   SETH_INJECT_SETH — SETH count (integer; 1 = 1 SETH). Default 100
 *   SETH_INJECT_SETH_NATIVE — optional override (same integer semantics as SETH_INJECT_SETH)
 *   SETH_BOOTSTRAP_MINT=1 — before inject: sUSDC.addMinter(owner), sUSDC.mint(Treasury, mint raw)
 *   SETH_MINT_SUSDC_RAW — mint amount (defaults to SETH_INJECT_SUSDC_RAW when bootstrapping)
 *
 * Example (100 sUSDC raw + 100 SETH, mint to Treasury then inject):
 *   set OWNER_PRIVATE_KEY=0x...
 *   set SETH_BOOTSTRAP_MINT=1
 *   set SETH_INJECT_SUSDC_RAW=100000000
 *   set SETH_INJECT_SETH=100
 *   node inject-liquidity.js
 */

const fs = require('fs');
const path = require('path');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');
const SethClient = require(path.join(__dirname, '../../relayer/sethClient.js'));

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForReceipt(client, txHash, maxAttempts = 180, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
        const r = await client.getTxReceipt(txHash);
        if (r && r.done) {
            return [true, r.status];
        }
        await sleep(intervalMs);
    }
    return [false, null];
}

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

function normalizeAddress(addr) {
    if (!addr) return '';
    if (addr.startsWith('0x')) addr = addr.slice(2);
    return addr.toLowerCase();
}

function uint256ToHex(value) {
    const hex = BigInt(value).toString(16);
    return hex.padStart(64, '0');
}

function getFunctionSig(signature) {
    return createKeccakHash('keccak256').update(signature).digest().slice(0, 4).toString('hex');
}

const MAX_U64_AMOUNT = 2n ** 64n - 1n;

/** Positive integer string → SETH amount (1 = 1 SETH; no sub-units, no conversion). */
function parseNativeSethAmount(s) {
    const t = String(s || '').trim();
    if (!t) throw new Error('empty SETH_INJECT_SETH');
    if (!/^[0-9]+$/.test(t)) throw new Error('SETH_INJECT_SETH must be a positive integer (SETH count)');
    const v = BigInt(t);
    if (v < 1n) throw new Error('SETH_INJECT_SETH must be >= 1');
    return v;
}

/** Proportional chunks so each native tx amount fits uint64 (Seth wire format). */
function injectChunks(totalSusdcRaw, totalSethNative) {
    const chunks = [];
    let remSeth = totalSethNative;
    let remSusdc = totalSusdcRaw;
    while (remSeth > 0n) {
        const chunkSeth = remSeth > MAX_U64_AMOUNT ? MAX_U64_AMOUNT : remSeth;
        const chunkSusdc =
            chunkSeth === remSeth ? remSusdc : (remSusdc * chunkSeth) / remSeth;
        chunks.push([chunkSusdc, chunkSeth]);
        remSeth -= chunkSeth;
        remSusdc -= chunkSusdc;
    }
    return chunks;
}

function loadTreasuryAddress() {
    if (process.env.TREASURY_ADDRESS) {
        return normalizeAddress(process.env.TREASURY_ADDRESS);
    }
    const p = path.join(__dirname, 'deployment-info.json');
    if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j.Treasury) return normalizeAddress(j.Treasury);
    }
    return '';
}

function loadSusdcAddress() {
    if (process.env.SUSDC_ADDRESS) {
        return normalizeAddress(process.env.SUSDC_ADDRESS);
    }
    const p = path.join(__dirname, 'deployment-info.json');
    if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (j.sUSDC) return normalizeAddress(j.sUSDC);
    }
    return '';
}

/** Last 20 bytes of keccak256(pubkey) — same as SethClient.sendTransaction */
function addressFromPrivateKey(privateKeyHex) {
    let pk = privateKeyHex.trim();
    if (pk.startsWith('0x')) pk = pk.slice(2);
    const privateKey = Buffer.from(pk, 'hex');
    const pubKeyBytes = secp256k1.publicKeyCreate(privateKey, false);
    const rawPubKey = Buffer.from(pubKeyBytes.slice(1));
    const hash = createKeccakHash('keccak256').update(rawPubKey).digest();
    return hash.slice(-20).toString('hex');
}

function padAddressParam(addrHex) {
    const a = normalizeAddress(addrHex);
    if (a.length !== 40) throw new Error('invalid address for ABI encode');
    return '000000000000000000000000' + a;
}

function encodeAddMinter(minterAddrHex) {
    return '0x' + getFunctionSig('addMinter(address)') + padAddressParam(minterAddrHex);
}

function encodeMint(toAddrHex, amount) {
    const a = typeof amount === 'bigint' ? amount : BigInt(amount);
    return (
        '0x' +
        getFunctionSig('mint(address,uint256)') +
        padAddressParam(toAddrHex) +
        uint256ToHex(a)
    );
}

async function sendContractCall(client, privateKeyHex, toHex, inputHex, amountWei = '0', label = 'tx') {
    const result = await client.sendTransaction(privateKeyHex, {
        to: toHex,
        step: 8,
        input: inputHex.startsWith('0x') ? inputHex : '0x' + inputHex,
        gas_limit: 2000000,
        gas_price: 1,
        amount: String(amountWei),
    });
    if (!result.success || !result.txHash) {
        throw new Error(`${label}: ${result.error || 'send failed'}`);
    }
    log(`TX (${label}): ${result.txHash}`, 'green');
    log('Waiting for receipt...', 'yellow');
    const [ok, status] = await waitForReceipt(client, result.txHash);
    if (!ok) throw new Error(`${label}: receipt timeout`);
    if (status === 10) throw new Error(`${label}: status=10 (tx not found)`);
    if (status === 5) throw new Error(`${label}: status=5 (reverted or invalid)`);
    log(`${label} done. status=${status}`, 'green');
    return result.txHash;
}

async function main() {
    log('\n========================================', 'cyan');
    log('  Inject liquidity (Treasury.injectToPoolB)', 'cyan');
    log('========================================\n', 'cyan');

    const privateKeyHex =
        process.env.OWNER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (!privateKeyHex) {
        log('ERROR: Set OWNER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY', 'red');
        process.exit(1);
    }

    const treasuryHex = loadTreasuryAddress();
    if (!treasuryHex || treasuryHex.length !== 40) {
        log('ERROR: Set TREASURY_ADDRESS or add "Treasury" to deployment-info.json', 'red');
        process.exit(1);
    }

    const host = process.env.SETH_HOST || '35.197.170.240';
    const port = parseInt(process.env.SETH_PORT || '23001', 10);
    /** Default 100000000 raw = 100 sUSDC (6 decimals) */
    const susdcRaw = BigInt(process.env.SETH_INJECT_SUSDC_RAW || '100000000');
    let sethNative;
    const nativeOverride = process.env.SETH_INJECT_SETH_NATIVE || process.env.SETH_INJECT_SETH_WEI;
    if (nativeOverride && nativeOverride.trim()) {
        sethNative = BigInt(nativeOverride.trim());
        if (sethNative < 1n) {
            log('ERROR: native SETH override must be >= 1', 'red');
            process.exit(1);
        }
    } else {
        try {
            sethNative = parseNativeSethAmount(process.env.SETH_INJECT_SETH || '100');
        } catch (e) {
            log(`ERROR: ${e.message}`, 'red');
            process.exit(1);
        }
    }

    log(`Seth: ${host}:${port}`);
    log(`Treasury: 0x${treasuryHex}`);
    log(`amountSUSDC (raw, 6 decimals): ${susdcRaw.toString()}`);
    log(`amountSETH (count, 1 = 1 SETH): ${sethNative.toString()}\n`);

    const client = new SethClient(host, port);

    const bootstrap =
        process.env.SETH_BOOTSTRAP_MINT === '1' ||
        process.env.SETH_BOOTSTRAP_MINT === 'true';
    if (bootstrap) {
        const susdcHex = loadSusdcAddress();
        if (!susdcHex || susdcHex.length !== 40) {
            log('ERROR: SETH_BOOTSTRAP_MINT requires SUSDC_ADDRESS or sUSDC in deployment-info.json', 'red');
            process.exit(1);
        }
        let mintRaw = susdcRaw;
        const mintEnv = process.env.SETH_MINT_SUSDC_RAW;
        if (mintEnv !== undefined && mintEnv.trim() !== '') {
            mintRaw = BigInt(mintEnv.trim());
        }
        if (mintRaw < susdcRaw) {
            log('ERROR: SETH_MINT_SUSDC_RAW must be >= SETH_INJECT_SUSDC_RAW', 'red');
            process.exit(1);
        }
        const deployerHex = addressFromPrivateKey(privateKeyHex);
        log(`[Bootstrap] sUSDC: 0x${susdcHex}`, 'cyan');
        log(`[Bootstrap] addMinter(0x${deployerHex}) then mint(Treasury, ${mintRaw.toString()})`, 'cyan');
        await sendContractCall(
            client,
            privateKeyHex,
            susdcHex,
            encodeAddMinter(deployerHex),
            '0',
            'addMinter(deployer)'
        );
        await sendContractCall(
            client,
            privateKeyHex,
            susdcHex,
            encodeMint(treasuryHex, mintRaw),
            '0',
            'mint(Treasury)'
        );
    }

    const sig = getFunctionSig('injectToPoolB(uint256,uint256)');
    const parts = injectChunks(susdcRaw, sethNative);
    if (parts.length > 1) {
        log(
            `Splitting into ${parts.length} txs (Seth tx amount field max ${MAX_U64_AMOUNT.toString()} SETH per tx)`,
            'yellow'
        );
    }

    for (let i = 0; i < parts.length; i++) {
        const [cSusdc, cSeth] = parts[i];
        log(
            `injectToPoolB part ${i + 1}/${parts.length}: sUSDC raw=${cSusdc} SETH=${cSeth}`,
            'yellow'
        );
        const inputData = '0x' + sig + uint256ToHex(cSusdc) + uint256ToHex(cSeth);

        const result = await client.sendTransaction(privateKeyHex, {
            to: treasuryHex,
            step: 8,
            input: inputData,
            gas_limit: 2000000,
            gas_price: 1,
            amount: cSeth.toString(),
        });

        if (!result.success || !result.txHash) {
            log(`ERROR: ${result.error || 'send failed'}`, 'red');
            process.exit(1);
        }

        log(`TX: ${result.txHash}`, 'green');
        log('Waiting for receipt...', 'yellow');

        const [ok, status] = await waitForReceipt(client, result.txHash);
        if (!ok) {
            log('ERROR: Receipt timeout', 'red');
            process.exit(1);
        }
        if (status === 10) {
            log('ERROR: status=10 (tx not found).', 'red');
            process.exit(1);
        }
        if (status === 5) {
            log(
                'ERROR: status=5 — check PoolB.treasury==Treasury, Treasury sUSDC balance, setPoolB.',
                'red'
            );
            process.exit(1);
        }

        log(`Part ${i + 1} done. Receipt status=${status}`, 'green');
    }

    log('All inject parts done.', 'green');
}

main().catch((err) => {
    log(`FATAL: ${err.message}`, 'red');
    console.error(err.stack);
    process.exit(1);
});
