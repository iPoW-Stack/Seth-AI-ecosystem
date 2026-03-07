//! 事件定义模块

use anchor_lang::prelude::*;

// ==================== Bridge 事件 ====================

/// 推荐关系设置事件
#[event]
pub struct ReferrerSet {
    pub user: Pubkey,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

/// 跨链完成事件
#[event]
pub struct CrossChainCompleted {
    pub solana_tx_sig: Pubkey,
    pub seth_tx_hash: [u8; 32],
    pub ecosystem_amount: u64,
    pub timestamp: i64,
}

/// Relayer 更新事件
#[event]
pub struct RelayerUpdated {
    pub old_relayer: Pubkey,
    pub new_relayer: Pubkey,
}

// ==================== Revenue 事件 ====================

/// 收入处理事件 (15-50-35 分账)
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

/// 佣金提取事件
#[event]
pub struct CommissionWithdrawn {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// 月底清算事件
#[event]
pub struct MonthlySettlement {
    pub team_funds: u64,
    pub project_funds: u64,
    pub timestamp: i64,
}