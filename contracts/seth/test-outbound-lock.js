#!/usr/bin/env node
/**
 * Outbound test (Seth -> Solana) in JavaScript.
 *
 * Flow:
 * 1) User calls SethBridge.requestWithdrawToSolanaFromSETH(bytes32,uint256)
 * 2) Verify totalWithdrawRequests increments
 * 3) Query request fields + lock key (lockRequestKey/withdrawRequestKey)
 *
 * Usage:
 *   cd contracts/seth
 *   set USER_PRIVATE_KEY=0x...
 *   node test-outbound-lock.js --amount-seth 10 --solana-recipient-hex <64_hex>
 *
 * Optional:
 *   --bridge 0x...
 *   --min-susdc-raw 0
 *   --gas-limit-call 5000000
 *   --solana-recipient-base58 <pubkey>   (requires: npm i bs58)
 */

const fs = require('fs');
const path = require('path');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');
const SethClient = require(path.join(__dirname, '../../relayer/sethClient.js'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function functionSelector(signature) {
  return createKeccakHash('keccak256').update(signature).digest('hex').slice(0, 8);
}

function uint256Hex(v) {
  return BigInt(v).toString(16).padStart(64, '0');
}

function parseArgs(argv) {
  const out = {
    host: process.env.SETH_HOST || '35.197.170.240',
    port: parseInt(process.env.SETH_PORT || '23001', 10),
    bridge: null,
    userKey: process.env.USER_PRIVATE_KEY || process.env.WITHDRAW_USER_PRIVATE_KEY || '',
    amountSeth: 1,
    minSusdcRaw: 0,
    gasLimitCall: 5_000_000,
    solanaRecipientHex: null,
    solanaRecipientBase58: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === '--host' && n) out.host = n, i++;
    else if (a === '--port' && n) out.port = parseInt(n, 10), i++;
    else if (a === '--bridge' && n) out.bridge = n, i++;
    else if (a === '--user-key' && n) out.userKey = n, i++;
    else if (a === '--amount-seth' && n) out.amountSeth = parseInt(n, 10), i++;
    else if (a === '--min-susdc-raw' && n) out.minSusdcRaw = parseInt(n, 10), i++;
    else if (a === '--gas-limit-call' && n) out.gasLimitCall = parseInt(n, 10), i++;
    else if (a === '--solana-recipient-hex' && n) out.solanaRecipientHex = n, i++;
    else if (a === '--solana-recipient-base58' && n) out.solanaRecipientBase58 = n, i++;
  }

  return out;
}

function normalizePrivateKey(pk) {
  if (!pk) throw new Error('Missing user private key (--user-key or USER_PRIVATE_KEY)');
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}

function normalizeBridgeAddress(addr) {
  const h = String(addr || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`Invalid bridge address: ${addr}`);
  return h;
}

function parseRecipientHex64(v) {
  const h = String(v || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new Error('solana recipient hex must be 64 hex chars');
  }
  return h;
}

function parseRecipientBase58(v) {
  try {
    const bs58 = require('bs58');
    const raw = bs58.decode(String(v).trim());
    if (raw.length !== 32) throw new Error(`decoded length ${raw.length} != 32`);
    return Buffer.from(raw).toString('hex');
  } catch (e) {
    throw new Error(`base58 parse failed (${e.message}); install bs58: npm i bs58`);
  }
}

function loadBridgeAddress(override) {
  if (override) return normalizeBridgeAddress(override);
  const depPath = path.join(__dirname, 'deployment-info.json');
  if (!fs.existsSync(depPath)) {
    throw new Error('Missing --bridge and deployment-info.json not found');
  }
  const j = JSON.parse(fs.readFileSync(depPath, 'utf8'));
  if (!j.SethBridge) throw new Error('deployment-info.json missing SethBridge');
  return normalizeBridgeAddress(j.SethBridge);
}

function deriveAddressFromPrivateKey(client, privateKeyHex) {
  const pk = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  const pub = secp256k1.publicKeyCreate(pk, false);
  return client.deriveAddressFromPubkey(pub).replace(/^0x/, '');
}

async function waitReceipt(client, txHash, maxAttempts = 180, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await client.getTxReceipt(txHash);
    if (r && r.done) return r;
    await sleep(intervalMs);
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const userKey = normalizePrivateKey(args.userKey);
  const bridge = loadBridgeAddress(args.bridge);
  const recipientHex = args.solanaRecipientBase58
    ? parseRecipientBase58(args.solanaRecipientBase58)
    : parseRecipientHex64(args.solanaRecipientHex);

  if (!Number.isFinite(args.amountSeth) || args.amountSeth < 1) {
    throw new Error('--amount-seth must be >= 1');
  }
  if (!Number.isFinite(args.minSusdcRaw) || args.minSusdcRaw < 0) {
    throw new Error('--min-susdc-raw must be >= 0');
  }

  const client = new SethClient(args.host, args.port);
  const userAddress = deriveAddressFromPrivateKey(client, userKey);
  const before = await client.getTotalWithdrawRequests(userAddress, bridge);

  console.log(`[outbound-js] Seth: ${args.host}:${args.port}`);
  console.log(`[outbound-js] Bridge: 0x${bridge}`);
  console.log(`[outbound-js] User: 0x${userAddress}`);
  console.log(`[outbound-js] totalWithdrawRequests(before): ${before}`);

  const input =
    functionSelector('requestWithdrawToSolanaFromSETH(bytes32,uint256)') +
    recipientHex +
    uint256Hex(args.minSusdcRaw);

  const tx = await client.sendTransaction(userKey, {
    to: bridge,
    step: 8,
    input,
    amount: String(args.amountSeth),
    gas_limit: args.gasLimitCall,
    gas_price: 1,
  });

  if (!tx.success || !tx.txHash) {
    throw new Error(`send failed: ${tx.error || 'unknown error'}`);
  }

  const receipt = await waitReceipt(client, tx.txHash);
  if (!receipt) throw new Error('receipt timeout');
  if (receipt.status === 5) throw new Error(`status=5 failed: ${JSON.stringify(receipt.raw)}`);

  console.log(`[outbound-js] tx: ${tx.txHash}`);
  console.log(`[outbound-js] receipt status: ${receipt.status}`);

  const after = await client.getTotalWithdrawRequests(userAddress, bridge);
  console.log(`[outbound-js] totalWithdrawRequests(after): ${after}`);
  if (!(after > before)) {
    throw new Error('request counter did not increase');
  }

  const requestId = after;
  const req = await client.getWithdrawRequest(userAddress, bridge, requestId);
  const requestKey = await client.getWithdrawRequestKey(userAddress, bridge, requestId);

  console.log(`[outbound-js] request_id: ${requestId}`);
  console.log(`[outbound-js] request: ${JSON.stringify(req)}`);
  console.log(`[outbound-js] lock/withdraw request key: ${requestKey}`);
  console.log('[outbound-js] next: ensure relayer is running to complete Solana unlock');
}

main().catch((e) => {
  console.error(`[outbound-js] failed: ${e.message}`);
  process.exit(1);
});

