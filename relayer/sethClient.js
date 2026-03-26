/**
 * Seth Chain Client
 * Based on https://github.com/iPoW-Stack/SethPub/blob/main/clinode/cli.js
 * 
 * Seth chain uses custom transaction format, no chainId
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

// Helper: Convert Buffer to percent-encoded string, consistent with Python requests sending bytes
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
        // Align with Seth official cli.py: transaction receipt uses /transaction_receipt
        this.receiptUrl = `${this.baseUrl}/transaction_receipt`;
        // Contract query interface
        this.queryContractUrl = `${this.baseUrl}/query_contract`;

        // Proxy parsing (e.g. http://127.0.0.1:7890)
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
        // Convert to Buffer, avoid Uint8Array / other types causing keccak error
        const buf = Buffer.isBuffer(pubKeyBytes)
            ? pubKeyBytes
            : Buffer.from(pubKeyBytes);
        const rawPubKey = buf.slice(1); // Remove '04' prefix
        const hash = createKeccakHash('keccak256').update(rawPubKey).digest();
        return '0x' + hash.slice(-20).toString('hex');
    }

    /**
     * Securely parse query_account response (Seth may return plain text error instead of JSON when address is invalid)
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
     * Note: Referencing cli.py, address does not start with 0x prefix
     */
    async getLatestNonce(addressHex) {
        // Remove 0x prefix (consistent with cli.py)
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
     * Note: Referencing cli.py, directly send hex string, not bytes
     */
    async getTxReceipt(txHash) {
        try {
            // Remove 0x prefix 
            const cleanHash = txHash.replace(/^0x/, '');
            
            // Use URLSearchParams to build request body (consistent with cli.py: directly send hex string)
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

            // Referencing Seth official cli.py: returns JSON, contains status field (MessageHandleStatus)
            const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
            const status = typeof data.status === 'number' ? data.status : null;

            // Consistent with Python version: kMessageHandle(1), kTxAccept(3) treated as "in progress"
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

        // Normalize destination address to plain 40-hex format.
        // Some configs append shard suffix like "00000", which breaks nonce query address length.
        const normalizeToAddress = (to) => {
            if (!to) return to;
            let hex = String(to).trim().toLowerCase().replace(/^0x/, '');
            if (hex.length === 45 && hex.endsWith('00000')) {
                hex = hex.slice(0, 40);
            }
            if (hex.length > 40) {
                hex = hex.slice(0, 40);
            }
            if (!/^[0-9a-f]{40}$/.test(hex)) {
                throw new Error(`Invalid txParams.to address format: ${to}`);
            }
            return hex;
        };
        const normalizedTo = normalizeToAddress(txParams.to);

        // --- 2. Get and Increment Nonce ---
        // 重要: 根据 cli.py，当 step=8 (合约调用) 时，获取 nonce 的地址需要是 "to + myAddress"
        let nonceQueryAddress = myAddressHex;
        if (txParams.step === 8 && normalizedTo) {
            console.log("txParams.to: ", normalizedTo);
            const toHex = normalizedTo;
            nonceQueryAddress = toHex + myAddressHex.replace('0x', '');
        }
        console.log("nonceQueryAddress: ",nonceQueryAddress);
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
            to: normalizedTo || txParams.to,
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
     * Corresponds to cli.py's query_contract interface
     * 
     * Note: Referencing cli.py, address does not start with 0x prefix
     */
    async queryContract(fromHex, contractAddress, inputData) {
        // Remove 0x prefix (consistent with cli.py)
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
     * Note: Referencing cli.py, contract call uses step=8
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
        // Simple encoding: solanaTxSig (64 bytes) + recipient (20 bytes) + amount (32 bytes)
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