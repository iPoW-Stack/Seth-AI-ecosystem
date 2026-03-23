-- Migration: Add new fields to cross_chain_messages table
-- Run this script to update existing database with new columns
-- 
-- Usage:
--   psql -U postgres -d your_database -f migrate-add-fields.sql
--
-- Or using environment variables from .env:
--   set PGPASSWORD=your_password
--   psql -U your_user -h localhost -d your_database -f migrate-add-fields.sql

-- Add original_amount column (original USDC amount before distribution)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS original_amount BIGINT DEFAULT 0;

-- Add team_funds column (5% team funds)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS team_funds BIGINT DEFAULT 0;

-- Add commission_l1 column (10% L1 referrer commission)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l1 BIGINT DEFAULT 0;

-- Add commission_l2 column (5% L2 referrer commission)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l2 BIGINT DEFAULT 0;

-- Add project_funds column (50% project funds)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS project_funds BIGINT DEFAULT 0;

-- Add product_type column (u8)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS product_type INTEGER DEFAULT 0;

-- Add l1_referrer column (L1 referrer Solana address)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l1_referrer VARCHAR(44);

-- Add l2_referrer column (L2 referrer Solana address)
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l2_referrer VARCHAR(44);

-- Verify migration
SELECT column_name, data_type, is_nullable, column_default 
FROM information_schema.columns 
WHERE table_name = 'cross_chain_messages' 
ORDER BY ordinal_position;