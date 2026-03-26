-- Cross-chain messages table
CREATE TABLE IF NOT EXISTS cross_chain_messages (
    id SERIAL PRIMARY KEY,
    solana_tx_sig VARCHAR(88) UNIQUE NOT NULL,  -- Solana transaction signature (base58, ~88 chars)
    solana_tx_sig_bytes32 VARCHAR(66) NOT NULL, -- Converted bytes32 format
    
    -- Message content
    original_amount BIGINT DEFAULT 0,            -- Original USDC amount
    amount BIGINT NOT NULL,                      -- Cross-chain amount (ecosystem funds 30%)
    team_funds BIGINT DEFAULT 0,                 -- Team funds (5%)
    commission_l1 BIGINT DEFAULT 0,              -- L1 commission (10%)
    commission_l2 BIGINT DEFAULT 0,              -- L2 commission (5%)
    project_funds BIGINT DEFAULT 0,              -- Project funds (50%)
    product_type INTEGER DEFAULT 0,              -- Product type (u8)
    recipient_eth VARCHAR(42) NOT NULL,          -- Seth recipient address
    sender_solana VARCHAR(44) NOT NULL,          -- Solana sender address
    
    -- Referrer info
    l1_referrer VARCHAR(44),                     -- L1 referrer address (Solana)
    l2_referrer VARCHAR(44),                     -- L2 referrer address (Solana)
    
    -- Status management
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    
    -- Seth chain transaction info
    seth_tx_hash VARCHAR(66),                    -- Seth chain transaction hash
    seth_block_number BIGINT,
    
    -- Timestamps
    solana_block_time BIGINT,                    -- Solana block time
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP,
    
    -- Index optimization fields
    next_retry_at TIMESTAMP                      -- Next retry time
);

-- Migration: Add new columns if they don't exist (run manually if needed)
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS original_amount BIGINT DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS team_funds BIGINT DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l1 BIGINT DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l2 BIGINT DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS project_funds BIGINT DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS product_type INTEGER DEFAULT 0;
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l1_referrer VARCHAR(44);
-- ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l2_referrer VARCHAR(44);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_status ON cross_chain_messages(status);
CREATE INDEX IF NOT EXISTS idx_solana_tx_sig ON cross_chain_messages(solana_tx_sig);
CREATE INDEX IF NOT EXISTS idx_next_retry ON cross_chain_messages(next_retry_at) 
    WHERE status = 'failed' AND retry_count < max_retries;
CREATE INDEX IF NOT EXISTS idx_created_at ON cross_chain_messages(created_at);

-- Relayer status table
CREATE TABLE IF NOT EXISTS relayer_status (
    id SERIAL PRIMARY KEY,
    relayer_address VARCHAR(42) NOT NULL,        -- Seth chain relayer address
    last_processed_slot BIGINT,                  -- Last processed Solana slot
    last_processed_signature VARCHAR(88),        -- Last processed transaction signature
    is_active BOOLEAN NOT NULL DEFAULT true,
    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Operation logs table
CREATE TABLE IF NOT EXISTS operation_logs (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES cross_chain_messages(id),
    operation VARCHAR(50) NOT NULL,              -- detect, process, retry, complete, fail
    details JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Update timestamp trigger
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

-- Insert initial relayer status
INSERT INTO relayer_status (relayer_address, is_active)
VALUES ('0x0000000000000000000000000000000000000000', true)
ON CONFLICT DO NOTHING;