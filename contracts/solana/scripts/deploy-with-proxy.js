/**
 * Solana 合约部署脚本 (通过代理)
 * 用法: node scripts/deploy-with-proxy.js
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');

// 配置
const CONFIG = {
  proxy: process.env.PROXY || 'http://127.0.0.1:7797',
  cluster: process.env.CLUSTER || 'devnet',
  rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
  keypairPath: path.resolve(__dirname, '../deployer-keypair.json'),
  programName: 'seth_bridge'
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

// 通过代理发送 RPC 请求
async function rpcRequest(method, params = []) {
  const agent = new HttpsProxyAgent(CONFIG.proxy);
  
  const data = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request(CONFIG.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      agent
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// 读取 keypair
function readKeypair(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

// 获取余额
async function getBalance(address) {
  const result = await rpcRequest('getBalance', [address]);
  return result.result?.value || 0;
}

// 请求空投
async function requestAirdrop(address, amount = 2e9) { // 2 SOL
  try {
    log(`  请求空投 ${amount / 1e9} SOL...`, 'yellow');
    const result = await rpcRequest('requestAirdrop', [address, amount]);
    if (result.error) {
      log(`  空投失败: ${result.error.message}`, 'red');
      return false;
    }
    log(`  空投成功!`, 'green');
    return true;
  } catch (e) {
    log(`  空投失败: ${e.message}`, 'red');
    return false;
  }
}

async function main() {
  log('\n=== Solana 合约部署 (通过代理) ===\n', 'cyan');
  log(`代理: ${CONFIG.proxy}`, 'cyan');
  log(`RPC: ${CONFIG.rpcUrl}`, 'cyan');
  log(`集群: ${CONFIG.cluster}`, 'cyan');

  // 1. 测试连接
  log('\n1. 测试代理连接...', 'yellow');
  try {
    const health = await rpcRequest('getHealth');
    if (health.result === 'ok') {
      log('  连接成功!', 'green');
    } else {
      log(`  连接异常: ${JSON.stringify(health)}`, 'red');
      process.exit(1);
    }
  } catch (e) {
    log(`  连接失败: ${e.message}`, 'red');
    process.exit(1);
  }

  // 2. 检查 deployer keypair
  log('\n2. 检查 deployer keypair...', 'yellow');
  if (!fs.existsSync(CONFIG.keypairPath)) {
    log('  生成新的 keypair...', 'yellow');
    execSync(`solana-keygen new --no-passphrase -o "${CONFIG.keypairPath}" --force`, { stdio: 'inherit' });
  }
  
  const keypair = readKeypair(CONFIG.keypairPath);
  // 获取公钥 (前32字节)
  const publicKeyBytes = keypair.slice(0, 32);
  const publicKey = Buffer.from(publicKeyBytes).toString('base64');
  
  // 使用 solana-keygen 获取公钥
  const deployerAddress = execSync(`solana-keygen pubkey "${CONFIG.keypairPath}"`, { encoding: 'utf-8' }).trim();
  log(`  Deployer: ${deployerAddress}`);

  // 3. 检查余额
  log('\n3. 检查余额...', 'yellow');
  let balance = await getBalance(deployerAddress);
  log(`  余额: ${balance / 1e9} SOL`);
  
  if (balance < 1e9) {
    log('  余额不足，请求空投...', 'yellow');
    await requestAirdrop(deployerAddress, 2e9);
    // 等待确认
    await new Promise(r => setTimeout(r, 5000));
    balance = await getBalance(deployerAddress);
    log(`  新余额: ${balance / 1e9} SOL`);
  }

  // 4. 生成/检查 program keypair
  log('\n4. 准备 Program Keypair...', 'yellow');
  const deployDir = path.join(__dirname, '../target/deploy');
  if (!fs.existsSync(deployDir)) {
    fs.mkdirSync(deployDir, { recursive: true });
  }
  
  const programKeypairPath = path.join(deployDir, `${CONFIG.programName}-keypair.json`);
  
  if (!fs.existsSync(programKeypairPath)) {
    log('  生成新的 program keypair...', 'yellow');
    execSync(`solana-keygen new --no-passphrase -o "${programKeypairPath}" --force`, { stdio: 'pipe' });
  }
  
  const programId = execSync(`solana-keygen pubkey "${programKeypairPath}"`, { encoding: 'utf-8' }).trim();
  log(`  Program ID: ${programId}`);

  // 5. 更新 Program ID 到代码
  log('\n5. 更新 Program ID...', 'yellow');
  
  // 更新 lib.rs
  const libRsPath = path.join(__dirname, '../src/lib.rs');
  if (fs.existsSync(libRsPath)) {
    let libRs = fs.readFileSync(libRsPath, 'utf-8');
    libRs = libRs.replace(
      /declare_id!\("[A-Za-z0-9]+"\)/,
      `declare_id!("${programId}")`
    );
    fs.writeFileSync(libRsPath, libRs);
    log('  已更新 src/lib.rs');
  }
  
  // 更新 Anchor.toml
  const anchorTomlPath = path.join(__dirname, '../Anchor.toml');
  if (fs.existsSync(anchorTomlPath)) {
    let anchorToml = fs.readFileSync(anchorTomlPath, 'utf-8');
    anchorToml = anchorToml.replace(
      /seth_bridge = "[A-Za-z0-9]+"/g,
      `seth_bridge = "${programId}"`
    );
    fs.writeFileSync(anchorTomlPath, anchorToml);
    log('  已更新 Anchor.toml');
  }

  // 6. 构建合约
  log('\n6. 构建合约...', 'yellow');
  const projectRoot = path.join(__dirname, '..');
  
  try {
    execSync('anchor build', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env }
    });
    log('  构建完成!', 'green');
  } catch (e) {
    log(`  构建失败: ${e.message}`, 'red');
    process.exit(1);
  }

  // 7. 部署合约
  log('\n7. 部署合约...', 'yellow');
  
  // 设置代理环境变量
  const deployEnv = {
    ...process.env,
    HTTP_PROXY: CONFIG.proxy,
    HTTPS_PROXY: CONFIG.proxy
  };
  
  try {
    execSync(`anchor deploy --provider.cluster ${CONFIG.cluster}`, {
      cwd: projectRoot,
      stdio: 'inherit',
      env: deployEnv
    });
    log('  部署完成!', 'green');
  } catch (e) {
    log(`  部署失败: ${e.message}`, 'red');
    log('  尝试使用 solana program deploy...', 'yellow');
    
    const soFile = path.join(deployDir, `${CONFIG.programName}.so`);
    if (fs.existsSync(soFile)) {
      try {
        execSync(`solana program deploy "${soFile}"`, {
          cwd: projectRoot,
          stdio: 'inherit',
          env: deployEnv
        });
        log('  使用 solana program deploy 部署完成!', 'green');
      } catch (e2) {
        log(`  部署失败: ${e2.message}`, 'red');
        process.exit(1);
      }
    } else {
      log(`  找不到 .so 文件: ${soFile}`, 'red');
      process.exit(1);
    }
  }

  // 8. 保存部署信息
  log('\n8. 保存部署信息...', 'yellow');
  
  const deploymentInfo = {
    programId,
    cluster: CONFIG.cluster,
    rpcUrl: CONFIG.rpcUrl,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress
  };
  
  const deploymentInfoPath = path.join(__dirname, '../deployment-info.json');
  fs.writeFileSync(deploymentInfoPath, JSON.stringify(deploymentInfo, null, 2));
  log(`  已保存: ${deploymentInfoPath}`);

  // 9. 完成
  log('\n=== 部署成功 ===', 'green');
  log(`\nProgram ID: ${programId}`);
  log(`\n下一步:`, 'yellow');
  log('1. 更新 relayer/.env 中的 SOLANA_PROGRAM_ID');
  log('2. 运行初始化脚本设置桥接参数');

  return deploymentInfo;
}

main().catch(err => {
  console.error('部署失败:', err);
  process.exit(1);
});