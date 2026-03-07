/**
 * Solana 合约部署脚本
 * 用法: node scripts/deploy-solana.js
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  cluster: process.env.CLUSTER || 'devnet',
  keypairPath: process.env.KEYPAIR_PATH || '../deployer-keypair.json',
  programName: 'seth_bridge'
};

// 颜色输出
const colors = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function execCommand(command, cwd = __dirname) {
  try {
    return execSync(command, { 
      cwd, 
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim();
  } catch (error) {
    return null;
  }
}

async function main() {
  log('\n=== Solana 合约部署脚本 ===\n', 'yellow');

  // 1. 检查环境
  log('1. 检查环境...', 'yellow');
  
  const solanaVersion = execCommand('solana --version');
  const anchorVersion = execCommand('anchor --version');
  
  if (!solanaVersion) {
    log('错误: Solana CLI 未安装', 'red');
    process.exit(1);
  }
  if (!anchorVersion) {
    log('错误: Anchor CLI 未安装', 'red');
    process.exit(1);
  }
  
  log(`  Solana CLI: ${solanaVersion}`);
  log(`  Anchor CLI: ${anchorVersion}`);

  // 2. 配置 Solana
  log('\n2. 配置 Solana...', 'yellow');
  
  execCommand(`solana config set --url ${CONFIG.cluster}`);
  execCommand(`solana config set --keypair ${CONFIG.keypairPath}`);
  
  const config = execCommand('solana config get');
  log(`  配置:\n${config?.split('\n').map(l => '    ' + l).join('\n')}`);

  // 3. 检查余额
  log('\n3. 检查余额...', 'yellow');
  
  const balance = execCommand('solana balance');
  log(`  余额: ${balance || '无法获取'}`);
  
  if (balance && parseFloat(balance) < 1) {
    log('  余额不足，尝试空投...', 'yellow');
    const airdrop = execCommand('solana airdrop 2');
    log(`  空投结果: ${airdrop || '失败'}`);
  }

  // 4. 生成新的 Program Keypair
  log('\n4. 生成 Program Keypair...', 'yellow');
  
  const programKeypairPath = path.join(__dirname, '../target/deploy', `${CONFIG.programName}-keypair.json`);
  const deployDir = path.dirname(programKeypairPath);
  
  if (!fs.existsSync(deployDir)) {
    fs.mkdirSync(deployDir, { recursive: true });
  }
  
  if (fs.existsSync(programKeypairPath)) {
    log(`  使用现有 keypair: ${programKeypairPath}`);
  } else {
    execCommand(`solana-keygen new --no-passphrase -o "${programKeypairPath}" --force`);
    log(`  生成新 keypair: ${programKeypairPath}`);
  }
  
  const programId = execCommand(`solana-keygen pubkey "${programKeypairPath}"`);
  log(`  Program ID: ${programId}`);

  // 5. 更新 Anchor.toml 和 lib.rs 中的 Program ID
  log('\n5. 更新 Program ID...', 'yellow');
  
  const anchorTomlPath = path.join(__dirname, '../Anchor.toml');
  const libRsPath = path.join(__dirname, '../src/lib.rs');
  
  // 更新 Anchor.toml
  if (fs.existsSync(anchorTomlPath)) {
    let anchorToml = fs.readFileSync(anchorTomlPath, 'utf-8');
    anchorToml = anchorToml.replace(
      /seth_bridge = "[A-Za-z0-9]+"/g,
      `seth_bridge = "${programId}"`
    );
    fs.writeFileSync(anchorTomlPath, anchorToml);
    log(`  已更新 Anchor.toml`);
  }
  
  // 更新 lib.rs
  if (fs.existsSync(libRsPath)) {
    let libRs = fs.readFileSync(libRsPath, 'utf-8');
    libRs = libRs.replace(
      /declare_id!\("[A-Za-z0-9]+"\)/,
      `declare_id!("${programId}")`
    );
    fs.writeFileSync(libRsPath, libRs);
    log(`  已更新 src/lib.rs`);
  }

  // 6. 构建合约
  log('\n6. 构建合约...', 'yellow');
  
  const projectRoot = path.join(__dirname, '..');
  log(`  项目目录: ${projectRoot}`);
  
  try {
    const buildOutput = execSync('anchor build', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'inherit'
    });
    log('  构建完成!', 'green');
  } catch (error) {
    log(`  构建失败: ${error.message}`, 'red');
    log('  请检查合约代码是否有错误', 'red');
    process.exit(1);
  }

  // 7. 部署合约
  log('\n7. 部署合约...', 'yellow');
  
  try {
    const deployOutput = execSync(`anchor deploy --provider.cluster ${CONFIG.cluster}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'inherit'
    });
    log('  部署完成!', 'green');
  } catch (error) {
    log(`  部署失败: ${error.message}`, 'red');
    process.exit(1);
  }

  // 8. 保存部署信息
  log('\n8. 保存部署信息...', 'yellow');
  
  const deploymentInfo = {
    programId,
    cluster: CONFIG.cluster,
    deployedAt: new Date().toISOString(),
    deployer: execCommand('solana address')
  };
  
  const deploymentInfoPath = path.join(__dirname, '../deployment-info.json');
  fs.writeFileSync(deploymentInfoPath, JSON.stringify(deploymentInfo, null, 2));
  log(`  部署信息已保存: ${deploymentInfoPath}`);

  // 9. 输出部署结果
  log('\n=== 部署完成 ===', 'green');
  log(`\nProgram ID: ${programId}`);
  log(`Cluster: ${CONFIG.cluster}`);
  log(`\n请将此 Program ID 更新到 relayer 配置中`);

  // 输出下一步操作
  log('\n下一步操作:', 'yellow');
  log('1. 更新 relayer/.env 中的 SOLANA_PROGRAM_ID');
  log('2. 更新 Seth 链合约配置（如果需要）');
  log('3. 初始化桥接合约（运行初始化脚本）');

  return deploymentInfo;
}

// 执行部署
main().catch(console.error);