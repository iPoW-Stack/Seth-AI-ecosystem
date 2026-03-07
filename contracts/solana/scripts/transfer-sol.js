/**
 * Solana SOL 转账脚本
 * 从 deployer 转账到指定地址
 * 
 * 用法: 
 *   node scripts/transfer-sol.js <recipient_address> [amount]
 *   node scripts/transfer-sol.js 69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j 1
 */

const { Connection, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 配置
const CONFIG = {
  proxy: process.env.PROXY || 'http://127.0.0.1:7797',
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  keypairPath: path.resolve(__dirname, '../deployer-keypair.json'),
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

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log(`
${colors.cyan}Solana SOL 转账工具${colors.reset}

用法:
  node scripts/transfer-sol.js <recipient_address> [amount_in_sol]

参数:
  recipient_address  - 接收方钱包地址 (Base58)
  amount_in_sol      - 转账金额，单位 SOL (默认: 1)

示例:
  # 转账 1 SOL
  node scripts/transfer-sol.js 69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j

  # 转账 2.5 SOL
  node scripts/transfer-sol.js 69ARjWMWFgpnH71N1Cogr3BR5VBy7fsT4sMgAKFqRj4j 2.5
`);
    process.exit(1);
  }

  const recipientAddress = args[0];
  const amountSol = parseFloat(args[1]) || 1;

  log('\n=== Solana SOL 转账 ===\n', 'cyan');
  log(`RPC: ${CONFIG.rpcUrl}`);
  log(`代理: ${CONFIG.proxy}`);

  // 1. 加载 keypair
  log('\n1. 加载 Keypair...', 'yellow');
  if (!fs.existsSync(CONFIG.keypairPath)) {
    log(`错误: 找不到 keypair 文件: ${CONFIG.keypairPath}`, 'red');
    process.exit(1);
  }
  
  const keypairData = JSON.parse(fs.readFileSync(CONFIG.keypairPath, 'utf-8'));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  log(`  Deployer: ${deployer.publicKey.toBase58()}`);

  // 2. 验证接收地址
  log('\n2. 验证接收地址...', 'yellow');
  let recipient;
  try {
    recipient = new PublicKey(recipientAddress);
    log(`  Recipient: ${recipient.toBase58()}`);
  } catch (e) {
    log(`错误: 无效的接收地址: ${recipientAddress}`, 'red');
    process.exit(1);
  }

  // 3. 创建连接
  log('\n3. 连接到 Solana 网络...', 'yellow');
  const connection = new Connection(CONFIG.rpcUrl, {
    commitment: 'confirmed',
    httpAgent: new HttpsProxyAgent(CONFIG.proxy),
  });

  // 4. 检查余额
  log('\n4. 检查余额...', 'yellow');
  const deployerBalance = await connection.getBalance(deployer.publicKey);
  log(`  Deployer 余额: ${deployerBalance / LAMPORTS_PER_SOL} SOL`);

  const recipientBalanceBefore = await connection.getBalance(recipient);
  log(`  Recipient 余额: ${recipientBalanceBefore / LAMPORTS_PER_SOL} SOL`);

  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  log(`\n  转账金额: ${amountSol} SOL (${amountLamports} lamports)`);

  if (deployerBalance < amountLamports + 5000) {
    log(`错误: 余额不足! 需要 ${amountSol + 0.000005} SOL (含手续费)`, 'red');
    process.exit(1);
  }

  // 5. 构建交易
  log('\n5. 构建交易...', 'yellow');
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: recipient,
      lamports: amountLamports,
    })
  );

  // 获取最新 blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = deployer.publicKey;

  // 6. 发送交易
  log('\n6. 发送交易...', 'yellow');
  
  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [deployer],
      {
        commitment: 'confirmed',
        skipPreflight: false,
      }
    );

    log(`\n${colors.green}转账成功!${colors.reset}`);
    log(`  交易签名: ${signature}`);
    log(`  浏览器: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

    // 7. 验证结果
    log('\n7. 验证结果...', 'yellow');
    const recipientBalanceAfter = await connection.getBalance(recipient);
    const received = (recipientBalanceAfter - recipientBalanceBefore) / LAMPORTS_PER_SOL;
    log(`  Recipient 新余额: ${recipientBalanceAfter / LAMPORTS_PER_SOL} SOL`);
    log(`  实际收到: ${received} SOL`);

  } catch (error) {
    log(`\n转账失败: ${error.message}`, 'red');
    
    if (error.message.includes('blockhash')) {
      log('提示: 网络拥堵，请稍后重试', 'yellow');
    }
    
    process.exit(1);
  }
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});