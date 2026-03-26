/**
 * 初始化根用户脚本
 *
 * 作用：
 * - 为合约 owner 创建 UserInfo 账户（无需 referrer）
 * - 这是一级 referrer 必须的解决方案
 * - 只有 owner 可以调用此指令
 *
 * 用法：
 *   在 contracts/solana 目录下执行：
 *     node scripts/init-root-user.js
 *
 * 前置条件：
 *   - 合约已部署并 initialize 完成
 *   - deployer-keypair.json 中的地址是 owner
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
  console.log('初始化根用户 (init_root_user)');
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

  // 1. 读取部署信息
  // const deployInfoPath = path.join(__dirname, '../deployment-info.json');
  // if (!fs.existsSync(deployInfoPath)) {
  //   throw new Error('deployment-info.json 不存在，请先部署合约');
  // }
  // const deployInfo = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
  // const programId = new PublicKey(deployInfo.programId || deployInfo.sethBridgeProgramId);

  const programId = new PublicKey("125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc");
  console.log('Program ID:', programId.toBase58());

  // 2. 计算 PDA
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [userInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), owner.publicKey.toBuffer()],
    programId
  );

  console.log('Config PDA:', configPda.toBase58());
  console.log('UserInfo PDA:', userInfoPda.toBase58());

  // 3. 检查 UserInfo 是否已存在
  const existingUserInfo = await connection.getAccountInfo(userInfoPda);
  if (existingUserInfo) {
    console.log('\n✅ 根用户已存在，无需初始化');
    return;
  }

  // 4. 构造指令
  const data = sighash('init_root_user');

  const keys = [
    { pubkey: owner.publicKey, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: userInfoPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId, keys, data });
  const tx = new Transaction().add(ix);

  // 5. 发送交易
  console.log('\n发送 init_root_user 交易...');
  try {
    const sig = await connection.sendTransaction(tx, [owner], { skipPreflight: false });
    console.log('交易签名:', sig);
    await connection.confirmTransaction(sig);
    console.log('✅ 根用户初始化成功！');
    console.log('\n现在其他用户可以使用此地址作为 referrer 进行注册。');
  } catch (err) {
    console.log('❌ 初始化失败:', err.message);
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ 失败:', err.message || err);
    process.exit(1);
  });