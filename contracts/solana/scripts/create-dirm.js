/**
 * 创建 DIRM 代币脚本
 * 
 * DIRM 是 Seth AI Ecosystem 的治理代币
 * 实现动态通胀调整 (DIRM - Dynamic Inflation Rate Mechanism)
 */

const { 
    Connection, 
    Keypair, 
    PublicKey, 
    LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const { 
    Token, 
    TOKEN_PROGRAM_ID 
} = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// 配置
const DEPLOYER_KEYPAIR_PATH = path.join(__dirname, '../deployer-keypair.json');
const CLUSTER = process.env.CLUSTER || 'devnet';
const RPC_URL = process.env.RPC_URL || (
    CLUSTER === 'mainnet-beta' 
        ? 'https://api.mainnet-beta.solana.com'
        : CLUSTER === 'devnet'
            ? 'https://api.devnet.solana.com'
            : 'http://localhost:8899'
);

// DIRM 代币配置
const DIRM_CONFIG = {
    name: 'DIRM Token',
    symbol: 'DIRM',
    decimals: 9,
    initialSupply: 100_000_000, // 1亿初始供应
    metadata: {
        description: 'Seth AI Ecosystem Governance Token with Dynamic Inflation Rate Mechanism',
        website: 'https://seth.ai',
        twitter: '@seth_ai'
    }
};

// 加载部署者密钥
function loadDeployerKeypair() {
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR_PATH, 'utf-8')));
    return Keypair.fromSecretKey(secretKey);
}

async function main() {
    console.log('========================================');
    console.log('DIRM Token Creation');
    console.log('========================================\n');

    console.log(`Cluster: ${CLUSTER}`);
    console.log(`RPC: ${RPC_URL}\n`);

    // 连接到 Solana 网络
    const connection = new Connection(RPC_URL, 'confirmed');
    const deployer = loadDeployerKeypair();
    
    console.log(`Deployer: ${deployer.publicKey.toBase58()}\n`);

    // 检查余额
    const balance = await connection.getBalance(deployer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.5 * LAMPORTS_PER_SOL) {
        console.log('\n⚠️  余额不足，正在请求空投...');
        if (CLUSTER === 'devnet' || CLUSTER === 'testnet') {
            const signature = await connection.requestAirdrop(deployer.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(signature);
            console.log('✅ 空投成功！');
        } else {
            throw new Error('余额不足，请充值 SOL');
        }
    }

    // 创建 DIRM 代币
    console.log('\n========================================');
    console.log('创建 DIRM 代币');
    console.log('========================================\n');

    console.log(`名称: ${DIRM_CONFIG.name}`);
    console.log(`符号: ${DIRM_CONFIG.symbol}`);
    console.log(`精度: ${DIRM_CONFIG.decimals}`);
    console.log(`初始供应: ${DIRM_CONFIG.initialSupply.toLocaleString()}\n`);

    // 创建代币铸造账户
    console.log('正在创建代币铸造账户...');
    const mint = await Token.createMint(
        connection,
        deployer,
        deployer.publicKey,      // mint authority
        deployer.publicKey,      // freeze authority
        DIRM_CONFIG.decimals,
        TOKEN_PROGRAM_ID
    );

    console.log(`✅ DIRM Mint: ${mint.publicKey.toBase58()}`);

    // 为部署者创建代币账户
    console.log('\n正在创建部署者代币账户...');
    const deployerTokenAccount = await mint.createAssociatedTokenAccount(deployer.publicKey);
    console.log(`✅ 部署者代币账户: ${deployerTokenAccount.toBase58()}`);

    // 铸造初始代币
    console.log('\n正在铸造初始供应...');
    const initialSupplyWithDecimals = DIRM_CONFIG.initialSupply * Math.pow(10, DIRM_CONFIG.decimals);
    await mint.mintTo(deployerTokenAccount, deployer, [], initialSupplyWithDecimals);
    console.log(`✅ 已铸造 ${DIRM_CONFIG.initialSupply.toLocaleString()} DIRM`);

    // 验证余额
    const balanceInfo = await mint.getAccountInfo(deployerTokenAccount);
    console.log(`\n验证余额: ${Number(balanceInfo.amount) / Math.pow(10, DIRM_CONFIG.decimals)} DIRM`);

    // 保存代币信息
    const tokenInfo = {
        cluster: CLUSTER,
        name: DIRM_CONFIG.name,
        symbol: DIRM_CONFIG.symbol,
        decimals: DIRM_CONFIG.decimals,
        mintAddress: mint.publicKey.toBase58(),
        deployer: deployer.publicKey.toBase58(),
        deployerTokenAccount: deployerTokenAccount.toBase58(),
        initialSupply: DIRM_CONFIG.initialSupply,
        createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
        path.join(__dirname, '../dirm-token-info.json'),
        JSON.stringify(tokenInfo, null, 2)
    );

    console.log('\n========================================');
    console.log('DIRM 代币创建完成！');
    console.log('========================================\n');
    console.log('代币信息已保存到: dirm-token-info.json');
    console.log('\n重要信息:');
    console.log(`- DIRM Mint: ${mint.publicKey.toBase58()}`);
    console.log(`- 部署者账户: ${deployerTokenAccount.toBase58()}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ 创建失败:', error);
        process.exit(1);
    });