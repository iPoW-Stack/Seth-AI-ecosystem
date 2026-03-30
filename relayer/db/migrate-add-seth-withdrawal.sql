-- Migration: Add Seth withdrawal messages table (Seth -> Solana)
-- This table stores withdrawal messages from Seth chain that need to be processed on Solana

-- Seth withdrawal messages table
CREATE TABLE IF NOT EXISTS seth_withdrawal_messages (
    id SERIAL PRIMARY KEY,
    seth_tx_hash VARCHAR(66) UNIQUE NOT NULL,     -- Seth transaction hash (bytes32 hex)
    
    -- Message content
    seth_user VARCHAR(42) NOT NULL,               -- Seth user address (0x...)
    solana_recipient VARCHAR(44) NOT NULL,        -- Solana recipient address
    susdc_amount BIGINT NOT NULL,                 -- sUSDC amount to swap
    min_usdc_out BIGINT DEFAULT 0,                -- Minimum USDC output (slippage protection)
    actual_usdc_out BIGINT,                       -- Actual USDC output after swap
    
    -- Original swap data from Seth
    seth_amount_in BIGINT NOT NULL,               -- Original SETH amount sold
    seth_price BIGINT,                            -- Price at time of swap
    seth_block_timestamp BIGINT,                  -- Seth block timestamp
    
    -- Status management
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    last_error TEXT,
    
    -- Solana transaction info
    solana_tx_sig VARCHAR(88),                    -- Solana transaction signature
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP,
    
    -- Index optimization fields
    next_retry_at TIMESTAMP                       -- Next retry time
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_seth_withdrawal_status ON seth_withdrawal_messages(status);
CREATE INDEX IF NOT EXISTS idx_seth_tx_hash ON seth_withdrawal_messages(seth_tx_hash);
CREATE INDEX IF NOT EXISTS idx_seth_withdrawal_next_retry ON seth_withdrawal_messages(next_retry_at) 
    WHERE status = 'failed' AND retry_count < max_retries;
CREATE INDEX IF NOT EXISTS idx_seth_withdrawal_created_at ON seth_withdrawal_messages(created_at);

-- Update timestamp trigger for new table
CREATE TRIGGER update_seth_withdrawal_messages_updated_at
    BEFORE UPDATE ON seth_withdrawal_messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Add column to relayer_status for tracking last processed Seth block
ALTER TABLE relayer_status ADD COLUMN IF NOT EXISTS last_seth_block BIGINT DEFAULT 0;
ALTER TABLE relayer_status ADD COLUMN IF NOT EXISTS last_seth_tx_hash VARCHAR(66);