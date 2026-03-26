/**
 * 测试 Solana 侧收入处理 & 跨链消息生成脚本
 *
 * 说明：
 * - 调用 seth_bridge::process_revenue，发送一笔 USDC 收入到 Vault，
 *   触发 10-5-5-50-30 分账，并在链上创建 CrossChainMessage（用于跨链到 Seth）。
 * - 分账比例：L1佣金(10%)、L2佣金(5%)、团队资金(5%)、项目资金(50%)、生态资金(30%)
 * - L1/L2佣金现在记录在用户信息中，通过单独的 distribute_commission 指令分发
 * - 团队资金通过跨链消息处理，不再实时转账
 * - 只测试交易构造和上链，不关心 Seth 侧是否真正到账（由 relayer 负责）。
 *
 * 用法：
 *   在 contracts/solana 目录下执行：
 *     node scripts/test-process-revenue.js
 *
 * 前置条件：
 *   - seth_bridge 程序已部署并 initialize 完成（config / vault 已初始化）
 *   - deployer-keypair.json 中的地址有足够 SOL
 *   - 你有一个 USDC 的用户账户里有少量 USDC 可用于测试
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

// ----- 配置，根据需要修改 -----

// 使用的 USDC Mint（devnet）
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

// 测试金额（USDC，6 位小数）
const TEST_AMOUNT_USDC = 1; // 1 USDC

// 产品类型（随便填一个 u8）
const PRODUCT_TYPE = 1;

// Seth 侧接收地址（20 字节，0x 开头）
// 可以填你在 Seth 的测试地址
// const SETH_RECIPIENT = process.env.SETH_TEST_RECIPIENT || '0x0000000000000000000000000000000000000000';
const SETH_RECIPIENT = "0x742bf979105179e44aed27baf37d66ef73cc3d88";
// ----- 帮助函数 -----

function sighash(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function main() {
  console.log('========================================');
  console.log('Test process_revenue');
  console.log('========================================\n');

  const rpcUrl = process.env.RPC_URL || 'https://devnet.helius-rpc.com/?api-key=453899d1-2296-4503-b3df-fcc3c64436bc';
  const keypairPath = path.join(__dirname, '../deployer-keypair.json');

  const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  console.log('RPC:', rpcUrl);
  console.log('Payer:', payer.publicKey.toBase58());

  const balance = await connection.getBalance(payer.publicKey);
  console.log('SOL balance:', balance / 1e9, 'SOL\n');

  // 1. 读取部署信息，拿到 programId
  // const deployInfoPath = path.join(__dirname, '../deployment-info.json');
  // if (!fs.existsSync(deployInfoPath)) {
  //   throw new Error('deployment-info.json 不存在，请先部署合约');
  // }
  // const deployInfo = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
  // const programId = new PublicKey(deployInfo.programId || deployInfo.sethBridgeProgramId || '2PpwtfR2QHfR7qGhH8eaeiTiJac8LfdSQFdR6FJf6aF9');

  // console.log('seth_bridge Program ID:', programId.toBase58());

  const programId = new PublicKey("125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc");

  // 2. 计算 config / vault / user-info / cross-chain PDA
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
  const [userInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), payer.publicKey.toBuffer()],
    programId
  );

  console.log('Config PDA:', configPda.toBase58());
  console.log('Vault Authority PDA:', vaultAuthorityPda.toBase58());
  console.log('Vault Token Account PDA:', vaultTokenPda.toBase58());
  console.log('UserInfo PDA:', userInfoPda.toBase58());

  // 从链上获取 user_info 和 config
  const [userInfoAcc, configAcc] = await Promise.all([
    connection.getAccountInfo(userInfoPda),
    connection.getAccountInfo(configPda),
  ]);
  if (!userInfoAcc) {
    throw new Error('UserInfo 未初始化，请先运行 test-set-referrer.js');
  }
  if (!configAcc) {
    throw new Error('Config 未初始化，请先部署并 initialize 桥');
  }

  // Config 布局:
  // 8 discriminator + 32 owner + 32 seth_treasury + 32 team_wallet + 32 project_wallet + 
  // 32 vault_authority + 32 relayer + 1 bump + 8 total_revenue + ...
  const configData = configAcc.data;
  const projectWalletOffset = 8 + 32 * 3; // discriminator + owner + seth_treasury + team_wallet
  const projectWalletBytes = configData.slice(projectWalletOffset, projectWalletOffset + 32);
  const projectWallet = new PublicKey(projectWalletBytes);
  console.log('Project Wallet (from config):', projectWallet.toBase58());
  
  const totalRevenueOffset = 8 + 32 * 6 + 1;
  const totalRevenue = configAcc.data.readBigUInt64LE(totalRevenueOffset);
  const totalRevenueBytes = Buffer.alloc(8);
  totalRevenueBytes.writeBigUInt64LE(totalRevenue);

  const [crossChainMsgPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('cross_chain_msg'), payer.publicKey.toBuffer(), totalRevenueBytes],
    programId
  );
  console.log('CrossChainMessage PDA (total_revenue=' + totalRevenue + '):', crossChainMsgPda.toBase58());

  // 3. 用户 USDC TokenAccount（这里假设与你 payer 相同的 owner，使用 ATA）
  const {
    getAssociatedTokenAddressSync,
  } = require('@solana/spl-token');
  const userUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    payer.publicKey
  );
  console.log('User USDC ATA:', userUsdcAta.toBase58());
  
  // 项目方 USDC 接收账户（使用 config 中配置的 project_wallet 对应的 ATA）
  const projectTokenAccount = getAssociatedTokenAddressSync(
    USDC_MINT,
    projectWallet
  );
  console.log('Project Token Account (from config.project_wallet):', projectTokenAccount.toBase58());
  console.log('');

  // 4. 构造指令 data
  const amountU64 = BigInt(TEST_AMOUNT_USDC * 1_000_000); // 6 小数
  const bufAmount = Buffer.alloc(8);
  bufAmount.writeBigUInt64LE(amountU64);

  const bufProductType = Buffer.from([PRODUCT_TYPE & 0xff]);

  let sethHex = SETH_RECIPIENT.startsWith('0x')
    ? SETH_RECIPIENT.slice(2)
    : SETH_RECIPIENT;
  if (sethHex.length !== 40) {
    console.warn('SETH_RECIPIENT 长度不为 20 字节，脚本会自动截断/填充。');
  }
  const sethBuf = Buffer.alloc(20);
  Buffer.from(sethHex.padStart(40, '0'), 'hex').copy(sethBuf);

  const data = Buffer.concat([
    sighash('process_revenue'),
    bufAmount,
    bufProductType,
    sethBuf,
  ]);

  // 5. 准备账户列表（顺序必须与 ProcessRevenue<'info> 一致）
  // 新版合约结构简化，不再需要 l1/l2/team 账户
  // 账户顺序：user, user_token_account, vault_token_account, vault_authority, config, user_info,
  //          project_token_account, cross_chain_message, token_program, system_program
  const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

  const keys = [
    { pubkey: payer.publicKey,     isSigner: true,  isWritable: true },  // user
    { pubkey: userUsdcAta,         isSigner: false, isWritable: true },  // user_token_account
    { pubkey: vaultTokenPda,       isSigner: false, isWritable: true },  // vault_token_account
    { pubkey: vaultAuthorityPda,   isSigner: false, isWritable: false }, // vault_authority
    { pubkey: configPda,           isSigner: false, isWritable: true },  // config
    { pubkey: userInfoPda,         isSigner: false, isWritable: true },  // user_info
    { pubkey: projectTokenAccount, isSigner: false, isWritable: true },  // project_token_account (50% 实时转账)
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
  console.log('交易完成！');
  console.log('========================================');
  console.log('分账明细（基于 ' + TEST_AMOUNT_USDC + ' USDC）:');
  console.log('  - L1 佣金 (10%):', (TEST_AMOUNT_USDC * 0.1).toFixed(2), 'USDC - 记录在链上，通过 distribute_commission 分发');
  console.log('  - L2 佣金 (5%):', (TEST_AMOUNT_USDC * 0.05).toFixed(2), 'USDC - 记录在链上，通过 distribute_commission 分发');
  console.log('  - 团队资金 (5%):', (TEST_AMOUNT_USDC * 0.05).toFixed(2), 'USDC - 通过跨链消息发送到 Seth');
  console.log('  - 项目资金 (50%):', (TEST_AMOUNT_USDC * 0.5).toFixed(2), 'USDC - 已实时转账到 project_token_account');
  console.log('  - 生态资金 (30%):', (TEST_AMOUNT_USDC * 0.3).toFixed(2), 'USDC - 通过跨链消息发送到 Seth');
  console.log('\n你可以在 relayer 日志中查看是否检测到这笔 RevenueProcessed 事件。');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
  });

