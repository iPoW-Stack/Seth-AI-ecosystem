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

/// sUSDC vault setup event
#[event]
pub struct SusdcVaultSetup {
    pub owner: Pubkey,
    pub susdc_mint: Pubkey,
    pub vault_susdc_token_account: Pubkey,
    pub timestamp: i64,
}

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

/// Revenue processed with sUSDC event (for DIRM swap flow)
#[event]
pub struct RevenueProcessedWithSusdc {
    pub user: Pubkey,
    /// Original total USDC amount (100%)
    pub original_amount: u64,
    /// USDC amount kept on Solana (65%: commissions + project)
    pub usdc_amount: u64,
    /// sUSDC amount for cross-chain (from DIRM swap)
    pub susdc_amount: u64,
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

// ==================== Seth Withdrawal Events ====================

/// Seth withdrawal processed event (Seth -> Solana)
#[event]
pub struct SethWithdrawalProcessed {
    /// Seth transaction hash
    pub seth_tx_hash: [u8; 32],
    /// Seth user address
    pub seth_user: [u8; 20],
    /// Solana recipient
    pub solana_recipient: Pubkey,
    /// sUSDC amount swapped
    pub susdc_amount: u64,
    /// USDC amount received
    pub usdc_amount: u64,
    /// Timestamp
    pub timestamp: i64,
}
