-- Relayer schema for MySQL 8.x.
-- No historical compatibility for withdraw flow: withdraw tables are rebuilt every boot migration.

CREATE TABLE IF NOT EXISTS cross_chain_messages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    solana_tx_sig VARCHAR(88) NOT NULL UNIQUE,
    solana_tx_sig_bytes32 VARCHAR(66) NOT NULL,
    original_amount BIGINT NOT NULL DEFAULT 0,
    amount BIGINT NOT NULL,
    commission_l1 BIGINT NOT NULL DEFAULT 0,
    commission_l2 BIGINT NOT NULL DEFAULT 0,
    project_funds BIGINT NOT NULL DEFAULT 0,
    recipient_eth VARCHAR(42) NOT NULL,
    sender_solana VARCHAR(44) NOT NULL,
    l1_referrer VARCHAR(44) NULL,
    l2_referrer VARCHAR(44) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    last_error TEXT NULL,
    seth_tx_hash VARCHAR(66) NULL,
    seth_block_number BIGINT NULL,
    solana_block_time BIGINT NULL,
    next_retry_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    INDEX idx_ccm_status (status),
    INDEX idx_ccm_next_retry (next_retry_at),
    INDEX idx_ccm_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS relayer_status (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    relayer_address VARCHAR(42) NOT NULL,
    last_processed_slot BIGINT NULL,
    last_processed_signature VARCHAR(88) NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seth_sync_heights (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    network INT NOT NULL,
    pool_index INT NOT NULL,
    next_height BIGINT NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_seth_sync_heights_network_pool (network, pool_index)
);

CREATE TABLE IF NOT EXISTS operation_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT UNSIGNED NULL,
    operation VARCHAR(50) NOT NULL,
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_op_logs_message (message_id),
    CONSTRAINT fk_op_logs_message FOREIGN KEY (message_id)
        REFERENCES cross_chain_messages(id) ON DELETE SET NULL
);

DROP TABLE IF EXISTS withdraw_operation_logs;
DROP TABLE IF EXISTS seth_withdraw_requests;

CREATE TABLE seth_withdraw_requests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    bridge_address VARCHAR(42) NOT NULL,
    request_id BIGINT NOT NULL,
    user_address VARCHAR(42) NULL,
    solana_recipient VARCHAR(66) NULL,
    susdc_amount BIGINT NULL,
    created_at_onchain BIGINT NULL,
    onchain_processed BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_retry_at DATETIME NULL,
    initiating_seth_tx_hash VARCHAR(66) NULL,
    solana_unlock_tx_sig VARCHAR(128) NULL,
    seth_mark_processed_tx_hash VARCHAR(66) NULL,
    last_error TEXT NULL,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    processed_at DATETIME NULL,
    UNIQUE KEY uq_withdraw_bridge_request (bridge_address, request_id),
    INDEX idx_withdraw_status (status),
    INDEX idx_withdraw_bridge (bridge_address),
    INDEX idx_withdraw_next_retry (next_retry_at),
    INDEX idx_withdraw_seen (first_seen_at)
);

CREATE TABLE withdraw_operation_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    withdraw_id BIGINT UNSIGNED NOT NULL,
    operation VARCHAR(50) NOT NULL,
    details JSON NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_withdraw_logs_withdraw (withdraw_id),
    CONSTRAINT fk_withdraw_logs_withdraw FOREIGN KEY (withdraw_id)
        REFERENCES seth_withdraw_requests(id) ON DELETE CASCADE
);

INSERT INTO relayer_status (relayer_address, is_active)
SELECT '0x0000000000000000000000000000000000000000', TRUE
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM relayer_status);

-- Seed Seth sync cursor per pool (network=3, pools 0..32). INSERT IGNORE keeps existing next_height.
INSERT IGNORE INTO seth_sync_heights (network, pool_index, next_height) VALUES
(3,0,0),(3,1,0),(3,2,0),(3,3,0),(3,4,0),(3,5,0),(3,6,0),(3,7,0),(3,8,0),(3,9,0),
(3,10,0),(3,11,0),(3,12,0),(3,13,0),(3,14,0),(3,15,0),(3,16,0),(3,17,0),(3,18,0),(3,19,0),
(3,20,0),(3,21,0),(3,22,0),(3,23,0),(3,24,0),(3,25,0),(3,26,0),(3,27,0),(3,28,0),(3,29,0),
(3,30,0),(3,31,0),(3,32,0);