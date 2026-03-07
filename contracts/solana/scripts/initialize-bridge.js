/**
 * Solana 桥接合约初始化脚本
 * 用法: node scripts/initialize-bridge.js
 */

const { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { Program, AnchorProvider, Wallet, BN } = require('@coral-xyz/anchor');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 配置
const CONFIG = {
  proxy: process.env.PROXY || 'http://127.0.0.1:7797',
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  keypairPath: path.resolve(__dirname, '../deployer-keypair.json'),
  programId: process.env.PROGRAM_ID || '5V3anofFhgpB9D8Uc72JDHg1VVH8qxJJrtaEMMxS4kmw',
  
  // 钱包地址（替换为实际地址）
  teamWallet: process.env.TEAM_WALLET || '69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j',
  projectWallet: process.env.PROJECT_WALLET || '69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j',
  
  // Seth Treasury 地址 (以太坊格式，20字节)
  sethTreasury: process.env.SETH_TREASURY || '0x0000000000000000000000000000000000000000',
  
  // USDC Mint (devnet)
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
};

// 颜色输出
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// IDL (从编译后的文件加载)
const IDL = {
  version: "0.1.0",
  name: "seth_bridge",
  instructions: [
    {
      name: "initialize",
      accounts: [
        { name: "owner", isMut: true, isSigner: true },
        { name: "teamWallet", isMut: false, isSigner: false },
        { name: "projectWallet", isMut: false, isSigner: false },
        { name: "config", isMut: true, isSigner: false },
        { name: "vaultAuthority", isMut: true, isSigner: false },
        { name: "vaultTokenAccount", isMut: true, isSigner: false },
        { name: "usdcMint", isMut: false, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false },
        { name: "rent", isMut: false, isSigner: false },
      ],
      args: [
        { name: "sethTreasury", type: "bytes" },
      ],
    },
    {
      name: "setReferrer",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "userInfo", isMut: true, isSigner: false },
        { name: "systemProgram", isMut: false, isSigner: false },
      ],
      args: [
        { name: "referrer", type: "publicKey" },
      ],
    },
    {
      name: "setRelayer",
      accounts: [
        { name: "owner", isMut: false, isSigner: true },
        { name: "config", isMut: true, isSigner: false },
      ],
      args: [
        { name: "newRelayer", type: "publicKey" },
      ],
    },
  ],
  accounts: [
    { name: "Config", type: { kind: "struct", fields: [] } },
    { name: "VaultAuthority", type: { kind: "struct", fields: [] } },
    { name: "UserInfo", type: { kind: "struct", fields: [] } },
    { name: "CrossChainMessage", type: { kind: "struct", fields: [] } },
  ],
  errors: [],
};

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
    httpAgent: new HttpsProxyAgent(CONFIG.proxy),
  });
  
  const balance = await connection.getBalance(keypair.publicKey);
  log(`  余额: ${balance / 1e9} SOL`);

  // 3. 创建 Provider 和 Program
  log('\n3. 创建 Program 客户端...', 'yellow');
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    skipPreflight: true,
  });
  
  const programId = new PublicKey(CONFIG.programId);
  const program = new Program(IDL, programId, provider);
  log('  Program 客户端已创建');

  // 4. 计算 PDA
  log('\n4. 计算 PDA...', 'yellow');
  
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
    const config = await program.account.config.fetch(configPda);
    log('  合约已初始化!', 'green');
    log(`  Owner: ${config.owner.toBase58()}`);
    log(`  Relayer: ${config.relayer.toBase58()}`);
    return;
  } catch (e) {
    log('  合约未初始化，继续...');
  }

  // 6. 构建初始化交易
  log('\n6. 构建初始化交易...', 'yellow');
  
  // Seth treasury 转换为 bytes32
  const sethTreasuryBytes = Buffer.alloc(32);
  const sethTreasuryHex = CONFIG.sethTreasury.replace('0x', '');
  Buffer.from(sethTreasuryHex, 'hex').copy(sethTreasuryBytes, 12); // 左侧填充0
  
  const teamWallet = new PublicKey(CONFIG.teamWallet);
  const projectWallet = new PublicKey(CONFIG.projectWallet);
  const usdcMint = new PublicKey(CONFIG.usdcMint);
  
  try {
    // 获取 vault token account 地址
    const { token } = require('@solana/spl-token');
    const vaultTokenAccount = await token.getAssociatedTokenAddress(
      usdcMint,
      vaultAuthorityPda,
      true // allowOwnerOffCurve
    );
    
    log(`  Vault Token Account: ${vaultTokenAccount.toBase58()}`);
    
    // 调用 initialize
    const tx = await program.methods
      .initialize(Array.from(sethTreasuryBytes))
      .accounts({
        owner: keypair.publicKey,
        teamWallet,
        projectWallet,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        vaultTokenAccount,
        usdcMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    
    log(`  交易: ${tx}`, 'green');
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
    const config = await program.account.config.fetch(configPda);
    log('  初始化验证成功!', 'green');
    log(`  Owner: ${config.owner.toBase58()}`);
    log(`  Relayer: ${config.relayer.toBase58()}`);
    log(`  Team Wallet: ${config.teamWallet.toBase58()}`);
    log(`  Project Wallet: ${config.projectWallet.toBase58()}`);
  } catch (e) {
    log(`  验证失败: ${e.message}`, 'red');
  }
}

main().catch(err => {
  console.error('初始化失败:', err);
  process.exit(1);
});