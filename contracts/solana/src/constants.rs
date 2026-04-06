//! Constants Definition Module

// ==================== Distribution Ratios (Basis Points, 10000 = 100%) ====================

/// Inbound ecosystem rate: 100% (amount passthrough).
pub const INBOUND_ECOSYSTEM_RATE: u64 = 10000;

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