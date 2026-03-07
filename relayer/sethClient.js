/**
 * Seth 链客户端
 * 基于 https://github.com/iPoW-Stack/SethPub/blob/main/clinode/cli.js
 * 
 * Seth 链使用自定义交易格式，没有 chainId
 */

const axios = require('axios');
const createKeccakHash = require('keccak');
const secp256k1 = require('secp256k1');
const { Buffer } = require('buffer');

// Helper: Convert BigInt/Number to 8-byte Little Endian Buffer
function uint64ToBuffer(val) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(val), 0);
    return buf;
}

// Helper: Convert Hex string to Buffer
function hexToBuffer(hex) {
    if (hex.startsWith('0x')) hex = hex.slice(2);
    return Buffer.from(hex, 'hex');
}

class SethClient {
    constructor(host, port) {
        this.baseUrl = `http://${host}:${port}`;
        this.txUrl = `${this.baseUrl}/transaction`;
        this.queryUrl = `${this.baseUrl}/query_account`;
        this.receiptUrl = `${this.baseUrl}/query_tx_receipt`;
    }

    /**
     * Derive Address from Public Key
     * Logic: Last 20 bytes of Keccak256(RawPublicKey without '04' prefix)
     */
    deriveAddressFromPubkey(pubKeyBytes) {
        const rawPubKey = pubKeyBytes.slice(1); // Remove '04' prefix
        const hash = createKeccakHash('keccak256').update(rawPubKey).digest();
        return '0x' + hash.slice(-20).toString('hex');
    }

    /**
     * Query account info and get the latest Nonce
     */
    async getLatestNonce(addressHex) {
        if (addressHex.startsWith('0x')) addressHex = addressHex.slice(2);
        
        try {
            const params = new URLSearchParams();
            params.append('address', addressHex);

            const res = await axios.post(this.queryUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });

            if (res.status !== 200) {
                return 0;
            }

            const data = res.data;
            const accountInfo = (typeof data === 'string') ? JSON.parse(data) : data;
            return parseInt(accountInfo.nonce || 0, 10);

        } catch (error) {
            console.error(`[SethClient] Get nonce error: ${error.message}`);
            return 0;
        }
    }

    /**
     * Query account balance
     */
    async getBalance(addressHex) {
        if (addressHex.startsWith('0x')) addressHex = addressHex.slice(2);
        
        try {
            const params = new URLSearchParams();
            params.append('address', addressHex);

            const res = await axios.post(this.queryUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });

            if (res.status !== 200) {
                return '0';
            }

            const data = res.data;
            const accountInfo = (typeof data === 'string') ? JSON.parse(data) : data;
            return accountInfo.balance || '0';

        } catch (error) {
            console.error(`[SethClient] Get balance error: ${error.message}`);
            return '0';
        }
    }

    /**
     * Query transaction receipt
     */
    async getTxReceipt(txHash) {
        try {
            const params = new URLSearchParams();
            params.append('tx_hash', txHash);

            const res = await axios.post(this.receiptUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000
            });

            return res.data;
        } catch (error) {
            console.error(`[SethClient] Get receipt error: ${error.message}`);
            return null;
        }
    }

    /**
     * Strictly replicates the serialization logic of C++ GetTxMessageHash
     */
    computeHash(params) {
        const buffers = [];

        // 1. nonce (uint64 LE)
        buffers.push(uint64ToBuffer(params.nonce));

        // 2. pubkey (bytes)
        buffers.push(hexToBuffer(params.pubkey));

        // 3. to (bytes)
        buffers.push(hexToBuffer(params.to));

        // 4. amount (uint64 LE)
        buffers.push(uint64ToBuffer(params.amount));

        // 5. gas_limit (uint64 LE)
        buffers.push(uint64ToBuffer(params.gas_limit));

        // 6. gas_price (uint64 LE)
        buffers.push(uint64ToBuffer(params.gas_price));

        // 7. step (uint64 LE) - Input is uint32, but serialized as uint64
        buffers.push(uint64ToBuffer(params.step));

        // 8. contract_code (bytes)
        if (params.contract_code) buffers.push(hexToBuffer(params.contract_code));

        // 9. input (bytes)
        if (params.input) buffers.push(hexToBuffer(params.input));

        // 10. prepayment (uint64 LE)
        if (params.prepayment > 0) buffers.push(uint64ToBuffer(params.prepayment));

        // 11. key & val (UTF-8 bytes)
        if (params.key) {
            buffers.push(Buffer.from(params.key, 'utf8'));
            if (params.val) buffers.push(Buffer.from(params.val, 'utf8'));
        }

        const serialized = Buffer.concat(buffers);
        return createKeccakHash('keccak256').update(serialized).digest();
    }

    /**
     * Send transaction with automatic nonce management
     */
    async sendTransaction(privateKeyHex, txParams) {
        // --- 1. Prepare Keys ---
        if (privateKeyHex.startsWith('0x')) privateKeyHex = privateKeyHex.slice(2);
        const privateKey = Buffer.from(privateKeyHex, 'hex');

        // Generate Public Key (Uncompressed: 65 bytes, starts with 04)
        const pubKeyBytes = secp256k1.publicKeyCreate(privateKey, false);
        const pubKeyHex = Buffer.from(pubKeyBytes).toString('hex');

        // Derive Address
        const myAddressHex = this.deriveAddressFromPubkey(pubKeyBytes);

        // --- 2. Get and Increment Nonce ---
        const currentNonce = await this.getLatestNonce(myAddressHex);
        const nextNonce = currentNonce + 1;

        // Merge params with defaults
        const finalParams = {
            amount: 0,
            gas_limit: 100000,
            gas_price: 1,
            step: 0,
            shard_id: 0,
            contract_code: '',
            input: '',
            prepayment: 0,
            key: '',
            val: '',
            ...txParams,
            nonce: nextNonce,
            pubkey: pubKeyHex
        };

        // --- 3. Compute Hash ---
        const txHash = this.computeHash(finalParams);
        const txHashHex = txHash.toString('hex');

        // --- 4. Sign ---
        const sigObj = secp256k1.ecdsaSign(txHash, privateKey);

        const r = Buffer.from(sigObj.signature.slice(0, 32)).toString('hex');
        const s = Buffer.from(sigObj.signature.slice(32, 64)).toString('hex');
        let v = sigObj.recid;

        // --- 5. Send Request ---
        const sendReq = async (vValue) => {
            const formData = new URLSearchParams();
            formData.append('nonce', finalParams.nonce);
            formData.append('pubkey', finalParams.pubkey);
            formData.append('to', finalParams.to);
            formData.append('amount', finalParams.amount);
            formData.append('gas_limit', finalParams.gas_limit);
            formData.append('gas_price', finalParams.gas_price);
            formData.append('shard_id', finalParams.shard_id);
            formData.append('type', finalParams.step);

            formData.append('sign_r', r);
            formData.append('sign_s', s);
            formData.append('sign_v', vValue);

            if (finalParams.contract_code) formData.append('bytes_code', finalParams.contract_code);
            if (finalParams.input) formData.append('input', finalParams.input);
            if (finalParams.prepayment > 0) formData.append('pepay', finalParams.prepayment);
            if (finalParams.key) formData.append('key', finalParams.key);
            if (finalParams.val) formData.append('val', finalParams.val);

            const res = await axios.post(this.txUrl, formData, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            });
            return res;
        };

        try {
            // First attempt
            const res = await sendReq(v);
            
            const respText = JSON.stringify(res.data);
            
            // Automatic Retry with V=1 if rejected
            if (respText.includes('SignatureInvalid') || respText.includes('verify signature failed')) {
                if (v === 0) {
                    const retryRes = await sendReq(1);
                    return {
                        success: true,
                        txHash: txHashHex,
                        nonce: nextNonce,
                        response: retryRes.data
                    };
                }
            }

            return {
                success: true,
                txHash: txHashHex,
                nonce: nextNonce,
                response: res.data
            };
        } catch (error) {
            return {
                success: false,
                txHash: txHashHex,
                nonce: nextNonce,
                error: error.message
            };
        }
    }

    /**
     * Send contract call (step = 2 for contract execution)
     */
    async sendContractCall(privateKeyHex, contractAddress, inputData, options = {}) {
        return this.sendTransaction(privateKeyHex, {
            to: contractAddress,
            input: inputData,
            step: 2, // Contract execution
            amount: options.amount || 0,
            gas_limit: options.gasLimit || 200000,
            gas_price: options.gasPrice || 1,
            ...options
        });
    }

    /**
     * Encode function call for SethBridge
     */
    encodeBridgeMessage(solanaTxSig, recipient, amount) {
        // 简单编码：solanaTxSig (64 bytes) + recipient (20 bytes) + amount (32 bytes)
        const solanaSigBytes = Buffer.alloc(64);
        Buffer.from(solanaTxSig, 'base64').copy(solanaSigBytes);
        
        const recipientBytes = Buffer.alloc(20);
        if (recipient.startsWith('0x')) recipient = recipient.slice(2);
        Buffer.from(recipient, 'hex').copy(recipientBytes);
        
        const amountBytes = Buffer.alloc(32);
        amountBytes.writeBigUInt64BE(BigInt(amount), 24);
        
        return Buffer.concat([solanaSigBytes, recipientBytes, amountBytes]).toString('hex');
    }
}

module.exports = SethClient;