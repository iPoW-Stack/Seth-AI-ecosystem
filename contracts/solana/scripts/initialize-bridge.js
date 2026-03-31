/**
 * Solana bridge initialization script (without Anchor Program client)
 * Usage: node scripts/initialize-bridge.js
 * Env vars: PROGRAM_ID, RPC_URL (optional)
 */

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc',
  keypairPath: path.resolve(__dirname, '../deployer-keypair.json'),
  programId: (() => {
    if (process.env.PROGRAM_ID) return process.env.PROGRAM_ID;
    const infoPath = path.resolve(__dirname, '../deployment-info.json');
    if (fs.existsSync(infoPath)) {
      const d = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      return d.programId;
    }
    return 'GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5';
  })(),

  // Wallet addresses (replace with real addresses)
  // teamWallet: process.env.TEAM_WALLET || '0a1020ab518d03a0106964683eb1da2de0c27430',
  teamWallet: 'Ax4XoKH8YKmsKqZzz5E5rfeXZmuBrANHT4C4Z5C6wQ6w',
  // projectWallet: process.env.PROJECT_WALLET || '69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j',
  projectWallet: 'Ax4XoKH8YKmsKqZzz5E5rfeXZmuBrANHT4C4Z5C6wQ6w',
  // Seth Treasury address (Ethereum format, 20 bytes)
  sethTreasury: process.env.SETH_TREASURY || '0x77a3deed600bb37d8fcbe2167bfb1a6e47a16b4f',

  // Bridge vault token mint (fixed to Solana USDC on devnet).
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

// Colored output
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Compute Anchor global function sighash
function sighash(name) {
  // sha256("global:initialize"), first 8 bytes
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  log('\n=== Solana Bridge Initialization ===\n', 'cyan');
  log(`RPC: ${CONFIG.rpcUrl}`, 'cyan');
  log(`Program ID: ${CONFIG.programId}`, 'cyan');
  log(`Bridge Vault Mint: ${CONFIG.usdcMint}`, 'cyan');

  // 1. Load keypair
  log('\n1. Loading keypair...', 'yellow');
  const keypairData = JSON.parse(fs.readFileSync(CONFIG.keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  log(`  Deployer: ${keypair.publicKey.toBase58()}`);

  // 2. Create connection
  log('\n2. Creating connection...', 'yellow');
  const connection = new Connection(CONFIG.rpcUrl, {
    commitment: 'confirmed',
  });
  
  const balance = await connection.getBalance(keypair.publicKey);
  log(`  Balance: ${balance / 1e9} SOL`);

  // 3. Prepare Program and PDAs
  log('\n3. Preparing Program and PDAs...', 'yellow');
  const programId = new PublicKey(CONFIG.programId);
  
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    programId
  );
  log(`  Config PDA: ${configPda.toBase58()}`);
  
  const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_authority')],
    programId
  );
  log(`  Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);

  // 5. Check initialization state
  log('\n5. Checking initialization state...', 'yellow');
  try {
    const info = await connection.getAccountInfo(configPda);
    if (info && info.owner && info.owner.equals(programId)) {
      log('  Program already initialized (config account exists).', 'green');
      return;
    }
  } catch (e) {
    // ignore
  }
  log('  Not initialized yet, continue...', 'yellow');

  // 6. Build initialization transaction
  log('\n6. Building initialization transaction...', 'yellow');
  
  // Seth treasury: 20-byte Ethereum address, left-padded to 32-byte Pubkey
  const sethTreasuryBytes = Buffer.alloc(32);
  const sethTreasuryHex = CONFIG.sethTreasury.replace('0x', '');
  Buffer.from(sethTreasuryHex, 'hex').copy(sethTreasuryBytes, 12);
  const sethTreasuryPubkey = new PublicKey(sethTreasuryBytes);
  
  const teamWallet = new PublicKey(CONFIG.teamWallet);
  const projectWallet = new PublicKey(CONFIG.projectWallet);
  const vaultMint = new PublicKey(CONFIG.usdcMint);
  
  try {
    // Derive vault token account address (PDA, aligned with bridge seeds)
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_token_account')],
      programId
    );
    
    const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    
    log(`  Vault Token Account: ${vaultTokenAccount.toBase58()}`);
    
    // Build instruction data: 8-byte sighash + 32-byte sethTreasury Pubkey
    const data = Buffer.concat([
      sighash('initialize'),
      sethTreasuryPubkey.toBuffer(),
    ]);

    // Fill account keys in Initialize<'info> order
    const keys = [
      { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true },  // owner
      { pubkey: teamWallet,             isSigner: false, isWritable: false }, // team_wallet
      { pubkey: projectWallet,          isSigner: false, isWritable: false }, // project_wallet
      { pubkey: configPda,              isSigner: false, isWritable: true },  // config (init)
      { pubkey: vaultAuthorityPda,      isSigner: false, isWritable: true },  // vault_authority (init)
      { pubkey: vaultTokenAccount,      isSigner: false, isWritable: true },  // vault_token_account (init)
      { pubkey: vaultMint,              isSigner: false, isWritable: false }, // usdc_mint
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false }, // system_program
      { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false }, // token_program
      { pubkey: SYSVAR_RENT_PUBKEY,     isSigner: false, isWritable: false }, // rent
    ];

    const ix = new TransactionInstruction({
      programId,
      keys,
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await connection.sendTransaction(tx, [keypair], {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, 'confirmed');
    
    log(`  Signature: ${sig}`, 'green');
    log('  Initialization succeeded.', 'green');
    
  } catch (e) {
    log(`  Initialization failed: ${e.message}`, 'red');
    console.error(e);
    
    // If spl-token is missing, provide install hint
    if (e.message.includes('Cannot find module')) {
      log('\nInstall dependency: npm install @solana/spl-token', 'yellow');
    }
  }

  // 7. Verify initialization
  log('\n7. Verifying initialization...', 'yellow');
  try {
    const info = await connection.getAccountInfo(configPda);
    if (info && info.owner && info.owner.equals(programId)) {
      log('  Verification succeeded (config account exists).', 'green');
      log(`  Config PDA: ${configPda.toBase58()}`);
      log(`  Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
      return;
    }
    log('  Verification failed: config missing or owner mismatch', 'red');
  } catch (e) {
    log(`  Verification failed: ${e.message}`, 'red');
  }
}

main().catch(err => {
  console.error('Initialization failed:', err);
  process.exit(1);
});