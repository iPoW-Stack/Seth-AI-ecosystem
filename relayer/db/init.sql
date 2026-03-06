-- 跨链消息表
CREATE TABLE IF NOT EXISTS cross_chain_messages (
    id SERIAL PRIMARY KEY,
    solana_tx_sig VARCHAR(88) UNIQUE NOT NULL,  -- Solana交易签名(base58, 约88字符)
    solana_tx_sig_bytes32 VARCHAR(66) NOT NULL, -- 转换后的bytes32格式
    
    -- 消息内容
    amount BIGINT NOT NULL,                      -- 跨链金额
    recipient_eth VARCHAR(42) NOT NULL,          -- Seth接收地址
    sender_solana VARCHAR(44) NOT NULL,          -- Solana发送者地址
    
    -- 状态管理
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    
    -- Seth链交易信息
    seth_tx_hash VARCHAR(66),                    -- Seth链交易哈希
    seth_block_number BIGINT,
    
    -- 时间戳
    solana_block_time BIGINT,                    -- Solana区块时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP,
    
    -- 索引优化字段
    next_retry_at TIMESTAMP                      -- 下次重试时间
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_status ON cross_chain_messages(status);
CREATE INDEX IF NOT EXISTS idx_solana_tx_sig ON cross_chain_messages(solana_tx_sig);
CREATE INDEX IF NOT EXISTS idx_next_retry ON cross_chain_messages(next_retry_at) 
    WHERE status = 'failed' AND retry_count < max_retries;
CREATE INDEX IF NOT EXISTS idx_created_at ON cross_chain_messages(created_at);

-- Relayer运行状态表
CREATE TABLE IF NOT EXISTS relayer_status (
    id SERIAL PRIMARY KEY,
    relayer_address VARCHAR(42) NOT NULL,        -- Seth链relayer地址
    last_processed_slot BIGINT,                  -- 最后处理的Solana slot
    last_processed_signature VARCHAR(88),        -- 最后处理的交易签名
    is_active BOOLEAN NOT NULL DEFAULT true,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 操作日志表
CREATE TABLE IF NOT EXISTS operation_logs (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES cross_chain_messages(id),
    operation VARCHAR(50) NOT NULL,              -- detect, process, retry, complete, fail
    details JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 更新时间触发器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_cross_chain_messages_updated_at
    BEFORE UPDATE ON cross_chain_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_relayer_status_updated_at
    BEFORE UPDATE ON relayer_status
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 插入初始relayer状态
INSERT INTO relayer_status (relayer_address, is_active)
VALUES ('0x0000000000000000000000000000000000000000', true)
ON CONFLICT DO NOTHING;