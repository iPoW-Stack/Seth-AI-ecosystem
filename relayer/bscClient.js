/**
 * BSC 测试网客户端
 * 使用 ethers.js 与 BSC 测试网交互
 * 
 * BSC 测试网信息：
 * - Chain ID: 97
 * - RPC: https://data-seed-prebsc-1-s1.binance.org:8545/
 * - Explorer: https://testnet.bscscan.com/
 */

const { ethers } = require('ethers');
const createKeccakHash = require('keccak');
const { Buffer } = require('buffer');

// BSC 测试网配置
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
        // 备用公共 RPC
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
        
        // 创建 provider（支持代理）
        if (proxyUrl) {
            // 使用代理时需要自定义 fetch
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
        
        // 创建 wallet（如果提供了私钥）
        if (privateKey) {
            this.wallet = new ethers.Wallet(privateKey, this.provider);
            this.relayerAddress = this.wallet.address;
        }
        
        console.log(`[BscClient] Initialized with RPC: ${this.rpcUrl}`);
    }

    /**
     * 连接到备用 RPC（当前 RPC 不可用时）
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
                
                // 测试连接
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
     * 获取当前区块号
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
     * 获取账户余额
     * @param {string} address - 账户地址
     * @returns {Promise<string>} 余额（wei 字符串）
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
     * 获取账户 BNB 余额（可读格式）
     * @param {string} address - 账户地址
     * @returns {Promise<string>} 余额（BNB）
     */
    async getBalanceInBNB(address) {
        const balance = await this.getBalance(address);
        return ethers.formatEther(balance);
    }

    /**
     * 获取当前 Gas 价格
     */
    async getGasPrice() {
        try {
            const feeData = await this.provider.getFeeData();
            return feeData.gasPrice;
        } catch (error) {
            console.error(`[BscClient] Get gas price error: ${error.message}`);
            return ethers.parseUnits('10', 'gwei'); // 默认 10 Gwei
        }
    }

    /**
     * 获取交易计数（nonce）
     * @param {string} address - 账户地址
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
     * 获取交易回执
     * @param {string} txHash - 交易哈希
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
     * 等待交易确认
     * @param {string} txHash - 交易哈希
     * @param {number} confirmations - 确认数
     * @param {number} timeout - 超时时间（毫秒）
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
     * 发送原生代币（BNB）转账
     * @param {string} to - 接收地址
     * @param {string|bigint} amount - 金额（wei）
     * @param {Object} options - 选项
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
     * 发送合约调用
     * @param {string} contractAddress - 合约地址
     * @param {string} inputData - 调用数据（十六进制）
     * @param {Object} options - 选项
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
     * 调用合约只读方法
     * @param {string} contractAddress - 合约地址
     * @param {string} inputData - 调用数据（十六进制）
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
     * 获取合约实例
     * @param {string} contractAddress - 合约地址
     * @param {Array} abi - 合约 ABI
     */
    getContract(contractAddress, abi) {
        return new ethers.Contract(contractAddress, abi, this.wallet || this.provider);
    }

    /**
     * 获取链 ID
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
     * 验证网络连接
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
     * 获取链上时间戳
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
     * 等待指定毫秒
     */
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 轮询等待交易回执
     * @param {string} txHash - 交易哈希
     * @param {number} maxAttempts - 最大尝试次数
     * @param {number} intervalMs - 间隔时间（毫秒）
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
     * 获取交易详情
     * @param {string} txHash - 交易哈希
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
     * 估算 Gas
     * @param {Object} txParams - 交易参数
     */
    async estimateGas(txParams) {
        try {
            const gas = await this.provider.estimateGas(txParams);
            return gas;
        } catch (error) {
            console.error(`[BscClient] Estimate gas error: ${error.message}`);
            return 300000n; // 默认值
        }
    }
}

module.exports = BscClient;