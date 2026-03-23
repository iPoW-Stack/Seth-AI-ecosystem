    /**
 * BSC Testnet Client
 * Use ethers.js to interact with the BSC Testnet
 * 
 * BSC Testnet Information:
 * - Chain ID: 97
 * - RPC: https://data-seed-prebsc-1-s1.binance.org:8545/
 * - Explorer: https://testnet.bscscan.com/
 */

const { ethers } = require('ethers');
const createKeccakHash = require('keccak');
const { Buffer } = require('buffer');

// BSC Testnet Configuration
const BSC_TESTNET = {
    chainId: 97,
    name: 'BSC Testnet',
    rpcUrls: [
        'https://data-seed-prebsc-1-s1.binance.org:8545/',
        'https://data-seed-prebsc-2-s1.binance.org:8545/',
        'https://data-seed-prebsc-1-s2.binance.org:8545/',
        'https://data-seed-prebsc-2-s2.binance.org:8545/',
        'https://data-seed-prebsc-1-s3.binance.org:8545/',
        'https://data-seed-prebsc-2-s3.binance.org:8545/',
        // Fallback public RPC
        'https://bsc-testnet.public.blastapi.io',
        'https://bsc-testnet.publicnode.com',
        'https://binance-testnet.public.blastapi.io',
    ],
    nativeCurrency: {
        name: 'BNB',
        symbol: 'tBNB',
        decimals: 18
    },
    blockExplorerUrls: ['https://testnet.bscscan.com/']
};

class BscClient {
    constructor(rpcUrl, privateKey = null, proxyUrl = null) {
        this.rpcUrl = rpcUrl || BSC_TESTNET.rpcUrls[0];
        this.chainId = BSC_TESTNET.chainId;
        this.proxyUrl = proxyUrl;
        
        // Create provider (support proxy)
        if (proxyUrl) {
            // Custom fetch required when using proxy
            const { HttpsProxyAgent } = require('https-proxy-agent');
            const agent = new HttpsProxyAgent(proxyUrl);
            
            this.provider = new ethers.JsonRpcProvider({
                url: this.rpcUrl,
                fetchOptions: {
                    agent
                }
            }, {
                chainId: this.chainId,
                name: BSC_TESTNET.name
            });
        } else {
            this.provider = new ethers.JsonRpcProvider(this.rpcUrl, {
                chainId: this.chainId,
                name: BSC_TESTNET.name
            });
        }
        
        // Create wallet (if private key is provided)
        if (privateKey) {
            this.wallet = new ethers.Wallet(privateKey, this.provider);
            this.relayerAddress = this.wallet.address;
        }
        
        console.log(`[BscClient] Initialized with RPC: ${this.rpcUrl}`);
    }

    /**
     * Connect to a fallback RPC (when the current RPC is unavailable)
     */
    async connectToFallbackRpc() {
        for (const rpcUrl of BSC_TESTNET.rpcUrls) {
            if (rpcUrl === this.rpcUrl) continue;
            
            try {
                console.log(`[BscClient] Trying fallback RPC: ${rpcUrl}`);
                
                let provider;
                if (this.proxyUrl) {
                    const { HttpsProxyAgent } = require('https-proxy-agent');
                    const agent = new HttpsProxyAgent(this.proxyUrl);
                    provider = new ethers.JsonRpcProvider({
                        url: rpcUrl,
                        fetchOptions: { agent }
                    }, {
                        chainId: this.chainId,
                        name: BSC_TESTNET.name
                    });
                } else {
                    provider = new ethers.JsonRpcProvider(rpcUrl, {
                        chainId: this.chainId,
                        name: BSC_TESTNET.name
                    });
                }
                
                // Test connection
                await provider.getBlockNumber();
                
                this.provider = provider;
                this.rpcUrl = rpcUrl;
                
                if (this.wallet) {
                    this.wallet = new ethers.Wallet(this.wallet.privateKey, this.provider);
                }
                
                console.log(`[BscClient] Switched to RPC: ${rpcUrl}`);
                return true;
            } catch (error) {
                console.log(`[BscClient] Failed to connect to ${rpcUrl}: ${error.message}`);
            }
        }
        
        return false;
    }

    /**
     * Get the current block number
     */
    async getBlockNumber() {
        try {
            return await this.provider.getBlockNumber();
        } catch (error) {
            console.error(`[BscClient] Get block number error: ${error.message}`);
            return null;
        }
    }

    /**
     * Get account balance
     * @param {string} address - Account address
      * @returns {Promise<string>} Balance (wei string)
     */
    async getBalance(address) {
        try {
            const balance = await this.provider.getBalance(address);
            return balance.toString();
        } catch (error) {
            console.error(`[BscClient] Get balance error: ${error.message}`);
            return '0';
        }
    }

    /**
     * Get account BNB balance (human-readable format)
     * @param {string} address - Account address
     * @returns {Promise<string>} Balance (BNB)
     */
    async getBalanceInBNB(address) {
        const balance = await this.getBalance(address);
        return ethers.formatEther(balance);
    }

    /**
     * Get current Gas price
     */
    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return feeData.gasPrice;
        } catch (error) {
            console.error(`[BscClient] Get gas price error: ${error.message}`);
            return ethers.parseUnits('10', 'gwei'); // Default gas price 10 Gwei
        }
    }

    /**
     * Get transaction count (nonce)
     * @param {string} address - Account address
     */
    async getNonce(address) {
        try {
            return await this.provider.getTransactionCount(address);
        } catch (error) {
            console.error(`[BscClient] Get nonce error: ${error.message}`);
            return 0;
        }
    }

    /**
     * Get transaction receipt
     * @param {string} txHash - Transaction hash
     */
    async getTransactionReceipt(txHash) {
        try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (!receipt) return null;
            
            return {
                raw: receipt,
                status: receipt.status,
                blockNumber: Number(receipt.blockNumber),
                gasUsed: receipt.gasUsed.toString(),
                effectiveGasPrice: receipt.gasPrice ? receipt.gasPrice.toString() : '0',
                logs: receipt.logs
            };
        } catch (error) {
            console.error(`[BscClient] Get receipt error: ${error.message}`);
            return null;
        }
    }

    /**
     * Wait for transaction confirmation
     * @param {string} txHash - Transaction hash
     * @param {number} confirmations - Number of confirmations
     * @param {number} timeout - Timeout time (milliseconds)
     */
    async waitForTransaction(txHash, confirmations = 1, timeout = 60000) {
        try {
            const receipt = await this.provider.waitForTransaction(txHash, confirmations, timeout);
            return receipt;
        } catch (error) {
            console.error(`[BscClient] Wait for transaction error: ${error.message}`);
            return null;
        }
    }

    /**
     * Send native token (BNB) transfer
     * @param {string} to - Recipient address
     * @param {string|bigint} amount - Amount (wei)
     * @param {Object} options - Options
     */
    async sendNativeToken(to, amount, options = {}) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized. Please provide private key.');
        }

        try {
            const gasPrice = options.gasPrice || await this.getGasPrice();
            const gasLimit = options.gasLimit || 21000n;

            const tx = await this.wallet.sendTransaction({
                to,
                value: BigInt(amount),
                gasLimit,
                gasPrice
            });

            console.log(`[BscClient] Transaction sent: ${tx.hash}`);

            return {
                success: true,
                txHash: tx.hash,
                nonce: tx.nonce,
                response: tx
            };
        } catch (error) {
            console.error(`[BscClient] Send transaction error: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Send contract call
     * @param {string} contractAddress - Contract address
     * @param {string} inputData - Call data (hexadecimal)
     * @param {Object} options - Options
     */
    async sendContractCall(contractAddress, inputData, options = {}) {
        if (!this.wallet) {
            throw new Error('Wallet not initialized. Please provide private key.');
        }

        try {
            const gasPrice = options.gasPrice || await this.getGasPrice();
            const gasLimit = options.gasLimit || 300000n;
            const value = options.value || options.amount || 0n;

            const tx = await this.wallet.sendTransaction({
                to: contractAddress,
                data: inputData,
                value: BigInt(value),
                gasLimit,
                gasPrice
            });

            console.log(`[BscClient] Contract call sent: ${tx.hash}`);
            console.log(`[BscClient]   To: ${contractAddress}`);
            console.log(`[BscClient]   Data: ${inputData.slice(0, 66)}...`);
            console.log(`[BscClient]   Value: ${value.toString()}`);

            return {
                success: true,
                txHash: tx.hash,
                nonce: tx.nonce,
                response: tx,
                request: {
                    to: contractAddress,
                    data: inputData,
                    value: value.toString(),
                    gasLimit: gasLimit.toString(),
                    gasPrice: gasPrice.toString()
                }
            };
        } catch (error) {
            console.error(`[BscClient] Contract call error: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Call contract read-only method
     * @param {string} contractAddress - Contract address
     * @param {string} inputData - Call data (hexadecimal)
     */
    async callContract(contractAddress, inputData) {
        try {
            const result = await this.provider.call({
                to: contractAddress,
                data: inputData
            });
            return {
                success: true,
                data: result
            };
        } catch (error) {
            console.error(`[BscClient] Contract call error: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Encode processCrossChainMessage function call
     * function processCrossChainMessage(bytes32 solanaTxSig, uint256 ecosystemAmount, uint256 teamFundsAmount, uint256 amountBNB)
     * @param solanaTxSigBytes32 Solana transaction signature (bytes32)
     * @param ecosystemAmount Ecosystem funds (30%) - inject to PoolB
     * @param teamFundsAmount Team funds (5%) - to TeamPayroll
     * @param amountBNB Native BNB amount (for PoolB liquidity)
     */
    encodeProcessCrossChainMessage(solanaTxSigBytes32, ecosystemAmount, teamFundsAmount, amountBNB) {
        // selector = keccak256("processCrossChainMessage(bytes32,uint256,uint256,uint256)")[:4]
        const selector = createKeccakHash('keccak256')
            .update('processCrossChainMessage(bytes32,uint256,uint256,uint256)')
            .digest('hex')
            .slice(0, 8);

        const sig = solanaTxSigBytes32.replace(/^0x/, '').padStart(64, '0');
        const ecoAmt = BigInt(ecosystemAmount).toString(16).padStart(64, '0');
        const teamAmt = BigInt(teamFundsAmount).toString(16).padStart(64, '0');
        const amtBNB = BigInt(amountBNB).toString(16).padStart(64, '0');

        return '0x' + selector + sig + ecoAmt + teamAmt + amtBNB;
    }

    /**
     * Get contract instance
     * @param {string} contractAddress - Contract address
     * @param {Array} abi - Contract ABI
     */
    getContract(contractAddress, abi) {
        return new ethers.Contract(contractAddress, abi, this.wallet || this.provider);
    }

    /**
     * Get chain ID
     */
    async getChainId() {
        try {
            const network = await this.provider.getNetwork();
            return Number(network.chainId);
        } catch (error) {
            return this.chainId;
        }
    }

    /**
     * Verify network connection
     */
    async verifyConnection() {
        try {
            const blockNumber = await this.provider.getBlockNumber();
            const chainId = await this.getChainId();
            
            console.log(`[BscClient] Connected to ${BSC_TESTNET.name}`);
            console.log(`[BscClient] Chain ID: ${chainId}`);
            console.log(`[BscClient] Block Number: ${blockNumber}`);
            
            if (chainId !== BSC_TESTNET.chainId) {
                console.warn(`[BscClient] Warning: Chain ID mismatch. Expected ${BSC_TESTNET.chainId}, got ${chainId}`);
                return false;
            }
            
            return true;
        } catch (error) {
            console.error(`[BscClient] Connection verification failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Get block timestamp
     */
    async getBlockTimestamp() {
        try {
            const block = await this.provider.getBlock('latest');
            return block.timestamp;
        } catch (error) {
            console.error(`[BscClient] Get block timestamp error: ${error.message}`);
            return null;
        }
    }

    /**
     * Wait for specified milliseconds
     */
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Polling wait for transaction receipt
     * @param {string} txHash - Transaction hash
     * @param {number} maxAttempts - Maximum attempt times
     * @param {number} intervalMs - Interval time (milliseconds)
     */
    async waitReceipt(txHash, maxAttempts = 30, intervalMs = 2000) {
        for (let i = 0; i < maxAttempts; i++) {
            const receipt = await this.getTransactionReceipt(txHash);
            if (receipt) {
                return receipt;
            }
            await this.sleep(intervalMs);
        }
        return null;
    }

    /**
     * Get transaction details
     * @param {string} txHash - Transaction hash
     */
    async getTransaction(txHash) {
        try {
            const tx = await this.provider.getTransaction(txHash);
            return tx;
        } catch (error) {
            console.error(`[BscClient] Get transaction error: ${error.message}`);
            return null;
        }
    }

    /**
     * Estimate Gas for transaction (default value: 300000n gas limit) - BSC Network
     * @param {Object} txParams - Transaction parameters
     */
    async estimateGas(txParams) {
        try {
            const gas = await this.provider.estimateGas(txParams);
            return gas;
        } catch (error) {
            console.error(`[BscClient] Estimate gas error: ${error.message}`);
            return 300000n; // Default value
        }
    }
}

module.exports = BscClient;