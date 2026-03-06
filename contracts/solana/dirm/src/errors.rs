use anchor_lang::prelude::*;

#[error_code]
pub enum DIRMError {
    #[msg("Swap input amount must be greater than zero")]
    ZeroAmount,
    #[msg("Insufficient output amount — slippage exceeded")]
    SlippageExceeded,
    #[msg("Treasury has insufficient funds to cover subsidy")]
    InsufficientTreasury,
    #[msg("Math overflow in fixed-point calculation")]
    MathOverflow,
    #[msg("Newton-Raphson solver failed to converge")]
    SolverFailed,
    #[msg("Invalid parameter value")]
    InvalidParameter,
}
