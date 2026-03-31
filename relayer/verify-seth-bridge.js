/**
 * Verify SethBridge / PoolB on-chain state via Seth query_contract (same node as relayer).
 *
 * Usage (from relayer/):
 *   node verify-seth-bridge.js
 *   node verify-seth-bridge.js --solana-sig <base58 tx signature>
 *
 * Env (or .env): SETH_HOST, SETH_PORT, SETH_BRIDGE_ADDRESS, RELAYER_PRIVATE_KEY
 */

require('dotenv').config();
const createKeccakHash = require('keccak');
const bs58 = require('bs58');
const { Buffer } = require('buffer');
const secp256k1 = require('secp256k1');
const SethClient = require('./sethClient');

function relayerAddrFromPk(pk) {
    let hex = pk.replace(/^0x/, '');
    const priv = Buffer.from(hex, 'hex');
    const pub = secp256k1.publicKeyCreate(priv, false);
    const rawPubKey = Buffer.from(pub).slice(1);
    const hash = createKeccakHash('keccak256').update(rawPubKey).digest();
    return hash.slice(-20).toString('hex');
}

/** Same as relayer parseSolanaTransaction solana_tx_sig_bytes32 */
function solanaSigToBytes32ForSeth(base58Sig) {
    const sigBytes = bs58.decode(base58Sig);
    return (
        '0x' +
        createKeccakHash('keccak256')
            .update(Buffer.concat([Buffer.alloc(32), sigBytes.slice(0, 32)]))
            .digest('hex')
    );
}

async function main() {
    const host = process.env.SETH_HOST || '127.0.0.1';
    const port = parseInt(process.env.SETH_PORT || '23001', 10);
    const bridge = (process.env.SETH_BRIDGE_ADDRESS || '').replace(/^0x/i, '').toLowerCase();
    const pk = process.env.RELAYER_PRIVATE_KEY;
    if (!bridge) {
        console.error('Set SETH_BRIDGE_ADDRESS');
        process.exit(1);
    }
    if (!pk) {
        console.error('Set RELAYER_PRIVATE_KEY (used as query "from" address)');
        process.exit(1);
    }

    let solanaSig = null;
    const argv = process.argv.slice(2);
    const i = argv.indexOf('--solana-sig');
    if (i >= 0 && argv[i + 1]) solanaSig = argv[i + 1].trim();

    const fromHex = relayerAddrFromPk(pk);
    const client = new SethClient(host, port, process.env.SETH_HTTP_PROXY || process.env.SETH_PROXY || null);

    console.log('Seth node:', `${host}:${port}`);
    console.log('SethBridge: 0x' + bridge);
    console.log('Query from (relayer): 0x' + fromHex);
    console.log('');

    const state = await client.getBridgeState(fromHex, bridge);
    if (!state) {
        console.error('getBridgeState failed (empty or invalid query response)');
        process.exit(1);
    }
    console.log('getBridgeState()');
    console.log('  totalInjectedToPoolB (sUSDC base units):', state.totalInjectedToPoolB);
    console.log('  totalTransactions:', state.totalTransactions);
    console.log('  SethBridge native balance (SETH):', state.nativeBalance);
    console.log('');

    const poolB = await client.getPoolBAddress(fromHex, bridge);
    console.log('poolB():', poolB || '(null)');
    if (poolB && poolB !== '0x0000000000000000000000000000000000000000') {
        const poolAddr = poolB.replace(/^0x/i, '');
        for (const [label, fn] of [
            ['PoolB.reserveSETH (native SETH count)', () => client.getPoolReserveSETH(fromHex, poolAddr)],
            ['PoolB.reservesUSDC (6 decimals)', () => client.getPoolReservesUSDC(fromHex, poolAddr)],
            ['PoolB.getPrice()', () => client.getPoolPrice(fromHex, poolAddr)],
        ]) {
            try {
                const v = await fn();
                if (v != null) console.log(label + ':', v);
            } catch (e) {
                console.log(label + ': (query failed — ' + e.message + ')');
            }
        }
    }

    if (solanaSig) {
        const b32 = solanaSigToBytes32ForSeth(solanaSig);
        console.log('');
        console.log('Solana tx sig (base58):', solanaSig);
        console.log('bytes32 (same as relayer / Seth):', b32);
        const processed = await client.getProcessedTx(fromHex, bridge, b32);
        if (processed === null) {
            console.log('processedTxs(bytes32): query failed');
        } else {
            console.log('processedTxs(bytes32):', processed);
        }
    } else {
        console.log('');
        console.log('Tip: pass --solana-sig <signature> to check processedTxs on Seth.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
