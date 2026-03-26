use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::dirm;
use crate::errors::DIRMError;
use crate::math::{self, SCALE};
use crate::state::{DIRMConfig, Pool};

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.usdc_mint.as_ref(), pool.susdc_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [b"dirm_config", pool.key().as_ref()],
        bump = dirm_config.bump,
    )]
    pub dirm_config: Account<'info, DIRMConfig>,

    /// USDC mint (not deserialized to reduce stack usage)
    /// CHECK: validated against pool.usdc_mint
    #[account(constraint = usdc_mint.key() == pool.usdc_mint)]
    pub usdc_mint: UncheckedAccount<'info>,

    /// sUSDC mint (not deserialized to reduce stack usage)
    /// CHECK: validated against pool.susdc_mint
    #[account(constraint = susdc_mint.key() == pool.susdc_mint)]
    pub susdc_mint: UncheckedAccount<'info>,

    /// Pool USDC vault
    #[account(
        mut,
        seeds = [b"vault_usdc", pool.key().as_ref()],
        bump,
        constraint = usdc_vault.key() == pool.usdc_vault,
    )]
    pub usdc_vault: Account<'info, TokenAccount>,

    /// Pool sUSDC vault
    #[account(
        mut,
        seeds = [b"vault_susdc", pool.key().as_ref()],
        bump,
        constraint = susdc_vault.key() == pool.susdc_vault,
    )]
    pub susdc_vault: Account<'info, TokenAccount>,

    /// Treasury vault
    #[account(
        mut,
        seeds = [b"treasury", pool.key().as_ref()],
        bump,
        constraint = treasury_vault.key() == pool.treasury_vault,
    )]
    pub treasury_vault: Account<'info, TokenAccount>,

    /// User's source token account (the token they're sending)
    #[account(mut)]
    pub user_source: Account<'info, TokenAccount>,

    /// User's destination token account (the token they're receiving)
    #[account(mut)]
    pub user_destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Direction of the swap
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SwapDirection {
    /// USDC -> sUSDC (buying sUSDC)
    UsdcToSusdc,
    /// sUSDC -> USDC (selling sUSDC)
    SusdcToUsdc,
}

pub fn handler(
    ctx: Context<Swap>,
    direction: SwapDirection,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(amount_in > 0, DIRMError::ZeroAmount);

    let config = &ctx.accounts.dirm_config;
    let a = config.amplification as u128;

    // Convert storage-scale params (1e6) to runtime-scale (1e12)
    let k = DIRMConfig::to_runtime(config.k);
    let r_max = DIRMConfig::to_runtime(config.r_max);
    let tau = DIRMConfig::to_runtime(config.tau);
    let target = DIRMConfig::to_runtime(config.target_price);

    // Current reserves in runtime fixed-point (token amounts * SCALE / 10^decimals)
    // Assuming 6-decimal tokens (USDC standard)
    let x_raw = ctx.accounts.usdc_vault.amount as u128;
    let y_raw = ctx.accounts.susdc_vault.amount as u128;
    let x = x_raw * (SCALE / 1_000_000); // 6-decimal token -> 12-decimal fp
    let y = y_raw * (SCALE / 1_000_000);

    // Solve for D and compute raw price
    let d = math::solve_d(a, x, y);
    let raw_p = math::raw_price(a, x, y, d);

    // Evaluate DIRM
    let dirm_result = dirm::evaluate(raw_p, target, tau, k, r_max);

    // Compute output amount from the invariant
    // For input dx, solve for new y' such that invariant holds with x' = x + dx
    let amount_in_fp = (amount_in as u128) * (SCALE / 1_000_000);

    let (_new_x, _new_y, amount_out_fp) = match direction {
        SwapDirection::UsdcToSusdc => {
            let new_x = x + amount_in_fp;
            // Solve invariant for new_y given new_x and same D
            let new_y = solve_for_y(a, new_x, d)?;
            let dy = y.checked_sub(new_y).ok_or(DIRMError::MathOverflow)?;
            (new_x, new_y, dy)
        }
        SwapDirection::SusdcToUsdc => {
            let new_y = y + amount_in_fp;
            let new_x = solve_for_y(a, new_y, d)?; // symmetric
            let dx = x.checked_sub(new_x).ok_or(DIRMError::MathOverflow)?;
            (new_x, new_y, dx)
        }
    };

    // Apply DIRM adjustment to output
    // If penalty (state=1): reduce output by treasury_delta proportion
    // If subsidy (state=2): increase output by treasury_delta proportion
    let treasury_delta_fp = dirm_result.treasury_delta;

    // Treasury delta in token units (6 decimals)
    // delta_tokens = amount_out * |R| (as fraction of 1.0)
    let treasury_amount = math::mul_fp(amount_out_fp, treasury_delta_fp);
    let treasury_tokens = (treasury_amount / (SCALE / 1_000_000)) as u64;

    let base_out_tokens = (amount_out_fp / (SCALE / 1_000_000)) as u64;

    let final_out_tokens = match dirm_result.state {
        0 => base_out_tokens, // Equilibrium — no adjustment
        1 => {
            // Penalty — reduce output, send delta to treasury
            base_out_tokens
                .checked_sub(treasury_tokens)
                .ok_or(DIRMError::MathOverflow)?
        }
        2 => {
            // Subsidy — increase output, fund from treasury
            require!(
                ctx.accounts.treasury_vault.amount >= treasury_tokens,
                DIRMError::InsufficientTreasury
            );
            base_out_tokens
                .checked_add(treasury_tokens)
                .ok_or(DIRMError::MathOverflow)?
        }
        _ => base_out_tokens,
    };

    // Slippage check
    require!(final_out_tokens >= min_amount_out, DIRMError::SlippageExceeded);

    // Execute transfers using pool PDA as signer
    let usdc_mint_key = ctx.accounts.pool.usdc_mint;
    let susdc_mint_key = ctx.accounts.pool.susdc_mint;
    let pool_bump = ctx.accounts.pool.bump;
    let seeds = &[
        b"pool".as_ref(),
        usdc_mint_key.as_ref(),
        susdc_mint_key.as_ref(),
        &[pool_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    // Transfer input from user to pool vault
    let (vault_in, vault_out) = match direction {
        SwapDirection::UsdcToSusdc => (
            ctx.accounts.usdc_vault.to_account_info(),
            ctx.accounts.susdc_vault.to_account_info(),
        ),
        SwapDirection::SusdcToUsdc => (
            ctx.accounts.susdc_vault.to_account_info(),
            ctx.accounts.usdc_vault.to_account_info(),
        ),
    };

    // User -> Pool vault (input)
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_source.to_account_info(),
                to: vault_in,
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
    )?;

    // Pool vault -> User (output)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: vault_out.clone(),
                to: ctx.accounts.user_destination.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            signer_seeds,
        ),
        final_out_tokens,
    )?;

    // Treasury settlement
    if dirm_result.state == 1 && treasury_tokens > 0 {
        // Penalty: pool vault -> treasury
        let penalty_source = match direction {
            SwapDirection::UsdcToSusdc => ctx.accounts.usdc_vault.to_account_info(),
            SwapDirection::SusdcToUsdc => ctx.accounts.usdc_vault.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: penalty_source,
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            treasury_tokens,
        )?;
    } else if dirm_result.state == 2 && treasury_tokens > 0 {
        // Subsidy: treasury -> pool vault (already accounted for in output)
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury_vault.to_account_info(),
                    to: vault_out,
                    authority: ctx.accounts.pool.to_account_info(),
                },
                signer_seeds,
            ),
            treasury_tokens,
        )?;
    }

    msg!(
        "Swap: in={}, out={}, R={}, state={}",
        amount_in,
        final_out_tokens,
        dirm_result.rate_r,
        dirm_result.state
    );

    Ok(())
}

/// Solve the Curve invariant for the other reserve given one reserve and D.
/// Uses Newton-Raphson on: 4A(x+y) + D = 4AD + D³/(4xy)
/// Rearranged for y: this is a quadratic in y given x and D.
fn solve_for_y(a: u128, x_new: u128, d: u128) -> Result<u128> {
    // From the invariant, rearranging for y:
    // y² + y(D - 4AD + 4Ax - D³/(4x·y)) = ... is complex.
    // Simpler: use Newton-Raphson on f(y) = 4A(x+y) + D - 4AD - D³/(4xy)
    let four_a = a * 4;
    let d2 = math::mul_fp(d, d);
    let d3 = math::mul_fp(d2, d);
    let four_a_x = math::mul_fp(four_a * SCALE, x_new);
    let four_a_d = four_a * SCALE; // 4A in fixed-point (will mul with D later)

    // Initial guess: current y ≈ D - x (rough)
    let mut y = if d > x_new { d - x_new } else { x_new / 2 };

    for _ in 0..32 {
        let four_xy = math::mul_fp(x_new, y) * 4;
        if four_xy == 0 {
            y = y / 2 + 1;
            continue;
        }

        // f(y) = 4A(x+y) + D - 4AD - D³/(4xy)
        let four_a_y = math::mul_fp(four_a * SCALE, y);
        let pos = four_a_x + four_a_y + d;
        let neg = math::mul_fp(four_a_d, d) + math::div_fp(d3, four_xy);

        // f'(y) = 4A + D³/(4xy²)
        let y2 = math::mul_fp(y, y);
        let four_xy2 = math::mul_fp(x_new, y2) * 4;
        let fp = four_a * SCALE + if four_xy2 > 0 { math::div_fp(d3, four_xy2) } else { 0 };

        if pos >= neg {
            let f_val = pos - neg;
            let step = math::div_fp(f_val, fp);
            let y_new = y.saturating_sub(step).max(1);
            if y_new.abs_diff(y) <= 1 {
                return Ok(y_new);
            }
            y = y_new;
        } else {
            let f_val = neg - pos;
            let step = math::div_fp(f_val, fp);
            let y_new = y + step;
            if y_new.abs_diff(y) <= 1 {
                return Ok(y_new);
            }
            y = y_new;
        }
    }

    Ok(y)
}
