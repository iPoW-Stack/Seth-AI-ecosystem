//! State Data Structure Module

use anchor_lang::prelude::*;

// ==================== Global Configuration ====================

/// Global configuration account
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Administrator
    pub owner: Pubkey,
    
    /// Seth chain Treasury address
    pub seth_treasury: Pubkey,
    
    /// Team wallet (5%)
    pub team_wallet: Pubkey,
    
    /// Project wallet (45%)
    pub project_wallet: Pubkey,
    
    /// Vault PDA authority
    pub vault_authority: Pubkey,
    
    /// Trusted Relayer
    pub relayer: Pubkey,
    
    /// PDA bump
    pub bump: u8,
    
    // ===== Statistics =====
    
    /// Total revenue
    pub total_revenue: u64,
    
    /// Total commission distributed
    pub total_commission_distributed: u64,
    
    /// Total cross-chain ecosystem funds
    pub total_ecosystem_transferred: u64,
    
    // ===== Pending Settlement Funds =====
    
    /// Pending team incentive
    pub pending_team_funds: u64,
    
    /// Pending project reserve
    pub pending_project_funds: u64,
    
    /// Last settlement timestamp
    pub last_settlement_timestamp: i64,
}

// ==================== Vault ====================

/// Vault authority account
#[account]
#[derive(InitSpace)]
pub struct VaultAuthority {
    pub bump: u8,
}

// ==================== User Related ====================

/// User info account (105 bytes - matching existing on-chain data)
#[account]
#[derive(InitSpace)]
pub struct UserInfo {
    /// User address
    pub user: Pubkey,
    
    /// L1 referrer (direct referrer)
    pub referrer: Pubkey,
    
    /// Is registered
    pub is_registered: bool,
    
    /// Total transaction volume
    pub total_volume: u64,
    
    /// Total commission earned
    pub total_commission_earned: u64,
    
    /// Pending commission to withdraw
    pub pending_commission: u64,
    
    /// Registration timestamp
    pub created_at: i64,
}

// ==================== Cross-Chain Message ====================

/// Cross-chain message status
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CrossChainStatus {
    Pending,
    Completed,
    Failed,
}

/// Cross-chain message account
#[account]
#[derive(InitSpace)]
pub struct CrossChainMessage {
    /// Sender
    pub sender: Pubkey,
    
    /// Original amount
    pub original_amount: u64,
    
    /// Cross-chain amount (ecosystem funds 30%)
    pub amount: u64,
    
    /// Team funds (5%) - for cross-chain to TeamPayroll
    pub team_funds: u64,
    
    /// Seth chain recipient address
    pub seth_recipient: [u8; 20],
    
    // ===== Distribution Details =====
    
    /// L1 commission
    pub commission_l1: u64,
    
    /// L2 commission
    pub commission_l2: u64,
    
    /// Project funds (50%) - already distributed locally
    pub project_funds: u64,
    
    /// Product type
    pub product_type: u8,
    
    /// L1 referrer
    pub l1_referrer: Option<Pubkey>,
    
    /// L2 referrer
    pub l2_referrer: Option<Pubkey>,
    
    /// Status
    pub status: CrossChainStatus,
    
    /// Seth chain transaction hash
    pub seth_tx_hash: [u8; 32],
    
    /// Created timestamp
    pub created_at: i64,
    
    /// Processed timestamp
    pub processed_at: i64,
}
