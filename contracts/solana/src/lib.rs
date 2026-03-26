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
pub mod withdrawal;

// Re-export public interfaces
pub use constants::*;
pub use errors::*;
pub use events::*;
pub use state::*;
pub use bridge::*;
pub use revenue::*;
pub use withdrawal::*;

// Program ID (replace when deploying)
declare_id!("125eQs1s3SNxd5KFRpAJ6JvtVpD4tRYw6fWKomibQ8tc");

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

    /// Set Relayer
    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        handle_set_relayer(ctx, new_relayer)
    }

    /// Close user info account (returns rent to user)
    pub fn close_user_info(ctx: Context<CloseUserInfo>) -> Result<()> {
        handle_close_user_info(ctx)
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

    // ==================== Seth Withdrawal Instructions (Seth -> Solana) ====================

    /// Process Seth withdrawal - records withdrawal, deducts fee, and mints sUSDC
    /// Called by relayer when SwapExecuted event detected on Seth (isBuySETH=false)
    /// 
    /// Arguments:
    /// - seth_tx_hash: Seth transaction hash for replay protection
    /// - seth_user: Seth user address (20 bytes)
    /// - susdc_amount: Total sUSDC amount to mint (before fee deduction)
    /// - cross_chain_fee: Fee in sUSDC to compensate relayer for Solana gas
    /// 
    /// User receives: susdc_amount - cross_chain_fee
    /// Relayer receives: cross_chain_fee
    pub fn process_seth_withdrawal(
        ctx: Context<ProcessSethWithdrawal>,
        seth_tx_hash: [u8; 32],
        seth_user: [u8; 20],
        susdc_amount: u64,
        cross_chain_fee: u64,
    ) -> Result<()> {
        handle_process_seth_withdrawal(ctx, seth_tx_hash, seth_user, susdc_amount, cross_chain_fee)
    }
}
