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

// Helper: 将 Buffer 正确地 percent-encode，与 Python requests 发送 bytes 的行为一致
function urlEncodeBytes(buf) {
    let str = '';
    for (const byte of buf) {
        str += '%' + byte.toString(16).padStart(2, '0');
    }
    return str;
}

class SethClient {
    constructor(host, port, proxyUrl = null) {
        this.baseUrl = `http://${host}:${port}`;
        this.txUrl = `${this.baseUrl}/transaction`;
        this.queryUrl = `${this.baseUrl}/query_account`;
        // 对齐 Seth 官方 cli.py：交易回执使用 /transaction_receipt
        this.receiptUrl = `${this.baseUrl}/transaction_receipt`;
        // 合约查询接口
        this.queryContractUrl = `${this.baseUrl}/query_contract`;

        // 解析代理（例如 http://127.0.0.1:7890）
        if (proxyUrl) {
            try {
                const u = new URL(proxyUrl);
                this.proxy = {
                    protocol: u.protocol.replace(':', ''),
                    host: u.hostname,
                    port: u.port ? parseInt(u.port, 10) : 80,
                };
            } catch (e) {
                console.error('[SethClient] Invalid proxy url:', proxyUrl, e.message);
                this.proxy = null;
            }
        } else {
            this.proxy = null;
        }
    }

    /**
     * Derive Address from Public Key
     * Logic: Last 20 bytes of Keccak256(RawPublicKey without '04' prefix)
     */
    deriveAddressFromPubkey(pubKeyBytes) {
        // 统一转成 Buffer，避免 Uint8Array / 其他类型导致 keccak 报错
        const buf = Buffer.isBuffer(pubKeyBytes)
            ? pubKeyBytes
            : Buffer.from(pubKeyBytes);
        const rawPubKey = buf.slice(1); // Remove '04' prefix
        const hash = createKeccakHash('keccak256').update(rawPubKey).digest();
        return '0x' + hash.slice(-20).toString('hex');
    }

    /**
     * 安全解析 query_account 响应（Seth 在地址无效时可能返回纯文本错误而非 JSON）
     */
    _parseQueryAccountResponse(resData) {
        if (resData == null) return null;
        if (typeof resData === 'object' && !Array.isArray(resData)) return resData;
        try {
            const parsed = typeof resData === 'string' ? JSON.parse(resData) : resData;
            return (parsed && typeof parsed === 'object') ? parsed : null;
        } catch {
            return null;
        }
    }

    /**
     * Query account info and get the latest Nonce
     * 注意：参照 cli.py，地址不带 0x 前缀
     */
    async getLatestNonce(addressHex) {
        // 移除 0x 前缀（与 cli.py 一致）
        if (addressHex.startsWith('0x')) addressHex = addressHex.slice(2);
        
        try {
            const params = new URLSearchParams();
            params.append('address', addressHex);

            const axiosConfig = {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            };
            if (this.proxy) {
                axiosConfig.proxy = this.proxy;
            }

            const res = await axios.post(this.queryUrl, params, axiosConfig);

            if (res.status !== 200) {
                return 0;
            }

            const accountInfo = this._parseQueryAccountResponse(res.data);
            if (!accountInfo) {
                console.error(`[SethClient] Get nonce: server returned non-JSON (address may be invalid)`);
                return 0;
            }
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

            const axiosConfig = {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            };
            // if (this.proxy) {
            //     axiosConfig.proxy = this.proxy;
            // }

            const res = await axios.post(this.queryUrl, params, axiosConfig);

            if (res.status !== 200) {
                return '0';
            }

            const accountInfo = this._parseQueryAccountResponse(res.data);
            if (!accountInfo) {
                console.error(`[SethClient] Get balance: server returned non-JSON (address may be invalid)`);
                return '0';
            }
            return accountInfo.balance || '0';

        } catch (error) {
            console.error(`[SethClient] Get balance error: ${error.message}`);
            return '0';
        }
    }

    /**
     * Query transaction receipt
     * 注意: cli.py 直接发送 hex 字符串，不是 bytes
     */
    async getTxReceipt(txHash) {
        try {
            // 移除 0x 前缀
            const cleanHash = txHash.replace(/^0x/, '');
            
            // 使用 URLSearchParams 构建请求体（与 cli.py 行为一致：直接发送 hex 字符串）
            const params = new URLSearchParams();
            params.append('tx_hash', cleanHash);

            const axiosConfig = {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            };
            if (this.proxy) {
                axiosConfig.proxy = this.proxy;
            }

            const res = await axios.post(this.receiptUrl, params, axiosConfig);

            if (res.status !== 200) {
                return null;
            }

            // 参考 Seth 官方 cli.py：返回 JSON，包含 status 字段（MessageHandleStatus）
            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const status = typeof data.status === 'number' ? data.status : null;

            // 与 Python 版本一致：kMessageHandle(1)、kTxAccept(3) 视为“处理中”
            const IN_PROGRESS = new Set([1, 3]);

            return {
                raw: data,
                status,
                done: status == null ? false : !IN_PROGRESS.has(status),
            };
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
        // 重要: 根据 cli.py，当 step=8 (合约调用) 时，获取 nonce 的地址需要是 "to + myAddress"
        let nonceQueryAddress = myAddressHex;
        if (txParams.step === 8 && txParams.to) {
            const toHex = txParams.to.startsWith('0x') ? txParams.to.slice(2) : txParams.to;
            nonceQueryAddress = toHex + myAddressHex.replace('0x', '');
        }
        const currentNonce = await this.getLatestNonce(nonceQueryAddress);
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

            console.log("input is ",finalParams.input);
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
                        response: retryRes.data,
                        httpStatus: retryRes.status,
                        request: {
                            to: finalParams.to,
                            amount: finalParams.amount,
                            gas_limit: finalParams.gas_limit,
                            gas_price: finalParams.gas_price,
                            shard_id: finalParams.shard_id,
                            type: finalParams.step,
                            nonce: finalParams.nonce,
                        }
                    };
                }
            }

            return {
                success: true,
                txHash: txHashHex,
                nonce: nextNonce,
                response: res.data,
                httpStatus: res.status,
                request: {
                    to: finalParams.to,
                    amount: finalParams.amount,
                    gas_limit: finalParams.gas_limit,
                    gas_price: finalParams.gas_price,
                    shard_id: finalParams.shard_id,
                    type: finalParams.step,
                    nonce: finalParams.nonce,
                }
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
     * Query contract (view/pure functions)
     * 对应 cli.py 中的 query_contract 接口
     * 
     * 注意：参照 cli.py，地址不带 0x 前缀
     */
    async queryContract(fromHex, contractAddress, inputData) {
        // 移除 0x 前缀（与 cli.py 一致）
        if (fromHex.startsWith('0x')) fromHex = fromHex.slice(2);
        if (contractAddress.startsWith('0x')) contractAddress = contractAddress.slice(2);
        
        try {
            const params = new URLSearchParams();
            params.append('from', fromHex);
            params.append('address', contractAddress);
            params.append('input', inputData);

            const axiosConfig = {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 10000,
            };
            if (this.proxy) {
                axiosConfig.proxy = this.proxy;
            }

            const res = await axios.post(this.queryContractUrl, params, axiosConfig);

            if (res.status === 200) {
                return res.data;
            }
            return null;
        } catch (error) {
            console.error(`[SethClient] Query contract error: ${error.message}`);
            return null;
        }
    }

    /**
     * Send contract call (step = 8 for contract execution)
     * 注意：参照 cli.py，合约调用使用 step=8
     */
    async sendContractCall(privateKeyHex, contractAddress, inputData, options = {}) {
        return this.sendTransaction(privateKeyHex, {
            to: contractAddress,
            input: inputData,
            step: 8, // Contract execution (参照 cli.py step=8)
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