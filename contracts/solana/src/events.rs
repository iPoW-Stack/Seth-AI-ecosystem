//! Event Definition Module

use anchor_lang::prelude::*;

// ==================== Bridge Events ====================

/// Referrer relationship set event
#[event]
pub struct ReferrerSet {
    pub user: Pubkey,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

/// Cross-chain completed event
#[event]
pub struct CrossChainCompleted {
    pub solana_tx_sig: Pubkey,
    pub seth_tx_hash: [u8; 32],
    pub ecosystem_amount: u64,
    pub timestamp: i64,
}

/// Relayer updated event
#[event]
pub struct RelayerUpdated {
    pub old_relayer: Pubkey,
    pub new_relayer: Pubkey,
}

// ==================== Revenue Events ====================

/// Revenue processed event (10-5-5-50-30 distribution)
#[event]
pub struct RevenueProcessed {
    pub user: Pubkey,
    pub amount: u64,
    pub commission_l1: u64,
    pub commission_l2: u64,
    pub team_funds: u64,
    pub project_funds: u64,
    pub ecosystem_funds: u64,
    pub l1_referrer: Option<Pubkey>,
    pub l2_referrer: Option<Pubkey>,
    pub product_type: u8,
    /// Seth recipient address (20 bytes EVM address)
    pub seth_recipient: [u8; 20],
    pub timestamp: i64,
}

/// Commission withdrawn event
#[event]
pub struct CommissionWithdrawn {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Monthly settlement event
#[event]
pub struct MonthlySettlement {
    pub team_funds: u64,
    pub project_funds: u64,
    pub timestamp: i64,
}