const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * Database Operations Class
 * Responsible for persistent storage and querying of cross-chain messages
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
        
        this.initialized = false;
    }

    /**
     * Test database connection
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
     * Check if a table exists
     * @param {string} tableName - Table name to check
     * @returns {Promise<boolean>}
     */
    async tableExists(tableName) {
        const query = `
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1
            )
        `;
        const result = await this.pool.query(query, [tableName]);
        return result.rows[0].exists;
    }

    /**
     * Run database migrations - create tables if they don't exist
     * This is called automatically on first startup
     */
    async runMigrations() {
        console.log('[DB] Checking database schema...');
        
        try {
            // Check if main tables exist
            const messagesTableExists = await this.tableExists('cross_chain_messages');
            const relayerStatusExists = await this.tableExists('relayer_status');
            const logsTableExists = await this.tableExists('operation_logs');
            
            if (messagesTableExists && relayerStatusExists && logsTableExists) {
                console.log('[DB] Database schema already exists, skipping migration');
                this.initialized = true;
                return true;
            }
            
            console.log('[DB] Running database migrations...');
            
            // Read and execute init.sql
            const initSqlPath = path.join(__dirname, 'init.sql');
            
            if (!fs.existsSync(initSqlPath)) {
                console.error('[DB] init.sql not found, creating tables programmatically');
                await this.createTablesProgrammatically();
            } else {
                const sql = fs.readFileSync(initSqlPath, 'utf8');
                await this.pool.query(sql);
                console.log('[DB] Database schema created from init.sql');
            }
            
            this.initialized = true;
            console.log('[DB] Database migrations completed successfully');
            return true;
            
        } catch (error) {
            console.error('[DB] Migration failed:', error.message);
            
            // Try programmatic creation as fallback
            try {
                await this.createTablesProgrammatically();
                this.initialized = true;
                console.log('[DB] Tables created programmatically as fallback');
                return true;
            } catch (fallbackError) {
                console.error('[DB] Fallback table creation also failed:', fallbackError.message);
                return false;
            }
        }
    }

    /**
     * Create tables programmatically (fallback if init.sql is not available)
     */
    async createTablesProgrammatically() {
        // Create cross_chain_messages table
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS cross_chain_messages (
                id SERIAL PRIMARY KEY,
                solana_tx_sig VARCHAR(88) NOT NULL UNIQUE,
                solana_tx_sig_bytes32 VARCHAR(66) NOT NULL,
                sender_solana VARCHAR(50),
                amount NUMERIC(78, 0) NOT NULL,
                team_funds NUMERIC(78, 0) DEFAULT 0,
                recipient_eth VARCHAR(42) NOT NULL,
                solana_block_time BIGINT,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                seth_tx_hash VARCHAR(66),
                seth_block_number BIGINT,
                retry_count INTEGER DEFAULT 0,
                max_retries INTEGER DEFAULT 5,
                next_retry_at TIMESTAMP,
                last_error TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                processed_at TIMESTAMP,
                CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
            )
        `);
        
        // Create indexes for cross_chain_messages
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_status ON cross_chain_messages(status)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_created_at ON cross_chain_messages(created_at)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_solana_tx_sig ON cross_chain_messages(solana_tx_sig)`);
        
        // Create relayer_status table
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS relayer_status (
                id SERIAL PRIMARY KEY,
                relayer_address VARCHAR(42),
                last_processed_slot BIGINT,
                last_processed_signature VARCHAR(88),
                is_active BOOLEAN DEFAULT FALSE,
                started_at TIMESTAMP,
                last_heartbeat TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Insert default relayer status if not exists
        await this.pool.query(`
            INSERT INTO relayer_status (is_active) 
            SELECT FALSE 
            WHERE NOT EXISTS (SELECT 1 FROM relayer_status)
        `);
        
        // Create operation_logs table
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS operation_logs (
                id SERIAL PRIMARY KEY,
                message_id INTEGER REFERENCES cross_chain_messages(id),
                operation VARCHAR(50) NOT NULL,
                details JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        
        // Create indexes for operation_logs
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_message_id ON operation_logs(message_id)`);
        await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_operation ON operation_logs(operation)`);
        
        // Create update timestamp trigger function
        await this.pool.query(`
            CREATE OR REPLACE FUNCTION update_timestamp()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);
        
        // Apply triggers (drop if exists first to avoid errors)
        await this.pool.query(`
            DROP TRIGGER IF EXISTS update_messages_timestamp ON cross_chain_messages
        `);
        await this.pool.query(`
            CREATE TRIGGER update_messages_timestamp
                BEFORE UPDATE ON cross_chain_messages
                FOR EACH ROW
                EXECUTE FUNCTION update_timestamp()
        `);
        
        await this.pool.query(`
            DROP TRIGGER IF EXISTS update_relayer_timestamp ON relayer_status
        `);
        await this.pool.query(`
            CREATE TRIGGER update_relayer_timestamp
                BEFORE UPDATE ON relayer_status
                FOR EACH ROW
                EXECUTE FUNCTION update_timestamp()
        `);
        
        console.log('[DB] All tables and indexes created successfully');
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
            throw new Error('Database migration failed');
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
                solana_tx_sig, solana_tx_sig_bytes32, amount, team_funds,
                recipient_eth, sender_solana, solana_block_time, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (solana_tx_sig) DO NOTHING
            RETURNING *
        `;
        
        const values = [
            message.solanaTxSig,
            message.solanaTxSigBytes32,
            message.amount,
            message.teamFunds || 0,
            message.recipientEth,
            message.senderSolana,
            message.solanaBlockTime,
            'pending'
        ];

        const result = await this.pool.query(query, values);
        return result.rows[0];
    }

    /**
     * Get message by Solana transaction signature
     * @param {string} solanaTxSig - Solana transaction signature
     * @returns {Promise<Object|null>}
     */
    async getMessageBySig(solanaTxSig) {
        const query = 'SELECT * FROM cross_chain_messages WHERE solana_tx_sig = $1';
        const result = await this.pool.query(query, [solanaTxSig]);
        return result.rows[0] || null;
    }

    /**
     * Check if message has been processed
     * @param {string} solanaTxSig - Solana transaction signature
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
     * Update message status to processing
     * @param {number} messageId - Message ID
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
     * Update message status to completed
     * @param {number} messageId - Message ID
     * @param {Object} txInfo - Seth transaction info
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
     * Update message status to failed
     * @param {number} messageId - Message ID
     * @param {string} error - Error message
     * @param {number} maxRetries - Maximum retry count
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
            LIMIT $1
        `;
        const result = await this.pool.query(query, [limit]);
        return result.rows;
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
            LIMIT $1
        `;
        const result = await this.pool.query(query, [limit]);
        return result.rows;
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

    // ==================== Relayer Status Operations ====================

    /**
     * Get relayer status
     * @returns {Promise<Object>}
     */
    async getRelayerStatus() {
        const query = 'SELECT * FROM relayer_status ORDER BY id DESC LIMIT 1';
        const result = await this.pool.query(query);
        return result.rows[0];
    }

    /**
     * Update relayer status
     * @param {Object} status - Status info
     */
    async updateRelayerStatus(status) {
        const query = `
            UPDATE relayer_status 
            SET last_processed_slot = COALESCE($1, last_processed_slot),
                last_processed_signature = COALESCE($2, last_processed_signature),
                relayer_address = COALESCE($3, relayer_address),
                updated_at = NOW()
            WHERE id = (SELECT MIN(id) FROM relayer_status)
        `;
        await this.pool.query(query, [
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
            SET is_active = $1, updated_at = NOW()
            WHERE id = (SELECT MIN(id) FROM relayer_status)
        `;
        await this.pool.query(query, [isActive]);
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
            VALUES ($1, $2, $3)
        `;
        await this.pool.query(query, [messageId, operation, JSON.stringify(details)]);
    }

    /**
     * Get operation logs for a message
     * @param {number} messageId - Message ID
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

    // ==================== Batch Operations ====================

    /**
     * Batch insert messages (for recovery or initialization)
     * @param {Array} messages - Message array
     */
    async batchInsertMessages(messages) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            for (const msg of messages) {
                await client.query(`
                    INSERT INTO cross_chain_messages (
                        solana_tx_sig, solana_tx_sig_bytes32, amount, team_funds,
                        recipient_eth, sender_solana, solana_block_time, status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (solana_tx_sig) DO NOTHING
                `, [
                    msg.solanaTxSig,
                    msg.solanaTxSigBytes32,
                    msg.amount,
                    msg.teamFunds || 0,
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
     * Clean up old completed messages (archive)
     * @param {number} daysToKeep - Days to keep
     * @returns {Promise<number>} Number of deleted records
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