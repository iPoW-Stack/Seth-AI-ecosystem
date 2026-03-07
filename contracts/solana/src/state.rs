//! 状态数据结构模块

use anchor_lang::prelude::*;

// ==================== 全局配置 ====================

/// 全局配置账户
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// 管理员
    pub owner: Pubkey,
    
    /// Seth链Treasury地址
    pub seth_treasury: Pubkey,
    
    /// 团队钱包 (5%)
    pub team_wallet: Pubkey,
    
    /// 项目方钱包 (45%)
    pub project_wallet: Pubkey,
    
    /// Vault PDA授权
    pub vault_authority: Pubkey,
    
    /// 受信任的Relayer
    pub relayer: Pubkey,
    
    /// PDA bump
    pub bump: u8,
    
    // ===== 统计 =====
    
    /// 总收入
    pub total_revenue: u64,
    
    /// 总分发佣金
    pub total_commission_distributed: u64,
    
    /// 总跨链生态资金
    pub total_ecosystem_transferred: u64,
    
    // ===== 待清算资金 =====
    
    /// 待拨付团队激励
    pub pending_team_funds: u64,
    
    /// 待拨付项目方储备
    pub pending_project_funds: u64,
    
    /// 上次清算时间
    pub last_settlement_timestamp: i64,
}

// ==================== Vault ====================

/// Vault 授权账户
#[account]
#[derive(InitSpace)]
pub struct VaultAuthority {
    pub bump: u8,
}

// ==================== 用户相关 ====================

/// 用户信息账户
#[account]
#[derive(InitSpace)]
pub struct UserInfo {
    /// 用户地址
    pub user: Pubkey,
    
    /// L1 推荐人
    pub referrer: Pubkey,
    
    /// 是否已注册
    pub is_registered: bool,
    
    /// 总交易量
    pub total_volume: u64,
    
    /// 累计获得的佣金
    pub total_commission_earned: u64,
    
    /// 待提取佣金
    pub pending_commission: u64,
    
    /// 注册时间
    pub created_at: i64,
}

// ==================== 跨链消息 ====================

/// 跨链消息状态
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CrossChainStatus {
    Pending,
    Completed,
    Failed,
}

/// 跨链消息账户
#[account]
#[derive(InitSpace)]
pub struct CrossChainMessage {
    /// 发送者
    pub sender: Pubkey,
    
    /// 原始金额
    pub original_amount: u64,
    
    /// 跨链金额 (35%)
    pub amount: u64,
    
    /// Seth链接收地址
    pub seth_recipient: [u8; 20],
    
    // ===== 分账详情 =====
    
    /// L1佣金
    pub commission_l1: u64,
    
    /// L2佣金
    pub commission_l2: u64,
    
    /// 团队资金
    pub team_funds: u64,
    
    /// 项目方资金
    pub project_funds: u64,
    
    /// 产品类型
    pub product_type: u8,
    
    /// L1 推荐人
    pub l1_referrer: Option<Pubkey>,
    
    /// L2 推荐人
    pub l2_referrer: Option<Pubkey>,
    
    /// 状态
    pub status: CrossChainStatus,
    
    /// Seth链交易哈希
    pub seth_tx_hash: [u8; 32],
    
    /// 创建时间
    pub created_at: i64,
    
    /// 处理时间
    pub processed_at: i64,
}