use anchor_lang::prelude::*;

/// Pool state holding token reserves and configuration references.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    /// Authority that can manage the pool
    pub authority: Pubkey,
    /// USDC token mint
    pub usdc_mint: Pubkey,
    /// sUSDC token mint
    pub susdc_mint: Pubkey,
    /// Pool USDC vault (token account)
    pub usdc_vault: Pubkey,
    /// Pool sUSDC vault (token account)
    pub susdc_vault: Pubkey,
    /// Treasury USDC vault for penalty/subsidy settlement
    pub treasury_vault: Pubkey,
    /// DIRM configuration account
    pub dirm_config: Pubkey,
    /// PDA bump seed
    pub bump: u8,
}

/// DIRM configuration — all values stored as u64 in 6-decimal fixed-point
/// (1e6 = 1.0) for compact storage. Converted to 1e12 at runtime.
#[account]
#[derive(InitSpace)]
pub struct DIRMConfig {
    /// Governance authority that can update parameters
    pub authority: Pubkey,
    /// Amplification coefficient A (integer, not fixed-point)
    pub amplification: u64,
    /// Sensitivity k in 1e6 fixed-point (e.g., 30_000_000 = 30.0)
    pub k: u64,
    /// Max intervention rate R_max in 1e6 fixed-point (e.g., 50_000 = 0.05)
    pub r_max: u64,
    /// Dead zone threshold tau in 1e6 fixed-point (e.g., 20_000 = 0.02)
    pub tau: u64,
    /// Target price in 1e6 fixed-point (e.g., 1_000_000 = 1.0)
    pub target_price: u64,
    /// PDA bump seed
    pub bump: u8,
}

impl DIRMConfig {
    /// Storage scale factor (1e6)
    pub const STORAGE_SCALE: u64 = 1_000_000;

    /// Convert a storage-scale u64 to runtime-scale u128 (1e12)
    pub fn to_runtime(val: u64) -> u128 {
        (val as u128) * 1_000_000 // multiply by 1e6 to go from 1e6 -> 1e12
    }
}
