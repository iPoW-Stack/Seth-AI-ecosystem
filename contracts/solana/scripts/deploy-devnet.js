/**
 * Build and deploy seth_bridge + dirm to the cluster configured in Anchor.toml (dev RPC).
 *
 * Prereqs: Rust, Solana CLI, Anchor (see contracts/solana/README.md).
 *
 * Usage:
 *   node scripts/deploy-devnet.js
 *   node scripts/deploy-devnet.js --init   # also runs initialize-bridge.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');

const root = path.resolve(__dirname, '..');

function run(cmd) {
  console.log(`\n> ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', cwd: root, shell: true });
}

function programIdFromDeployKeypair(filename) {
  const abs = path.join(root, 'target/deploy', filename);
  const secret = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
}

async function main() {
  const withInit = process.argv.includes('--init');

  run('anchor build');
  run('anchor deploy');

  const programId = programIdFromDeployKeypair('seth_bridge-keypair.json');
  const dirmProgramId = programIdFromDeployKeypair('dirm-keypair.json');

  const out = {
    programId,
    dirmProgramId,
    cluster: 'devnet',
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, 'deployment-info.json'), JSON.stringify(out, null, 2));
  console.log('\nWrote deployment-info.json:', JSON.stringify(out, null, 2));

  if (withInit) {
    run('node scripts/initialize-bridge.js');
  } else {
    console.log(
      '\n(Optional) Initialize bridge config on-chain: node scripts/initialize-bridge.js\n' +
        'Or re-run: node scripts/deploy-devnet.js --init\n'
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
