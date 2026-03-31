/**
 * Root user initialization script
 *
 * Purpose:
 * - Creates UserInfo for contract owner (no referrer required)
 * - Provides the first-level referrer bootstrap
 * - Only owner can call this instruction
 *
 * Usage:
 *   Run in contracts/solana:
 *     node scripts/init-root-user.js
 *
 * Prerequisites:
 *   - Program has been deployed and initialized
 *   - Address in deployer-keypair.json is the owner
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

function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  console.log('========================================');
  console.log('Initialize root user (init_root_user)');
  console.log('========================================\n');

  const rpcUrl = process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc';
  const keypairPath = path.join(__dirname, '../deployer-keypair.json');

  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const owner = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  console.log('RPC:', rpcUrl);
  console.log('Owner:', owner.publicKey.toBase58());

  const balance = await connection.getBalance(owner.publicKey);
  console.log('SOL balance:', balance / 1e9, 'SOL\n');

  // 1. Load deployment info
  // const deployInfoPath = path.join(__dirname, '../deployment-info.json');
  // if (!fs.existsSync(deployInfoPath)) {
  //   throw new Error('deployment-info.json not found; deploy contract first');
  // }
  // const deployInfo = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
  // const programId = new PublicKey(deployInfo.programId || deployInfo.sethBridgeProgramId);

  const programId = new PublicKey("GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5");
  console.log('Program ID:', programId.toBase58());

  // 2. Derive PDAs
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [userInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), owner.publicKey.toBuffer()],
    programId
  );

  console.log('Config PDA:', configPda.toBase58());
  console.log('UserInfo PDA:', userInfoPda.toBase58());

  // 3. Check whether UserInfo already exists
  const existingUserInfo = await connection.getAccountInfo(userInfoPda);
  if (existingUserInfo) {
    console.log('\nRoot user already exists, nothing to initialize.');
    return;
  }

  // 4. Build instruction
  const data = sighash('init_root_user');

  const keys = [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: userInfoPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId, keys, data });
  const tx = new Transaction().add(ix);

  // 5. Send transaction
  console.log('\nSending init_root_user transaction...');
  try {
    const sig = await connection.sendTransaction(tx, [owner], { skipPreflight: false });
    console.log('Transaction signature:', sig);
    await connection.confirmTransaction(sig);
    console.log('Root user initialized successfully.');
    console.log('\nOther users can now use this address as referrer.');
  } catch (err) {
    console.log('Initialization failed:', err.message);
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFailed:', err.message || err);
    process.exit(1);
  });