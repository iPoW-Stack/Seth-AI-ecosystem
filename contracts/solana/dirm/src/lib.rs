use anchor_lang::prelude::*;

pub mod dirm;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

#[cfg(test)]
mod tests;

use instructions::*;

declare_id!("7yxEZzWfZxJuhRLJUQwjSioiJ49NMDa1bw2JyBFwYcE7");

#[program]
pub mod dirm_program {
    use super::*;

    /// Initialize pool state and DIRM configuration (step 1 of 2).
    /// Parameters are in 1e6 fixed-point (e.g., k=30_000_000 means k=30.0).
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        amplification: u64,
        k: u64,
        r_max: u64,
        tau: u64,
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, amplification, k, r_max, tau)
    }

    /// Initialize token vaults for the pool (step 2 of 2).
    /// Must be called after initialize_pool.
    pub fn initialize_vaults(ctx: Context<InitializeVaults>) -> Result<()> {
        instructions::initialize_vaults::handler(ctx)
    }

    /// Execute a swap through the DIRM state machine.
    pub fn swap(
        ctx: Context<Swap>,
        direction: SwapDirection,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::swap::handler(ctx, direction, amount_in, min_amount_out)
    }

    /// Update DIRM parameters (governance only).
    /// Pass None for any parameter to leave it unchanged.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        amplification: Option<u64>,
        k: Option<u64>,
        r_max: Option<u64>,
        tau: Option<u64>,
    ) -> Result<()> {
        instructions::update_config::handler(ctx, amplification, k, r_max, tau)
    }
}
