/**
 * 纯 Node.js 部署脚本 - 不依赖 Solana CLI
 * 
 * 使用 @solana/web3.js 和 @solana/spl-token 直接部署
 * 适合没有安装 Solana CLI 的环境
 */

// 配置代理支持
const { setGlobalDispatcher, ProxyAgent } = require('undici');
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || 'http://127.0.0.1:7797';
console.log(`使用代理: ${proxyUrl}`);
setGlobalDispatcher(new ProxyAgent(proxyUrl));

const { 
    Connection, 
    Keypair, 
    PublicKey, 
    LAMPORTS_PER_SOL,
    Transaction,
    SystemProgram,
    SYSVAR_RENT_PUBKEY
} = require('@solana/web3.js');
const { 
    Token, 
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createMint,
    createAssociatedTokenAccount,
    mintTo,
    createInitializeMintInstruction,
    createAssociatedTokenAccountInstruction,
    createMintToInstruction,
    getAssociatedTokenAddress
} = require('@solana/spl-token');
const fs = require('fs');
const path = require('path');

// 配置
const DEPLOYER_KEYPAIR_PATH = path.join(__dirname, '../deployer-keypair.json');
const CLUSTER = process.env.CLUSTER || 'devnet';

// 多个 RPC 端点备选
const RPC_ENDPOINTS = {
    devnet: [
        'https://api.devnet.solana.com',
        'https://devnet.helius-rpc.com/?api-key=devnet',
        'https://rpc.ankr.com/solana_devnet',
    ],
    mainnet: [
        'https://api.mainnet-beta.solana.com',
        'https://solana-api.projectserum.com',
    ]
};

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';

// 加载部署者密钥
function loadDeployerKeypair() {
    const content = fs.readFileSync(DEPLOYER_KEYPAIR_PATH, 'utf-8').trim();
    const secretKey = Uint8Array.from(JSON.parse(content));
    console.log(`密钥长度: ${secretKey.length} 字节`);
    if (secretKey.length !== 64) {
        throw new Error(`无效的密钥长度: ${secretKey.length}, 期望 64 字节`);
    }
    return Keypair.fromSecretKey(secretKey);
}

async function main() {
    console.log('========================================');
    console.log('Seth-Solana Bridge 部署 (纯 Node.js)');
    console.log('========================================\n');

    console.log(`Cluster: ${CLUSTER}`);
    console.log(`RPC: ${RPC_URL}\n`);

    // 1. 连接到 Solana 网络（禁用 WebSocket，使用 HTTP 轮询）
    const connection = new Connection(RPC_URL, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: false,
        confirmTransactionInitialTimeout: 120000, // 2分钟超时
    });
    
    // 使用 HTTP 轮询确认交易（不使用 WebSocket）
    const confirmTransactionHttp = async (signature) => {
        console.log(`等待交易确认: ${signature.substring(0, 20)}...`);
        const start = Date.now();
        const timeout = 120000; // 2分钟
        while (Date.now() - start < timeout) {
            try {
                const status = await connection.getSignatureStatus(signature);
                if (status && status.value) {
                    if (status.value.err) {
                        throw new Error(`交易失败: ${JSON.stringify(status.value.err)}`);
                    }
                    if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                        console.log(`✅ 交易确认耗时: ${((Date.now() - start) / 1000).toFixed(1)}秒`);
                        return;
                    }
                }
            } catch (e) {
                if (e.message.includes('交易失败')) throw e;
            }
            await new Promise(r => setTimeout(r, 2000)); // 每2秒轮询
        }
        throw new Error('交易确认超时');
    };
    
    const deployer = loadDeployerKeypair();
    
    console.log(`Deployer: ${deployer.publicKey.toBase58()}\n`);

    // 2. 检查余额
    const balance = await connection.getBalance(deployer.publicKey);
    console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

    if (balance < 0.1 * LAMPORTS_PER_SOL) {
        console.log('\n⚠️  余额不足，正在请求空投...');
        if (CLUSTER === 'devnet' || CLUSTER === 'testnet') {
            try {
                const signature = await connection.requestAirdrop(deployer.publicKey, 2 * LAMPORTS_PER_SOL);
                await connection.confirmTransaction(signature);
                console.log('✅ 空投成功！');
            } catch (e) {
                console.log('❌ 空投失败，请手动获取 SOL');
                console.log(`使用命令: solana airdrop 2 ${deployer.publicKey.toBase58()}`);
            }
        } else {
            throw new Error('余额不足，请充值 SOL');
        }
    }

    // 3. 创建 DIRM 代币
    console.log('\n========================================');
    console.log('步骤 1: 创建 DIRM 代币');
    console.log('========================================\n');

    const dirmMint = await createDIRMToken(connection, deployer, confirmTransactionHttp);
    console.log(`✅ DIRM Mint: ${dirmMint.toBase58()}`);

    // 4. 创建团队和项目方钱包
    console.log('\n========================================');
    console.log('步骤 2: 创建钱包账户');
    console.log('========================================\n');

    const teamWallet = Keypair.generate();
    const projectWallet = Keypair.generate();

    console.log(`团队钱包: ${teamWallet.publicKey.toBase58()}`);
    console.log(`项目方钱包: ${projectWallet.publicKey.toBase58()}`);

    // 5. 为钱包创建 DIRM 代币账户
    console.log('\n========================================');
    console.log('步骤 3: 创建代币账户');
    console.log('========================================\n');

    // 辅助函数：使用 HTTP 轮询创建代币账户
    const createTokenAccountHttp = async (owner) => {
        const ataAddress = await getAssociatedTokenAddress(dirmMint, owner);
        const accountInfo = await connection.getAccountInfo(ataAddress);
        if (!accountInfo) {
            const createIx = createAssociatedTokenAccountInstruction(
                deployer.publicKey,
                ataAddress,
                owner,
                dirmMint
            );
            const bh = await connection.getLatestBlockhash('confirmed');
            const tx = new Transaction({ 
                blockhash: bh.blockhash, 
                lastValidBlockHeight: bh.lastValidBlockHeight, 
                feePayer: deployer.publicKey 
            });
            tx.add(createIx);
            tx.sign(deployer);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
            await confirmTransactionHttp(sig);
        }
        return ataAddress;
    };

    const teamTokenAccount = await createTokenAccountHttp(teamWallet.publicKey);
    console.log(`团队 DIRM 账户: ${teamTokenAccount.toBase58()}`);

    const projectTokenAccount = await createTokenAccountHttp(projectWallet.publicKey);
    console.log(`项目方 DIRM 账户: ${projectTokenAccount.toBase58()}`);

    // 6. 保存部署信息
    const deploymentInfo = {
        cluster: CLUSTER,
        deployer: deployer.publicKey.toBase58(),
        dirmMint: dirmMint.toBase58(),
        teamWallet: teamWallet.publicKey.toBase58(),
        teamTokenAccount: teamTokenAccount.toBase58(),
        projectWallet: projectWallet.publicKey.toBase58(),
        projectTokenAccount: projectTokenAccount.toBase58(),
        teamWalletSecret: Buffer.from(teamWallet.secretKey).toString('base64'),
        projectWalletSecret: Buffer.from(projectWallet.secretKey).toString('base64'),
        createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
        path.join(__dirname, '../deployment-info.json'),
        JSON.stringify(deploymentInfo, null, 2)
    );

    console.log('\n========================================');
    console.log('部署完成！');
    console.log('========================================\n');
    console.log('部署信息已保存到: deployment-info.json');
    
    console.log('\n⚠️  注意: 完整的 Anchor 程序部署需要 Solana CLI 和 Anchor CLI');
    console.log('请按照 README.md 中的说明安装这些工具');
    console.log('\n后续步骤:');
    console.log('1. 安装 Solana CLI: https://docs.solana.com/cli/install-solana-cli-tools');
    console.log('2. 安装 Anchor: https://www.anchor-lang.com/docs/installation');
    console.log('3. 运行: anchor build');
    console.log('4. 运行: anchor deploy');
}

// HTTP 轮询确认交易
async function confirmTransactionHttp(connection, signature, label = '交易') {
    console.log(`  等待${label}确认: ${signature.substring(0, 16)}...`);
    const start = Date.now();
    const timeout = 120000; // 2分钟
    while (Date.now() - start < timeout) {
        try {
            const status = await connection.getSignatureStatus(signature);
            if (status && status.value) {
                if (status.value.err) {
                    throw new Error(`${label}失败: ${JSON.stringify(status.value.err)}`);
                }
                if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
                    console.log(`  ✅ ${label}确认耗时: ${((Date.now() - start) / 1000).toFixed(1)}秒`);
                    return true;
                }
            }
        } catch (e) {
            if (e.message.includes('失败')) throw e;
        }
        await new Promise(r => setTimeout(r, 2000)); // 每2秒轮询
    }
    throw new Error(`${label}确认超时`);
}

// 创建 DIRM 代币
async function createDIRMToken(connection, deployer, confirmFn) {
    const decimals = 9;
    const initialSupply = 100_000_000n * BigInt(10 ** decimals); // 1亿

    console.log('  创建 Mint 账户...');
    
    // 创建 Mint - 使用原生交易
    const mintKeypair = Keypair.generate();
    const mintRent = await connection.getMinimumBalanceForRentExemption(82);
    const createAccountIx = SystemProgram.createAccount({
        fromPubkey: deployer.publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        lamports: mintRent,
        space: 82,
        programId: TOKEN_PROGRAM_ID,
    });
    
    const initMintIx = createInitializeMintInstruction(
        mintKeypair.publicKey,
        decimals,
        deployer.publicKey,
        deployer.publicKey,
        TOKEN_PROGRAM_ID
    );
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: deployer.publicKey });
    tx.add(createAccountIx, initMintIx);
    tx.sign(deployer, mintKeypair);
    
    const sig1 = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await confirmFn(sig1);
    console.log(`  ✅ Mint 地址: ${mintKeypair.publicKey.toBase58()}`);

    console.log('  创建部署者代币账户...');
    
    // 手动创建关联代币账户（使用 HTTP 轮询）
    const tokenAccountAddress = await getAssociatedTokenAddress(mintKeypair.publicKey, deployer.publicKey);
    
    // 检查账户是否已存在
    const accountInfo = await connection.getAccountInfo(tokenAccountAddress);
    if (!accountInfo) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
            deployer.publicKey,
            tokenAccountAddress,
            deployer.publicKey,
            mintKeypair.publicKey
        );
        
        const blockhash2 = await connection.getLatestBlockhash('confirmed');
        const tx2 = new Transaction({ 
            blockhash: blockhash2.blockhash, 
            lastValidBlockHeight: blockhash2.lastValidBlockHeight, 
            feePayer: deployer.publicKey 
        });
        tx2.add(createAtaIx);
        tx2.sign(deployer);
        
        const sig2 = await connection.sendRawTransaction(tx2.serialize(), { skipPreflight: false });
        await confirmFn(sig2);
    }
    
    console.log(`  ✅ 代币账户: ${tokenAccountAddress.toBase58()}`);

    console.log('  铸造代币...');
    
    // 铸造代币
    const mintIx = createMintToInstruction(
        mintKeypair.publicKey,
        tokenAccountAddress,
        deployer.publicKey,
        initialSupply,
        [],
        TOKEN_PROGRAM_ID
    );
    
    const tx3 = new Transaction({ blockhash: (await connection.getLatestBlockhash('confirmed')).blockhash, 
        lastValidBlockHeight: (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight, 
        feePayer: deployer.publicKey });
    tx3.add(mintIx);
    tx3.sign(deployer);
    
    const sig3 = await connection.sendRawTransaction(tx3.serialize(), { skipPreflight: false });
    await confirmFn(sig3);
    
    console.log(`  ✅ 铸造初始供应: ${Number(initialSupply) / Math.pow(10, decimals)} DIRM`);

    return mintKeypair.publicKey;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ 部署失败:', error);
        process.exit(1);
    });