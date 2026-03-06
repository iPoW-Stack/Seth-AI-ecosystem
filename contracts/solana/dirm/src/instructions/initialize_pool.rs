use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::state::{DIRMConfig, Pool};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", usdc_mint.key().as_ref(), susdc_mint.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = authority,
        space = 8 + DIRMConfig::INIT_SPACE,
        seeds = [b"dirm_config", pool.key().as_ref()],
        bump,
    )]
    pub dirm_config: Account<'info, DIRMConfig>,

    pub usdc_mint: Account<'info, Mint>,
    pub susdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    amplification: u64,
    k: u64,
    r_max: u64,
    tau: u64,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.authority = ctx.accounts.authority.key();
    pool.usdc_mint = ctx.accounts.usdc_mint.key();
    pool.susdc_mint = ctx.accounts.susdc_mint.key();
    pool.dirm_config = ctx.accounts.dirm_config.key();
    pool.bump = ctx.bumps.pool;

    let config = &mut ctx.accounts.dirm_config;
    config.authority = ctx.accounts.authority.key();
    config.amplification = amplification;
    config.k = k;
    config.r_max = r_max;
    config.tau = tau;
    config.target_price = DIRMConfig::STORAGE_SCALE;
    config.bump = ctx.bumps.dirm_config;

    msg!("Pool initialized: A={}, k={}, R_max={}, tau={}", amplification, k, r_max, tau);
    Ok(())
}
