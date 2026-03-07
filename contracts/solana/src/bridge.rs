//! Bridge 模块 - 负责基础跨链桥功能

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{Config, VaultAuthority, UserInfo, CrossChainMessage, CrossChainStatus};
use crate::{BridgeError};
use crate::{ReferrerSet, CrossChainCompleted, RelayerUpdated};

// ==================== 初始化 ====================

/// 初始化桥接配置
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    
    /// 团队钱包
    /// CHECK: 团队钱包地址
    pub team_wallet: AccountInfo<'info>,
    
    /// 项目方钱包
    /// CHECK: 项目方钱包地址
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
    
    /// Vault USDC 代币账户
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
    /// CHECK: USDC mint 地址
    pub usdc_mint: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

/// 初始化桥接配置处理逻辑
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
    config.pending_team_funds = 0;
    config.pending_project_funds = 0;
    config.last_settlement_timestamp = Clock::get()?.unix_timestamp;
    Ok(())
}

// ==================== 推荐系统 ====================

/// 设置推荐关系
#[derive(Accounts)]
pub struct SetReferrer<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserInfo::INIT_SPACE,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    pub system_program: Program<'info, System>,
}

/// 设置推荐关系处理逻辑
pub fn handle_set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
    require!(
        ctx.accounts.user.key() != referrer,
        BridgeError::CannotReferSelf
    );

    let user_info = &mut ctx.accounts.user_info;
    
    // 如果已有推荐人，不允许修改
    require!(
        user_info.referrer == Pubkey::default() || !user_info.is_registered,
        BridgeError::ReferrerAlreadySet
    );

    user_info.user = ctx.accounts.user.key();
    user_info.referrer = referrer;
    user_info.is_registered = true;
    user_info.created_at = Clock::get()?.unix_timestamp;

    emit!(ReferrerSet {
        user: ctx.accounts.user.key(),
        referrer,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

// ==================== 跨链消息管理 ====================

/// Relayer 标记跨链完成
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

/// 标记跨链完成处理逻辑
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

// ==================== Relayer 管理 ====================

/// 设置 Relayer
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

/// 设置 Relayer 处理逻辑
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

// ==================== 辅助函数 ====================

/// 从 Vault 转账到用户 (使用 AccountInfo 避免生命周期问题)
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