#!/usr/bin/env node
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    keypairPath: path.join(__dirname, 'test-user-keypair.json'),
    programId: process.env.SOLANA_PROGRAM_ID || 'GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5',
    rpcUrl: process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc',
    referrer: process.env.ROOT_REFERRER || '69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keypair' && args[i + 1]) out.keypairPath = args[++i];
    if (args[i] === '--referrer' && args[i + 1]) out.referrer = args[++i];
  }
  return out;
}

async function main() {
  const cfg = parseArgs();
  const raw = JSON.parse(fs.readFileSync(path.resolve(cfg.keypairPath), 'utf8'));
  const user = Keypair.fromSecretKey(Uint8Array.from(raw));
  const programId = new PublicKey(cfg.programId);
  const referrer = new PublicKey(cfg.referrer);
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });

  let bal = await conn.getBalance(user.publicKey);
  if (bal < 0.01 * LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(user.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    bal = await conn.getBalance(user.publicKey);
  }

  const [userInfoPda] = PublicKey.findProgramAddressSync([Buffer.from('user_info'), user.publicKey.toBuffer()], programId);
  const [l1InfoPda] = PublicKey.findProgramAddressSync([Buffer.from('user_info'), referrer.toBuffer()], programId);
  const data = Buffer.concat([sighash('set_referrer'), referrer.toBuffer()]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: userInfoPda, isSigner: false, isWritable: true },
      { pubkey: l1InfoPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const txSig = await conn.sendTransaction(new Transaction().add(ix), [user], { skipPreflight: false });
  const conf = await conn.confirmTransaction(txSig, 'confirmed');
  if (conf?.value?.err) throw new Error(JSON.stringify(conf.value.err));

  console.log(`user=${user.publicKey.toBase58()}`);
  console.log(`balance_sol=${bal / LAMPORTS_PER_SOL}`);
  console.log(`user_info_pda=${userInfoPda.toBase58()}`);
  console.log(`tx=${txSig}`);
}

main().catch((e) => {
  console.error(`init-user failed: ${e.message}`);
  process.exit(1);
});

