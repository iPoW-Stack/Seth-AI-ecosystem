/// Pure DIRM engine — no Solana dependencies.
/// Takes raw price and config, returns intervention rate and effective price.
use crate::math::{imul_fp, tanh_fp};

/// Result of the DIRM state machine evaluation.
pub struct DIRMResult {
    /// Raw marginal price P (SCALE fixed-point, unsigned)
    pub raw_price: u128,
    /// Intervention rate R (SCALE fixed-point, signed)
    pub rate_r: i128,
    /// Effective execution price P_eff = P + R (SCALE fixed-point, signed)
    pub effective_price: i128,
    /// Treasury delta per unit = |R| (SCALE fixed-point, unsigned)
    pub treasury_delta: u128,
    /// 0 = Equilibrium, 1 = Penalty (P > target + tau), 2 = Subsidy (P < target - tau)
    pub state: u8,
}

/// Evaluate the 3-state nonlinear DIRM.
///
/// All inputs in SCALE (1e12) fixed-point.
/// - `raw_price`: the raw marginal price P from the Curve invariant
/// - `target`: target peg price (typically 1.0 * SCALE)
/// - `tau`: dead zone threshold
/// - `k`: sensitivity coefficient (steepness of tanh)
/// - `r_max`: maximum intervention rate cap
pub fn evaluate(
    raw_price: u128,
    target: u128,
    tau: u128,
    k: u128,
    r_max: u128,
) -> DIRMResult {
    let p_signed = raw_price as i128;
    let target_signed = target as i128;
    let tau_signed = tau as i128;

    // d = P - P_target
    let d = p_signed.checked_sub(target_signed).expect("dirm d");

    let abs_d = d.unsigned_abs();

    if abs_d <= tau as u128 {
        // State 1: Equilibrium — no intervention
        return DIRMResult {
            raw_price,
            rate_r: 0,
            effective_price: p_signed,
            treasury_delta: 0,
            state: 0,
        };
    }

    // Shifted deviation: d' = d - sgn(d) * tau
    let sign: i128 = if d > 0 { 1 } else { -1 };
    let d_shifted = d.checked_sub(sign * tau_signed).expect("dirm d_shifted");

    // R = R_max * tanh(k * d')
    // k is stored as unsigned fixed-point, convert for signed mul
    let k_signed = k as i128;
    let k_d = imul_fp(k_signed, d_shifted);
    let tanh_val = tanh_fp(k_d);
    let rate_r = imul_fp(r_max as i128, tanh_val);

    let effective_price = p_signed.checked_add(rate_r).expect("dirm p_eff");
    let treasury_delta = rate_r.unsigned_abs();

    let state = if d > 0 { 1 } else { 2 };

    DIRMResult {
        raw_price,
        rate_r,
        effective_price,
        treasury_delta,
        state,
    }
}

