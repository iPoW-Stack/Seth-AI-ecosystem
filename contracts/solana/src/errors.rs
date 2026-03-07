//! 错误定义模块

use anchor_lang::prelude::*;

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
    
    #[msg("Invalid settlement time")]
    InvalidSettlementTime,
    
    #[msg("No pending funds to settle")]
    NoPendingFunds,
}

#[error_code]
pub enum RevenueError {
    #[msg("Invalid commission rate")]
    InvalidCommissionRate,
    
    #[msg("Settlement already done this month")]
    SettlementAlreadyDone,
    
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    
    #[msg("User not registered")]
    UserNotRegistered,
}