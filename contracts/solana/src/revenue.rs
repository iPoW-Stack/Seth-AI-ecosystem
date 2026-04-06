//! Revenue Module - Handles revenue distribution logic
//! 
//! Features:
//! - Revenue processing and distribution
//! - Commission distribution (separate instruction)
//! - Commission withdrawal

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    Config, VaultAuthority, UserInfo, CrossChainMessage, CrossChainStatus,
    BASIS_POINTS, INBOUND_ECOSYSTEM_RATE,
};
use crate::{BridgeError};
use crate::{RevenueProcessed, CommissionWithdrawn, MonthlySettlement};
use crate::bridge::transfer_from_vault;

// ==================== Revenue Processing ====================

/// Process revenue and execute inbound distribution.
/// Current model: 100% of `amount` becomes cross-chain ecosystem funds.
#[derive(Accounts)]
#[instruction(amount: u64, seth_recipient: [u8; 20])]
pub struct ProcessRevenue<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    /// User USDC account
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    
    /// Vault USDC account
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Vault authority
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// Global configuration
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    /// Cross-chain message record
    #[account(
        init,
        payer = user,
        space = 8 + CrossChainMessage::INIT_SPACE,
        seeds = [b"cross_chain_msg", user.key().as_ref(), &config.total_revenue.to_le_bytes()],
        bump
    )]
    pub cross_chain_message: Account<'info, CrossChainMessage>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Process revenue distribution logic.
/// Inbound simplification:
/// - No L1/L2 referral split
/// - No project-reserve transfer
/// - `ecosystem_funds == amount`
pub fn handle_process_revenue(
    ctx: Context<ProcessRevenue>,
    amount: u64,
    seth_recipient: [u8; 20],
) -> Result<()> {
    require!(amount > 0, BridgeError::ZeroAmount);

    // 1. Transfer USDC from user to Vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    // 2. Full passthrough to cross-chain ecosystem amount.
    let ecosystem_funds = (amount * INBOUND_ECOSYSTEM_RATE) / BASIS_POINTS;
    
    // 3. Record cross-chain message (100% ecosystem).
    let cross_chain_msg = &mut ctx.accounts.cross_chain_message;
    cross_chain_msg.sender = ctx.accounts.user.key();
    cross_chain_msg.amount = ecosystem_funds;
    cross_chain_msg.original_amount = amount;
    cross_chain_msg.seth_recipient = seth_recipient;
    cross_chain_msg.status = CrossChainStatus::Pending;
    cross_chain_msg.created_at = Clock::get()?.unix_timestamp;

    // 4. Update statistics
    ctx.accounts.config.total_revenue += amount;

    // 5. Emit event
    emit!(RevenueProcessed {
        user: ctx.accounts.user.key(),
        amount,
        ecosystem_funds,
        seth_recipient,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== Commission Distribution ====================

/// Distribute commission to referrer
#[derive(Accounts)]
pub struct DistributeCommission<'info> {
    pub user: Signer<'info>,
    
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// Referrer user info
    #[account(
        mut,
        seeds = [b"user_info", referrer.key().as_ref()],
        bump
    )]
    pub referrer_info: Account<'info, UserInfo>,
    
    /// CHECK: Referrer address - only used for PDA derivation, verified by referrer_info seed constraint
    pub referrer: AccountInfo<'info>,
    
    /// Referrer USDC account
    #[account(mut)]
    pub referrer_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

/// Distribute commission to a single referrer
pub fn handle_distribute_commission(
    ctx: Context<DistributeCommission>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, BridgeError::ZeroAmount);
    
    transfer_from_vault(
        &ctx.accounts.vault_token_account.to_account_info(),
        &ctx.accounts.referrer_token_account.to_account_info(),
        &ctx.accounts.vault_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        amount,
        ctx.accounts.config.bump,
    )?;
    
    ctx.accounts.referrer_info.pending_commission += amount;
    ctx.accounts.config.total_commission_distributed += amount;
    
    Ok(())
}

// ==================== Commission Withdrawal ====================

/// User withdraws commission
#[derive(Accounts)]
pub struct WithdrawCommission<'info> {
    pub user: Signer<'info>,
    
    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    pub token_program: Program<'info, Token>,
}

/// Withdraw commission handler
pub fn handle_withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
    let user_info = &mut ctx.accounts.user_info;
    let commission = user_info.pending_commission;
    
    require!(commission > 0, BridgeError::NoCommissionToWithdraw);

    transfer_from_vault(
        &ctx.accounts.vault_token_account.to_account_info(),
        &ctx.accounts.user_token_account.to_account_info(),
        &ctx.accounts.vault_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        commission,
        ctx.accounts.config.bump,
    )?;

    user_info.pending_commission = 0;
    user_info.total_commission_earned += commission;

    emit!(CommissionWithdrawn {
        user: ctx.accounts.user.key(),
        amount: commission,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== Monthly Settlement ====================

/// Manually trigger monthly settlement (project reserve only)
#[derive(Accounts)]
pub struct TriggerSettlement<'info> {
    pub owner: Signer<'info>,
    
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    #[account(mut)]
    pub team_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

/// Manual trigger settlement handler
pub fn handle_trigger_settlement(ctx: Context<TriggerSettlement>) -> Result<()> {
    require!(
        ctx.accounts.owner.key() == ctx.accounts.config.owner,
        BridgeError::Unauthorized
    );

    let config = &mut ctx.accounts.config;
    let project_funds = config.pending_project_funds;
    require!(project_funds > 0, BridgeError::NoPendingFunds);

    transfer_from_vault(
        &ctx.accounts.vault_token_account.to_account_info(),
        &ctx.accounts.team_token_account.to_account_info(),
        &ctx.accounts.vault_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        project_funds,
        config.bump,
    )?;

    config.pending_project_funds = 0;
    config.last_settlement_timestamp = Clock::get()?.unix_timestamp;

    emit!(MonthlySettlement {
        project_funds,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}