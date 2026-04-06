/**
 * Send one step=8 call to SethBridge so default prepayment applies:
 * DEFAULT_CONTRACT_PREPAYMENT + BRIDGE_ADDRESS_PREPAYMENT_EXTRA when `to` === SETH_BRIDGE_ADDRESS.
 *
 * Usage (from relayer/):
 *   node send-bridge-once.js
 *   node send-bridge-once.js 0x614f5d7aa80dd021ca3fa570bcc08f7d9f794322
 *
 * Env: SETH_HOST, SETH_PORT, RELAYER_PRIVATE_KEY, SETH_BRIDGE_ADDRESS (or pass bridge as argv[2])
 */

require('dotenv').config();
const createKeccakHash = require('keccak');
const SethClient = require('./sethClient');

const DEFAULT_CONTRACT_PREPAYMENT = 100_000_000;
const BRIDGE_ADDRESS_PREPAYMENT_EXTRA = 400_000_000;

function selector(fnSig) {
    return createKeccakHash('keccak256').update(fnSig).digest('hex').slice(0, 8);
}

async function pollReceipt(client, txHash, timeoutMs = 600000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const r = await client.getTxReceipt(txHash);
        if (r && r.done) return r;
        await new Promise((res) => setTimeout(res, 1000));
    }
    return null;
}

async function main() {
    const bridgeArg = process.argv[2];
    if (bridgeArg) {
        process.env.SETH_BRIDGE_ADDRESS = bridgeArg.startsWith('0x') ? bridgeArg : `0x${bridgeArg}`;
    }
    const bridge = (process.env.SETH_BRIDGE_ADDRESS || '').trim();
    const pk = process.env.RELAYER_PRIVATE_KEY;
    if (!bridge) {
        console.error('Set SETH_BRIDGE_ADDRESS or pass bridge address as first argument');
        process.exit(1);
    }
    if (!pk) {
        console.error('Set RELAYER_PRIVATE_KEY');
        process.exit(1);
    }

    const host = process.env.SETH_HOST || '127.0.0.1';
    const port = parseInt(process.env.SETH_PORT || '23001', 10);
    const bridgeHex = bridge.replace(/^0x/i, '').toLowerCase();

    console.log('Seth:', `${host}:${port}`);
    console.log('Bridge:', '0x' + bridgeHex);
    console.log(
        'Expected pepay (auto, no explicit prepayment in txParams):',
        DEFAULT_CONTRACT_PREPAYMENT + BRIDGE_ADDRESS_PREPAYMENT_EXTRA,
        `(${DEFAULT_CONTRACT_PREPAYMENT} + ${BRIDGE_ADDRESS_PREPAYMENT_EXTRA})`
    );

    const input = selector('totalWithdrawRequests()');
    const client = new SethClient(host, port, process.env.SETH_HTTP_PROXY || process.env.SETH_PROXY || null);

    const res = await client.sendContractCall(pk, bridgeHex, input, {
        gasLimit: 50_000_000,
        gasPrice: 1,
    });

    if (!res || !res.success) {
        console.error('Send failed:', res);
        process.exit(1);
    }
    console.log('Submitted tx:', res.txHash);
    console.log('Polling receipt...');
    const receipt = await pollReceipt(client, res.txHash);
    if (!receipt) {
        console.error('Receipt timeout');
        process.exit(1);
    }
    console.log('Receipt status:', receipt.status, 'raw:', JSON.stringify(receipt.raw).slice(0, 500));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
