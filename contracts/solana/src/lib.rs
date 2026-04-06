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
declare_id!("GmfLWKJuTgyaNvro91Vd8mwg8BXccgXS3jZ4WTjsAan5");

#[program]
pub mod seth_bridge {
    use super::*;

    // ==================== Bridge Instructions ====================

    /// Initialize bridge configuration
    pub fn initialize(ctx: Context<Initialize>, seth_treasury: Pubkey) -> Result<()> {
        handle_initialize(ctx, seth_treasury)
    }

    /// Initialize root user (owner) - creates first user without requiring referrer
    pub fn init_root_user(ctx: Context<InitRootUser>) -> Result<()> {
        handle_init_root_user(ctx)
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

    /// Relayer unlocks USDC on Solana for Seth->Solana bridge-back
    pub fn unlock_from_seth(
        ctx: Context<UnlockFromSeth>,
        bridge_address: [u8; 20],
        request_id: u64,
        amount: u64,
        seth_tx_hash: [u8; 32],
    ) -> Result<()> {
        handle_unlock_from_seth(ctx, bridge_address, request_id, amount, seth_tx_hash)
    }

    /// Set Relayer
    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        handle_set_relayer(ctx, new_relayer)
    }

    /// Close user info account (returns rent to user)
    pub fn close_user_info(ctx: Context<CloseUserInfo>) -> Result<()> {
        handle_close_user_info(ctx)
    }

    // ==================== Revenue Instructions ====================

    /// Process inbound revenue: 100% of amount goes to cross-chain ecosystem flow
    pub fn process_revenue(
        ctx: Context<ProcessRevenue>,
        amount: u64,
        seth_recipient: [u8; 20],
    ) -> Result<()> {
        handle_process_revenue(ctx, amount, seth_recipient)
    }

    /// Distribute commission to referrer
    pub fn distribute_commission(
        ctx: Context<DistributeCommission>,
        amount: u64,
    ) -> Result<()> {
        handle_distribute_commission(ctx, amount)
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