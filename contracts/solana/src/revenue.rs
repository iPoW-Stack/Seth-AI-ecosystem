//! Revenue Module - Handles revenue distribution logic (10-5-5-50-30)
//! 
//! Features:
//! - Revenue processing and distribution
//! - Commission distribution (separate instruction)
//! - Commission withdrawal

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    Config, VaultAuthority, UserInfo, CrossChainMessage, CrossChainStatus, SusdcConfig,
    COMMISSION_L1_RATE, COMMISSION_L2_RATE, TEAM_INCENTIVE_RATE, 
    PROJECT_RESERVE_RATE, ECOSYSTEM_RATE, BASIS_POINTS,
};
use crate::{BridgeError};
use crate::{RevenueProcessed, RevenueProcessedWithSusdc, CommissionWithdrawn, MonthlySettlement};
use crate::bridge::transfer_from_vault;

// ==================== Revenue Processing ====================

/// Process revenue and execute distribution
/// L1/L2 commissions are recorded and distributed via separate instruction
#[derive(Accounts)]
#[instruction(amount: u64, product_type: u8, seth_recipient: [u8; 20])]
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
    
    /// User info (must be registered)
    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
        constraint = user_info.is_registered @ BridgeError::UserNotRegistered
    )]
    pub user_info: Account<'info, UserInfo>,
    
    /// Project USDC account (50% - real-time transfer)
    #[account(mut)]
    pub project_token_account: Account<'info, TokenAccount>,
    
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

/// Process revenue distribution logic
/// Commissions are recorded in user_info.pending_commission for later withdrawal
pub fn handle_process_revenue(
    ctx: Context<ProcessRevenue>,
    amount: u64,
    product_type: u8,
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

    // 2. Calculate each portion (10-5-5-50-30)
    let commission_l1 = (amount * COMMISSION_L1_RATE) / BASIS_POINTS;
    let commission_l2 = (amount * COMMISSION_L2_RATE) / BASIS_POINTS;
    let team_funds = (amount * TEAM_INCENTIVE_RATE) / BASIS_POINTS;
    let project_funds = (amount * PROJECT_RESERVE_RATE) / BASIS_POINTS;
    let ecosystem_funds = (amount * ECOSYSTEM_RATE) / BASIS_POINTS;

    // 3. Get referrer info
    let has_l1 = ctx.accounts.user_info.referrer != Pubkey::default();
    let l1_referrer = if has_l1 {
        Some(ctx.accounts.user_info.referrer)
    } else {
        None
    };
    
    // 4. Distribute project funds (real-time transfer)
    if project_funds > 0 {
        transfer_from_vault(
            &ctx.accounts.vault_token_account.to_account_info(),
            &ctx.accounts.project_token_account.to_account_info(),
            &ctx.accounts.vault_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            project_funds,
            ctx.accounts.config.bump,
        )?;
    }
    
    // 5. Record cross-chain message (30% ecosystem + 5% team)
    // Commissions L1/L2 will be distributed via separate distribute_commission instruction
    let cross_chain_msg = &mut ctx.accounts.cross_chain_message;
    cross_chain_msg.sender = ctx.accounts.user.key();
    cross_chain_msg.amount = ecosystem_funds;
    cross_chain_msg.original_amount = amount;
    cross_chain_msg.team_funds = team_funds;
    cross_chain_msg.seth_recipient = seth_recipient;
    cross_chain_msg.product_type = product_type;
    cross_chain_msg.l1_referrer = l1_referrer;
    cross_chain_msg.l2_referrer = None;
    cross_chain_msg.commission_l1 = commission_l1;
    cross_chain_msg.commission_l2 = commission_l2;
    cross_chain_msg.project_funds = project_funds;
    cross_chain_msg.status = CrossChainStatus::Pending;
    cross_chain_msg.created_at = Clock::get()?.unix_timestamp;

    // 6. Update statistics
    ctx.accounts.config.total_revenue += amount;

    // 7. Update user statistics
    ctx.accounts.user_info.total_volume += amount;

    // 8. Emit event
    emit!(RevenueProcessed {
        user: ctx.accounts.user.key(),
        amount,
        commission_l1,
        commission_l2,
        team_funds,
        project_funds,
        ecosystem_funds,
        l1_referrer,
        l2_referrer: None,
        product_type,
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

// ==================== Revenue Processing with sUSDC (Plan B) ====================

/// Process revenue with pre-swapped sUSDC for cross-chain portion.
///
/// This is the second instruction in a two-instruction transaction:
///   Instruction 1: DIRM swap (user swaps 35% USDC → sUSDC)
///   Instruction 2: process_revenue_with_susdc (this instruction)
///
/// Flow:
/// - 65% of USDC goes to vault (commissions L1/L2 + project 50%)
/// - 35% of USDC was already swapped to sUSDC by DIRM in instruction 1
/// - sUSDC from user goes to vault_susdc for cross-chain (ecosystem 30% + team 5%)
/// - Project's 50% USDC is real-time transferred from vault
#[derive(Accounts)]
#[instruction(original_amount: u64, susdc_amount: u64, product_type: u8, seth_recipient: [u8; 20])]
pub struct ProcessRevenueWithSusdc<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // ===== USDC accounts (65% of original_amount) =====

    /// User USDC account (holds 65% USDC after DIRM swap)
    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,

    /// Vault USDC account (receives 65% USDC)
    #[account(mut)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    // ===== sUSDC accounts (35% swapped from USDC via DIRM) =====

    /// User sUSDC account (holds the sUSDC received from DIRM swap)
    #[account(mut)]
    pub user_susdc_account: Account<'info, TokenAccount>,

    /// Vault sUSDC account (receives sUSDC for cross-chain)
    #[account(mut)]
    pub vault_susdc_account: Account<'info, TokenAccount>,

    // ===== Config accounts =====

    /// Vault authority
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Box<Account<'info, VaultAuthority>>,

    /// Global configuration
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    /// sUSDC config (validates vault_susdc_account)
    #[account(
        seeds = [b"susdc_config"],
        bump,
        constraint = susdc_config.vault_susdc_token_account == vault_susdc_account.key() @ BridgeError::InvalidVaultAccount,
    )]
    pub susdc_config: Box<Account<'info, SusdcConfig>>,

    /// User info (must be registered)
    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
        constraint = user_info.is_registered @ BridgeError::UserNotRegistered
    )]
    pub user_info: Box<Account<'info, UserInfo>>,

    /// Project USDC account (50% - real-time transfer)
    #[account(mut)]
    pub project_token_account: Account<'info, TokenAccount>,

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

/// Process revenue with sUSDC handler
///
/// Parameters:
/// - `original_amount`: Total original USDC amount (100%, for distribution calculation)
/// - `susdc_amount`: sUSDC amount received from DIRM swap (for cross-chain portion)
/// - `product_type`: Product category
/// - `seth_recipient`: Seth chain recipient address (20 bytes EVM address)
pub fn handle_process_revenue_with_susdc(
    ctx: Context<ProcessRevenueWithSusdc>,
    original_amount: u64,
    susdc_amount: u64,
    product_type: u8,
    seth_recipient: [u8; 20],
) -> Result<()> {
    require!(original_amount > 0, BridgeError::ZeroAmount);
    require!(susdc_amount > 0, BridgeError::ZeroAmount);

    // Calculate distribution from original amount (10-5-5-50-30)
    let commission_l1 = (original_amount * COMMISSION_L1_RATE) / BASIS_POINTS;
    let commission_l2 = (original_amount * COMMISSION_L2_RATE) / BASIS_POINTS;
    let team_funds = (original_amount * TEAM_INCENTIVE_RATE) / BASIS_POINTS;
    let project_funds = (original_amount * PROJECT_RESERVE_RATE) / BASIS_POINTS;
    let ecosystem_funds = (original_amount * ECOSYSTEM_RATE) / BASIS_POINTS;

    // The USDC portion that stays on Solana: commissions (10+5) + project (50%) = 65%
    let usdc_amount = commission_l1
        .checked_add(commission_l2)
        .and_then(|v| v.checked_add(project_funds))
        .ok_or(BridgeError::MathOverflow)?;

    // 1. Transfer USDC from user to Vault (65%: commissions + project)
    if usdc_amount > 0 {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc_account.to_account_info(),
                    to: ctx.accounts.vault_usdc_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            usdc_amount,
        )?;
    }

    // 2. Transfer sUSDC from user to Vault sUSDC (35%: ecosystem 30% + team 5%)
    // This sUSDC was received from DIRM swap in the previous instruction
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_susdc_account.to_account_info(),
                to: ctx.accounts.vault_susdc_account.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        susdc_amount,
    )?;

    // 3. Get referrer info
    let has_l1 = ctx.accounts.user_info.referrer != Pubkey::default();
    let l1_referrer = if has_l1 {
        Some(ctx.accounts.user_info.referrer)
    } else {
        None
    };

    // 4. Distribute project funds (real-time USDC transfer from vault)
    if project_funds > 0 {
        transfer_from_vault(
            &ctx.accounts.vault_usdc_account.to_account_info(),
            &ctx.accounts.project_token_account.to_account_info(),
            &ctx.accounts.vault_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            project_funds,
            ctx.accounts.config.bump,
        )?;
    }

    // 5. Record cross-chain message (sUSDC amount for ecosystem + team)
    // Commissions L1/L2 will be distributed via separate distribute_commission instruction
    let cross_chain_msg = &mut ctx.accounts.cross_chain_message;
    cross_chain_msg.sender = ctx.accounts.user.key();
    cross_chain_msg.amount = susdc_amount; // Actual sUSDC amount (may differ from 30% USDC)
    cross_chain_msg.original_amount = original_amount;
    cross_chain_msg.team_funds = team_funds; // Team portion in original USDC terms
    cross_chain_msg.seth_recipient = seth_recipient;
    cross_chain_msg.product_type = product_type;
    cross_chain_msg.l1_referrer = l1_referrer;
    cross_chain_msg.l2_referrer = None;
    cross_chain_msg.commission_l1 = commission_l1;
    cross_chain_msg.commission_l2 = commission_l2;
    cross_chain_msg.project_funds = project_funds;
    cross_chain_msg.status = CrossChainStatus::Pending;
    cross_chain_msg.created_at = Clock::get()?.unix_timestamp;

    // 6. Update statistics
    ctx.accounts.config.total_revenue += original_amount;

    // 7. Update user statistics
    ctx.accounts.user_info.total_volume += original_amount;

    // 8. Emit event
    emit!(RevenueProcessedWithSusdc {
        user: ctx.accounts.user.key(),
        original_amount,
        usdc_amount,
        susdc_amount,
        commission_l1,
        commission_l2,
        team_funds,
        project_funds,
        ecosystem_funds,
        l1_referrer,
        l2_referrer: None,
        product_type,
        seth_recipient,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== Monthly Settlement ====================

/// Manually trigger monthly settlement (legacy, team funds now cross-chain)
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
    let team_funds = config.pending_team_funds;

    require!(team_funds > 0, BridgeError::NoPendingFunds);

    transfer_from_vault(
        &ctx.accounts.vault_token_account.to_account_info(),
        &ctx.accounts.team_token_account.to_account_info(),
        &ctx.accounts.vault_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        team_funds,
        config.bump,
    )?;

    config.pending_team_funds = 0;
    config.last_settlement_timestamp = Clock::get()?.unix_timestamp;

    emit!(MonthlySettlement {
        team_funds,
        project_funds: 0,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}