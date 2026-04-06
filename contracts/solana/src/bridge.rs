//! Bridge Module - Handles basic cross-chain bridge functionality

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{Config, VaultAuthority, UserInfo, CrossChainMessage, CrossChainStatus, SethUnlockReceipt};
use crate::{BridgeError};
use crate::{ReferrerSet, CrossChainCompleted, RelayerUpdated, SethUnlockProcessed};

// ==================== Initialization ====================

/// Initialize bridge configuration
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    
    /// Team wallet
    /// CHECK: Team wallet address
    pub team_wallet: AccountInfo<'info>,
    
    /// Project wallet
    /// CHECK: Project wallet address
    pub project_wallet: AccountInfo<'info>,
    
    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(
        init,
        payer = owner,
        space = 8 + VaultAuthority::INIT_SPACE,
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// Vault USDC token account
    #[account(
        init,
        payer = owner,
        token::mint = usdc_mint,
        token::authority = vault_authority,
        seeds = [b"vault_token_account"],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// USDC Mint
    /// CHECK: USDC mint address
    pub usdc_mint: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

/// Initialize bridge configuration handler
pub fn handle_initialize(ctx: Context<Initialize>, seth_treasury: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.owner = ctx.accounts.owner.key();
    config.seth_treasury = seth_treasury;
    config.team_wallet = ctx.accounts.team_wallet.key();
    config.project_wallet = ctx.accounts.project_wallet.key();
    config.vault_authority = ctx.accounts.vault_authority.key();
    config.bump = ctx.bumps.vault_authority;
    config.relayer = ctx.accounts.owner.key();
    config.total_revenue = 0;
    config.total_commission_distributed = 0;
    config.total_ecosystem_transferred = 0;
    config.pending_project_funds = 0;
    config.last_settlement_timestamp = Clock::get()?.unix_timestamp;
    Ok(())
}

/// Initialize root user (owner) - creates first user without requiring referrer
/// Only callable by owner during initialization
#[derive(Accounts)]
pub struct InitRootUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    /// Root user info account
    #[account(
        init,
        payer = owner,
        space = 8 + UserInfo::INIT_SPACE,
        seeds = [b"user_info", owner.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    pub system_program: Program<'info, System>,
}

/// Initialize root user handler
pub fn handle_init_root_user(ctx: Context<InitRootUser>) -> Result<()> {
    // Verify caller is the owner
    require!(
        ctx.accounts.owner.key() == ctx.accounts.config.owner,
        BridgeError::Unauthorized
    );
    
    let user_info = &mut ctx.accounts.user_info;
    user_info.user = ctx.accounts.owner.key();
    user_info.referrer = Pubkey::default(); // Root user has no referrer
    user_info.is_registered = true;
    user_info.total_volume = 0;
    user_info.total_commission_earned = 0;
    user_info.pending_commission = 0;
    user_info.created_at = Clock::get()?.unix_timestamp;

    emit!(ReferrerSet {
        user: ctx.accounts.owner.key(),
        referrer: Pubkey::default(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== Referral System ====================

/// Set referrer relationship
#[derive(Accounts)]
#[instruction(referrer: Pubkey)]
pub struct SetReferrer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    /// User info account (to be initialized if needed)
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserInfo::INIT_SPACE,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    /// L1 referrer info (must be registered)
    /// Required: every user must have a referrer
    #[account(
        mut,
        seeds = [b"user_info", referrer.as_ref()],
        bump,
        constraint = l1_referrer_info.is_registered @ BridgeError::ReferrerNotRegistered
    )]
    pub l1_referrer_info: Account<'info, UserInfo>,
    
    pub system_program: Program<'info, System>,
    
    /// L2 referrer info (referrer's referrer, for L2 commission)
    /// This is optional - only exists if L1 referrer has a referrer (not root user)
    /// Seeds not used because L1 might be root user (no L2 referrer)
    /// Placed last so it can be omitted when L1 is root user
    /// CHECK: Verified manually in handler if present
    #[account(mut)]
    pub l2_referrer_info: Option<AccountInfo<'info>>,
}

/// Set referrer relationship handler
/// Validates referrer chain and updates referral statistics
pub fn handle_set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
    // Cannot refer yourself
    require!(
        ctx.accounts.user.key() != referrer,
        BridgeError::CannotReferSelf
    );
    
    let user_info = &mut ctx.accounts.user_info;
    
    // If referrer already set, do not allow modification
    require!(
        user_info.referrer == Pubkey::default() || !user_info.is_registered,
        BridgeError::ReferrerAlreadySet
    );
    
    // Validate referrer is not default (zero address means no referrer)
    let has_referrer = referrer != Pubkey::default();
    
    // Update user info
    let is_new_user = !user_info.is_registered;
    user_info.user = ctx.accounts.user.key();
    user_info.referrer = referrer;
    user_info.is_registered = true;
    
    if is_new_user {
        user_info.created_at = Clock::get()?.unix_timestamp;
    }
    
    emit!(ReferrerSet {
        user: ctx.accounts.user.key(),
        referrer,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== Cross-Chain Message Management ====================

/// Relayer marks cross-chain completed
#[derive(Accounts)]
pub struct MarkCrossChainCompleted<'info> {
    pub relayer: Signer<'info>,
    
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(
        mut,
        seeds = [b"cross_chain_msg", cross_chain_message.key().as_ref()],
        bump
    )]
    pub cross_chain_message: Account<'info, CrossChainMessage>,
}

/// Mark cross-chain completed handler
pub fn handle_mark_cross_chain_completed(
    ctx: Context<MarkCrossChainCompleted>,
    seth_tx_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.relayer.key() == ctx.accounts.config.relayer,
        BridgeError::Unauthorized
    );

    let message = &mut ctx.accounts.cross_chain_message;
    require!(
        message.status == CrossChainStatus::Pending,
        BridgeError::AlreadyProcessed
    );

    message.status = CrossChainStatus::Completed;
    message.seth_tx_hash = seth_tx_hash;
    message.processed_at = Clock::get()?.unix_timestamp;

    ctx.accounts.config.total_ecosystem_transferred += message.amount;

    emit!(CrossChainCompleted {
        solana_tx_sig: message.key(),
        seth_tx_hash,
        ecosystem_amount: message.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

/// Relayer unlocks sUSDC on Solana for Seth->Solana bridge-back
#[derive(Accounts)]
#[instruction(bridge_address: [u8; 20], request_id: u64)]
pub struct UnlockFromSeth<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,
    
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    #[account(
        mut,
        seeds = [b"vault_token_account"],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// Recipient sUSDC token account on Solana
    #[account(mut)]
    pub recipient_token_account: Account<'info, TokenAccount>,
    
    #[account(
        init_if_needed,
        payer = relayer,
        space = 8 + SethUnlockReceipt::INIT_SPACE,
        seeds = [b"seth_unlock", bridge_address.as_ref(), request_id.to_le_bytes().as_ref()],
        bump
    )]
    pub unlock_receipt: Account<'info, SethUnlockReceipt>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_unlock_from_seth(
    ctx: Context<UnlockFromSeth>,
    bridge_address: [u8; 20],
    request_id: u64,
    amount: u64,
    seth_tx_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.relayer.key() == ctx.accounts.config.relayer,
        BridgeError::Unauthorized
    );
    require!(amount > 0, BridgeError::ZeroAmount);
    require!(
        ctx.accounts.recipient_token_account.mint == ctx.accounts.vault_token_account.mint,
        BridgeError::InvalidAccount
    );

    // Idempotent: relayer retries must not re-init the PDA (init -> "already in use");
    // if this unlock was already recorded, succeed without transferring again.
    {
        let r = &ctx.accounts.unlock_receipt;
        if r.request_id == request_id
            && r.bridge_address == bridge_address
            && r.processed_at != 0
        {
            return Ok(());
        }
    }

    transfer_from_vault(
        &ctx.accounts.vault_token_account.to_account_info(),
        &ctx.accounts.recipient_token_account.to_account_info(),
        &ctx.accounts.vault_authority.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        amount,
        ctx.accounts.config.bump,
    )?;
    
    let receipt = &mut ctx.accounts.unlock_receipt;
    receipt.bridge_address = bridge_address;
    receipt.request_id = request_id;
    receipt.recipient = ctx.accounts.recipient_token_account.owner;
    receipt.amount = amount;
    receipt.seth_tx_hash = seth_tx_hash;
    receipt.processed_at = Clock::get()?.unix_timestamp;
    
    emit!(SethUnlockProcessed {
        request_id,
        recipient: ctx.accounts.recipient_token_account.owner,
        amount,
        seth_tx_hash,
        timestamp: Clock::get()?.unix_timestamp,
    });
    
    Ok(())
}

// ==================== Relayer Management ====================

/// Set Relayer
#[derive(Accounts)]
pub struct SetRelayer<'info> {
    pub owner: Signer<'info>,
    
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
}

/// Set Relayer handler
pub fn handle_set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
    require!(
        ctx.accounts.owner.key() == ctx.accounts.config.owner,
        BridgeError::Unauthorized
    );
    
    let old_relayer = ctx.accounts.config.relayer;
    ctx.accounts.config.relayer = new_relayer;
    
    emit!(RelayerUpdated {
        old_relayer,
        new_relayer,
    });
    
    Ok(())
}

/// Close user info account (returns rent to user)
/// Only the account owner can close their account
#[derive(Accounts)]
pub struct CloseUserInfo<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    /// User info account to close
    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
        close = user
    )]
    pub user_info: Account<'info, UserInfo>,
}

/// Close user info handler
pub fn handle_close_user_info(_ctx: Context<CloseUserInfo>) -> Result<()> {
    // The close constraint automatically handles:
    // 1. Transferring lamports to the user
    // 2. Zeroing out the account data
    // 3. Marking the account as closed
    Ok(())
}

// ==================== Helper Functions ====================

/// Transfer from Vault to user (using AccountInfo to avoid lifetime issues)
pub fn transfer_from_vault<'info>(
    vault: &AccountInfo<'info>,
    recipient: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    bump: u8,
) -> Result<()> {
    let seeds = &[
        b"vault_authority".as_ref(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: vault.clone(),
        to: recipient.clone(),
        authority: authority.clone(),
    };
    
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.clone(),
        cpi_accounts,
        signer,
    );
    
    token::transfer(cpi_ctx, amount)?;
    Ok(())
}