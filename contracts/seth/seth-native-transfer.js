#!/usr/bin/env node
/**
 * Simple native SETH transfer on Seth (no contract call, step=0).
 * Use to verify Node/SethClient sends transactions correctly (compare with deploy_seth.py).
 *
 * Environment:
 *   SETH_HOST / SETH_PORT — RPC (default 35.197.170.240:23001)
 *   PRIVATE_KEY or RELAYER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY — 0x-prefixed hex
 *   TO_ADDRESS — recipient (0x or 40 hex chars)
 *   AMOUNT — amount as string integer (Seth often uses whole units, not wei; default 1)
 *
 * Usage:
 *   cd contracts/seth
 *   set RELAYER_PRIVATE_KEY=0x...
 *   set TO_ADDRESS=0x742bf979105179e44aed27baf37d66ef73cc3d88
 *   set AMOUNT=1
 *   node seth-native-transfer.js
 */

const path = require('path');
const SethClient = require(path.join(__dirname, '../../relayer/sethClient.js'));

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForReceipt(client, txHash, maxAttempts = 180, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
        const r = await client.getTxReceipt(txHash);
        if (r && r.done) {
            return { ok: true, status: r.status, raw: r.raw };
        }
        await sleep(intervalMs);
    }
    return { ok: false, status: null };
}

function normalizeAddr(a) {
    if (!a) return '';
    let h = String(a).trim().toLowerCase().replace(/^0x/, '');
    if (h.length === 45 && h.endsWith('00000')) h = h.slice(0, 40);
    if (h.length !== 40 || !/^[0-9a-f]{40}$/.test(h)) {
        throw new Error(`Invalid TO_ADDRESS: ${a}`);
    }
    return h;
}

async function queryBalance(client, addressHex) {
    const addr = normalizeAddr(addressHex);
    try {
        const axios = require('axios');
        const params = new URLSearchParams();
        params.append('address', addr);
        const res = await axios.post(
            `${client.baseUrl}/query_account`,
            params,
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: client.httpTimeoutMs || 30000,
            }
        );
        if (res.status !== 200) return null;
        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        return data.balance != null ? String(data.balance) : null;
    } catch (e) {
        return null;
    }
}

async function main() {
    const pk =
        process.env.PRIVATE_KEY ||
        process.env.RELAYER_PRIVATE_KEY ||
        process.env.DEPLOYER_PRIVATE_KEY;
    if (!pk) {
        console.error('ERROR: Set PRIVATE_KEY, RELAYER_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY');
        process.exit(1);
    }
    const to = process.env.TO_ADDRESS;
    if (!to) {
        console.error('ERROR: Set TO_ADDRESS (recipient 40-byte hex)');
        process.exit(1);
    }
    const amountStr = (process.env.AMOUNT || '1').trim();
    if (!/^[0-9]+$/.test(amountStr)) {
        console.error('ERROR: AMOUNT must be a non-negative integer string');
        process.exit(1);
    }
    const amount = amountStr;
    const host = process.env.SETH_HOST || '35.197.170.240';
    const port = parseInt(process.env.SETH_PORT || '23001', 10);

    const toHex = normalizeAddr(to);
    const client = new SethClient(host, port);

    console.log('--- Seth native transfer (step=0) ---');
    console.log(`Node: http://${host}:${port}`);
    console.log(`To: 0x${toHex}`);
    console.log(`Amount: ${amount}`);

    const balBefore = await queryBalance(client, toHex);
    if (balBefore != null) console.log(`Recipient balance (before): ${balBefore}`);

    const result = await client.sendTransaction(pk, {
        to: toHex,
        step: 0,
        amount,
        gas_limit: parseInt(process.env.GAS_LIMIT || '100000', 10),
        gas_price: parseInt(process.env.GAS_PRICE || '1', 10),
        shard_id: parseInt(process.env.SHARD_ID || '0', 10),
    });

    console.log('sendTransaction result:', JSON.stringify(result, null, 2));

    if (!result.success || !result.txHash) {
        console.error('FAILED: no tx hash or success=false');
        process.exit(1);
    }

    const txHash = result.txHash.startsWith('0x') ? result.txHash : `0x${result.txHash}`;
    console.log(`Tx hash: ${txHash}`);
    console.log('Polling receipt...');

    const rec = await waitForReceipt(client, result.txHash);
    if (!rec.ok) {
        console.error('Receipt timeout (tx may still confirm later).');
        process.exit(2);
    }

    console.log('Receipt status:', rec.status, rec.raw && rec.raw.msg ? `(${rec.raw.msg})` : '');

    const balAfter = await queryBalance(client, toHex);
    if (balAfter != null) {
        console.log(`Recipient balance (after): ${balAfter}`);
        if (balBefore != null) {
            try {
                const delta = BigInt(balAfter) - BigInt(balBefore);
                console.log(`Delta: ${delta.toString()}`);
            } catch (_) {
                /* ignore */
            }
        }
    }

    if (rec.status === 5) {
        console.error('On-chain status=5 (often invalid/reverted).');
        process.exit(1);
    }

    console.log('Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
