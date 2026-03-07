//! Seth-Solana Cross-Chain Bridge
//! 
//! Based on TrustRelayer security model

use anchor_lang::prelude::*;

// Module declarations
pub mod constants;
pub mod errors;
pub mod events;
pub mod state;
pub mod bridge;
pub mod revenue;

// Re-export public interfaces
pub use constants::*;
pub use errors::*;
pub use events::*;
pub use state::*;
pub use bridge::*;
pub use revenue::*;

// Program ID (replace when deploying)
declare_id!("5V3anofFhgpB9D8Uc72JDHg1VVH8qxJJrtaEMMxS4kmw");

#[program]
pub mod seth_bridge {
    use super::*;

    // ==================== Bridge Instructions ====================

    /// Initialize bridge configuration
    pub fn initialize(ctx: Context<Initialize>, seth_treasury: Pubkey) -> Result<()> {
        handle_initialize(ctx, seth_treasury)
    }

    /// Set referrer relationship
    pub fn set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
        handle_set_referrer(ctx, referrer)
    }

    /// Relayer marks cross-chain completed
    pub fn mark_cross_chain_completed(
        ctx: Context<MarkCrossChainCompleted>,
        seth_tx_hash: [u8; 32],
    ) -> Result<()> {
        handle_mark_cross_chain_completed(ctx, seth_tx_hash)
    }

    /// Set Relayer
    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        handle_set_relayer(ctx, new_relayer)
    }

    // ==================== Revenue Instructions ====================

    /// Process revenue and execute 15-50-35 distribution
    pub fn process_revenue(
        ctx: Context<ProcessRevenue>,
        amount: u64,
        product_type: u8,
        seth_recipient: [u8; 20],
    ) -> Result<()> {
        handle_process_revenue(ctx, amount, product_type, seth_recipient)
    }

    /// User withdraws commission
    pub fn withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
        handle_withdraw_commission(ctx)
    }

    /// Manually trigger monthly settlement
    pub fn trigger_settlement(ctx: Context<TriggerSettlement>) -> Result<()> {
        handle_trigger_settlement(ctx)
    }
}