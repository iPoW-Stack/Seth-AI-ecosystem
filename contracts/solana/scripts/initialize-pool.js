/**
 * DIRM 池初始化脚本（不依赖 Anchor Program）
 * 步骤: 1. initialize_pool  2. initialize_vaults
 *
 * 用法: node scripts/initialize-pool.js
 * 环境变量: USDC_MINT, SUSDC_MINT, DIRM_PROGRAM_ID (可选)
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

const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  keypairPath: path.resolve(__dirname, '../deployer-keypair.json'),
  programId: (() => {
    if (process.env.DIRM_PROGRAM_ID) return process.env.DIRM_PROGRAM_ID;
    const infoPath = path.resolve(__dirname, '../deployment-info.json');
    if (fs.existsSync(infoPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
        if (d.dirmProgramId) return d.dirmProgramId;
      } catch {}
    }
    // 默认使用当前已部署的 dirm_program ID
    return '125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc';
  })(),
  usdcMint:
    process.env.USDC_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  susdcMint: process.env.SUSDC_MINT || null,

  // DIRM 参数 (1e6 定点)
  amplification: 30,
  k: 30_000_000, // 30.0
  r_max: 50_000, // 0.05 = 5%
  tau: 20_000, // 0.02 = 2%
};

function log(msg, color = '') {
  const c = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', reset: '\x1b[0m' };
  console.log(`${c[color] || ''}${msg}${c.reset}`);
}

// Anchor 全局函数 sighash
function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  log('\n=== DIRM 池初始化 ===\n', 'yellow');

  // 1. 获取 sUSDC mint
  let susdcMint = CONFIG.susdcMint;
  if (!susdcMint) {
    const infoPath = path.join(__dirname, '../susdc-token-info.json');
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      susdcMint = info.mintAddress;
      log(`从 susdc-token-info.json 读取 sUSDC Mint: ${susdcMint}`);
    } else {
      log('错误: 请先运行 node scripts/create-susdc.js 创建 sUSDC', 'red');
      log('或设置环境变量 SUSDC_MINT', 'red');
      process.exit(1);
    }
  }

  // 2. 加载 keypair 与连接
  const keypairData = JSON.parse(fs.readFileSync(CONFIG.keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));

  const connection = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed' });
  const programId = new PublicKey(CONFIG.programId);
  const usdcMintPk = new PublicKey(CONFIG.usdcMint);
  const susdcMintPk = new PublicKey(susdcMint);

  // 3. 计算 PDA
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), usdcMintPk.toBuffer(), susdcMintPk.toBuffer()],
    programId
  );
  const [dirmConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('dirm_config'), poolPda.toBuffer()],
    programId
  );
  const [usdcVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_usdc'), poolPda.toBuffer()],
    programId
  );
  const [susdcVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_susdc'), poolPda.toBuffer()],
    programId
  );
  const [treasuryVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('treasury'), poolPda.toBuffer()],
    programId
  );

  log(`Pool PDA: ${poolPda.toBase58()}`);
  log(`DIRM Config PDA: ${dirmConfigPda.toBase58()}`);
  log(`USDC Vault: ${usdcVaultPda.toBase58()}`);
  log(`sUSDC Vault: ${susdcVaultPda.toBase58()}`);
  log(`Treasury Vault: ${treasuryVaultPda.toBase58()}`);

  const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

  // Step 1: initialize_pool
  log('\n1. 调用 initialize_pool...', 'yellow');
  try {
    const poolInfo = await connection.getAccountInfo(poolPda);
    if (poolInfo) {
      log('  Pool 已存在，跳过 initialize_pool', 'yellow');
    } else {
      // data: sighash + amplification + k + r_max + tau (u64 LE)
      const bufA = Buffer.alloc(8);
      bufA.writeBigUInt64LE(BigInt(CONFIG.amplification));
      const bufK = Buffer.alloc(8);
      bufK.writeBigUInt64LE(BigInt(CONFIG.k));
      const bufR = Buffer.alloc(8);
      bufR.writeBigUInt64LE(BigInt(CONFIG.r_max));
      const bufT = Buffer.alloc(8);
      bufT.writeBigUInt64LE(BigInt(CONFIG.tau));

      const data = Buffer.concat([
        sighash('initialize_pool'),
        bufA,
        bufK,
        bufR,
        bufT,
      ]);

      const keys = [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },  // authority / payer
        { pubkey: poolPda,           isSigner: false, isWritable: true }, // pool (init)
        { pubkey: dirmConfigPda,     isSigner: false, isWritable: true }, // dirm_config (init)
        { pubkey: usdcMintPk,        isSigner: false, isWritable: false },// usdc_mint
        { pubkey: susdcMintPk,       isSigner: false, isWritable: false },// susdc_mint
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
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
      log(`  initialize_pool 交易: ${sig}`, 'green');
    }
  } catch (e) {
    log(`  initialize_pool 失败: ${e.message}`, 'red');
    throw e;
  }

  // Step 2: initialize_vaults
  log('\n2. 调用 initialize_vaults...', 'yellow');
  try {
    const vaultInfo = await connection.getAccountInfo(usdcVaultPda);
    if (vaultInfo) {
      log('  Vaults 已存在，跳过 initialize_vaults', 'yellow');
    } else {
      const data = sighash('initialize_vaults');

      const keys = [
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true },  // authority / payer
        { pubkey: poolPda,           isSigner: false, isWritable: true },  // pool
        { pubkey: usdcMintPk,        isSigner: false, isWritable: false }, // usdc_mint
        { pubkey: susdcMintPk,       isSigner: false, isWritable: false }, // susdc_mint
        { pubkey: usdcVaultPda,      isSigner: false, isWritable: true },  // usdc_vault (init)
        { pubkey: susdcVaultPda,     isSigner: false, isWritable: true },  // susdc_vault (init)
        { pubkey: treasuryVaultPda,  isSigner: false, isWritable: true },  // treasury_vault (init)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        { pubkey: TOKEN_PROGRAM_ID,       isSigner: false, isWritable: false },   // token_program
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
      log(`  initialize_vaults 交易: ${sig}`, 'green');
    }
  } catch (e) {
    log(`  initialize_vaults 失败: ${e.message}`, 'red');
    throw e;
  }

  log('\n=== 池子初始化完成 ===', 'green');
  log(`Pool: ${poolPda.toBase58()}`);
  log(`USDC: ${CONFIG.usdcMint} | sUSDC: ${susdcMint}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
