/**
 * 测试脚本：初始化 user_info（调用 set_referrer）
 *
 * 作用：
 * - 为当前 deployer（user）创建并初始化 UserInfo 账户
 * - 设置一个合法的 referrer（不能等于 user 自己）
 * - 支持两级推荐系统（L1 和 L2）
 *
 * 用法（在 contracts/solana 目录下）：
 *   # 无 referrer（推荐人为空）
 *   node scripts/test-set-referrer.js
 *
 *   # 有 referrer（指定 Solana 公钥）
 *   # Windows PowerShell:
 *   #   $env:REFERRER_PUBKEY="xxxx"
 *   # CMD:
 *   #   set REFERRER_PUBKEY=xxxx
 *   node scripts/test-set-referrer.js
 *
 * 注意：
 *   - 如果 referrer 不是 default pubkey，则 referrer 必须已经注册（有自己的 user_info）
 *   - 首次部署后，owner 可以作为第一个用户，然后其他人可以用 owner 作为 referrer
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
  const keypairPath = path.join(__dirname, '../deployer-keypair.json');

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
      d.programId || d.sethBridgeProgramId || '125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc'
    );
  } else {
    programId = new PublicKey('125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc');
  }

  console.log('seth_bridge Program ID:', programId.toBase58());

  // 2. 计算 user_info PDA
  const [userInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), user.publicKey.toBuffer()],
    programId
  );
  console.log('UserInfo PDA:', userInfoPda.toBase58());

  // 3. 选择 referrer
  const DEFAULT_PUBKEY = new PublicKey('11111111111111111111111111111111');
  let referrerStr = process.env.REFERRER_PUBKEY;
  let referrerPk;
  
  if (referrerStr) {
    referrerPk = new PublicKey(referrerStr);
  } else {
    // 默认无 referrer
    referrerPk = DEFAULT_PUBKEY;
  }

  if (referrerPk.equals(user.publicKey)) {
    throw new Error('referrer 不能等于 user，请设置 REFERRER_PUBKEY 为其他地址');
  }

  console.log('Referrer:', referrerPk.toBase58());
  console.log('Is default (no referrer):', referrerPk.equals(DEFAULT_PUBKEY));

  // 4. 检查 user_info 是否已存在
  const existingUserInfo = await connection.getAccountInfo(userInfoPda);
  if (existingUserInfo) {
    console.log('\n⚠️  UserInfo 账户已存在！');
    console.log('注意：如果这是旧版合约创建的账户，需要先关闭它才能使用新合约。');
    console.log('解决方案：');
    console.log('  1. 使用不同的钱包/用户进行测试');
    console.log('  2. 重新部署合约（使用新的 program keypair）');
    console.log('  3. 在本地 validator 上测试');
    
    // 尝试读取账户数据看看大小
    console.log('\n现有账户大小:', existingUserInfo.data.length, 'bytes');
    console.log('新版 UserInfo 预期大小: ~130 bytes (8 discriminator + struct)');
    
    // 如果大小不对，给出更明确的提示
    const expectedSize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 4 + 4; // 大约
    if (existingUserInfo.data.length < expectedSize - 20 || existingUserInfo.data.length > expectedSize + 20) {
      console.log('\n❌ 账户大小不匹配，可能是旧版合约创建的。');
      console.log('请使用新钱包或重新部署合约。');
      process.exit(1);
    }
  }

  // 5. 计算 L1 referrer info PDA
  const [l1ReferrerInfoPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_info'), referrerPk.toBuffer()],
    programId
  );
  console.log('L1 Referrer Info PDA:', l1ReferrerInfoPda.toBase58());

  // 6. 构造 set_referrer 指令 data（仅 sighash + referrer Pubkey）
  const data = Buffer.concat([
    sighash('set_referrer'),
    referrerPk.toBuffer(),
  ]);

  // 6.1 计算 l2_referrer_info（新版指令需要显式传入该账户）
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

  // 7. 准备账户列表
  // 新版 SetReferrer 结构：
  // - user (signer, mut)
  // - user_info (init_if_needed, mut)
  // - l1_referrer_info (mut, 需要 seeds 验证)
  // - l2_referrer_info (可选, mut)
  // - system_program
  
  // 检查 L1 referrer 是否已注册（如果不是 default）
  if (!referrerPk.equals(DEFAULT_PUBKEY)) {
    const l1Info = await connection.getAccountInfo(l1ReferrerInfoPda);
    if (!l1Info) {
      console.log('\n❌ L1 referrer 尚未注册！Referrer 必须先注册自己的 user_info。');
      console.log('解决方案：');
      console.log('  1. 让 referrer 先运行此脚本注册');
      console.log('  2. 或者不设置 referrer（使用 default pubkey）');
      process.exit(1);
    }
    console.log('L1 referrer 已注册 ✓');
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

    console.log('\n✅ 完成：UserInfo 已初始化！');
    console.log('你现在可以运行 test-process-revenue.js 进行收入处理测试。');
  } catch (err) {
    if (err.message && err.message.includes('AccountDidNotDeserialize')) {
      console.log('\n❌ 账户反序列化失败！');
      console.log('原因：链上的 UserInfo 账户是用旧版合约创建的，与新合约结构不兼容。');
      console.log('\n解决方案：');
      console.log('  1. 使用不同的钱包/用户进行测试');
      console.log('  2. 重新部署合约（使用新的 program keypair）');
      console.log('  3. 在本地 validator 上测试（solana-test-validator）');
    }
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ set_referrer 测试失败:', err.message || err);
    process.exit(1);
  });