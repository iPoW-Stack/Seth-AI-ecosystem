/**
 * Inbound test (Solana -> Seth):
 * User deposits USDC on Solana by calling process_revenue, creating a pending cross-chain message.
 *
 * Usage:
 *   cd contracts/solana
 *   node scripts/test-inbound-lock.js --amount-usdc 1 --seth-recipient 0x742bf979105179e44aed27baf37d66ef73cc3d88
 *
 * Optional env:
 *   RPC_URL
 *   USER_KEYPAIR_PATH
 *   SOLANA_PROGRAM_ID
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    amountUsdc: 1,
    sethRecipient: process.env.SETH_TEST_RECIPIENT || '0x742bf979105179e44aed27baf37d66ef73cc3d88',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--amount-usdc' && args[i + 1]) {
      out.amountUsdc = Number(args[++i]);
    } else if (args[i] === '--seth-recipient' && args[i + 1]) {
      out.sethRecipient = args[++i];
    }
  }
  if (!Number.isFinite(out.amountUsdc) || out.amountUsdc <= 0) {
    throw new Error('Invalid --amount-usdc');
  }
  const h = out.sethRecipient.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) {
    throw new Error('Invalid --seth-recipient, must be 20-byte hex address');
  }
  return out;
}

async function main() {
  const cfg = parseArgs();
  const rpcUrl = process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc';
  const keypairPath = process.env.USER_KEYPAIR_PATH
    ? path.resolve(process.env.USER_KEYPAIR_PATH)
    : path.join(__dirname, '../deployer-keypair.json');
  const programId = new PublicKey(process.env.SOLANA_PROGRAM_ID || 'GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5');
  const usdcMint = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const user = Keypair.fromSecretKey(Uint8Array.from(secret));
  const conn = new Connection(rpcUrl, { commitment: 'confirmed' });

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority')], programId);
  const [vaultTokenPda] = PublicKey.findProgramAddressSync([Buffer.from('vault_token_account')], programId);
  const [userInfoPda] = PublicKey.findProgramAddressSync([Buffer.from('user_info'), user.publicKey.toBuffer()], programId);

  const [userInfoAcc, configAcc] = await Promise.all([
    conn.getAccountInfo(userInfoPda),
    conn.getAccountInfo(configPda),
  ]);
  if (!userInfoAcc) throw new Error('UserInfo missing: run set_referrer/init flow first');
  if (!configAcc) throw new Error('Config missing: initialize bridge first');

  const projectWalletOffset = 8 + 32 * 3;
  const projectWallet = new PublicKey(configAcc.data.slice(projectWalletOffset, projectWalletOffset + 32));

  const totalRevenueOffset = 8 + 32 * 6 + 1;
  const totalRevenue = configAcc.data.readBigUInt64LE(totalRevenueOffset);
  const totalRevenueBytes = Buffer.alloc(8);
  totalRevenueBytes.writeBigUInt64LE(totalRevenue);
  const [crossChainMsgPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('cross_chain_msg'), user.publicKey.toBuffer(), totalRevenueBytes],
    programId
  );

  const userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
  const projectTokenAccount = getAssociatedTokenAddressSync(usdcMint, projectWallet);

  const amountRaw = BigInt(Math.floor(cfg.amountUsdc * 1_000_000));
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amountRaw);
  const recipientBuf = Buffer.from(cfg.sethRecipient.replace(/^0x/, ''), 'hex');
  const data = Buffer.concat([sighash('process_revenue'), amountBuf, recipientBuf]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: userUsdcAta, isSigner: false, isWritable: true },
      { pubkey: vaultTokenPda, isSigner: false, isWritable: true },
      { pubkey: vaultAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: userInfoPda, isSigner: false, isWritable: true },
      { pubkey: projectTokenAccount, isSigner: false, isWritable: true },
      { pubkey: crossChainMsgPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  const sig = await conn.sendTransaction(tx, [user], { skipPreflight: false });
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf?.value?.err) throw new Error(`process_revenue failed: ${JSON.stringify(conf.value.err)}`);

  console.log(`[inbound] signature: ${sig}`);
  console.log(`[inbound] cross_chain_message_pda: ${crossChainMsgPda.toBase58()}`);
  console.log(`[inbound] amount_usdc=${cfg.amountUsdc} recipient=${cfg.sethRecipient}`);
}

main().catch((e) => {
  console.error(`[inbound] failed: ${e.message}`);
  process.exit(1);
});

