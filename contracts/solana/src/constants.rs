//! Constants Definition Module

// ==================== Distribution Ratios (Basis Points, 10000 = 100%) ====================

/// L1 referrer commission rate: 10%
pub const COMMISSION_L1_RATE: u64 = 1000;

/// L2 referrer commission rate: 5%
pub const COMMISSION_L2_RATE: u64 = 500;

/// Total commission rate: 15%
pub const TOTAL_COMMISSION_RATE: u64 = 1500;

/// Team incentive rate: 5%
pub const TEAM_INCENTIVE_RATE: u64 = 500;

/// Project reserve rate: 50%
pub const PROJECT_RESERVE_RATE: u64 = 5000;

/// Ecosystem funds rate: 30%
pub const ECOSYSTEM_RATE: u64 = 3000;

/// Basis points precision
pub const BASIS_POINTS: u64 = 10000;

// ==================== Settlement Configuration ====================

/// Monthly settlement day (28th)
pub const SETTLEMENT_DAY: u64 = 28;

/// Minimum settlement interval (seconds) - 25 days
pub const MIN_SETTLEMENT_INTERVAL: i64 = 25 * 86400;

// ==================== Product Types ====================

/// Cloud mining
pub const PRODUCT_TYPE_CLOUD_MINING: u8 = 1;

/// Doctorate tuition
pub const PRODUCT_TYPE_DOCTORATE_TUITION: u8 = 2;

/// Smart device
pub const PRODUCT_TYPE_SMART_DEVICE: u8 = 3;