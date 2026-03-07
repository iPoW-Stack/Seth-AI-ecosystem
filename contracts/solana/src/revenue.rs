//! Revenue 模块 - 负责收入分账逻辑 (15-50-35)
//! 
//! 功能：
//! - 收入处理与分账
//! - 佣金分发
//! - 月底清算
//! - 佣金提取

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    Config, VaultAuthority, UserInfo, CrossChainMessage, CrossChainStatus,
    COMMISSION_L1_RATE, COMMISSION_L2_RATE, TEAM_INCENTIVE_RATE, 
    PROJECT_RESERVE_RATE, ECOSYSTEM_RATE, BASIS_POINTS,
    SETTLEMENT_DAY, MIN_SETTLEMENT_INTERVAL,
};
use crate::{BridgeError};
use crate::{RevenueProcessed, CommissionWithdrawn, MonthlySettlement};
use crate::bridge::transfer_from_vault;

// ==================== 收入处理 ====================

/// 处理收入并执行 15-50-35 分账
#[derive(Accounts)]
#[instruction(amount: u64, product_type: u8, seth_recipient: [u8; 20])]
pub struct ProcessRevenue<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    
    /// 用户 USDC 账户
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    
    /// Vault USDC 账户
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// Vault 授权
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: Account<'info, VaultAuthority>,
    
    /// 全局配置
    #[account(
        mut,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    /// 用户信息
    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    /// L1 推荐人信息
    #[account(
        mut,
        seeds = [b"user_info", user_info.referrer.as_ref()],
        bump
    )]
    pub l1_user_info: Option<Account<'info, UserInfo>>,
    
    /// L1 推荐人 USDC 账户
    #[account(mut)]
    pub l1_token_account: Option<Account<'info, TokenAccount>>,
    
    /// L2 推荐人信息
    #[account(
        mut,
        seeds = [b"user_info", l1_user_info.as_ref().unwrap().referrer.as_ref()],
        bump
    )]
    pub l2_user_info: Option<Account<'info, UserInfo>>,
    
    /// L2 推荐人 USDC 账户
    #[account(mut)]
    pub l2_token_account: Option<Account<'info, TokenAccount>>,
    
    /// 团队 USDC 账户
    #[account(mut)]
    pub team_token_account: Account<'info, TokenAccount>,
    
    /// 项目方 USDC 账户
    #[account(mut)]
    pub project_token_account: Account<'info, TokenAccount>,
    
    /// 跨链消息记录
    #[account(
        init,
        payer = user,
        space = 8 + CrossChainMessage::INIT_SPACE,
        seeds = [b"cross_chain_msg", user.key().as_ref(), &Clock::get()?.unix_timestamp.to_le_bytes()],
        bump
    )]
    pub cross_chain_message: Account<'info, CrossChainMessage>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// 处理收入分账逻辑
pub fn handle_process_revenue(
    ctx: Context<ProcessRevenue>,
    amount: u64,
    product_type: u8,
    seth_recipient: [u8; 20],
) -> Result<()> {
    require!(amount > 0, BridgeError::ZeroAmount);

    // 1. 从用户转入 USDC 到 Vault
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

    // 2. 计算各部分金额 (15-50-35)
    let commission_l1 = (amount * COMMISSION_L1_RATE) / BASIS_POINTS;
    let commission_l2 = (amount * COMMISSION_L2_RATE) / BASIS_POINTS;
    let team_funds = (amount * TEAM_INCENTIVE_RATE) / BASIS_POINTS;
    let project_funds = (amount * PROJECT_RESERVE_RATE) / BASIS_POINTS;
    let ecosystem_funds = (amount * ECOSYSTEM_RATE) / BASIS_POINTS;

    // 3. 获取推荐链
    let (l1_referrer, l2_referrer) = get_referrer_chain(&ctx.accounts);

    // 4. 分发 L1 佣金 (实时)
    let mut total_commission = 0u64;
    if l1_referrer.is_some() {
        if commission_l1 > 0 {
            transfer_from_vault(
                &ctx.accounts.vault_token_account.to_account_info(),
                &ctx.accounts.l1_token_account.as_ref().unwrap().to_account_info(),
                &ctx.accounts.vault_authority.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                commission_l1,
                ctx.accounts.config.bump,
            )?;
            total_commission += commission_l1;
            
            // 更新 L1 推荐人佣金记录
            ctx.accounts.l1_user_info.as_mut().unwrap().pending_commission += commission_l1;
        }
    }

    // 5. 分发 L2 佣金 (实时)
    if l2_referrer.is_some() {
        if commission_l2 > 0 {
            transfer_from_vault(
                &ctx.accounts.vault_token_account.to_account_info(),
                &ctx.accounts.l2_token_account.as_ref().unwrap().to_account_info(),
                &ctx.accounts.vault_authority.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                commission_l2,
                ctx.accounts.config.bump,
            )?;
            total_commission += commission_l2;
            
            // 更新 L2 推荐人佣金记录
            ctx.accounts.l2_user_info.as_mut().unwrap().pending_commission += commission_l2;
        }
    }

    // 6. 累计待清算资金 (月底拨付)
    let config = &mut ctx.accounts.config;
    config.pending_team_funds += team_funds;
    config.pending_project_funds += project_funds;

    // 7. 记录跨链消息 (35% 生态资金)
    let cross_chain_msg = &mut ctx.accounts.cross_chain_message;
    cross_chain_msg.sender = ctx.accounts.user.key();
    cross_chain_msg.amount = ecosystem_funds;
    cross_chain_msg.original_amount = amount;
    cross_chain_msg.seth_recipient = seth_recipient;
    cross_chain_msg.product_type = product_type;
    cross_chain_msg.l1_referrer = l1_referrer;
    cross_chain_msg.l2_referrer = l2_referrer;
    cross_chain_msg.commission_l1 = commission_l1;
    cross_chain_msg.commission_l2 = commission_l2;
    cross_chain_msg.team_funds = team_funds;
    cross_chain_msg.project_funds = project_funds;
    cross_chain_msg.status = CrossChainStatus::Pending;
    cross_chain_msg.created_at = Clock::get()?.unix_timestamp;

    // 8. 更新统计
    config.total_revenue += amount;
    config.total_commission_distributed += total_commission;

    // 9. 更新用户统计
    ctx.accounts.user_info.total_volume += amount;

    // 10. 发射事件
    emit!(RevenueProcessed {
        user: ctx.accounts.user.key(),
        amount,
        commission_l1,
        commission_l2,
        team_funds,
        project_funds,
        ecosystem_funds,
        l1_referrer,
        l2_referrer,
        product_type,
        timestamp: Clock::get()?.unix_timestamp,
    });

    // 11. 检查月底清算
    check_and_settle_monthly(ctx)?;

    Ok(())
}

/// 获取推荐链
fn get_referrer_chain(accounts: &ProcessRevenue) -> (Option<Pubkey>, Option<Pubkey>) {
    let l1 = if accounts.user_info.referrer != Pubkey::default() {
        Some(accounts.user_info.referrer)
    } else {
        None
    };

    let l2 = if let Some(l1_info) = &accounts.l1_user_info {
        if l1_info.referrer != Pubkey::default() {
            Some(l1_info.referrer)
        } else {
            None
        }
    } else {
        None
    };

    (l1, l2)
}

/// 检查并执行月底清算
fn check_and_settle_monthly(ctx: Context<ProcessRevenue>) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;

    if is_settlement_day(current_time) && can_settle(config.last_settlement_timestamp, current_time) {
        let team_funds = config.pending_team_funds;
        let project_funds = config.pending_project_funds;

        if team_funds > 0 || project_funds > 0 {
            // 转账团队激励
            if team_funds > 0 {
                transfer_from_vault(
                    &ctx.accounts.vault_token_account.to_account_info(),
                    &ctx.accounts.team_token_account.to_account_info(),
                    &ctx.accounts.vault_authority.to_account_info(),
                    &ctx.accounts.token_program.to_account_info(),
                    team_funds,
                    config.bump,
                )?;
            }

            // 转账项目方储备
            if project_funds > 0 {
                transfer_from_vault(
                    &ctx.accounts.vault_token_account.to_account_info(),
                    &ctx.accounts.project_token_account.to_account_info(),
                    &ctx.accounts.vault_authority.to_account_info(),
                    &ctx.accounts.token_program.to_account_info(),
                    project_funds,
                    config.bump,
                )?;
            }

            config.pending_team_funds = 0;
            config.pending_project_funds = 0;
            config.last_settlement_timestamp = current_time;

            emit!(MonthlySettlement {
                team_funds,
                project_funds,
                timestamp: current_time,
            });
        }
    }

    Ok(())
}

/// 判断是否是清算日 (28号)
fn is_settlement_day(timestamp: i64) -> bool {
    // 简化计算：假设每月30天
    let day_of_month = ((timestamp / 86400) % 30) + 1;
    day_of_month == SETTLEMENT_DAY as i64
}

/// 判断是否可以清算
fn can_settle(last_settlement: i64, current: i64) -> bool {
    current - last_settlement >= MIN_SETTLEMENT_INTERVAL
}

// ==================== 佣金提取 ====================

/// 用户提取佣金
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

/// 提取佣金处理逻辑
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

// ==================== 月底清算 ====================

/// 手动触发月底清算
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
    
    #[account(mut)]
    pub project_token_account: Account<'info, TokenAccount>,
    
    pub token_program: Program<'info, Token>,
}

/// 手动触发清算处理逻辑
pub fn handle_trigger_settlement(ctx: Context<TriggerSettlement>) -> Result<()> {
    require!(
        ctx.accounts.owner.key() == ctx.accounts.config.owner,
        BridgeError::Unauthorized
    );

    let config = &mut ctx.accounts.config;
    let team_funds = config.pending_team_funds;
    let project_funds = config.pending_project_funds;

    require!(
        team_funds > 0 || project_funds > 0,
        BridgeError::NoPendingFunds
    );

    if team_funds > 0 {
        transfer_from_vault(
            &ctx.accounts.vault_token_account.to_account_info(),
            &ctx.accounts.team_token_account.to_account_info(),
            &ctx.accounts.vault_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            team_funds,
            config.bump,
        )?;
    }

    if project_funds > 0 {
        transfer_from_vault(
            &ctx.accounts.vault_token_account.to_account_info(),
            &ctx.accounts.project_token_account.to_account_info(),
            &ctx.accounts.vault_authority.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            project_funds,
            config.bump,
        )?;
    }

    config.pending_team_funds = 0;
    config.pending_project_funds = 0;
    config.last_settlement_timestamp = Clock::get()?.unix_timestamp;

    emit!(MonthlySettlement {
        team_funds,
        project_funds,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}