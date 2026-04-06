/**
 * Test script for Solana-side revenue processing and cross-chain message creation
 *
 * Notes:
 * - Calls seth_bridge::process_revenue and transfers a USDC amount into Vault.
 * - Creates a CrossChainMessage for Seth-side processing by relayer.
 * - Current model: 100% of inbound amount is treated as ecosystem funds.
 * - This script only validates transaction construction and on-chain execution.
 *
 * Usage:
 *   Run in contracts/solana:
 *     node scripts/test-process-revenue.js
 *   Optional:
 *     USER_KEYPAIR_PATH=... node scripts/test-process-revenue.js
 *
 * Prerequisites:
 *   - seth_bridge program is deployed and initialized (config/vault ready)
 *   - deployer-keypair.json address has enough SOL
 *   - user owns a USDC token account with test balance
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ----- Configuration (edit as needed) -----

// USDC Mint in use (devnet)
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// Test amount (USDC, 6 decimals)
const TEST_AMOUNT_USDC = 1; // 1 USDC

// Seth recipient address (20 bytes, 0x prefixed)
// Fill with your Seth test address
// const SETH_RECIPIENT = process.env.SETH_TEST_RECIPIENT || '0x0000000000000000000000000000000000000000';
const SETH_RECIPIENT = "0x742bf979105179e44aed27baf37d66ef73cc3d88";
// ----- Helpers -----

function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  console.log('========================================');
  console.log('Test process_revenue');
  console.log('========================================\n');

  const rpcUrl = process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc';
  const keypairPath = process.env.USER_KEYPAIR_PATH
    ? path.resolve(process.env.USER_KEYPAIR_PATH)
    : path.join(__dirname, '../deployer-keypair.json');

  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  console.log('RPC:', rpcUrl);
  console.log('Payer:', payer.publicKey.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log('SOL balance:', balance / 1e9, 'SOL\n');

  // 1. Resolve programId
  // const deployInfoPath = path.join(__dirname, '../deployment-info.json');
  // if (!fs.existsSync(deployInfoPath)) {
  //   throw new Error('deployment-info.json not found; deploy contract first');
  // }
  // const deployInfo = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
  // const programId = new PublicKey(deployInfo.programId || deployInfo.sethBridgeProgramId || '2PpwtfR2QHfR7qGhH8eaeiTiJac8LfdSQFdR6FJf6aF9');

  // console.log('seth_bridge Program ID:', programId.toBase58());

  const programId = new PublicKey("GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5");

  // 2. Derive config / vault / cross-chain PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    programId
  );
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_authority')],
    programId
  );
  const [vaultTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_token_account')],
    programId
  );

  console.log('Config PDA:', configPda.toBase58());
  console.log('Vault Authority PDA:', vaultAuthorityPda.toBase58());
  console.log('Vault Token Account PDA:', vaultTokenPda.toBase58());

  // Fetch config from chain
  const configAcc = await connection.getAccountInfo(configPda);
  if (!configAcc) {
    throw new Error('Config is not initialized; deploy and initialize bridge first');
  }

  const totalRevenueOffset = 8 + 32 * 6 + 1;
  const totalRevenue = configAcc.data.readBigUInt64LE(totalRevenueOffset);
  const totalRevenueBytes = Buffer.alloc(8);
  totalRevenueBytes.writeBigUInt64LE(totalRevenue);

  const [crossChainMsgPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('cross_chain_msg'), payer.publicKey.toBuffer(), totalRevenueBytes],
    programId
  );
  console.log('CrossChainMessage PDA (total_revenue=' + totalRevenue + '):', crossChainMsgPda.toBase58());

  // 3. User USDC token account (ATA of payer)
  const {
    getAssociatedTokenAddressSync,
  } = require('@solana/spl-token');
  const userUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    payer.publicKey
  );
  console.log('User USDC ATA:', userUsdcAta.toBase58());
  
  console.log('');

  // 4. Build instruction data
  const amountU64 = BigInt(TEST_AMOUNT_USDC * 1_000_000); // 6 decimals
  const bufAmount = Buffer.alloc(8);
  bufAmount.writeBigUInt64LE(amountU64);

  let sethHex = SETH_RECIPIENT.startsWith('0x')
    ? SETH_RECIPIENT.slice(2)
    : SETH_RECIPIENT;
  if (sethHex.length !== 40) {
    console.warn('SETH_RECIPIENT is not 20 bytes; script will truncate/pad automatically.');
  }
  const sethBuf = Buffer.alloc(20);
  Buffer.from(sethHex.padStart(40, '0'), 'hex').copy(sethBuf);

  const data = Buffer.concat([
    sighash('process_revenue'),
    bufAmount,
    sethBuf,
  ]);

  // 5. Prepare account metas (must match ProcessRevenue<'info> order)
  // Account order: user, user_token_account, vault_token_account, vault_authority,
  //          config, cross_chain_message, token_program, system_program
  const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

  const keys = [
    { pubkey: payer.publicKey,     isSigner: true,  isWritable: true },  // user
    { pubkey: userUsdcAta,         isSigner: false, isWritable: true },  // user_token_account
    { pubkey: vaultTokenPda,       isSigner: false, isWritable: true },  // vault_token_account
    { pubkey: vaultAuthorityPda,   isSigner: false, isWritable: false }, // vault_authority
    { pubkey: configPda,           isSigner: false, isWritable: true },  // config
    { pubkey: crossChainMsgPda,    isSigner: false, isWritable: true },  // cross_chain_message
    { pubkey: TOKEN_PROGRAM_ID,    isSigner: false, isWritable: false }, // token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];
  
  const ix = new TransactionInstruction({
    programId,
    keys,
    data,
  });

  const tx = new Transaction();
  tx.add(ix);

  console.log('Sending process_revenue transaction...');
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: false,
  });
  console.log('Signature:', sig);

  const conf = await connection.confirmTransaction(sig, 'confirmed');
  console.log('Confirmed:', conf.value);

  console.log('\n========================================');
  console.log('Transaction completed!');
  console.log('========================================');
  console.log('Distribution details (based on ' + TEST_AMOUNT_USDC + ' USDC):');
  console.log('  - Ecosystem funds (100%):', TEST_AMOUNT_USDC.toFixed(2), 'USDC - sent to Seth via cross-chain message');
  console.log('\nCheck relayer logs for RevenueProcessed detection.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nTest failed:', err);
    process.exit(1);
  });

