# Inject Liquidity Script

This script runs the following steps automatically:

1. Mint 1,000,000 sUSDC
2. Approve 10 sUSDC to PoolB
3. Add 10 sUSDC + 100 SETH liquidity to PoolB

## Prerequisites

1. **Node.js** — dependencies installed
2. **Deployer private key** — enough SETH for gas
3. **Seth RPC** — reachable endpoint

## Environment variables

In PowerShell:

```powershell
# Deployer private key
$env:DEPLOYER_PRIVATE_KEY = "0x..."  # your deployer key, 0x prefix

# Optional: custom Seth RPC
$env:SETH_HOST = "35.197.170.240"     # default
$env:SETH_PORT = "23001"              # default
```

Or inline:

```powershell
set DEPLOYER_PRIVATE_KEY=0x...
node inject-liquidity.js
```

## How to run

```bash
cd contracts\seth

# Option A: env vars or defaults
node inject-liquidity.js

# Option B: one-line PowerShell
$env:DEPLOYER_PRIVATE_KEY="0x..."; node inject-liquidity.js
```

## Flow

### Step 1: Mint sUSDC
- Call `sUSDC.mint(deployer, 1000000 * 10^6)`
- Mints 1,000,000 sUSDC to the deployer
- Wait for receipt

### Step 2: Approve sUSDC
- Call `sUSDC.approve(PoolB, 10 * 10^6)`
- Approve PoolB to spend 10 sUSDC
- Wait for receipt

### Step 3: Add liquidity
- Call `PoolB.addLiquidity(10 * 10^6)`
- Send 100 SETH as `msg.value`
- Wait for receipt

## Sample output

```
========================================
    Inject Liquidity Script
========================================

Seth Host: 35.197.170.240:23001
sUSDC Address: 0x2f845c7e0a45e5d577dbd8761970532104c0ec30
PoolB Address: 0x5b6df156ab2070a2b45834f1c10000967051f6e1

1. Attempting operations...

2. Minting 1,000,000 sUSDC...
   Amount: 1000000.000000 sUSDC
   Sending transaction...
   TX Hash: 0x...
   Waiting for receipt...
   ✓ Status: Success

3. Approving sUSDC to PoolB...
   Amount: 10.000000 sUSDC
   Spender: 0x5b6df156ab2070a2b45834f1c10000967051f6e1
   Sending transaction...
   TX Hash: 0x...
   Waiting for receipt...
   ✓ Status: Success

4. Adding liquidity to PoolB...
   sUSDC: 10.000000 sUSDC
   SETH: 100.000000 SETH (wei: 100000000000000000000)
   Sending transaction...
   TX Hash: 0x...
   Waiting for receipt...
   ✓ Status: Success

========================================
✓ All operations completed successfully!
========================================

Summary:
  • Minted: 1000000.000000 sUSDC
  • Approved: 10.000000 sUSDC to PoolB
  • Injected: 10.000000 sUSDC + 100.000000 SETH to PoolB

Transaction Hashes:
  Mint: 0x...
  Approve: 0x...
  Add Liquidity: 0x...
```

## Configuration

Edit the `CONFIG` object in the script:

```javascript
const CONFIG = {
    host: process.env.SETH_HOST || '35.197.170.240',
    port: parseInt(process.env.SETH_PORT || '23001'),
    privateKeyHex: process.env.DEPLOYER_PRIVATE_KEY,

    // Contract addresses
    sUSDCAddr: '0x2f845c7e0a45e5d577dbd8761970532104c0ec30',
    PoolBAddr: '0x5b6df156ab2070a2b45834f1c10000967051f6e1',

    // Amounts
    totalMintAmount: 1000000n * 10n**6n,  // mint size
    injectSUSDC: 10n * 10n**6n,           // sUSDC to inject
    injectSETH: 100n * 10n**18n,          // SETH to inject
};
```

## Troubleshooting

### Error: DEPLOYER_PRIVATE_KEY not set

```
ERROR: DEPLOYER_PRIVATE_KEY environment variable not set
```

Set the variable and run again:

```powershell
set DEPLOYER_PRIVATE_KEY=0x...
node inject-liquidity.js
```

### Error: transaction failed

Check:

- Private key is correct (0x + 64 hex chars)
- Account has enough SETH (at least ~100 SETH for the scripted amounts)
- Seth RPC is reachable

### Error: Mint receipt timeout

Possible causes:

- Slow RPC
- Transaction not mined
- Network issues

Try increasing wait time or inspect the tx:

```javascript
const [ok, status] = await waitForReceipt(client, txHash, 120); // increase max attempts
```

## Verifying results

After success:

1. **sUSDC balance** — query deployer balance
2. **PoolB reserves** — `reserveSETH` and `reservesUSDC` should increase
3. **Tx status** — use returned hashes on a Seth explorer

## FAQ

**Q: Can I change the mint amount?**  
A: Yes. Change `totalMintAmount`, e.g. `2000000n * 10n**6n` for 2,000,000 sUSDC.

**Q: Can I run steps separately?**  
A: Yes. Comment out steps you do not need in the script.

**Q: Can I change the liquidity ratio?**  
A: Yes. Adjust `injectSUSDC` and `injectSETH`.

## Support

If something fails, verify:

1. `deployment-info.json` matches your deployment
2. Seth RPC connectivity
3. Contract addresses match on-chain deployment
