/// Fixed-point math library for on-chain DIRM calculations.
///
/// All prices and rates use 12-decimal fixed-point representation (SCALE = 1e12).
/// Intermediate calculations use u128 to avoid overflow.

/// 12-decimal fixed-point scale factor
pub const SCALE: u128 = 1_000_000_000_000; // 1e12

/// SCALE as i128 for signed operations
pub const ISCALE: i128 = SCALE as i128;

/// Multiply two fixed-point u128 values: (a * b) / SCALE
/// Uses split multiplication to avoid overflow for large values.
pub fn mul_fp(a: u128, b: u128) -> u128 {
    // Split SCALE into two factors: 1e6 * 1e6
    let half = 1_000_000_u128;
    // (a / half) * b / half — loses minimal precision, avoids overflow
    let a_hi = a / half;
    let a_lo = a % half;
    // result = a_hi * b / half + a_lo * b / SCALE
    let term1 = a_hi.checked_mul(b).expect("mul_fp term1 overflow") / half;
    let term2 = a_lo.checked_mul(b).expect("mul_fp term2 overflow") / SCALE;
    term1 + term2
}

/// Divide two fixed-point u128 values: (a * SCALE) / b
/// Uses split multiplication to avoid overflow.
pub fn div_fp(a: u128, b: u128) -> u128 {
    assert!(b > 0, "div_fp: division by zero");
    let half = 1_000_000_u128;
    // (a * half) / b * half + remainder
    let scaled_a = a.checked_mul(half).expect("div_fp scale overflow");
    let quotient = scaled_a / b;
    let remainder = scaled_a % b;
    let main = quotient.checked_mul(half).expect("div_fp main overflow");
    let extra = remainder.checked_mul(half).expect("div_fp extra overflow") / b;
    main + extra
}

/// Signed multiply: (a * b) / ISCALE
/// Uses split multiplication to avoid overflow.
pub fn imul_fp(a: i128, b: i128) -> i128 {
    let sign: i128 = if (a < 0) ^ (b < 0) { -1 } else { 1 };
    let abs_a = a.unsigned_abs();
    let abs_b = b.unsigned_abs();
    let result = mul_fp(abs_a, abs_b);
    sign * (result as i128)
}

/// Signed divide: (a * ISCALE) / b
/// Uses split division to avoid overflow.
pub fn idiv_fp(a: i128, b: i128) -> i128 {
    let sign: i128 = if (a < 0) ^ (b < 0) { -1 } else { 1 };
    let abs_a = a.unsigned_abs();
    let abs_b = b.unsigned_abs();
    let result = div_fp(abs_a, abs_b);
    sign * (result as i128)
}

/// Fixed-point tanh approximation using Padé(3,3):
///   tanh(x) ≈ x(x² + 15) / (6x² + 15)  for |x| < ~4.5
///   tanh(x) ≈ ±1                          for |x| >= 4.5
///
/// Input and output are i128 in SCALE fixed-point.
pub fn tanh_fp(x: i128) -> i128 {
    let sign: i128 = if x >= 0 { 1 } else { -1 };
    let abs_x = x.abs();

    // Saturation threshold: 4.5 * SCALE
    let sat = 4_500_000_000_000_i128; // 4.5 in fixed-point
    if abs_x >= sat {
        return sign * ISCALE; // ±1.0
    }

    // x² in fixed-point
    let x2 = imul_fp(abs_x, abs_x);

    // numerator = x * (x² + 15)
    let fifteen = 15 * ISCALE;
    let num = imul_fp(abs_x, x2.checked_add(fifteen).expect("tanh num add"));

    // denominator = 6x² + 15
    let six_x2 = x2.checked_mul(6).expect("tanh 6x2");
    let den = six_x2
        .checked_div(1) // no-op, keeps type consistent
        .expect("tanh den")
        .checked_add(fifteen)
        .expect("tanh den add");

    let result = idiv_fp(num, den);
    sign * result
}

/// Solve the Curve StableSwap invariant for D given reserves (x, y) and
/// amplification A. All values in SCALE fixed-point (u128).
///
/// Invariant: 4A(x+y) + D = 4AD + D³/(4xy)
/// Rearranged: f(D) = 4A(x+y) + D - 4AD - D³/(4xy) = 0
///
/// Uses Newton-Raphson with initial guess D₀ = x + y.
/// Max 32 iterations, convergence threshold = 1 (smallest unit).
pub fn solve_d(a: u128, x: u128, y: u128) -> u128 {
    let sum = x.checked_add(y).expect("solve_d sum");
    let four_a = a.checked_mul(4).expect("solve_d 4a");
    let four_xy = mul_fp(x, y).checked_mul(4).expect("solve_d 4xy");

    let mut d = sum; // initial guess

    for _ in 0..32 {
        // d³ in fixed-point: d * d / SCALE * d / SCALE
        let d2 = mul_fp(d, d);
        let d3 = mul_fp(d2, d);

        // f(D) = 4A*(x+y) + D - 4A*D - D³/(4xy)
        // All terms in SCALE fixed-point
        let four_a_sum = mul_fp(four_a.checked_mul(SCALE as u128).expect("4a scale"), sum);
        let four_a_d = mul_fp(four_a.checked_mul(SCALE as u128).expect("4a scale d"), d);
        let d3_over_4xy = div_fp(d3, four_xy);

        // f = 4A(x+y) + D - 4AD - D³/(4xy)
        // Compute positive and negative parts separately to avoid underflow
        let pos = four_a_sum.checked_add(d).expect("f pos");
        let neg = four_a_d.checked_add(d3_over_4xy).expect("f neg");

        // f'(D) = 1 - 4A - 3D²/(4xy)
        let three_d2_over_4xy = div_fp(d2.checked_mul(3).expect("3d2"), four_xy);

        // Newton step: d_new = d - f(d)/f'(d)
        // Since f' is negative for valid D, we handle signs carefully
        if pos > neg {
            // f > 0, f' < 0 => d_new = d + |f/f'|
            let f_val = pos - neg;
            // |f'| = 4A + 3D²/(4xy) - 1
            let fp_abs = four_a
                .checked_mul(SCALE as u128)
                .expect("fp 4a")
                .checked_add(three_d2_over_4xy)
                .expect("fp add")
                .checked_sub(SCALE as u128)
                .unwrap_or(1); // safety floor
            let step = div_fp(f_val, fp_abs);
            let d_new = d.checked_add(step).expect("d_new add");
            if d_new.abs_diff(d) <= 1 {
                return d_new;
            }
            d = d_new;
        } else {
            // f <= 0, f' < 0 => d_new = d - |f/f'|
            let f_val = neg - pos;
            let fp_abs = four_a
                .checked_mul(SCALE as u128)
                .expect("fp 4a")
                .checked_add(three_d2_over_4xy)
                .expect("fp add")
                .checked_sub(SCALE as u128)
                .unwrap_or(1);
            let step = div_fp(f_val, fp_abs);
            let d_new = d.checked_sub(step).unwrap_or(d / 2);
            if d_new.abs_diff(d) <= 1 {
                return d_new;
            }
            d = d_new;
        }
    }

    d
}

/// Calculate the raw marginal price P = (16Ax²y² + xD³) / (16Ax²y² + yD³)
/// All values in SCALE fixed-point. Returns u128 in SCALE.
///
/// To avoid overflow, we compute 16A·x²·y² by chaining multiplications
/// and factor out common terms.
pub fn raw_price(a: u128, x: u128, y: u128, d: u128) -> u128 {
    let d2 = mul_fp(d, d);
    let d3 = mul_fp(d2, d);

    // Compute 16A·x·y·x·y step by step to avoid overflow:
    // base = 16A (integer) * x (fp) => mul_fp(16A * SCALE, x) but that overflows too.
    // Instead: xy = mul_fp(x, y), then base = mul_fp(xy, xy) * 16A
    // But 16A * xy² can still overflow. Let's use a different approach:
    // Divide everything by D³ to get smaller numbers:
    // P = (16Ax²y²/(D³) + x) / (16Ax²y²/(D³) + y)
    // Let c = 16A·x²·y² / D³ (computed carefully)

    let xy = mul_fp(x, y);
    // c = 16A · xy · xy / d3
    // = 16A · mul_fp(xy, xy) / d3  but mul_fp(xy, xy) might overflow
    // So: c = 16A · xy / d3 · xy  (chain divisions to keep values small)
    let xy_over_d3 = div_fp(xy, d3);
    let c = mul_fp(xy_over_d3, xy) * 16 * a;

    let num = c + x;
    let den = c + y;

    div_fp(num, den)
}

