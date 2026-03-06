use anchor_lang::prelude::*;

use crate::errors::DIRMError;
use crate::state::{DIRMConfig, Pool};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        constraint = authority.key() == dirm_config.authority @ DIRMError::InvalidParameter,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.usdc_mint.as_ref(), pool.susdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [b"dirm_config", pool.key().as_ref()],
        bump = dirm_config.bump,
    )]
    pub dirm_config: Account<'info, DIRMConfig>,
}

pub fn handler(
    ctx: Context<UpdateConfig>,
    amplification: Option<u64>,
    k: Option<u64>,
    r_max: Option<u64>,
    tau: Option<u64>,
) -> Result<()> {
    let config = &mut ctx.accounts.dirm_config;

    if let Some(a) = amplification {
        require!(a > 0, DIRMError::InvalidParameter);
        config.amplification = a;
    }
    if let Some(k_val) = k {
        require!(k_val > 0, DIRMError::InvalidParameter);
        config.k = k_val;
    }
    if let Some(r) = r_max {
        config.r_max = r;
    }
    if let Some(t) = tau {
        config.tau = t;
    }

    msg!(
        "Config updated: A={}, k={}, R_max={}, tau={}",
        config.amplification,
        config.k,
        config.r_max,
        config.tau
    );
    Ok(())
}
