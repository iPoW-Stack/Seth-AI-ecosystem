use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::Pool;

#[derive(Accounts)]
pub struct InitializeVaults<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        seeds = [b"pool", pool.usdc_mint.as_ref(), pool.susdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    pub usdc_mint: Account<'info, Mint>,
    pub susdc_mint: Account<'info, Mint>,

    /// Pool USDC vault
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = pool,
        seeds = [b"vault_usdc", pool.key().as_ref()],
        bump,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// Pool sUSDC vault
    #[account(
        init,
        payer = authority,
        token::mint = susdc_mint,
        token::authority = pool,
        seeds = [b"vault_susdc", pool.key().as_ref()],
        bump,
    )]
    pub susdc_vault: Account<'info, TokenAccount>,

    /// Treasury vault for DIRM settlement
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = pool,
        seeds = [b"treasury", pool.key().as_ref()],
        bump,
    )]
    pub treasury_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<InitializeVaults>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.usdc_vault = ctx.accounts.usdc_vault.key();
    pool.susdc_vault = ctx.accounts.susdc_vault.key();
    pool.treasury_vault = ctx.accounts.treasury_vault.key();

    msg!("Vaults initialized for pool: {}", pool.key());
    Ok(())
}
