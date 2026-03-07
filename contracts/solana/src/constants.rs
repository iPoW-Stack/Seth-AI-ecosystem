//! 常量定义模块

// ==================== 分账比例 (基点, 10000 = 100%) ====================

/// L1 推荐人佣金比例: 10%
pub const COMMISSION_L1_RATE: u64 = 1000;

/// L2 推荐人佣金比例: 5%
pub const COMMISSION_L2_RATE: u64 = 500;

/// 总佣金比例: 15%
pub const TOTAL_COMMISSION_RATE: u64 = 1500;

/// 团队激励比例: 5% (50%的10%)
pub const TEAM_INCENTIVE_RATE: u64 = 500;

/// 项目方储备比例: 45% (50%的90%)
pub const PROJECT_RESERVE_RATE: u64 = 4500;

/// 生态资金比例: 35%
pub const ECOSYSTEM_RATE: u64 = 3500;

/// 基点精度
pub const BASIS_POINTS: u64 = 10000;

// ==================== 清算配置 ====================

/// 月底清算日 (28号)
pub const SETTLEMENT_DAY: u64 = 28;

/// 最小清算间隔 (秒) - 25天
pub const MIN_SETTLEMENT_INTERVAL: i64 = 25 * 86400;

// ==================== 产品类型 ====================

/// 云算力
pub const PRODUCT_TYPE_CLOUD_MINING: u8 = 1;

/// 博士学费
pub const PRODUCT_TYPE_DOCTORATE_TUITION: u8 = 2;

/// 智能设备
pub const PRODUCT_TYPE_SMART_DEVICE: u8 = 3;