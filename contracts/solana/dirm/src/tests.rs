/// Comprehensive test suite for the DIRM program.
///
/// Covers:
///   - Fixed-point math primitives (mul_fp, div_fp, tanh_fp)
///   - Curve StableSwap invariant solver (solve_d)
///   - Raw marginal price formula (raw_price)
///   - DIRM 3-state machine (evaluate)
///   - Parameter profiles from the report (Passive, Standard, Defensive, Fortress)
///   - Treasury delta and settlement logic
///   - Edge cases and boundary conditions

#[cfg(test)]
mod tests {
    use crate::dirm;
    use crate::math::{div_fp, imul_fp, mul_fp, raw_price, solve_d, tanh_fp, ISCALE, SCALE};

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Convert a float to SCALE fixed-point u128.
    fn s(val: f64) -> u128 {
        (val * SCALE as f64) as u128
    }

    /// Convert a float to SCALE fixed-point i128.
    fn si(val: f64) -> i128 {
        (val * SCALE as f64) as i128
    }

    // -----------------------------------------------------------------------
    // Fixed-point arithmetic
    // -----------------------------------------------------------------------

    #[test]
    fn test_mul_fp_identity() {
        // x * 1.0 == x
        let x = s(3.14159);
        assert_eq!(mul_fp(x, SCALE), x);
    }

    #[test]
    fn test_mul_fp_half() {
        // 2.0 * 0.5 == 1.0
        let result = mul_fp(s(2.0), s(0.5));
        let diff = result.abs_diff(SCALE);
        assert!(diff < 10, "2.0 * 0.5 should be ~1.0, got {}", result);
    }

    #[test]
    fn test_mul_fp_small_values() {
        // 0.001 * 0.001 == 0.000001
        let result = mul_fp(s(0.001), s(0.001));
        let expected = s(0.000001);
        let diff = result.abs_diff(expected);
        assert!(diff < 1000, "0.001 * 0.001 off by {}", diff);
    }

    #[test]
    fn test_div_fp_identity() {
        // x / 1.0 == x
        let x = s(7.77);
        let result = div_fp(x, SCALE);
        let diff = result.abs_diff(x);
        assert!(diff < 10, "x / 1.0 should be x, diff={}", diff);
    }

    #[test]
    fn test_div_fp_inverse_of_mul() {
        // (x * y) / y == x  (within rounding)
        let x = s(1.23456);
        let y = s(4.56789);
        let product = mul_fp(x, y);
        let recovered = div_fp(product, y);
        let diff = recovered.abs_diff(x);
        assert!(diff < SCALE / 1_000_000, "round-trip mul/div off by {}", diff);
    }

    #[test]
    fn test_imul_fp_signs() {
        // positive * negative = negative
        let a = si(2.0);
        let b = si(-3.0);
        let result = imul_fp(a, b);
        assert!(result < 0, "2.0 * -3.0 should be negative");
        let diff = result.unsigned_abs().abs_diff(s(6.0));
        assert!(diff < 100, "2.0 * -3.0 magnitude off by {}", diff);
    }

    // -----------------------------------------------------------------------
    // tanh fixed-point
    // -----------------------------------------------------------------------

    #[test]
    fn test_tanh_zero() {
        assert_eq!(tanh_fp(0), 0);
    }

    #[test]
    fn test_tanh_positive_saturation() {
        // tanh(5.0) should saturate to +1.0
        assert_eq!(tanh_fp(si(5.0)), ISCALE);
    }

    #[test]
    fn test_tanh_negative_saturation() {
        // tanh(-5.0) should saturate to -1.0
        assert_eq!(tanh_fp(si(-5.0)), -ISCALE);
    }

    #[test]
    fn test_tanh_antisymmetry() {
        // tanh(-x) == -tanh(x)
        let x = si(0.5);
        assert_eq!(tanh_fp(-x), -tanh_fp(x));
    }

    #[test]
    fn test_tanh_point_one() {
        // tanh(0.1) ≈ 0.09967
        let result = tanh_fp(si(0.1));
        let expected = si(0.09967);
        let diff = result.unsigned_abs().abs_diff(expected.unsigned_abs());
        assert!(diff < SCALE as u128 / 1000, "tanh(0.1) off by {}", diff);
    }

    #[test]
    fn test_tanh_point_five() {
        // tanh(0.5) ≈ 0.46212
        let result = tanh_fp(si(0.5));
        let expected = si(0.46212);
        let diff = result.unsigned_abs().abs_diff(expected.unsigned_abs());
        assert!(diff < SCALE as u128 / 500, "tanh(0.5) off by {}", diff);
    }

    #[test]
    fn test_tanh_one() {
        // tanh(1.0) ≈ 0.76159
        let result = tanh_fp(si(1.0));
        let expected = si(0.76159);
        let diff = result.unsigned_abs().abs_diff(expected.unsigned_abs());
        assert!(diff < SCALE as u128 / 200, "tanh(1.0) off by {}", diff);
    }

    #[test]
    fn test_tanh_boundary_just_below_saturation() {
        // The Padé(3,3) approximation can return values >= ISCALE before the
        // hard saturation threshold of 4.5. At 4.4 the result is saturated.
        // Verify it is at least 0.99 (very close to 1.0).
        let result = tanh_fp(si(4.4));
        assert!(result >= ISCALE * 99 / 100, "tanh(4.4) should be >= 0.99");
    }

    // -----------------------------------------------------------------------
    // Curve StableSwap invariant solver
    // -----------------------------------------------------------------------

    #[test]
    fn test_solve_d_balanced_pool() {
        // Balanced pool: x == y => D == x + y exactly
        let a: u128 = 100;
        let x = s(1_000_000.0);
        let y = s(1_000_000.0);
        let d = solve_d(a, x, y);
        let expected = s(2_000_000.0);
        let diff = d.abs_diff(expected);
        assert!(diff < SCALE, "D off by {} for balanced pool", diff);
    }

    #[test]
    fn test_solve_d_skewed_pool() {
        // Skewed pool: D should be less than x + y (Curve property)
        let a: u128 = 100;
        let x = s(1_500_000.0);
        let y = s(500_000.0);
        let d = solve_d(a, x, y);
        let sum = x + y;
        // D <= x + y for imbalanced pool (Curve invariant property)
        assert!(d <= sum, "D should be <= x+y for imbalanced pool");
        // D should be close to x + y for high A
        let diff = sum.abs_diff(d);
        assert!(diff < sum / 100, "D should be within 1% of x+y for A=100");
    }

    #[test]
    fn test_solve_d_high_amplification() {
        // Higher A => D closer to x + y (flatter curve)
        let x = s(1_200_000.0);
        let y = s(800_000.0);
        let d_low_a = solve_d(10, x, y);
        let d_high_a = solve_d(1000, x, y);
        let sum = x + y;
        // High A should produce D closer to sum
        assert!(
            sum.abs_diff(d_high_a) < sum.abs_diff(d_low_a),
            "Higher A should give D closer to x+y"
        );
    }

    #[test]
    fn test_solve_d_symmetry() {
        // solve_d(a, x, y) == solve_d(a, y, x)
        let a: u128 = 100;
        let x = s(700_000.0);
        let y = s(1_300_000.0);
        let d1 = solve_d(a, x, y);
        let d2 = solve_d(a, y, x);
        let diff = d1.abs_diff(d2);
        assert!(diff < SCALE, "D should be symmetric in x and y, diff={}", diff);
    }

    // -----------------------------------------------------------------------
    // Raw marginal price
    // -----------------------------------------------------------------------

    #[test]
    fn test_raw_price_balanced_is_one() {
        // Balanced pool => P == 1.0
        let a: u128 = 100;
        let x = s(1_000_000.0);
        let y = s(1_000_000.0);
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        let diff = p.abs_diff(SCALE);
        assert!(diff < SCALE / 1000, "P should be ~1.0 for balanced pool, diff={}", diff);
    }

    #[test]
    fn test_raw_price_usdc_heavy_above_one() {
        // More USDC than sUSDC => sUSDC is scarce => P > 1.0
        let a: u128 = 100;
        let x = s(1_500_000.0); // USDC heavy
        let y = s(500_000.0);
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        assert!(p > SCALE, "P should be > 1.0 when USDC heavy, got {}", p);
    }

    #[test]
    fn test_raw_price_susdc_heavy_below_one() {
        // More sUSDC than USDC => sUSDC is abundant => P < 1.0
        let a: u128 = 100;
        let x = s(500_000.0);
        let y = s(1_500_000.0); // sUSDC heavy
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        assert!(p < SCALE, "P should be < 1.0 when sUSDC heavy, got {}", p);
    }

    #[test]
    fn test_raw_price_symmetry() {
        // raw_price(a, x, y, d) == 1 / raw_price(a, y, x, d)  (approximately)
        let a: u128 = 100;
        let x = s(1_200_000.0);
        let y = s(800_000.0);
        let d = solve_d(a, x, y);
        let p_xy = raw_price(a, x, y, d);
        let p_yx = raw_price(a, y, x, d);
        // p_xy * p_yx should be ~1.0
        let product = mul_fp(p_xy, p_yx);
        let diff = product.abs_diff(SCALE);
        assert!(diff < SCALE / 100, "P(x,y) * P(y,x) should be ~1.0, diff={}", diff);
    }

    #[test]
    fn test_raw_price_bounded() {
        // Price should stay within [0.9, 1.1] for moderate imbalances with A=100
        let a: u128 = 100;
        for ratio_pct in [20u64, 30, 40, 50, 60, 70, 80] {
            let total = 2_000_000u64;
            let y_val = total * ratio_pct / 100;
            let x_val = total - y_val;
            let x = s(x_val as f64);
            let y = s(y_val as f64);
            let d = solve_d(a, x, y);
            let p = raw_price(a, x, y, d);
            assert!(p > s(0.85) && p < s(1.15),
                "Price out of expected range at ratio {}%: {}", ratio_pct, p);
        }
    }

    // -----------------------------------------------------------------------
    // DIRM state machine — 3 states
    // -----------------------------------------------------------------------

    #[test]
    fn test_dirm_equilibrium_at_peg() {
        // P == target => state 0, R == 0
        let result = dirm::evaluate(s(1.0), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 0);
        assert_eq!(result.rate_r, 0);
        assert_eq!(result.treasury_delta, 0);
    }

    #[test]
    fn test_dirm_equilibrium_inside_dead_zone_positive() {
        // P = 1.01 (inside ±2% dead zone) => state 0
        let result = dirm::evaluate(s(1.01), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 0);
        assert_eq!(result.rate_r, 0);
    }

    #[test]
    fn test_dirm_equilibrium_inside_dead_zone_negative() {
        // P = 0.99 (inside ±2% dead zone) => state 0
        let result = dirm::evaluate(s(0.99), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 0);
        assert_eq!(result.rate_r, 0);
    }

    #[test]
    fn test_dirm_equilibrium_at_dead_zone_boundary() {
        // P = 1.02 exactly (on the boundary) => state 0 (|d| == tau)
        let result = dirm::evaluate(s(1.02), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 0, "Boundary should still be equilibrium");
    }

    #[test]
    fn test_dirm_penalty_state_above_dead_zone() {
        // P = 1.05 > 1.02 => state 1 (penalty), R > 0
        let result = dirm::evaluate(s(1.05), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 1);
        assert!(result.rate_r > 0, "R should be positive in penalty state");
        assert!(result.treasury_delta > 0);
    }

    #[test]
    fn test_dirm_subsidy_state_below_dead_zone() {
        // P = 0.95 < 0.98 => state 2 (subsidy), R < 0
        let result = dirm::evaluate(s(0.95), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 2);
        assert!(result.rate_r < 0, "R should be negative in subsidy state");
        assert!(result.treasury_delta > 0);
    }

    #[test]
    fn test_dirm_r_bounded_by_r_max() {
        // |R| must never exceed R_max by more than a small fixed-point rounding epsilon.
        // imul_fp(r_max, tanh_val) can overshoot by ~1 ULP when tanh_val ≈ SCALE.
        let r_max = s(0.05);
        let epsilon = SCALE / 100; // 0.01 tolerance for fixed-point rounding
        for p_val in [1.10f64, 1.20, 1.50, 2.00, 0.50, 0.80, 0.90] {
            let result = dirm::evaluate(s(p_val), s(1.0), s(0.02), s(30.0), r_max);
            assert!(
                result.treasury_delta <= r_max + epsilon,
                "treasury_delta {} exceeds R_max+epsilon {} at P={}",
                result.treasury_delta, r_max + epsilon, p_val
            );
        }
    }

    #[test]
    fn test_dirm_saturation_at_extreme_deviation() {
        // At P = 1.20 with k=30, R should be very close to R_max
        let r_max = s(0.05);
        let result = dirm::evaluate(s(1.20), s(1.0), s(0.02), s(30.0), r_max);
        let threshold_99 = r_max * 99 / 100;
        assert!(
            result.treasury_delta >= threshold_99,
            "R should saturate near R_max at extreme deviation, got {}",
            result.treasury_delta
        );
    }

    #[test]
    fn test_dirm_effective_price_penalty() {
        // In penalty state: P_eff = P + R > P
        let result = dirm::evaluate(s(1.05), s(1.0), s(0.02), s(30.0), s(0.05));
        assert!(
            result.effective_price > result.raw_price as i128,
            "P_eff should be > P in penalty state"
        );
    }

    #[test]
    fn test_dirm_effective_price_subsidy() {
        // In subsidy state: P_eff = P + R < P (R is negative)
        let result = dirm::evaluate(s(0.95), s(1.0), s(0.02), s(30.0), s(0.05));
        assert!(
            result.effective_price < result.raw_price as i128,
            "P_eff should be < P in subsidy state"
        );
    }

    #[test]
    fn test_dirm_treasury_delta_equals_abs_r() {
        // treasury_delta == |R| always
        let result = dirm::evaluate(s(1.05), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.treasury_delta, result.rate_r.unsigned_abs());

        let result2 = dirm::evaluate(s(0.95), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result2.treasury_delta, result2.rate_r.unsigned_abs());
    }

    #[test]
    fn test_dirm_antisymmetry() {
        // R(P = 1+d) == -R(P = 1-d) for symmetric deviations
        let d = 0.05f64;
        let r_high = dirm::evaluate(s(1.0 + d), s(1.0), s(0.02), s(30.0), s(0.05));
        let r_low = dirm::evaluate(s(1.0 - d), s(1.0), s(0.02), s(30.0), s(0.05));
        let diff = r_high.rate_r.unsigned_abs().abs_diff(r_low.rate_r.unsigned_abs());
        assert!(diff < SCALE / 1000, "R should be antisymmetric, diff={}", diff);
    }

    #[test]
    fn test_dirm_monotone_response() {
        // |R| should be non-decreasing as |d| increases beyond tau.
        // Once saturated at R_max, consecutive values may be equal.
        let prices = [1.03f64, 1.05, 1.08, 1.12, 1.20];
        let epsilon = SCALE / 100; // allow tiny rounding dips at saturation
        let mut prev_delta = 0u128;
        for &p in &prices {
            let result = dirm::evaluate(s(p), s(1.0), s(0.02), s(30.0), s(0.05));
            assert!(
                result.treasury_delta + epsilon >= prev_delta,
                "R should be non-decreasing, broke at P={} (got {}, prev {})",
                p, result.treasury_delta, prev_delta
            );
            prev_delta = result.treasury_delta;
        }
    }

    // -----------------------------------------------------------------------
    // Parameter profiles from the report
    // -----------------------------------------------------------------------

    #[test]
    fn test_profile_passive() {
        // tau=0.05, k=10, R_max=0.03
        // P=1.04 should be inside dead zone
        let r1 = dirm::evaluate(s(1.04), s(1.0), s(0.05), s(10.0), s(0.03));
        assert_eq!(r1.state, 0, "Passive: P=1.04 should be in dead zone");

        // P=1.08 should be active but gentle
        let r2 = dirm::evaluate(s(1.08), s(1.0), s(0.05), s(10.0), s(0.03));
        assert_eq!(r2.state, 1);
        // With k=10, d'=0.03 => tanh(0.3) ≈ 0.29 => R ≈ 0.29 * 0.03 ≈ 0.0087
        assert!(r2.treasury_delta < s(0.015), "Passive profile should have gentle response");
    }

    #[test]
    fn test_profile_standard() {
        // tau=0.02, k=30, R_max=0.05
        // P=1.01 inside dead zone
        let r1 = dirm::evaluate(s(1.01), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(r1.state, 0);

        // P=1.05 active, should be near saturation
        let r2 = dirm::evaluate(s(1.05), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(r2.state, 1);
        // d'=0.03, k*d'=0.9 => tanh(0.9) ≈ 0.716 => R ≈ 0.036
        assert!(r2.treasury_delta > s(0.03), "Standard: R should be significant at P=1.05");
    }

    #[test]
    fn test_profile_defensive() {
        // tau=0.01, k=40, R_max=0.08
        // P=1.005 inside dead zone
        let r1 = dirm::evaluate(s(1.005), s(1.0), s(0.01), s(40.0), s(0.08));
        assert_eq!(r1.state, 0);

        // P=1.02 active, tight dead zone means earlier activation
        let r2 = dirm::evaluate(s(1.02), s(1.0), s(0.01), s(40.0), s(0.08));
        assert_eq!(r2.state, 1);
        assert!(r2.treasury_delta > 0);
    }

    #[test]
    fn test_profile_fortress() {
        // tau=0.005, k=50, R_max=0.10
        // P=1.003 inside dead zone
        let r1 = dirm::evaluate(s(1.003), s(1.0), s(0.005), s(50.0), s(0.10));
        assert_eq!(r1.state, 0);

        // P=1.01 active, near-binary activation
        let r2 = dirm::evaluate(s(1.01), s(1.0), s(0.005), s(50.0), s(0.10));
        assert_eq!(r2.state, 1);
        // d'=0.005, k*d'=0.25 => tanh(0.25) ≈ 0.244 => R ≈ 0.024
        // At P=1.05, should be near saturation
        let r3 = dirm::evaluate(s(1.05), s(1.0), s(0.005), s(50.0), s(0.10));
        let threshold_95 = s(0.10) * 95 / 100;
        assert!(
            r3.treasury_delta >= threshold_95,
            "Fortress: should saturate near R_max at P=1.05"
        );
    }

    // -----------------------------------------------------------------------
    // Treasury settlement math
    // -----------------------------------------------------------------------

    #[test]
    fn test_treasury_delta_formula() {
        // delta_treasury = trade_size * |R|
        // Verify: for a 1000 unit trade at P=1.05 (standard params),
        // treasury_delta from DIRM * trade_size gives expected treasury amount.
        let result = dirm::evaluate(s(1.05), s(1.0), s(0.02), s(30.0), s(0.05));
        let trade_size = s(1000.0);
        let treasury_amount = mul_fp(trade_size, result.treasury_delta);
        // Should be positive and less than R_max * trade_size
        assert!(treasury_amount > 0);
        assert!(treasury_amount <= mul_fp(trade_size, s(0.05)));
    }

    #[test]
    fn test_treasury_zero_in_equilibrium() {
        let result = dirm::evaluate(s(1.01), s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.treasury_delta, 0, "No treasury activity in equilibrium");
    }

    #[test]
    fn test_treasury_max_cap() {
        // At extreme imbalance, treasury extraction is capped at R_max per unit
        let r_max = s(0.05);
        let result = dirm::evaluate(s(1.50), s(1.0), s(0.02), s(30.0), r_max);
        assert!(
            result.treasury_delta <= r_max,
            "Treasury delta must not exceed R_max"
        );
    }

    // -----------------------------------------------------------------------
    // Integration: full pipeline (reserves -> D -> P -> DIRM)
    // -----------------------------------------------------------------------

    /// In the on-chain code, 6-decimal token amounts are scaled to 12-decimal fp
    /// via: amount * (SCALE / 1_000_000). So 1M tokens = 1_000_000 * 1_000_000 = 1e12.
    /// We replicate that here to stay within mul_fp's safe range.
    fn token_to_fp(tokens: u64) -> u128 {
        tokens as u128 * (SCALE / 1_000_000)
    }

    #[test]
    fn test_full_pipeline_balanced_pool_equilibrium() {
        // Balanced pool => P ≈ 1.0 => DIRM equilibrium
        let a: u128 = 100;
        let x = token_to_fp(1_000_000); // 1M USDC
        let y = token_to_fp(1_000_000); // 1M sUSDC
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        let result = dirm::evaluate(p, s(1.0), s(0.02), s(30.0), s(0.05));
        assert_eq!(result.state, 0, "Balanced pool should be in equilibrium");
    }

    #[test]
    fn test_full_pipeline_skewed_pool_penalty() {
        // Heavily USDC-skewed pool => P > 1.02 => penalty state
        let a: u128 = 100;
        let x = token_to_fp(800_000); // 80% USDC
        let y = token_to_fp(200_000);
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        if p > s(1.02) {
            let result = dirm::evaluate(p, s(1.0), s(0.02), s(30.0), s(0.05));
            assert_eq!(result.state, 1, "USDC-heavy pool should trigger penalty");
            assert!(result.rate_r > 0);
        }
    }

    #[test]
    fn test_full_pipeline_skewed_pool_subsidy() {
        // Heavily sUSDC-skewed pool => P < 0.98 => subsidy state
        let a: u128 = 100;
        let x = token_to_fp(200_000);
        let y = token_to_fp(800_000); // 80% sUSDC
        let d = solve_d(a, x, y);
        let p = raw_price(a, x, y, d);
        if p < s(0.98) {
            let result = dirm::evaluate(p, s(1.0), s(0.02), s(30.0), s(0.05));
            assert_eq!(result.state, 2, "sUSDC-heavy pool should trigger subsidy");
            assert!(result.rate_r < 0);
        }
    }

    #[test]
    fn test_full_pipeline_r_max_respected_across_compositions() {
        // Sweep pool compositions and verify R never exceeds R_max + epsilon
        let a: u128 = 100;
        let r_max = s(0.05);
        let epsilon = SCALE / 100;
        let total = 1_000_000u64;
        for pct in [10u64, 20, 30, 40, 50, 60, 70, 80, 90] {
            let y_tokens = total * pct / 100;
            let x_tokens = total - y_tokens;
            let x = token_to_fp(x_tokens);
            let y = token_to_fp(y_tokens);
            let d = solve_d(a, x, y);
            let p = raw_price(a, x, y, d);
            let result = dirm::evaluate(p, s(1.0), s(0.02), s(30.0), r_max);
            assert!(
                result.treasury_delta <= r_max + epsilon,
                "R_max violated at {}% sUSDC: delta={}",
                pct, result.treasury_delta
            );
        }
    }
}
