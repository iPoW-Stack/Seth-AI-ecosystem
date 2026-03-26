// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title TeamPayroll - Team Incentive Management Contract
 * @notice Manages 5% team incentive from Solana revenue
 * @dev 
 *   - Receives sUSDC from cross-chain bridge
 *   - Converts sUSDC to SETH via PoolB
 *   - Stores SETH in vault
 *   - Monthly release to team wallet (28th)
 *   - Supports "buffer mode" during high volatility
 * 
 * Flow:
 *   Solana (5% team USDC) -> Relayer -> TeamPayroll -> PoolB (swap to SETH) -> Vault -> Team Wallet (monthly)
 */
contract TeamPayroll {
    // ==================== Ownable Functionality (Inlined) ====================
    
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == _owner, "TeamPayroll: Not owner");
        _;
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function renounceOwnership() public onlyOwner {
        emit OwnershipTransferred(_owner, address(0));
        _owner = address(0);
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0), "TeamPayroll: New owner is zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ==================== Contract State ====================
    
    // Token addresses
    address public susdcToken;      // sUSDC token address
    address public poolB;           // PoolB address for sUSDC -> SETH swap
    
    // Team wallet (receives monthly SETH)
    address public teamWallet;
    
    // Trusted relayer (cross-chain message sender)
    address public trustedRelayer;
    
    // Treasury address (for buffer mode)
    address public treasury;
    
    // SethBridge address (for minting sUSDC)
    address public sethBridge;
    
    // Settlement day (default: 28th)
    uint256 public settlementDay = 28;
    
    // Minimum settlement interval (25 days)
    uint256 public constant MIN_SETTLEMENT_INTERVAL = 25 days;
    
    // Volatility threshold for buffer mode (in basis points, 1000 = 10%)
    uint256 public volatilityThreshold = 1000;
    
    // SETH vault balance
    uint256 public vaultSETHBalance;
    
    // Pending sUSDC to convert (not yet swapped)
    uint256 public pendingSUSDC;
    
    // Statistics
    uint256 public totalSUSDCReceived;
    uint256 public totalSETHConverted;
    uint256 public totalSETHReleased;
    uint256 public lastSettlementTimestamp;
    
    // Processed cross-chain messages (replay protection)
    mapping(bytes32 => bool) public processedMessages;
    
    // Monthly release records
    struct MonthlyRelease {
        uint256 timestamp;
        uint256 amountSETH;
        uint256 amountSUSDCBuffered;  // If buffer mode was used
        bool bufferModeUsed;
    }
    
    MonthlyRelease[] public releaseHistory;
    
    // ==================== Events ====================
    
    event TeamFundsReceived(
        bytes32 indexed solanaTxSig,
        uint256 amountSUSDC,
        uint256 timestamp
    );
    
    event SUSDCConvertedToSETH(
        uint256 amountSUSDC,
        uint256 amountSETH,
        uint256 price,
        uint256 timestamp
    );
    
    event MonthlyReleaseExecuted(
        uint256 amountSETH,
        bool bufferModeUsed,
        uint256 timestamp
    );
    
    event BufferModeActivated(
        uint256 sUSDCAmount,
        uint256 reason
    );
    
    event TeamWalletUpdated(address oldWallet, address newWallet);
    event RelayerUpdated(address oldRelayer, address newRelayer);
    event PoolBUpdated(address oldPoolB, address newPoolB);
    event VolatilityThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // ==================== Modifiers ====================
    
    modifier onlyRelayer() {
        require(msg.sender == trustedRelayer, "TeamPayroll: Not trusted relayer");
        _;
    }

    // ==================== Constructor ====================

    constructor(
        address _susdcToken,
        address _poolB,
        address _teamWallet,
        address _relayer
    ) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        susdcToken = _susdcToken;
        poolB = _poolB;
        teamWallet = _teamWallet;
        trustedRelayer = _relayer;
        lastSettlementTimestamp = block.timestamp;
    }

    // Receive native SETH
    receive() external payable {
        // For receiving SETH from PoolB swaps
        vaultSETHBalance += msg.value;
    }

    // ==================== Configuration Functions ====================
    
    function setTeamWallet(address _newWallet) external onlyOwner {
        emit TeamWalletUpdated(teamWallet, _newWallet);
        teamWallet = _newWallet;
    }
    
    function setRelayer(address _newRelayer) external onlyOwner {
        emit RelayerUpdated(trustedRelayer, _newRelayer);
        trustedRelayer = _newRelayer;
    }
    
    function setPoolB(address _poolB) external onlyOwner {
        emit PoolBUpdated(poolB, _poolB);
        poolB = _poolB;
    }
    
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }
    
    function setSethBridge(address _sethBridge) external onlyOwner {
        sethBridge = _sethBridge;
    }
    
    function setVolatilityThreshold(uint256 _threshold) external onlyOwner {
        emit VolatilityThresholdUpdated(volatilityThreshold, _threshold);
        volatilityThreshold = _threshold;
    }

    // ==================== Core Functions ====================
    
    /**
     * @dev Receive team funds from Solana (5%)
     * @param solanaTxSig Solana transaction signature (replay protection)
     * @param amountSUSDC sUSDC amount (already minted by SethBridge)
     */
    function receiveTeamFunds(
        bytes32 solanaTxSig,
        uint256 amountSUSDC
    ) external onlyRelayer {
        require(amountSUSDC > 0, "TeamPayroll: Zero amount");
        require(!processedMessages[solanaTxSig], "TeamPayroll: Already processed");
        
        // Mark as processed
        processedMessages[solanaTxSig] = true;
        
        // Update statistics
        totalSUSDCReceived += amountSUSDC;
        pendingSUSDC += amountSUSDC;
        
        emit TeamFundsReceived(solanaTxSig, amountSUSDC, block.timestamp);
        
        // Auto-convert sUSDC to SETH via PoolB
        _convertToSETH(amountSUSDC);
    }
    
    /**
     * @dev Internal function to convert sUSDC to SETH via PoolB
     * @param amountSUSDC Amount of sUSDC to convert
     */
    function _convertToSETH(uint256 amountSUSDC) internal {
        require(poolB != address(0), "TeamPayroll: PoolB not set");
        require(amountSUSDC > 0, "TeamPayroll: Zero amount");
        
        // Check price volatility before swap
        (uint256 currentPrice, uint256 priceChange) = _checkPriceVolatility();
        
        if (priceChange > volatilityThreshold && treasury != address(0)) {
            // Buffer mode: keep sUSDC instead of swapping during high volatility
            emit BufferModeActivated(amountSUSDC, priceChange);
            return;
        }
        
        // Approve PoolB to use sUSDC
        _approve(susdcToken, poolB, amountSUSDC);
        
        // Get expected SETH output (for slippage protection)
        uint256 expectedSETH = _getExpectedSETH(amountSUSDC);
        uint256 minSETHOut = (expectedSETH * 95) / 100; // 5% slippage tolerance
        
        // Execute swap: sell sUSDC for SETH
        // Note: PoolB.buySETH() receives sUSDC and sends SETH
        (bool success, ) = poolB.call(
            abi.encodeWithSignature("buySETH(uint256,uint256)", amountSUSDC, minSETHOut)
        );
        
        if (success) {
            // Update statistics
            pendingSUSDC -= amountSUSDC;
            totalSETHConverted += expectedSETH;
            
            emit SUSDCConvertedToSETH(amountSUSDC, expectedSETH, currentPrice, block.timestamp);
        }
        // If swap fails, sUSDC remains in pendingSUSDC for retry
    }
    
    /**
     * @dev Check price volatility
     * @return currentPrice Current SETH price
     * @return priceChange Price change in basis points
     */
    function _checkPriceVolatility() internal view returns (uint256 currentPrice, uint256 priceChange) {
        // Get current price from PoolB
        (bool success, bytes memory data) = poolB.staticcall(
            abi.encodeWithSignature("getPrice()")
        );
        
        if (!success || data.length == 0) {
            return (0, 0);
        }
        
        currentPrice = abi.decode(data, (uint256));
        
        // Get price history for comparison
        (success, data) = poolB.staticcall(
            abi.encodeWithSignature("getPriceHistoryLength()")
        );
        
        if (!success || data.length == 0) {
            return (currentPrice, 0);
        }
        
        uint256 historyLength = abi.decode(data, (uint256));
        
        if (historyLength < 2) {
            return (currentPrice, 0);
        }
        
        // Compare with price 24 hours ago (approximately 288 records if 5 min intervals)
        uint256 compareIndex = historyLength > 288 ? historyLength - 288 : 0;
        
        (success, data) = poolB.staticcall(
            abi.encodeWithSignature("priceHistory(uint256)", compareIndex)
        );
        
        if (!success || data.length == 0) {
            return (currentPrice, 0);
        }
        
        (,, uint256 oldPrice) = abi.decode(data, (uint256, uint256, uint256));
        
        if (oldPrice == 0) {
            return (currentPrice, 0);
        }
        
        // Calculate price change in basis points
        if (currentPrice > oldPrice) {
            priceChange = ((currentPrice - oldPrice) * 10000) / oldPrice;
        } else {
            priceChange = ((oldPrice - currentPrice) * 10000) / oldPrice;
        }
    }
    
    /**
     * @dev Get expected SETH output from PoolB
     * @param amountSUSDC sUSDC amount
     * @return amountSETH Expected SETH amount
     */
    function _getExpectedSETH(uint256 amountSUSDC) internal view returns (uint256 amountSETH) {
        // Get pool reserves
        (bool success, bytes memory data) = poolB.staticcall(
            abi.encodeWithSignature("getPoolState()")
        );
        
        if (!success || data.length == 0) {
            return 0;
        }
        
        (uint256 reserveSETH, uint256 reservesUSDC,,,,,) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
        
        if (reserveSETH == 0 || reservesUSDC == 0) {
            return 0;
        }
        
        // Calculate output using constant product formula
        amountSETH = (amountSUSDC * reserveSETH) / (reservesUSDC + amountSUSDC);
    }
    
    /**
     * @dev Execute monthly release to team wallet
     * @notice Can be called by anyone after settlement day + interval
     */
    function executeMonthlyRelease() external {
        require(block.timestamp >= lastSettlementTimestamp + MIN_SETTLEMENT_INTERVAL, "TeamPayroll: Too early");
        require(vaultSETHBalance > 0 || pendingSUSDC > 0, "TeamPayroll: No funds to release");
        require(teamWallet != address(0), "TeamPayroll: Team wallet not set");
        
        // Convert any pending sUSDC first
        if (pendingSUSDC > 0) {
            _convertToSETH(pendingSUSDC);
        }
        
        uint256 releaseAmount = vaultSETHBalance;
        require(releaseAmount > 0, "TeamPayroll: No SETH to release");
        
        // Reset vault balance before transfer
        vaultSETHBalance = 0;
        
        // Transfer SETH to team wallet
        (bool success, ) = teamWallet.call{value: releaseAmount}("");
        require(success, "TeamPayroll: SETH transfer failed");
        
        // Update statistics
        totalSETHReleased += releaseAmount;
        lastSettlementTimestamp = block.timestamp;
        
        // Record release
        releaseHistory.push(MonthlyRelease({
            timestamp: block.timestamp,
            amountSETH: releaseAmount,
            amountSUSDCBuffered: 0,
            bufferModeUsed: false
        }));
        
        emit MonthlyReleaseExecuted(releaseAmount, false, block.timestamp);
    }
    
    /**
     * @dev Manual convert pending sUSDC to SETH
     * @notice Owner only, for retry failed conversions
     */
    function manualConvert() external onlyOwner {
        if (pendingSUSDC > 0) {
            _convertToSETH(pendingSUSDC);
        }
    }
    
    /**
     * @dev Emergency release with buffer mode
     * @notice Releases from treasury sUSDC if SETH price is too volatile
     */
    function emergencyReleaseFromTreasury(uint256 amountSUSDC) external onlyOwner {
        require(treasury != address(0), "TeamPayroll: Treasury not set");
        
        // Request sUSDC from treasury
        (bool success, ) = treasury.call(
            abi.encodeWithSignature("emergencyWithdrawToken(address,uint256)", susdcToken, amountSUSDC)
        );
        
        if (success) {
            pendingSUSDC += amountSUSDC;
            _convertToSETH(amountSUSDC);
        }
    }

    // ==================== Query Functions ====================
    
    /**
     * @dev Get contract state
     */
    function getPayrollState() external view returns (
        uint256 _vaultSETH,
        uint256 _pendingSUSDC,
        uint256 _totalReceived,
        uint256 _totalConverted,
        uint256 _totalReleased,
        uint256 _lastSettlement,
        uint256 _nativeBalance
    ) {
        _vaultSETH = vaultSETHBalance;
        _pendingSUSDC = pendingSUSDC;
        _totalReceived = totalSUSDCReceived;
        _totalConverted = totalSETHConverted;
        _totalReleased = totalSETHReleased;
        _lastSettlement = lastSettlementTimestamp;
        _nativeBalance = address(this).balance;
    }
    
    /**
     * @dev Get release history count
     */
    function getReleaseHistoryLength() external view returns (uint256) {
        return releaseHistory.length;
    }
    
    /**
     * @dev Check if monthly release is ready
     */
    function isReleaseReady() external view returns (bool) {
        return block.timestamp >= lastSettlementTimestamp + MIN_SETTLEMENT_INTERVAL 
            && (vaultSETHBalance > 0 || pendingSUSDC > 0);
    }

    // ==================== Internal Helper Functions ====================
    
    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, ) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        // Some tokens don't require approve return value
    }

    // ==================== Emergency Functions ====================
    
    /**
     * @dev Emergency withdraw native SETH (Owner only)
     */
    function emergencyWithdrawNative(uint256 amount) external onlyOwner {
        (bool success, ) = owner().call{value: amount}("");
        require(success, "TeamPayroll: Native withdraw failed");
        if (amount <= vaultSETHBalance) {
            vaultSETHBalance -= amount;
        }
    }
    
    /**
     * @dev Emergency withdraw ERC20 tokens (Owner only)
     */
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner(), amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TeamPayroll: Token withdraw failed");
    }
}