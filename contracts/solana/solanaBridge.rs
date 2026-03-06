// Cargo.toml 依赖
// [dependencies]
// anchor-lang = "0.29.0"
// anchor-spl = "0.29.0"
// spl-token = "4.0.0"

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("SethBridge11111111111111111111111111111111");

// ==================== 常量定义 ====================

// 分账比例 (基点, 10000 = 100%)
pub const COMMISSION_L1_RATE: u64 = 1000;      // 10%
pub const COMMISSION_L2_RATE: u64 = 500;       // 5%
pub const TOTAL_COMMISSION_RATE: u64 = 1500;   // 15%
pub const TEAM_INCENTIVE_RATE: u64 = 500;      // 5% (50%的10%)
pub const PROJECT_RESERVE_RATE: u64 = 4500;    // 45% (50%的90%)
pub const ECOSYSTEM_RATE: u64 = 3500;          // 35%
pub const BASIS_POINTS: u64 = 10000;

// 清算日
pub const SETTLEMENT_DAY: u64 = 28;

#[program]
pub mod seth_bridge {
    use super::*;

    /// 初始化桥接配置（仅Owner）
    pub fn initialize(ctx: Context<Initialize>, seth_treasury: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.seth_treasury = seth_treasury;  // Seth链Treasury地址
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

    /// 设置推荐关系
    pub fn set_referrer(ctx: Context<SetReferrer>, referrer: Pubkey) -> Result<()> {
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

        // 验证推荐人是否已注册
        if let Some(referrer_info) = &ctx.accounts.referrer_info {
            require!(
                referrer_info.is_registered,
                BridgeError::ReferrerNotRegistered
            );
        }

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

    /// 处理收入并执行 15-50-35 分账
    /// 这是核心函数：在 Solana 链上完成所有分账逻辑
    pub fn process_revenue(
        ctx: Context<ProcessRevenue>,
        amount: u64,
        product_type: u8,
        seth_recipient: [u8; 20],  // Seth链接收地址（用于35%跨链）
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
        let commission_l1 = (amount * COMMISSION_L1_RATE) / BASIS_POINTS;  // 10%
        let commission_l2 = (amount * COMMISSION_L2_RATE) / BASIS_POINTS;  // 5%
        let team_funds = (amount * TEAM_INCENTIVE_RATE) / BASIS_POINTS;    // 5%
        let project_funds = (amount * PROJECT_RESERVE_RATE) / BASIS_POINTS; // 45%
        let ecosystem_funds = (amount * ECOSYSTEM_RATE) / BASIS_POINTS;    // 35%

        // 3. 获取推荐链
        let (l1_referrer, l2_referrer) = Self::get_referrer_chain(&ctx.accounts);

        // 4. 分发 L1 佣金 (实时)
        let mut total_commission = 0u64;
        if let Some(l1) = l1_referrer {
            if commission_l1 > 0 {
                Self::transfer_to_user(
                    &ctx.accounts.vault_token_account,
                    &ctx.accounts.l1_token_account,
                    &ctx.accounts.vault_authority,
                    &ctx.accounts.token_program,
                    commission_l1,
                    ctx.accounts.config.bump,
                )?;
                total_commission += commission_l1;
                
                // 更新 L1 推荐人佣金记录
                ctx.accounts.l1_user_info.pending_commission += commission_l1;
            }
        }

        // 5. 分发 L2 佣金 (实时)
        if let Some(l2) = l2_referrer {
            if commission_l2 > 0 {
                Self::transfer_to_user(
                    &ctx.accounts.vault_token_account,
                    &ctx.accounts.l2_token_account,
                    &ctx.accounts.vault_authority,
                    &ctx.accounts.token_program,
                    commission_l2,
                    ctx.accounts.config.bump,
                )?;
                total_commission += commission_l2;
                
                // 更新 L2 推荐人佣金记录
                ctx.accounts.l2_user_info.pending_commission += commission_l2;
            }
        }

        // 6. 累计待清算资金 (月底拨付)
        let config = &mut ctx.accounts.config;
        config.pending_team_funds += team_funds;
        config.pending_project_funds += project_funds;

        // 7. 记录跨链消息 (35% 生态资金)
        let cross_chain_msg = &mut ctx.accounts.cross_chain_message;
        cross_chain_msg.sender = ctx.accounts.user.key();
        cross_chain_msg.amount = ecosystem_funds;  // 只有35%需要跨链
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
        Self::check_monthly_settlement(&mut ctx.accounts)?;

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

    /// 从 Vault 转账到用户
    fn transfer_to_user(
        vault: &Account<TokenAccount>,
        recipient: &Account<TokenAccount>,
        authority: &Account<VaultAuthority>,
        token_program: &Program<Token>,
        amount: u64,
        bump: u8,
    ) -> Result<()> {
        let seeds = &[
            b"vault_authority".as_ref(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: recipient.to_account_info(),
                    authority: authority.to_account_info(),
                },
                signer,
            ),
            amount,
        )?;

        Ok(())
    }

    /// 检查并执行月底清算
    fn check_monthly_settlement(ctx: &mut ProcessRevenue) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;

        // 检查是否是28号且本月未清算
        if Self::is_settlement_day(current_time) && Self::can_settle(config.last_settlement_timestamp, current_time) {
            let team_funds = config.pending_team_funds;
            let project_funds = config.pending_project_funds;

            if team_funds > 0 || project_funds > 0 {
                // 转账团队激励
                if team_funds > 0 {
                    Self::transfer_to_user(
                        &ctx.accounts.vault_token_account,
                        &ctx.accounts.team_token_account,
                        &ctx.accounts.vault_authority,
                        &ctx.accounts.token_program,
                        team_funds,
                        config.bump,
                    )?;
                }

                // 转账项目方储备
                if project_funds > 0 {
                    Self::transfer_to_user(
                        &ctx.accounts.vault_token_account,
                        &ctx.accounts.project_token_account,
                        &ctx.accounts.vault_authority,
                        &ctx.accounts.token_program,
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
        // 至少间隔25天
        current - last_settlement >= 25 * 86400
    }

    /// Relayer 标记跨链完成（35%资金已在Seth链处理）
    pub fn mark_cross_chain_completed(
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

    /// 用户提取佣金
    pub fn withdraw_commission(ctx: Context<WithdrawCommission>) -> Result<()> {
        let user_info = &mut ctx.accounts.user_info;
        let commission = user_info.pending_commission;
        
        require!(commission > 0, BridgeError::NoCommissionToWithdraw);

        Self::transfer_to_user(
            &ctx.accounts.vault_token_account,
            &ctx.accounts.user_token_account,
            &ctx.accounts.vault_authority,
            &ctx.accounts.token_program,
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

    /// 手动触发月底清算（Owner专用）
    pub fn trigger_settlement(ctx: Context<TriggerSettlement>) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.config.owner,
            BridgeError::Unauthorized
        );

        let config = &mut ctx.accounts.config;
        let team_funds = config.pending_team_funds;
        let project_funds = config.pending_project_funds;

        if team_funds > 0 {
            Self::transfer_to_user(
                &ctx.accounts.vault_token_account,
                &ctx.accounts.team_token_account,
                &ctx.accounts.vault_authority,
                &ctx.accounts.token_program,
                team_funds,
                config.bump,
            )?;
        }

        if project_funds > 0 {
            Self::transfer_to_user(
                &ctx.accounts.vault_token_account,
                &ctx.accounts.project_token_account,
                &ctx.accounts.vault_authority,
                &ctx.accounts.token_program,
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

    /// 设置 Relayer
    pub fn set_relayer(ctx: Context<SetRelayer>, new_relayer: Pubkey) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.config.owner,
            BridgeError::Unauthorized
        );
        ctx.accounts.config.relayer = new_relayer;
        emit!(RelayerUpdated {
            old_relayer: ctx.accounts.config.relayer,
            new_relayer,
        });
        Ok(())
    }
}

// ==================== 账户结构 ====================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    
    /// 团队钱包 (接收5%激励)
    pub team_wallet: AccountInfo<'info>,
    
    /// 项目方钱包 (接收45%储备)
    pub project_wallet: AccountInfo<'info>,
    
    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE
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
    pub usdc_mint: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetReferrer<'info> {
    pub user: Signer<'info>,
    
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserInfo::INIT_SPACE,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,
    
    /// 推荐人信息（可选）
    #[account(
        seeds = [b"user_info", referrer.key().as_ref()],
        bump
    )]
    pub referrer_info: Option<Account<'info, UserInfo>>,
    
    pub system_program: Program<'info, System>,
}

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

// ==================== 数据结构 ====================

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,                      // 管理员
    pub seth_treasury: Pubkey,              // Seth链Treasury地址
    pub team_wallet: Pubkey,                // 团队钱包 (5%)
    pub project_wallet: Pubkey,             // 项目方钱包 (45%)
    pub vault_authority: Pubkey,            // Vault PDA授权
    pub relayer: Pubkey,                    // 受信任的Relayer
    pub bump: u8,                           // PDA bump
    
    // 统计
    pub total_revenue: u64,                 // 总收入
    pub total_commission_distributed: u64,  // 总分发佣金
    pub total_ecosystem_transferred: u64,   // 总跨链生态资金
    
    // 待清算资金
    pub pending_team_funds: u64,            // 待拨付团队激励
    pub pending_project_funds: u64,         // 待拨付项目方储备
    pub last_settlement_timestamp: i64,     // 上次清算时间
}

#[account]
#[derive(InitSpace)]
pub struct VaultAuthority {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserInfo {
    pub user: Pubkey,                       // 用户地址
    pub referrer: Pubkey,                   // L1 推荐人
    pub is_registered: bool,                // 是否已注册
    pub total_volume: u64,                  // 总交易量
    pub total_commission_earned: u64,       // 累计获得的佣金
    pub pending_commission: u64,            // 待提取佣金
    pub created_at: i64,                    // 注册时间
}

#[account]
#[derive(InitSpace)]
pub struct CrossChainMessage {
    pub sender: Pubkey,                     // 发送者
    pub original_amount: u64,               // 原始金额
    pub amount: u64,                        // 跨链金额 (35%)
    pub seth_recipient: [u8; 20],           // Seth链接收地址
    
    // 分账详情
    pub commission_l1: u64,                 // L1佣金
    pub commission_l2: u64,                 // L2佣金
    pub team_funds: u64,                    // 团队资金
    pub project_funds: u64,                 // 项目方资金
    
    pub product_type: u8,                   // 产品类型
    pub l1_referrer: Option<Pubkey>,        // L1 推荐人
    pub l2_referrer: Option<Pubkey>,        // L2 推荐人
    pub status: CrossChainStatus,           // 状态
    pub seth_tx_hash: [u8; 32],             // Seth链交易哈希
    pub created_at: i64,                    // 创建时间
    pub processed_at: i64,                  // 处理时间
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CrossChainStatus {
    Pending,
    Completed,
    Failed,
}

// ==================== 事件 ====================

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
    pub timestamp: i64,
}

#[event]
pub struct CrossChainCompleted {
    pub solana_tx_sig: Pubkey,
    pub seth_tx_hash: [u8; 32],
    pub ecosystem_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ReferrerSet {
    pub user: Pubkey,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CommissionWithdrawn {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MonthlySettlement {
    pub team_funds: u64,
    pub project_funds: u64,
    pub timestamp: i64,
}

#[event]
pub struct RelayerUpdated {
    pub old_relayer: Pubkey,
    pub new_relayer: Pubkey,
}

// ==================== 错误 ====================

#[error_code]
pub enum BridgeError {
    #[msg("Cannot refer yourself")]
    CannotReferSelf,
    #[msg("Referrer is not registered")]
    ReferrerNotRegistered,
    #[msg("Referrer already set")]
    ReferrerAlreadySet,
    #[msg("Already processed")]
    AlreadyProcessed,
    #[msg("No commission to withdraw")]
    NoCommissionToWithdraw,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Zero amount")]
    ZeroAmount,
}