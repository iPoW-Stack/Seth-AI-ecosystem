const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

/**
 * Database Operations Class
 * Responsible for persistent storage and querying of cross-chain messages
 */
class Database {
    constructor(config) {
        this.pool = mysql.createPool({
            host: config.host || 'localhost',
            port: config.port || 3306,
            database: config.database || 'bridge_relayer',
            user: config.user || 'root',
            password: config.password || '',
            waitForConnections: true,
            connectionLimit: config.maxConnections || 10,
            queueLimit: 0,
            multipleStatements: true,
            timezone: 'Z',
        });
        
        this.initialized = false;
    }

    async _query(sql, params = []) {
        const [rows] = await this.pool.execute(sql, params);
        return rows;
    }

    /**
     * Test database connection
     */
    async testConnection() {
        try {
            const rows = await this._query('SELECT NOW() AS now');
            console.log('[DB] Connected successfully at:', rows[0].now);
            return true;
        } catch (error) {
            console.error('[DB] Connection failed:', error.message);
            return false;
        }
    }

    /**
     * Apply schema from db/init.sql (idempotent; single source of truth).
     */
    async runMigrations() {
        const initSqlPath = path.join(__dirname, 'init.sql');
        if (!fs.existsSync(initSqlPath)) {
            console.error('[DB] init.sql not found');
            return false;
        }

        try {
            console.log('[DB] Applying db/init.sql...');
            const sql = fs.readFileSync(initSqlPath, 'utf8');
            const conn = await this.pool.getConnection();
            try {
                await conn.query(sql);
            } finally {
                conn.release();
            }
            this.initialized = true;
            console.log('[DB] Schema ready');
            return true;
        } catch (error) {
            console.error('[DB] Schema init failed:', error.message);
            return false;
        }
    }

    /**
     * Initialize database - call this before using the database
     */
    async initialize() {
        const connected = await this.testConnection();
        if (!connected) {
            throw new Error('Database connection failed');
        }
        
        const migrated = await this.runMigrations();
        if (!migrated) {
            throw new Error('Database schema init failed (see logs; check db/init.sql)');
        }
        
        return true;
    }

    /**
     * Close database connection pool
     */
    async close() {
        await this.pool.end();
        console.log('[DB] Connection pool closed');
    }

    // ==================== Cross-Chain Message Operations ====================

    /**
     * Insert new cross-chain message
     * @param {Object} message - Message data
     * @returns {Promise<Object>} Inserted record
     */
    async insertMessage(message) {
        const query = `
            INSERT INTO cross_chain_messages (
                solana_tx_sig, solana_tx_sig_bytes32, amount,
                recipient_eth, sender_solana, solana_block_time, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE id = id
        `;
        
        const values = [
            message.solanaTxSig,
            message.solanaTxSigBytes32,
            message.amount,
            message.recipientEth,
            message.senderSolana,
            message.solanaBlockTime,
            'pending'
        ];

        const result = await this._query(query, values);
        if (result.insertId) {
            return this.getMessageBySig(message.solanaTxSig);
        }
        return null;
    }

    /**
     * Get message by Solana transaction signature
     * @param {string} solanaTxSig - Solana transaction signature
     * @returns {Promise<Object|null>}
     */
    async getMessageBySig(solanaTxSig) {
        const query = 'SELECT * FROM cross_chain_messages WHERE solana_tx_sig = ?';
        const rows = await this._query(query, [solanaTxSig]);
        return rows[0] || null;
    }

    /**
     * Check if message has been processed
     * @param {string} solanaTxSig - Solana transaction signature
     * @returns {Promise<boolean>}
     */
    async isProcessed(solanaTxSig) {
        const query = `
            SELECT status FROM cross_chain_messages 
            WHERE solana_tx_sig = ? AND status = 'completed'
        `;
        const rows = await this._query(query, [solanaTxSig]);
        return rows.length > 0;
    }

    /**
     * Update message status to processing
     * @param {number} messageId - Message ID
     * @returns {Promise<void>}
     */
    async markAsProcessing(messageId) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = 'processing', updated_at = NOW()
            WHERE id = ? AND status IN ('pending', 'failed')
        `;
        await this._query(query, [messageId]);
    }

    /**
     * Update message status to completed
     * @param {number} messageId - Message ID
     * @param {Object} txInfo - Seth transaction info
     */
    async markAsCompleted(messageId, txInfo) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = 'completed', 
                seth_tx_hash = ?, 
                seth_block_number = ?,
                processed_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `;
        await this._query(query, [
            txInfo.txHash, 
            txInfo.blockNumber,
            messageId,
        ]);
        
        await this.logOperation(messageId, 'complete', { txInfo });
    }

    /**
     * Update message status to failed
     * @param {number} messageId - Message ID
     * @param {string} error - Error message
     * @param {number} maxRetries - Maximum retry count
     */
    async markAsFailed(messageId, error, maxRetries = 5) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = CASE WHEN retry_count >= ? THEN 'failed' ELSE 'pending' END,
                retry_count = retry_count + 1,
                last_error = ?,
                next_retry_at = CASE 
                    WHEN retry_count < ? THEN DATE_ADD(NOW(), INTERVAL LEAST(POW(2, retry_count), 30) MINUTE)
                    ELSE NULL 
                END,
                updated_at = NOW()
            WHERE id = ?
        `;
        await this._query(query, [maxRetries, error, maxRetries, messageId]);
        const rows = await this._query('SELECT retry_count, status FROM cross_chain_messages WHERE id = ?', [messageId]);
        const row = rows[0];
        
        if (row) {
            await this.logOperation(messageId, 'fail', { 
                error, 
                retryCount: row.retry_count 
            });
        }
        
        return row;
    }

    /**
     * Get failed messages pending retry
     * @param {number} limit - Maximum return count
     * @returns {Promise<Array>}
     */
    async getPendingRetries(limit = 10) {
        const query = `
            SELECT * FROM cross_chain_messages 
            WHERE status = 'pending' 
              AND retry_count > 0 
              AND retry_count < max_retries
              AND next_retry_at <= NOW()
            ORDER BY created_at ASC
            LIMIT ?
        `;
        return this._query(query, [limit]);
    }

    /**
     * Get all pending messages
     * @param {number} limit - Maximum return count
     * @returns {Promise<Array>}
     */
    async getPendingMessages(limit = 100) {
        const query = `
            SELECT * FROM cross_chain_messages 
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT ?
        `;
        return this._query(query, [limit]);
    }

    /**
     * Get message statistics
     * @returns {Promise<Object>}
     */
    async getStats() {
        const query = `
            SELECT 
                status,
                COUNT(*) as count
            FROM cross_chain_messages
            GROUP BY status
        `;
        const result = await this._query(query);
        
        const stats = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            total: 0,
            withdraw: {
                pending: 0,
                processing: 0,
                completed: 0,
                failed: 0,
                total: 0,
            },
        };
        
        const messageRows = Array.isArray(result) ? result : (result?.rows || []);
        messageRows.forEach(row => {
            const count = parseInt(row.count, 10) || 0;
            if (stats[row.status] !== undefined) {
                stats[row.status] = count;
            }
            stats.total += count;
        });

        const wq = await this._query(`
            SELECT status, COUNT(*) AS count
            FROM seth_withdraw_requests
            GROUP BY status
        `);
        const withdrawRows = Array.isArray(wq) ? wq : (wq?.rows || []);
        withdrawRows.forEach(row => {
            const count = parseInt(row.count, 10) || 0;
            if (stats.withdraw[row.status] !== undefined) {
                stats.withdraw[row.status] = count;
            }
            stats.withdraw.total += count;
        });
        
        return stats;
    }

    // ==================== Relayer Status Operations ====================

    /**
     * Get relayer status
     * @returns {Promise<Object>}
     */
    async getRelayerStatus() {
        const query = 'SELECT * FROM relayer_status ORDER BY id DESC LIMIT 1';
        const rows = await this._query(query);
        return rows[0];
    }

    /**
     * Update relayer status
     * @param {Object} status - Status info
     */
    async updateRelayerStatus(status) {
        const query = `
            UPDATE relayer_status 
            SET last_processed_slot = COALESCE(?, last_processed_slot),
                last_processed_signature = COALESCE(?, last_processed_signature),
                relayer_address = COALESCE(?, relayer_address),
                updated_at = NOW()
            ORDER BY id ASC
            LIMIT 1
        `;
        await this._query(query, [
            status.lastProcessedSlot || null,
            status.lastProcessedSignature || null,
            status.relayerAddress || null
        ]);
    }

    /**
     * Set relayer active status
     * @param {boolean} isActive - Is active
     */
    async setRelayerActive(isActive) {
        const query = `
            UPDATE relayer_status 
            SET is_active = ?, updated_at = NOW()
            ORDER BY id ASC
            LIMIT 1
        `;
        await this._query(query, [isActive]);
    }

    async getSethSyncHeight(network, poolIndex) {
        const rows = await this._query(
            `SELECT * FROM seth_sync_heights WHERE network = ? AND pool_index = ? LIMIT 1`,
            [Number(network), Number(poolIndex)]
        );
        return rows[0] || null;
    }

    async upsertSethSyncHeight(network, poolIndex, nextHeight) {
        const query = `
            INSERT INTO seth_sync_heights (network, pool_index, next_height)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
                next_height = VALUES(next_height),
                updated_at = NOW()
        `;
        await this._query(query, [Number(network), Number(poolIndex), Number(nextHeight)]);
        return this.getSethSyncHeight(network, poolIndex);
    }

    // ==================== Operation Logs ====================

    /**
     * Log operation
     * @param {number} messageId - Message ID
     * @param {string} operation - Operation type
     * @param {Object} details - Operation details
     */
    async logOperation(messageId, operation, details = {}) {
        const query = `
            INSERT INTO operation_logs (message_id, operation, details)
            VALUES (?, ?, ?)
        `;
        await this._query(query, [messageId, operation, JSON.stringify(details)]);
    }

    /**
     * Get operation logs for a message
     * @param {number} messageId - Message ID
     * @returns {Promise<Array>}
     */
    async getOperationLogs(messageId) {
        const query = `
            SELECT * FROM operation_logs 
            WHERE message_id = ? 
            ORDER BY created_at DESC
        `;
        return this._query(query, [messageId]);
    }

    // ==================== Seth Reverse Withdraw Tracking ====================

    async logWithdrawOperation(withdrawId, operation, details = {}) {
        const query = `
            INSERT INTO withdraw_operation_logs (withdraw_id, operation, details)
            VALUES (?, ?, ?)
        `;
        await this._query(query, [withdrawId, operation, JSON.stringify(details)]);
    }

    async getSethWithdrawByRequestId(bridgeAddress, requestId) {
        const rows = await this._query(
            'SELECT * FROM seth_withdraw_requests WHERE bridge_address = ? AND request_id = ?',
            [bridgeAddress, requestId]
        );
        return rows[0] || null;
    }

    async upsertSethWithdrawRequest(bridgeAddress, requestId, req, status = 'pending') {
        const query = `
            INSERT INTO seth_withdraw_requests (
                bridge_address, request_id, user_address, solana_recipient, susdc_amount,
                created_at_onchain, onchain_processed, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                user_address = COALESCE(VALUES(user_address), user_address),
                solana_recipient = COALESCE(VALUES(solana_recipient), solana_recipient),
                susdc_amount = COALESCE(VALUES(susdc_amount), susdc_amount),
                created_at_onchain = COALESCE(VALUES(created_at_onchain), created_at_onchain),
                onchain_processed = VALUES(onchain_processed),
                status = VALUES(status),
                updated_at = NOW()
        `;
        const values = [
            bridgeAddress,
            requestId,
            req?.user || null,
            req?.solanaRecipient || null,
            req?.susdcAmount != null ? String(req.susdcAmount) : null,
            req?.createdAt != null ? Number(req.createdAt) : null,
            req?.processed === true,
            status,
        ];
        await this._query(query, values);
        return this.getSethWithdrawByRequestId(bridgeAddress, requestId);
    }

    async markSethWithdrawProcessing(bridgeAddress, requestId, req) {
        return this.upsertSethWithdrawRequest(bridgeAddress, requestId, req, 'processing');
    }

    async setSethWithdrawInitiatingTxHash(bridgeAddress, requestId, txHash) {
        const query = `
            UPDATE seth_withdraw_requests
            SET initiating_seth_tx_hash = COALESCE(?, initiating_seth_tx_hash),
                updated_at = NOW()
            WHERE bridge_address = ? AND request_id = ?
        `;
        await this._query(query, [txHash || null, bridgeAddress, requestId]);
        return this.getSethWithdrawByRequestId(bridgeAddress, requestId);
    }

    async markSethWithdrawCompleted(bridgeAddress, requestId, solanaUnlockTxSig, sethMarkProcessedTxHash) {
        const query = `
            UPDATE seth_withdraw_requests
            SET status = 'completed',
                solana_unlock_tx_sig = COALESCE(?, solana_unlock_tx_sig),
                seth_mark_processed_tx_hash = COALESCE(?, seth_mark_processed_tx_hash),
                last_error = NULL,
                next_retry_at = NULL,
                retry_count = 0,
                processed_at = NOW(),
                updated_at = NOW()
            WHERE bridge_address = ? AND request_id = ?
        `;
        await this._query(query, [
            solanaUnlockTxSig || null,
            sethMarkProcessedTxHash || null,
            bridgeAddress,
            requestId,
        ]);
        const row = await this.getSethWithdrawByRequestId(bridgeAddress, requestId);
        if (row) {
            await this.logWithdrawOperation(row.id, 'complete', {
                solana_unlock_tx_sig: solanaUnlockTxSig,
                seth_mark_processed_tx_hash: sethMarkProcessedTxHash,
            });
        }
        return row;
    }

    /**
     * Same backoff semantics as markAsFailed for cross_chain_messages.
     */
    async markSethWithdrawFailed(bridgeAddress, requestId, errorMessage, maxRetries = 5) {
        const query = `
            INSERT INTO seth_withdraw_requests (
                bridge_address, request_id, status, last_error, onchain_processed, max_retries,
                retry_count, next_retry_at
            )
            VALUES (
                ?, ?, 'pending', ?, false, ?, 1,
                DATE_ADD(NOW(), INTERVAL 1 MINUTE)
            )
            ON DUPLICATE KEY UPDATE
                status = CASE
                    WHEN onchain_processed = true THEN 'completed'
                    WHEN retry_count >= ? THEN 'failed'
                    ELSE 'pending'
                END,
                retry_count = CASE
                    WHEN onchain_processed = true THEN retry_count
                    ELSE retry_count + 1
                END,
                last_error = CASE
                    WHEN onchain_processed = true THEN last_error
                    ELSE VALUES(last_error)
                END,
                next_retry_at = CASE
                    WHEN onchain_processed = true THEN NULL
                    WHEN retry_count < ? THEN
                        DATE_ADD(NOW(), INTERVAL LEAST(POW(2, retry_count), 30) MINUTE)
                    ELSE NULL
                END,
                updated_at = NOW()
        `;
        await this._query(query, [
            bridgeAddress, requestId, errorMessage, maxRetries,
            maxRetries, maxRetries,
        ]);
        const row = await this.getSethWithdrawByRequestId(bridgeAddress, requestId);
        if (row) {
            await this.logWithdrawOperation(row.id, 'fail', {
                error: errorMessage,
                retryCount: row.retry_count,
                status: row.status,
            });
        }
        return row;
    }

    async getPendingWithdrawRetries(bridgeAddress, limit = 10) {
        const query = `
            SELECT * FROM seth_withdraw_requests
            WHERE bridge_address = ?
              AND status = 'pending'
              AND retry_count > 0
              AND retry_count < max_retries
              AND next_retry_at IS NOT NULL
              AND next_retry_at <= NOW()
              AND onchain_processed = false
            ORDER BY first_seen_at ASC
            LIMIT ?
        `;
        return this._query(query, [bridgeAddress, limit]);
    }

    /** @deprecated use markSethWithdrawFailed — kept for callers that only pass (id, err) */
    async markSethWithdrawQueryFailed(bridgeAddress, requestId, errorMessage) {
        return this.markSethWithdrawFailed(bridgeAddress, requestId, errorMessage);
    }

    // ==================== Batch Operations ====================

    /**
     * Batch insert messages (for recovery or initialization)
     * @param {Array} messages - Message array
     */
    async batchInsertMessages(messages) {
        const client = await this.pool.getConnection();
        try {
            await client.beginTransaction();
            
            for (const msg of messages) {
                await client.query(`
                    INSERT INTO cross_chain_messages (
                        solana_tx_sig, solana_tx_sig_bytes32, amount,
                        recipient_eth, sender_solana, solana_block_time, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE id = id
                `, [
                    msg.solanaTxSig,
                    msg.solanaTxSigBytes32,
                    msg.amount,
                    msg.recipientEth,
                    msg.senderSolana,
                    msg.solanaBlockTime,
                    msg.status || 'pending'
                ]);
            }
            
            await client.commit();
        } catch (error) {
            await client.rollback();
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Clean up old completed messages (archive)
     * @param {number} daysToKeep - Days to keep
     * @returns {Promise<number>} Number of deleted records
     */
    async archiveOldMessages(daysToKeep = 30) {
        const query = `
            DELETE FROM cross_chain_messages 
            WHERE status = 'completed' 
              AND processed_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `;
        const result = await this._query(query, [daysToKeep]);
        return result.affectedRows || 0;
    }
}

module.exports = Database;