-- Migration: Add missing columns to cross_chain_messages table
-- Run this if the table was created with an older schema

-- Add team_funds column
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS team_funds BIGINT DEFAULT 0;

-- Add original_amount column
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS original_amount BIGINT DEFAULT 0;

-- Add commission columns
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l1 BIGINT DEFAULT 0;
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS commission_l2 BIGINT DEFAULT 0;

-- Add project_funds column
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS project_funds BIGINT DEFAULT 0;

-- Add product_type column
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS product_type INTEGER DEFAULT 0;

-- Add referrer columns
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l1_referrer VARCHAR(44);
ALTER TABLE cross_chain_messages ADD COLUMN IF NOT EXISTS l2_referrer VARCHAR(44);