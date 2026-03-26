/**
 * Price Service - Fetches prices from multiple sources for cross-chain fee calculation
 * 
 * Price Chain:
 * 1. Seth: SETH/sUSDC price (from PoolB)
 * 2. Solana: USDC/sUSDC price (from DIRM pool)
 * 3. External: SOL/USDC price (from CoinGecko or similar)
 * 
 * Final: SOL/SETH = (SOL/USDC) * (USDC/sUSDC_solana) / (SETH/sUSDC_seth)
 */

const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
require('dotenv').config();

// PoolB ABI for price query
const POOL_B_ABI = [
    'function getPrice() external view returns (uint256)',
    'function getReserves() external view returns (uint256 reserveSETH, uint256 reserveSUSDC)'
];

// DIRM pool ABI (simplified)
const DIRM_POOL_ABI = {};

class PriceService {
    constructor() {
        // Seth provider
        this.sethProvider = new ethers.JsonRpcProvider(process.env.SETH_RPC_URL);
        this.poolBContract = new ethers.Contract(
            process.env.POOL_B_ADDRESS,
            POOL_B_ABI,
            this.sethProvider
        );
        
        // Solana connection
        this.solanaConnection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
        
        // Cache
        this.priceCache = {
            sethPerSusdc: null,
            usdcPerSusdc: null,
            solPerUsdc: null,
            lastUpdate: 0,
            cacheDuration: 60000 // 1 minute cache
        };
        
        // CoinGecko API
        this.coinGeckoApiUrl = process.env.COINGECKO_API_URL || 'https://api.coingecko.com/api/v3';
        this.coinGeckoApiKey = process.env.COINGECKO_API_KEY;
    }
    
    /**
     * Get all prices and calculate cross-chain exchange rate
     * Returns: { solPerSeth, sethPerSusdc, usdcPerSusdc, solPerUsdc }
     */
    async getCrossChainExchangeRate() {
        const now = Date.now();
        
        // Use cache if fresh
        if (this.priceCache.lastUpdate && 
            (now - this.priceCache.lastUpdate) < this.priceCache.cacheDuration) {
            return this.calculateExchangeRate();
        }
        
        // Fetch all prices in parallel
        const [sethPerSusdc, usdcPerSusdc, solPerUsdc] = await Promise.all([
            this.getSethPerSusdcPrice().catch(e => {
                console.error('[PriceService] Failed to get SETH/sUSDC price:', e.message);
                return this.priceCache.sethPerSusdc || null;
            }),
            this.getUsdcPerSusdcPrice().catch(e => {
                console.error('[PriceService] Failed to get USDC/sUSDC price:', e.message);
                return this.priceCache.usdcPerSusdc || null;
            }),
            this.getSolPerUsdcPrice().catch(e => {
                console.error('[PriceService] Failed to get SOL/USDC price:', e.message);
                return this.priceCache.solPerUsdc || null;
            })
        ]);
        
        // Update cache
        this.priceCache.sethPerSusdc = sethPerSusdc;
        this.priceCache.usdcPerSusdc = usdcPerSusdc;
        this.priceCache.solPerUsdc = solPerUsdc;
        this.priceCache.lastUpdate = now;
        
        return this.calculateExchangeRate();
    }
    
    /**
     * Calculate SOL/SETH exchange rate from cached prices
     * Formula: SOL/SETH = (SOL/USDC) * (USDC/sUSDC) / (SETH/sUSDC)
     */
    calculateExchangeRate() {
        const { sethPerSusdc, usdcPerSusdc, solPerUsdc } = this.priceCache;
        
        if (!sethPerSusdc || !usdcPerSusdc || !solPerUsdc) {
            console.warn('[PriceService] Missing price data, cannot calculate exchange rate');
            return null;
        }
        
        // All prices are in 18 decimals (or 6 for USDC, normalized to 18)
        // solPerUsdc: how many SOL for 1 USDC
        // usdcPerSusdc: how many USDC for 1 sUSDC
        // sethPerSusdc: how many SETH for 1 sUSDC
        
        // SOL/SETH = (SOL/USDC) * (USDC/sUSDC) / (SETH/sUSDC)
        // = solPerUsdc * (1/usdcPerSusdc) / sethPerSusdc
        // = solPerUsdc / (usdcPerSusdc * sethPerSusdc)
        
        const solPerSeth = (solPerUsdc * BigInt(1e18)) / (usdcPerSusdc * sethPerSusdc / BigInt(1e18));
        
        return {
            solPerSeth,
            sethPerSusdc,
            usdcPerSusdc,
            solPerUsdc,
            // Inverse rate
            sethPerSol: (BigInt(1e36)) / solPerSeth
        };
    }
    
    /**
     * Get SETH/sUSDC price from Seth PoolB
     * Returns: price in 18 decimals (how many SETH for 1 sUSDC)
     */
    async getSethPerSusdcPrice() {
        try {
            const price = await this.poolBContract.getPrice();
            // Price is usually in 18 decimals
            return BigInt(price.toString());
        } catch (error) {
            console.error('[PriceService] Error getting SETH price:', error);
            
            // Fallback: calculate from reserves
            try {
                const { reserveSETH, reserveSUSDC } = await this.poolBContract.getReserves();
                // Price = reserveSETH / reserveSUSDC
                const price = (BigInt(reserveSETH.toString()) * BigInt(1e18)) / BigInt(reserveSUSDC.toString());
                return price;
            } catch (e) {
                console.error('[PriceService] Fallback also failed:', e);
                throw error;
            }
        }
    }
    
    /**
     * Get USDC/sUSDC price from Solana DIRM pool
     * Returns: price in 18 decimals (how many USDC for 1 sUSDC)
     */
    async getUsdcPerSusdcPrice() {
        try {
            // Call DIRM program to get pool reserves
            // This is a simplified implementation
            const dirmProgramId = new PublicKey(process.env.DIRM_PROGRAM_ID);
            const poolPDA = await this.getDirmPoolPDA();
            
            // Fetch pool account and calculate price
            const accountInfo = await this.solanaConnection.getAccountInfo(poolPDA);
            if (!accountInfo) {
                throw new Error('DIRM pool not found');
            }
            
            // Decode pool data (simplified - actual implementation needs proper deserialization)
            // Pool data structure: { usdcReserve: u64, susdcReserve: u64, ... }
            const data = accountInfo.data;
            // Assuming layout: 8 (discriminator) + 8 (usdcReserve) + 8 (susdcReserve) + ...
            const usdcReserve = data.readBigUInt64LE(8);
            const susdcReserve = data.readBigUInt64LE(16);
            
            if (susdcReserve === 0n) {
                throw new Error('Invalid DIRM pool reserves');
            }
            
            // Price = usdcReserve / susdcReserve (normalized to 18 decimals)
            // USDC is 6 decimals, sUSDC is 6 decimals
            const price = (usdcReserve * BigInt(1e18)) / susdcReserve;
            return price;
            
        } catch (error) {
            console.error('[PriceService] Error getting USDC/sUSDC price:', error);
            
            // Fallback: return a default or cached value
            // In production, this should have proper error handling
            return BigInt(1e18); // Assume 1:1 as fallback
        }
    }
    
    async getDirmPoolPDA() {
        const dirmProgramId = new PublicKey(process.env.DIRM_PROGRAM_ID);
        const [poolPDA] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool')],
            dirmProgramId
        );
        return poolPDA;
    }
    
    /**
     * Get SOL/USDC price from CoinGecko
     * Returns: price in 18 decimals (how many SOL for 1 USDC)
     */
    async getSolPerUsdcPrice() {
        try {
            const options = {
                method: 'GET',
                url: `${this.coinGeckoApiUrl}/simple/price`,
                params: {
                    ids: 'solana',
                    vs_currencies: 'usd'
                }
            };
            
            if (this.coinGeckoApiKey) {
                options.headers = {
                    'x-cg-demo-api-key': this.coinGeckoApiKey
                };
            }
            
            const response = await axios.request(options);
            const solPriceUsd = response.data?.solana?.usd;
            
            if (!solPriceUsd) {
                throw new Error('Invalid CoinGecko response');
            }
            
            // Convert to 18 decimals
            // If SOL = $150, then 1 USDC = 1/150 SOL = 0.00667 SOL
            const solPerUsdc = BigInt(Math.floor((1 / solPriceUsd) * 1e18));
            return solPerUsdc;
            
        } catch (error) {
            console.error('[PriceService] Error getting SOL price from CoinGecko:', error);
            
            // Try alternative price sources
            try {
                return await this.getSolPriceFromAlternative();
            } catch (e) {
                console.error('[PriceService] Alternative price source also failed:', e);
                throw error;
            }
        }
    }
    
    /**
     * Alternative SOL price source (e.g., Jupiter, Pyth)
     */
    async getSolPriceFromAlternative() {
        // Could use Jupiter price API or Pyth oracle
        // For now, use a simpler fallback
        const jupiterPriceUrl = 'https://price.jup.ag/v6/price?ids=SOL';
        
        try {
            const response = await axios.get(jupiterPriceUrl);
            const solPriceUsd = response.data?.data?.SOL?.price;
            
            if (!solPriceUsd) {
                throw new Error('Invalid Jupiter response');
            }
            
            const solPerUsdc = BigInt(Math.floor((1 / solPriceUsd) * 1e18));
            return solPerUsdc;
            
        } catch (error) {
            console.error('[PriceService] Jupiter price fetch failed:', error);
            throw error;
        }
    }
    
    /**
     * Estimate cross-chain fee based on current gas prices
     * @param direction 'solana-to-seth' or 'seth-to-solana'
     * @param gasUnits Estimated gas units for the transaction
     */
    async estimateCrossChainFee(direction, gasUnits = 100000n) {
        const exchangeRate = await this.getCrossChainExchangeRate();
        if (!exchangeRate) {
            throw new Error('Cannot get exchange rate');
        }
        
        if (direction === 'solana-to-seth') {
            // User pays on Solana, relayer pays on Seth
            // Fee should cover Seth gas in SOL equivalent
            
            // Get Seth gas price
            const sethGasPrice = await this.getSethGasPrice();
            const sethGasCost = sethGasPrice * gasUnits;
            
            // Convert SETH gas cost to SOL equivalent
            // SOL = SETH * (SOL/SETH)
            const solFee = (sethGasCost * exchangeRate.solPerSeth) / BigInt(1e18);
            
            // Add markup (e.g., 10%)
            const markup = process.env.FEE_MARKUP_PERCENT || 10;
            const feeWithMarkup = solFee * BigInt(100 + markup) / BigInt(100);
            
            return {
                direction,
                sethGasCost,
                solFee: feeWithMarkup,
                exchangeRate,
                breakdown: {
                    baseFeeSOL: solFee,
                    markupPercent: markup,
                    totalFeeSOL: feeWithMarkup
                }
            };
            
        } else if (direction === 'seth-to-solana') {
            // User pays on Seth, relayer pays on Solana
            // Fee should cover Solana gas in SETH equivalent
            
            // Get Solana compute unit price
            const solanaComputePrice = await this.getSolanaComputePrice();
            const solanaGasCost = solanaComputePrice * gasUnits;
            
            // Convert SOL gas cost to SETH equivalent
            // SETH = SOL * (SETH/SOL)
            const sethFee = (solanaGasCost * exchangeRate.sethPerSol) / BigInt(1e36);
            
            // Add markup
            const markup = process.env.FEE_MARKUP_PERCENT || 10;
            const feeWithMarkup = sethFee * BigInt(100 + markup) / BigInt(100);
            
            return {
                direction,
                solanaGasCostLamports: solanaGasCost,
                sethFee: feeWithMarkup,
                exchangeRate,
                breakdown: {
                    baseFeeSETH: sethFee,
                    markupPercent: markup,
                    totalFeeSETH: feeWithMarkup
                }
            };
            
        } else {
            throw new Error(`Unknown direction: ${direction}`);
        }
    }
    
    async getSethGasPrice() {
        try {
            const gasPrice = await this.sethProvider.getFeeData();
            return BigInt(gasPrice.gasPrice?.toString() || '1000000000'); // Default 1 gwei
        } catch (error) {
            console.error('[PriceService] Error getting Seth gas price:', error);
            return BigInt('1000000000'); // Fallback 1 gwei
        }
    }
    
    async getSolanaComputePrice() {
        try {
            // Get recent prioritization fees
            const recentFees = await this.solanaConnection.getRecentPrioritizationFees();
            if (recentFees && recentFees.length > 0) {
                const avgFee = recentFees.reduce((sum, f) => sum + f.prioritizationFee, 0) / recentFees.length;
                return BigInt(Math.floor(avgFee));
            }
            return BigInt(1000); // Default 1000 micro-lamports
        } catch (error) {
            console.error('[PriceService] Error getting Solana compute price:', error);
            return BigInt(1000);
        }
    }
}

module.exports = { PriceService };