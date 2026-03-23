// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SethBridge
 * @notice Cross-chain bridge contract with centralized Relayer model (Solana -> Seth)
 * @dev Only trusts specific Relayer address calls, uses Solana transaction signature for replay protection
 *      Ownable functionality inlined, no external dependencies
 * 
 * Cross-chain flow:
 * Solana (35% ecosystem funds) → Relayer → SethBridge → PoolB (inject liquidity)
 */
contract SethBridge {
    // ==================== Ownable Functionality (Inlined) ====================
    
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == _owner, "SethBridge: Not owner");
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
        require(newOwner != address(0), "SethBridge: New owner is zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ==================== Contract State ====================
    
    // Trusted Relayer address
    address public trustedRelayer;
    
    // sUSDC token address
    address public sUSDC;
    
    // PoolB address (SETH/sUSDC pricing pool)
    address public poolB;
    
    // Treasury address (optional, for special cases)
    address public treasury;
    
    // TeamPayroll contract address (for 5% team funds)
    address public teamPayroll;
    
    // Replay protection: record processed Solana transaction signatures
    mapping(bytes32 => bool) public processedTxs;
    
    // Solana USDC decimals → seth sUSDC decimals
    uint256 public constant DECIMALS_SCALE = 1;
    
    // Statistics
    uint256 public totalInjectedToPoolB;
    uint256 public totalTransactions;
    
    // ==================== Events ====================
    
    event EcosystemFundsInjected(
        bytes32 indexed solanaTxSig,
        uint256 amountSUSDC,
        uint256 amountSETH,
        uint256 timestamp
    );
    
    event PoolBUpdated(address oldPoolB, address newPoolB);
    event RelayerUpdated(address oldRelayer, address newRelayer);

    // ==================== Constructor ====================

    constructor(address _sUSDC, address _initialRelayer) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        sUSDC = _sUSDC;
        trustedRelayer = _initialRelayer;
        // poolB and treasury set via setter to avoid circular dependencies
    }

    modifier onlyRelayer() {
        require(msg.sender == trustedRelayer, "SethBridge: Not trusted relayer");
        _;
    }

    // Receive native SETH
    receive() external payable {
        // For receiving native SETH
    }

    // ==================== Configuration Functions ====================
    
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
    
    function setTeamPayroll(address _teamPayroll) external onlyOwner {
        teamPayroll = _teamPayroll;
    }

    // ==================== Core Functions ====================
    
    /**
     * @dev Process combined cross-chain message: ecosystem funds + team funds
     * @param solanaTxSig Solana transaction signature (replay protection)
     * @param ecosystemAmount Ecosystem funds amount (30%) - goes to PoolB
     * @param teamFundsAmount Team funds amount (5%) - goes to TeamPayroll
     * @param amountSETH Native SETH amount (sent with transaction, for paired injection to PoolB)
     */
    function processCrossChainMessage(
        bytes32 solanaTxSig,
        uint256 ecosystemAmount,
        uint256 teamFundsAmount,
        uint256 amountSETH
    ) external payable onlyRelayer {
        // 1. Validation
        require(!processedTxs[solanaTxSig], "SethBridge: Transaction already processed");
        require(ecosystemAmount > 0 || teamFundsAmount > 0, "SethBridge: Zero amounts");
        
        // 2. Mark as processed
        processedTxs[solanaTxSig] = true;
        
        // 3. Process ecosystem funds (30% to PoolB)
        if (ecosystemAmount > 0) {
            require(poolB != address(0), "SethBridge: PoolB not set");
            require(msg.value >= amountSETH, "SethBridge: Insufficient native SETH");
            require(amountSETH > 0, "SethBridge: Zero SETH amount for PoolB");
            
            uint256 amountSUSDC = ecosystemAmount * DECIMALS_SCALE;
            _mintSUSDC(address(this), amountSUSDC);
            _approve(sUSDC, poolB, amountSUSDC);
            
            (bool success, ) = poolB.call{value: amountSETH}(
                abi.encodeWithSignature("addLiquidity(uint256)", amountSUSDC)
            );
            require(success, "SethBridge: Failed to add liquidity to PoolB");
            
            totalInjectedToPoolB += amountSUSDC;
        }
        
        // 4. Process team funds (5% to TeamPayroll)
        if (teamFundsAmount > 0) {
            require(teamPayroll != address(0), "SethBridge: TeamPayroll not set");
            
            uint256 teamSUSDC = teamFundsAmount * DECIMALS_SCALE;
            _mintSUSDC(teamPayroll, teamSUSDC);
            
            // Notify TeamPayroll about the funds
            (bool success, ) = teamPayroll.call(
                abi.encodeWithSignature("receiveTeamFunds(bytes32,uint256)", solanaTxSig, teamSUSDC)
            );
            // TeamPayroll call may fail if already processed, which is fine
        }
        
        totalTransactions++;
        
        emit EcosystemFundsInjected(solanaTxSig, ecosystemAmount * DECIMALS_SCALE, amountSETH, block.timestamp);
    }
    
    /**
     * @dev Execute standard cross-chain mint (backup, for users or Treasury)
     * @param amount Amount from Solana (6 decimals), contract converts to sUSDC 18 decimals
     */
    function executeUnlock(
        bytes32 solanaTxSig,
        address recipient,
        uint256 amount
    ) external onlyRelayer {
        require(!processedTxs[solanaTxSig], "SethBridge: Transaction already processed");
        require(recipient != address(0), "SethBridge: Invalid recipient");
        require(amount > 0, "SethBridge: Zero amount");
        
        processedTxs[solanaTxSig] = true;
        
        uint256 amountSUSDC = amount * DECIMALS_SCALE;
        _mintSUSDC(recipient, amountSUSDC);
        
        totalTransactions++;
        
        emit EcosystemFundsInjected(solanaTxSig, amountSUSDC, 0, block.timestamp);
    }

    // ==================== Internal Functions ====================
    
    function _mintSUSDC(address to, uint256 amount) internal {
        (bool success, ) = sUSDC.call(
            abi.encodeWithSignature("mint(address,uint256)", to, amount)
        );
        require(success, "SethBridge: Mint failed");
    }
    
    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, ) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        // Some tokens don't require approve return value
    }

    // ==================== Query Functions ====================
    
    function getBridgeState() external view returns (
        uint256 _totalInjected,
        uint256 _totalTx,
        uint256 _nativeBalance
    ) {
        _totalInjected = totalInjectedToPoolB;
        _totalTx = totalTransactions;
        _nativeBalance = address(this).balance;
    }

    // ==================== Emergency Functions ====================
    
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        (bool success, ) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner(), amount)
        );
        require(success, "SethBridge: Token withdraw failed");
    }
    
    function emergencyWithdrawNative(uint256 amount) external onlyOwner {
        (bool success, ) = owner().call{value: amount}("");
        require(success, "SethBridge: Native withdraw failed");
    }
}