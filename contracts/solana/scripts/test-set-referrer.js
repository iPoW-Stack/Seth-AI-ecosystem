/**
 * Test script: initialize user_info (call set_referrer)
 *
 * Purpose:
 * - Creates and initializes UserInfo for current deployer (user)
 * - Sets a valid referrer (must not equal user)
 * - Supports two-level referral model (L1 and L2)
 *
 * Usage (in contracts/solana):
 *   # Use root referrer from env (recommended for first-time setup)
 *   #   $env:ROOT_REFERRER_PUBKEY="xxxx"   (PowerShell)
 *   #   set ROOT_REFERRER_PUBKEY=xxxx      (CMD)
 *   #   $env:USER_KEYPAIR_PATH="path\\to\\user-keypair.json" (optional)
 *   node scripts/test-set-referrer.js
 *
 *   # With referrer (specific Solana pubkey)
 *   # Windows PowerShell:
 *   #   $env:REFERRER_PUBKEY="xxxx"
 *   # CMD:
 *   #   set REFERRER_PUBKEY=xxxx
 *   node scripts/test-set-referrer.js
 *
 * Notes:
 *   - If referrer is not default pubkey, referrer must already be registered
 *   - After first deployment, owner can be first user and act as referrer
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
  console.log('Test set_referrer (init user_info)');
  console.log('========================================\n');

  const rpcUrl = process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc';
  const keypairPath = process.env.USER_KEYPAIR_PATH
    ? path.resolve(process.env.USER_KEYPAIR_PATH)
    : path.join(__dirname, '../deployer-keypair.json');

  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const user = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  console.log('RPC:', rpcUrl);
  console.log('User (deployer):', user.publicKey.toBase58());

  const balance = await connection.getBalance(user.publicKey);
  console.log('SOL balance:', balance / 1e9, 'SOL\n');

  // 1. Program ID
  const deployInfoPath = path.join(__dirname, '../deployment-info.json');
  let programId;
  if (process.env.SOLANA_PROGRAM_ID) {
    programId = new PublicKey(process.env.SOLANA_PROGRAM_ID);
  } else if (fs.existsSync(deployInfoPath)) {
    const d = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
    programId = new PublicKey(
      d.programId || d.sethBridgeProgramId || 'GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5'
    );
  } else {
    programId = new PublicKey('GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5');
  }

  console.log('seth_bridge Program ID:', programId.toBase58());

  // 2. Derive user_info PDA
  const [userInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), user.publicKey.toBuffer()],
    programId
  );
  console.log('UserInfo PDA:', userInfoPda.toBase58());

  // 3. Select referrer
  const DEFAULT_PUBKEY = new PublicKey('11111111111111111111111111111111');
  let referrerStr = process.env.REFERRER_PUBKEY;
  let referrerPk;
  
  if (referrerStr) {
    referrerPk = new PublicKey(referrerStr);
  } else {
    // Prefer explicit root referrer from env for first-time setup.
    // Keep default pubkey as fallback for advanced/manual flows.
    const rootReferrerStr = process.env.ROOT_REFERRER_PUBKEY;
    referrerPk = rootReferrerStr ? new PublicKey(rootReferrerStr) : DEFAULT_PUBKEY;
  }

  if (referrerPk.equals(user.publicKey)) {
    throw new Error(
      'referrer cannot equal user. Use USER_KEYPAIR_PATH for a non-root user, ' +
      'and set ROOT_REFERRER_PUBKEY/REFERRER_PUBKEY to a registered referrer.'
    );
  }

  console.log('Referrer:', referrerPk.toBase58());
  console.log('Is default (no referrer):', referrerPk.equals(DEFAULT_PUBKEY));

  // 4. Check if user_info already exists
  const existingUserInfo = await connection.getAccountInfo(userInfoPda);
  if (existingUserInfo) {
    console.log('\nUserInfo account already exists.');
    console.log('If this account was created by old contract layout, close or use a new account.');
    console.log('Suggested options:');
    console.log('  1. Use a different wallet/user for tests');
    console.log('  2. Redeploy contract with a new program keypair');
    console.log('  3. Test with local validator');
    
    // Try reading account size for quick compatibility check
    console.log('\nCurrent account size:', existingUserInfo.data.length, 'bytes');
    console.log('Expected UserInfo size: ~130 bytes (8 discriminator + struct)');
    
    // If size mismatches, provide explicit hint
    const expectedSize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 4 + 4; // approximate
    if (existingUserInfo.data.length < expectedSize - 20 || existingUserInfo.data.length > expectedSize + 20) {
      console.log('\nAccount size mismatch, likely created by old contract layout.');
      console.log('Use a new wallet or redeploy the contract.');
      process.exit(1);
    }
  }

  // 5. Derive L1 referrer info PDA
  const [l1ReferrerInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), referrerPk.toBuffer()],
    programId
  );
  console.log('L1 Referrer Info PDA:', l1ReferrerInfoPda.toBase58());

  // 6. Build set_referrer instruction data (sighash + referrer pubkey)
  const data = Buffer.concat([
    sighash('set_referrer'),
    referrerPk.toBuffer(),
  ]);

  // 6.1 Derive l2_referrer_info (new instruction expects explicit account)
  let l2ReferrerInfoPda = l1ReferrerInfoPda;
  const l1Info = await connection.getAccountInfo(l1ReferrerInfoPda);
  if (l1Info && l1Info.data && l1Info.data.length >= 72) {
    // UserInfo layout(approx): 8 discriminator + 32 user + 32 referrer + ...
    const l2ReferrerPk = new PublicKey(l1Info.data.slice(40, 72));
    if (!l2ReferrerPk.equals(DEFAULT_PUBKEY)) {
      const [derivedL2Pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('user_info'), l2ReferrerPk.toBuffer()],
        programId
      );
      l2ReferrerInfoPda = derivedL2Pda;
      console.log('L2 Referrer:', l2ReferrerPk.toBase58());
      console.log('L2 Referrer Info PDA:', l2ReferrerInfoPda.toBase58());
    } else {
      console.log('L2 Referrer: <none>');
      console.log('L2 Referrer Info PDA:', l2ReferrerInfoPda.toBase58());
    }
  } else {
    console.log('L2 Referrer: <unavailable>');
    console.log('L2 Referrer Info PDA:', l2ReferrerInfoPda.toBase58());
  }

  // 7. Prepare account metas
  // Current SetReferrer accounts:
  // - user (signer, mut)
  // - user_info (init_if_needed, mut)
  // - l1_referrer_info (mut, seeds-validated)
  // - l2_referrer_info (optional, mut)
  // - system_program
  
  // Check whether L1 referrer is registered (if not default)
  if (!referrerPk.equals(DEFAULT_PUBKEY)) {
    const l1Info = await connection.getAccountInfo(l1ReferrerInfoPda);
    if (!l1Info) {
      console.log('\nL1 referrer is not registered. Referrer must register user_info first.');
      console.log('Suggested options:');
      console.log('  1. Let referrer run this script first');
      console.log('  2. Or do not set referrer (use default pubkey)');
      process.exit(1);
    }
    console.log('L1 referrer is registered.');
  }

  const keys = [
    { pubkey: user.publicKey,  isSigner: true,  isWritable: true },  // user
    { pubkey: userInfoPda,     isSigner: false, isWritable: true },  // user_info (init_if_needed)
    { pubkey: l1ReferrerInfoPda, isSigner: false, isWritable: true }, // l1_referrer_info
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
  ];
  // l2_referrer_info is optional in program logic but key is still expected by this raw instruction.
  keys.push({ pubkey: l2ReferrerInfoPda, isSigner: false, isWritable: true });

  const ix = new TransactionInstruction({
    programId,
    keys,
    data,
  });

  const tx = new Transaction().add(ix);
  console.log('\nSending set_referrer transaction...');
  
  try {
    const sig = await connection.sendTransaction(tx, [user], {
      skipPreflight: false,
    });
    console.log('Signature:', sig);

    const conf = await connection.confirmTransaction(sig, 'confirmed');
    console.log('Confirmed:', conf.value);

    console.log('\nDone: UserInfo initialized.');
    console.log('You can now run test-process-revenue.js.');
  } catch (err) {
    if (err.message && err.message.includes('AccountDidNotDeserialize')) {
      console.log('\nAccount deserialization failed.');
      console.log('Cause: on-chain UserInfo account was created by old contract layout.');
      console.log('\nSuggested options:');
      console.log('  1. Use a different wallet/user for tests');
      console.log('  2. Redeploy contract with a new program keypair');
      console.log('  3. Test with local validator (solana-test-validator)');
    }
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nset_referrer test failed:', err.message || err);
    process.exit(1);
  });