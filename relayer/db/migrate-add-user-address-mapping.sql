-- Migration: Add user address mapping table (Seth <-> Solana)
-- This table stores the mapping between Seth addresses and Solana addresses for cross-chain withdrawals

-- User address mapping table
CREATE TABLE IF NOT EXISTS user_address_mapping (
    id SERIAL PRIMARY KEY,
    seth_address VARCHAR(42) UNIQUE NOT NULL,     -- Seth address (0x... format)
    solana_address VARCHAR(44) NOT NULL,          -- Solana address (base58 format)
    
    -- Metadata
    registered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMP,
    
    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    
    -- Optional: signature verification
    signature TEXT,                                -- Signature proving ownership
    
    -- Statistics
    total_withdrawals INTEGER DEFAULT 0,
    total_withdrawn_amount BIGINT DEFAULT 0
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_user_mapping_seth ON user_address_mapping(seth_address);
CREATE INDEX IF NOT EXISTS idx_user_mapping_solana ON user_address_mapping(solana_address);
CREATE INDEX IF NOT EXISTS idx_user_mapping_active ON user_address_mapping(is_active) WHERE is_active = true;

-- Update timestamp trigger
CREATE TRIGGER update_user_address_mapping_updated_at
    BEFORE UPDATE ON user_address_mapping
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Comments
COMMENT ON TABLE user_address_mapping IS 'Maps Seth addresses to Solana addresses for cross-chain withdrawals';
COMMENT ON COLUMN user_address_mapping.seth_address IS 'Seth chain address (EVM format)';
COMMENT ON COLUMN user_address_mapping.solana_address IS 'Solana chain address (base58 format)';
COMMENT ON COLUMN user_address_mapping.signature IS 'Optional signature proving address ownership';
