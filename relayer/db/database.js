const { Pool } = require('pg');

/**
 * 数据库操作类
 * 负责跨链消息的持久化存储和查询
 */
class Database {
    constructor(config) {
        this.pool = new Pool({
            host: config.host || 'localhost',
            port: config.port || 5432,
            database: config.database || 'bridge_relayer',
            user: config.user || 'postgres',
            password: config.password || '',
            max: config.maxConnections || 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        this.pool.on('error', (err) => {
            console.error('[DB] Unexpected error on idle client:', err.message);
        });
    }

    /**
     * 测试数据库连接
     */
    async testConnection() {
        try {
            const client = await this.pool.connect();
            const result = await client.query('SELECT NOW()');
            client.release();
            console.log('[DB] Connected successfully at:', result.rows[0].now);
            return true;
        } catch (error) {
            console.error('[DB] Connection failed:', error.message);
            return false;
        }
    }

    /**
     * 关闭数据库连接池
     */
    async close() {
        await this.pool.end();
        console.log('[DB] Connection pool closed');
    }

    // ==================== 跨链消息操作 ====================

    /**
     * 插入新的跨链消息
     * @param {Object} message - 消息数据
     * @returns {Promise<Object>} 插入的记录
     */
    async insertMessage(message) {
        const query = `
            INSERT INTO cross_chain_messages (
                solana_tx_sig, solana_tx_sig_bytes32, amount, 
                recipient_eth, sender_solana, solana_block_time, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (solana_tx_sig) DO NOTHING
            RETURNING *
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

        const result = await this.pool.query(query, values);
        return result.rows[0];
    }

    /**
     * 根据Solana交易签名查询消息
     * @param {string} solanaTxSig - Solana交易签名
     * @returns {Promise<Object|null>}
     */
    async getMessageBySig(solanaTxSig) {
        const query = 'SELECT * FROM cross_chain_messages WHERE solana_tx_sig = $1';
        const result = await this.pool.query(query, [solanaTxSig]);
        return result.rows[0] || null;
    }

    /**
     * 检查消息是否已处理
     * @param {string} solanaTxSig - Solana交易签名
     * @returns {Promise<boolean>}
     */
    async isProcessed(solanaTxSig) {
        const query = `
            SELECT status FROM cross_chain_messages 
            WHERE solana_tx_sig = $1 AND status = 'completed'
        `;
        const result = await this.pool.query(query, [solanaTxSig]);
        return result.rows.length > 0;
    }

    /**
     * 更新消息状态为处理中
     * @param {number} messageId - 消息ID
     * @returns {Promise<void>}
     */
    async markAsProcessing(messageId) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = 'processing', updated_at = NOW()
            WHERE id = $1 AND status IN ('pending', 'failed')
        `;
        await this.pool.query(query, [messageId]);
    }

    /**
     * 更新消息状态为完成
     * @param {number} messageId - 消息ID
     * @param {Object} txInfo - Seth交易信息
     */
    async markAsCompleted(messageId, txInfo) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = 'completed', 
                seth_tx_hash = $2, 
                seth_block_number = $3,
                processed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
        `;
        await this.pool.query(query, [
            messageId, 
            txInfo.txHash, 
            txInfo.blockNumber
        ]);
        
        await this.logOperation(messageId, 'complete', { txInfo });
    }

    /**
     * 更新消息状态为失败
     * @param {number} messageId - 消息ID
     * @param {string} error - 错误信息
     * @param {number} maxRetries - 最大重试次数
     */
    async markAsFailed(messageId, error, maxRetries = 5) {
        const query = `
            UPDATE cross_chain_messages 
            SET status = CASE WHEN retry_count >= $3 THEN 'failed' ELSE 'pending' END,
                retry_count = retry_count + 1,
                last_error = $2,
                next_retry_at = CASE 
                    WHEN retry_count < $3 THEN NOW() + INTERVAL '1 minute' * LEAST(POWER(2, retry_count), 30)
                    ELSE NULL 
                END,
                updated_at = NOW()
            WHERE id = $1
            RETURNING retry_count, status
        `;
        const result = await this.pool.query(query, [messageId, error, maxRetries]);
        
        if (result.rows[0]) {
            await this.logOperation(messageId, 'fail', { 
                error, 
                retryCount: result.rows[0].retry_count 
            });
        }
        
        return result.rows[0];
    }

    /**
     * 获取待重试的失败消息
     * @param {number} limit - 最大返回数量
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
            LIMIT $1
        `;
        const result = await this.pool.query(query, [limit]);
        return result.rows;
    }

    /**
     * 获取所有待处理消息
     * @param {number} limit - 最大返回数量
     * @returns {Promise<Array>}
     */
    async getPendingMessages(limit = 100) {
        const query = `
            SELECT * FROM cross_chain_messages 
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT $1
        `;
        const result = await this.pool.query(query, [limit]);
        return result.rows;
    }

    /**
     * 获取消息统计信息
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
        const result = await this.pool.query(query);
        
        const stats = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            total: 0
        };
        
        result.rows.forEach(row => {
            stats[row.status] = parseInt(row.count);
            stats.total += parseInt(row.count);
        });
        
        return stats;
    }

    // ==================== Relayer状态操作 ====================

    /**
     * 获取Relayer状态
     * @returns {Promise<Object>}
     */
    async getRelayerStatus() {
        const query = 'SELECT * FROM relayer_status ORDER BY id DESC LIMIT 1';
        const result = await this.pool.query(query);
        return result.rows[0];
    }

    /**
     * 更新Relayer状态
     * @param {Object} status - 状态信息
     */
    async updateRelayerStatus(status) {
        const query = `
            UPDATE relayer_status 
            SET last_processed_slot = COALESCE($2, last_processed_slot),
                last_processed_signature = COALESCE($3, last_processed_signature),
                relayer_address = COALESCE($4, relayer_address),
                updated_at = NOW()
            WHERE id = (SELECT MIN(id) FROM relayer_status)
        `;
        await this.pool.query(query, [
            null, // id placeholder
            status.lastProcessedSlot || null,
            status.lastProcessedSignature || null,
            status.relayerAddress || null
        ]);
    }

    /**
     * 设置Relayer活跃状态
     * @param {boolean} isActive - 是否活跃
     */
    async setRelayerActive(isActive) {
        const query = `
            UPDATE relayer_status 
            SET is_active = $1, updated_at = NOW()
            WHERE id = (SELECT MIN(id) FROM relayer_status)
        `;
        await this.pool.query(query, [isActive]);
    }

    // ==================== 操作日志 ====================

    /**
     * 记录操作日志
     * @param {number} messageId - 消息ID
     * @param {string} operation - 操作类型
     * @param {Object} details - 操作详情
     */
    async logOperation(messageId, operation, details = {}) {
        const query = `
            INSERT INTO operation_logs (message_id, operation, details)
            VALUES ($1, $2, $3)
        `;
        await this.pool.query(query, [messageId, operation, JSON.stringify(details)]);
    }

    /**
     * 获取消息的操作日志
     * @param {number} messageId - 消息ID
     * @returns {Promise<Array>}
     */
    async getOperationLogs(messageId) {
        const query = `
            SELECT * FROM operation_logs 
            WHERE message_id = $1 
            ORDER BY created_at DESC
        `;
        const result = await this.pool.query(query, [messageId]);
        return result.rows;
    }

    // ==================== 批量操作 ====================

    /**
     * 批量插入消息（用于恢复或初始化）
     * @param {Array} messages - 消息数组
     */
    async batchInsertMessages(messages) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            for (const msg of messages) {
                await client.query(`
                    INSERT INTO cross_chain_messages (
                        solana_tx_sig, solana_tx_sig_bytes32, amount, 
                        recipient_eth, sender_solana, solana_block_time, status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (solana_tx_sig) DO NOTHING
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
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * 清理旧的已完成消息（归档）
     * @param {number} daysToKeep - 保留天数
     * @returns {Promise<number>} 删除的记录数
     */
    async archiveOldMessages(daysToKeep = 30) {
        const query = `
            DELETE FROM cross_chain_messages 
            WHERE status = 'completed' 
              AND processed_at < NOW() - INTERVAL '1 day' * $1
            RETURNING id
        `;
        const result = await this.pool.query(query, [daysToKeep]);
        return result.rows.length;
    }
}

module.exports = Database;