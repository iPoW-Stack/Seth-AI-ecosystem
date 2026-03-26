/**
 * Solana 桥接合约初始化脚本（不依赖 Anchor Program）
 * 用法: node scripts/initialize-bridge.js
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

// 配置
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
    return '125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc';
  })(),

  // 钱包地址（替换为实际地址）
  // teamWallet: process.env.TEAM_WALLET || '0a1020ab518d03a0106964683eb1da2de0c27430',
  teamWallet: 'Ax4XoKH8YKmsKqZzz5E5rfeXZmuBrANHT4C4Z5C6wQ6w',
  // projectWallet: process.env.PROJECT_WALLET || '69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j',
  projectWallet: 'Ax4XoKH8YKmsKqZzz5E5rfeXZmuBrANHT4C4Z5C6wQ6w',
  // Seth Treasury 地址 (以太坊格式，20字节)
  sethTreasury: process.env.SETH_TREASURY || '0x77a3deed600bb37d8fcbe2167bfb1a6e47a16b4f',

  // USDC Mint (devnet)
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
};

// 颜色输出
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

// 计算 Anchor 全局函数 sighash
function sighash(name) {
  // 对 "global:initialize" 做 sha256，取前 8 字节
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  log('\n=== Solana 桥接合约初始化 ===\n', 'cyan');
  log(`RPC: ${CONFIG.rpcUrl}`, 'cyan');
  log(`Program ID: ${CONFIG.programId}`, 'cyan');

  // 1. 加载 keypair
  log('\n1. 加载 Keypair...', 'yellow');
  const keypairData = JSON.parse(fs.readFileSync(CONFIG.keypairPath, 'utf-8'));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  log(`  Deployer: ${keypair.publicKey.toBase58()}`);

  // 2. 创建连接
  log('\n2. 创建连接...', 'yellow');
  const connection = new Connection(CONFIG.rpcUrl, {
    commitment: 'confirmed',
  });
  
  const balance = await connection.getBalance(keypair.publicKey);
  log(`  余额: ${balance / 1e9} SOL`);

  // 3. 计算 programId
  log('\n3. 准备 Program 与 PDA...', 'yellow');
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

  // 5. 检查是否已初始化
  log('\n5. 检查初始化状态...', 'yellow');
  try {
    const info = await connection.getAccountInfo(configPda);
    if (info && info.owner && info.owner.equals(programId)) {
      log('  合约已初始化!（config 账户已存在）', 'green');
      return;
    }
  } catch (e) {
    // ignore
  }
  log('  合约未初始化，继续...', 'yellow');

  // 6. 构建初始化交易
  log('\n6. 构建初始化交易...', 'yellow');
  
  // Seth treasury: Ethereum 地址 20 字节，左填充 0 转为 32 字节 Pubkey
  const sethTreasuryBytes = Buffer.alloc(32);
  const sethTreasuryHex = CONFIG.sethTreasury.replace('0x', '');
  Buffer.from(sethTreasuryHex, 'hex').copy(sethTreasuryBytes, 12);
  const sethTreasuryPubkey = new PublicKey(sethTreasuryBytes);
  
  const teamWallet = new PublicKey(CONFIG.teamWallet);
  const projectWallet = new PublicKey(CONFIG.projectWallet);
  const usdcMint = new PublicKey(CONFIG.usdcMint);
  
  try {
    // 获取 vault token account 地址 (PDA, 与 bridge 合约 seeds 一致)
    const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_token_account')],
      programId
    );
    
    const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
    
    log(`  Vault Token Account: ${vaultTokenAccount.toBase58()}`);
    
    // 构造 instruction data：8 字节 sighash + 32 字节 sethTreasury Pubkey
    const data = Buffer.concat([
      sighash('initialize'),
      sethTreasuryPubkey.toBuffer(),
    ]);

    // 按 Initialize<'info> 的账户顺序填 keys
    const keys = [
      { pubkey: keypair.publicKey,      isSigner: true,  isWritable: true },  // owner
      { pubkey: teamWallet,             isSigner: false, isWritable: false }, // team_wallet
      { pubkey: projectWallet,          isSigner: false, isWritable: false }, // project_wallet
      { pubkey: configPda,              isSigner: false, isWritable: true },  // config (init)
      { pubkey: vaultAuthorityPda,      isSigner: false, isWritable: true },  // vault_authority (init)
      { pubkey: vaultTokenAccount,      isSigner: false, isWritable: true },  // vault_token_account (init)
      { pubkey: usdcMint,               isSigner: false, isWritable: false }, // usdc_mint
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
    
    log(`  交易: ${sig}`, 'green');
    log('  初始化成功!', 'green');
    
  } catch (e) {
    log(`  初始化失败: ${e.message}`, 'red');
    console.error(e);
    
    // 如果是 spl-token 未安装，提示手动初始化
    if (e.message.includes('Cannot find module')) {
      log('\n请安装依赖: npm install @solana/spl-token', 'yellow');
    }
  }

  // 7. 验证初始化
  log('\n7. 验证初始化...', 'yellow');
  try {
    const info = await connection.getAccountInfo(configPda);
    if (info && info.owner && info.owner.equals(programId)) {
      log('  初始化验证成功!（config 账户已存在）', 'green');
      log(`  Config PDA: ${configPda.toBase58()}`);
      log(`  Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
      return;
    }
    log('  验证失败: config 账户不存在或 owner 不匹配', 'red');
  } catch (e) {
    log(`  验证失败: ${e.message}`, 'red');
  }
}

main().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});