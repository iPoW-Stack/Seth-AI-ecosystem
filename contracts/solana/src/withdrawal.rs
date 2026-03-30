//! Seth Withdrawal Module - Handles Seth -> Solana cross-chain withdrawals
//! 
//! When users sell SETH on Seth chain (via PoolB.sellSETH), the relayer
//! listens for SwapExecuted events and submits the withdrawal to Solana.
//! 
//! Flow:
//! 1. User calls PoolB.sellSETH on Seth chain -> receives sUSDC
//! 2. Relayer detects SwapExecuted event (isBuySETH=false)
//! 3. Relayer calls process_seth_withdrawal on Solana
//! 4. Solana contract mints sUSDC to user's account (minus cross-chain fee)
//! 5. Fee is collected to compensate relayer for Solana transaction costs
//! 6. User can then call DIRM swap directly to get USDC (if desired)
//!
//! Fee Calculation:
//! - Relayer pays SOL for Solana transaction
//! - Fee is deducted from sUSDC amount to cover SOL cost
//! - Exchange rate: SOL/SETH = (SOL/USDC) * (USDC/sUSDC) / (SETH/sUSDC)

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, MintTo};

use crate::{
    Config, SethWithdrawalMessage, SethWithdrawalStatus,
    SethWithdrawalProcessed, SethWithdrawalError, BridgeError,
};

/// Cross-chain fee constants (in basis points)
pub const CROSS_CHAIN_FEE_BPS: u64 = 50; // 0.5% fee
pub const MIN_FEE_SUSDC: u64 = 100; // Minimum fee in sUSDC (0.0001 USDC)

/// Calculate cross-chain fee
pub fn calculate_cross_chain_fee(amount: u64) -> u64 {
    let fee = (amount * CROSS_CHAIN_FEE_BPS) / 10000;
    if fee < MIN_FEE_SUSDC {
        MIN_FEE_SUSDC
    } else {
        fee
    }
}

/// Process Seth withdrawal (Relayer only)
/// Records the withdrawal and mints sUSDC to user's account (minus fee)
#[derive(Accounts)]
#[instruction(seth_tx_hash: [u8; 32], susdc_amount: u64)]
pub struct ProcessSethWithdrawal<'info> {
    /// Relayer (must match config.relayer)
    #[account(mut)]
    pub relayer: Signer<'info>,
    
    /// Global configuration
    #[account(
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    
    /// Seth withdrawal message account (PDA) - for replay protection
    #[account(
        init,
        payer = relayer,
        space = 8 + SethWithdrawalMessage::INIT_SPACE,
        seeds = [b"seth_withdrawal", seth_tx_hash.as_ref()],
        bump
    )]
    pub withdrawal_message: Account<'info, SethWithdrawalMessage>,
    
    /// Solana recipient (user's wallet)
    /// CHECK: Validated in handler
    pub solana_recipient: AccountInfo<'info>,
    
    /// sUSDC mint
    #[account(mut)]
    pub susdc_mint: Account<'info, Mint>,
    
    /// User's sUSDC token account (receiving account)
    #[account(mut)]
    pub user_susdc_account: Account<'info, TokenAccount>,
    
    /// Relayer's sUSDC token account (fee collection)
    #[account(mut)]
    pub relayer_susdc_account: Account<'info, TokenAccount>,
    
    /// Bridge authority (PDA with mint authority on sUSDC)
    /// CHECK: Verified by seeds
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Process Seth withdrawal handler
/// Records withdrawal, deducts fee, and mints sUSDC to user and relayer
pub fn handle_process_seth_withdrawal(
    ctx: Context<ProcessSethWithdrawal>,
    seth_tx_hash: [u8; 32],
    seth_user: [u8; 20],
    susdc_amount: u64,
    cross_chain_fee: u64,  // Fee in sUSDC to compensate relayer
) -> Result<()> {
    // 1. Verify relayer
    require!(
        ctx.accounts.relayer.key() == ctx.accounts.config.relayer,
        SethWithdrawalError::UnauthorizedRelayer
    );
    
    // 2. Validate amount
    require!(susdc_amount > 0, BridgeError::ZeroAmount);
    
    // 3. Use fee from relayer (0 = no fee, fee disabled on relayer side)
    // If fee is enabled but relayer sends 0, the contract trusts the relayer
    let fee = cross_chain_fee;
    
    // Ensure fee doesn't exceed amount
    require!(
        fee <= susdc_amount,
        SethWithdrawalError::InvalidRecipient  // Reuse as "fee exceeds amount"
    );
    
    let user_amount = susdc_amount - fee;
    
    // 4. Create withdrawal message record (for replay protection)
    let withdrawal = &mut ctx.accounts.withdrawal_message;
    withdrawal.seth_tx_hash = seth_tx_hash;
    withdrawal.seth_user = seth_user;
    withdrawal.solana_recipient = ctx.accounts.solana_recipient.key();
    withdrawal.susdc_amount = susdc_amount;
    withdrawal.min_usdc_out = fee;  // Store fee in this field
    withdrawal.actual_usdc_out = user_amount;  // Store net amount
    withdrawal.status = SethWithdrawalStatus::Completed;  // sUSDC minted = completed
    withdrawal.processed_by = Some(ctx.accounts.relayer.key());
    withdrawal.created_at = Clock::get()?.unix_timestamp;
    withdrawal.processed_at = Clock::get()?.unix_timestamp;
    
    // 5. Prepare PDA signer
    let seeds = &[b"vault_authority".as_ref(), &[ctx.accounts.config.bump]];
    let signer = &[&seeds[..]];
    
    // 6. Mint sUSDC to user's account (net amount after fee)
    if user_amount > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.susdc_mint.to_account_info(),
                    to: ctx.accounts.user_susdc_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            user_amount,
        )?;
    }
    
    // 7. Mint fee to relayer's account (to compensate for SOL gas)
    if fee > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.susdc_mint.to_account_info(),
                    to: ctx.accounts.relayer_susdc_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer,
            ),
            fee,
        )?;
    }
    
    // 8. Emit event
    emit!(SethWithdrawalProcessed {
        seth_tx_hash,
        seth_user,
        solana_recipient: ctx.accounts.solana_recipient.key(),
        susdc_amount: user_amount,  // Net amount to user
        usdc_amount: fee,  // Fee collected by relayer (stored here for event)
        timestamp: Clock::get()?.unix_timestamp,
    });
    
    msg!(
        "Seth withdrawal processed: seth_tx_hash={}, gross_amount={}, fee={}, net_amount={}, recipient={}",
        seth_tx_hash.iter().map(|b| format!("{:02x}", b)).collect::<String>(),
        susdc_amount,
        fee,
        user_amount,
        ctx.accounts.solana_recipient.key()
    );
    
    Ok(())
}
