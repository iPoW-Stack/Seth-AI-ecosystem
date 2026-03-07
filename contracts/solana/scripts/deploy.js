/**
 * Solana Bridge 部署脚本
 * 
 * 部署步骤：
 * 1. 构建 Anchor 程序
 * 2. 部署到 Solana 网络
 * 3. 创建 DIRM 代币
 * 4. 初始化 Bridge 配置
 * 5. 创建必要账户
 */

const anchor = require('@project-serum/anchor');
const { 
    Connection, 
    Keypair, 
    PublicKey, 
    LAMPORTS_PER_SOL,
    SystemProgram,
    SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const { 
    Token, 
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID 
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

// 加载部署者密钥
function loadDeployerKeypair() {
    const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(DEPLOYER_KEYPAIR_PATH, 'utf-8')));
    return Keypair.fromSecretKey(secretKey);
}

// 主部署函数
async function main() {
    console.log('========================================');
    console.log('Seth-Solana Bridge Deployment');
    console.log('========================================\n');

    console.log(`Cluster: ${CLUSTER}`);
    console.log(`RPC: ${RPC_URL}\n`);

    // 1. 连接到 Solana 网络
    const connection = new Connection(RPC_URL, 'confirmed');
    const deployer = loadDeployerKeypair();
    
    console.log(`Deployer: ${deployer.publicKey.toBase58()}\n`);

    // 2. 检查余额
    const balance = await connection.getBalance(deployer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 1 * LAMPORTS_PER_SOL) {
        console.log('\n⚠️  余额不足，正在请求空投...');
        if (CLUSTER === 'devnet' || CLUSTER === 'testnet') {
            const signature = await connection.requestAirdrop(deployer.publicKey, 2 * LAMPORTS_PER_SOL);
            await connection.confirmTransaction(signature);
            console.log('✅ 空投成功！');
        } else {
            throw new Error('余额不足，请充值 SOL');
        }
    }

    // 3. 加载 Anchor 程序
    console.log('\n正在加载 Anchor 程序...');
    
    // 读取程序 ID
    const programId = new PublicKey('SethBridge11111111111111111111111111111111');
    
    // 创建 Anchor provider
    const wallet = new anchor.Wallet(deployer);
    const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed'
    });
    anchor.setProvider(provider);

    // 读取 IDL
    let idl;
    try {
        idl = JSON.parse(fs.readFileSync(path.join(__dirname, '../target/idl/seth_bridge.json'), 'utf-8'));
    } catch (e) {
        console.log('⚠️  IDL 文件未找到，请先运行: anchor build');
        console.log('使用默认 IDL...');
        idl = require('../target/types/seth_bridge').IDLSethBridge;
    }

    const program = new anchor.Program(idl, programId, provider);
    console.log(`✅ 程序加载成功: ${programId.toBase58()}`);

    // 4. 创建 DIRM 代币
    console.log('\n========================================');
    console.log('创建 DIRM 代币');
    console.log('========================================\n');

    const dirmMint = await createDIRMToken(connection, deployer);
    console.log(`✅ DIRM 代币地址: ${dirmMint.toBase58()}`);

    // 5. 创建必要账户
    console.log('\n========================================');
    console.log('创建必要账户');
    console.log('========================================\n');

    // 创建团队钱包
    const teamWallet = Keypair.generate();
    console.log(`团队钱包: ${teamWallet.publicKey.toBase58()}`);

    // 创建项目方钱包
    const projectWallet = Keypair.generate();
    console.log(`项目方钱包: ${projectWallet.publicKey.toBase58()}`);

    // Seth Treasury 地址 (示例)
    const sethTreasury = new PublicKey('0x0000000000000000000000000000000000000000');

    // 6. 初始化 Bridge
    console.log('\n========================================');
    console.log('初始化 Bridge');
    console.log('========================================\n');

    // 获取 PDA
    const [configPda] = await PublicKey.findProgramAddress(
        [Buffer.from('config')],
        programId
    );

    const [vaultAuthorityPda] = await PublicKey.findProgramAddress(
        [Buffer.from('vault_authority')],
        programId
    );

    const [vaultTokenAccount] = await PublicKey.findProgramAddress(
        [Buffer.from('vault_token_account')],
        programId
    );

    console.log(`Config PDA: ${configPda.toBase58()}`);
    console.log(`Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
    console.log(`Vault Token Account: ${vaultTokenAccount.toBase58()}`);

    try {
        // 调用 initialize 指令
        const tx = await program.methods
            .initialize(sethTreasury)
            .accounts({
                owner: deployer.publicKey,
                teamWallet: teamWallet.publicKey,
                projectWallet: projectWallet.publicKey,
                config: configPda,
                vaultAuthority: vaultAuthorityPda,
                vaultTokenAccount: vaultTokenAccount,
                usdcMint: dirmMint,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([deployer])
            .rpc();

        console.log(`\n✅ 初始化交易: ${tx}`);
    } catch (error) {
        console.log('\n⚠️  初始化失败，可能已初始化');
        console.log(error.message);
    }

    // 7. 保存部署信息
    const deploymentInfo = {
        cluster: CLUSTER,
        programId: programId.toBase58(),
        deployer: deployer.publicKey.toBase58(),
        dirmMint: dirmMint.toBase58(),
        configPda: configPda.toBase58(),
        vaultAuthorityPda: vaultAuthorityPda.toBase58(),
        vaultTokenAccount: vaultTokenAccount.toBase58(),
        teamWallet: teamWallet.publicKey.toBase58(),
        projectWallet: projectWallet.publicKey.toBase58(),
        deployedAt: new Date().toISOString()
    };

    fs.writeFileSync(
        path.join(__dirname, '../deployment-info.json'),
        JSON.stringify(deploymentInfo, null, 2)
    );

    console.log('\n========================================');
    console.log('部署完成！');
    console.log('========================================\n');
    console.log('部署信息已保存到: deployment-info.json');
    console.log('\n请妥善保管以下信息：');
    console.log(`- 团队钱包私钥: ${Buffer.from(teamWallet.secretKey).toString('base64')}`);
    console.log(`- 项目方钱包私钥: ${Buffer.from(projectWallet.secretKey).toString('base64')}`);
}

// 创建 DIRM 代币
async function createDIRMToken(connection, deployer) {
    // 创建代币铸造账户
    const mint = await Token.createMint(
        connection,
        deployer,
        deployer.publicKey,
        deployer.publicKey,
        9, // 精度
        TOKEN_PROGRAM_ID
    );

    // 为部署者创建代币账户
    const tokenAccount = await mint.createAssociatedTokenAccount(deployer.publicKey);

    // 铸造初始代币 (1亿 DIRM)
    const initialSupply = 100_000_000 * Math.pow(10, 9);
    await mint.mintTo(tokenAccount, deployer, [], initialSupply);

    console.log(`✅ 铸造初始供应量: ${initialSupply / Math.pow(10, 9)} DIRM`);

    return mint.publicKey;
}

// 执行部署
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ 部署失败:', error);
        process.exit(1);
    });