// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Treasury - Seth AI Ecosystem Treasury
 * @notice Receives 35% ecosystem funds from Solana chain
 * @dev Ownable functionality inlined, no external dependencies
 *      Revenue sharing logic completed on Solana chain, this contract only handles:
 *      1. Receiving cross-chain funds (sUSDC minted via SethBridge)
 *      2. Managing funds
 *      3. Optional: inject to PoolB to support SETH price
 *      4. Seth→Solana withdraw is now handled by SethBridge directly calling PoolB.sellSETH.
 *         `swapSethForSusdc` is kept as a legacy bridge-only function for backward compatibility.
 */
contract Treasury {
    // ==================== Ownable Functionality (Inlined) ====================
    
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == _owner, "Treasury: Not owner");
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
        require(newOwner != address(0), "Treasury: New owner is zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ==================== Contract State ====================
    
    // sUSDC token address
    address public susdcToken;
    
    // SethBridge contract address (has mint permission)
    address public bridgeContract;
    
    // PoolB address (optional, for liquidity injection)
    address public poolB;
    
    // Relayer address
    address public trustedRelayer;
    
    // Statistics
    uint256 public totalReceivedFromSolana;  // Funds received from Solana
    uint256 public totalInjectedToPoolB;     // Funds injected to PoolB
    
    // Processed cross-chain messages (replay protection)
    mapping(bytes32 => bool) public processedMessages;
    
    // ==================== Events ====================
    
    event EcosystemFundsReceived(
        bytes32 indexed solanaTxSig,
        uint256 amount,
        address indexed recipient
    );
    
    event FundsInjectedToPoolB(
        uint256 amountSUSDC,
        uint256 amountSETH,
        uint256 timestamp
    );
    
    event RelayerUpdated(address oldRelayer, address newRelayer);
    event PoolBUpdated(address oldPoolB, address newPoolB);
    event SethSwappedForBridgeWithdraw(uint256 amountSETH, uint256 amountSUSDC);

    // ==================== Modifiers ====================
    
    modifier onlyRelayer() {
        require(msg.sender == trustedRelayer, "Treasury: Not trusted relayer");
        _;
    }

    modifier onlyBridge() {
        require(bridgeContract != address(0), "Treasury: Bridge not set");
        require(msg.sender == bridgeContract, "Treasury: Not bridge");
        _;
    }

    // ==================== Constructor ====================

    constructor(address _susdcToken, address _relayer) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        susdcToken = _susdcToken;
        trustedRelayer = _relayer;
        // bridgeContract and poolB set via setter to avoid circular dependencies
    }

    // Receive native SETH
    receive() external payable {
        // For receiving native SETH (if needed)
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
    
    function setBridgeContract(address _bridgeContract) external onlyOwner {
        bridgeContract = _bridgeContract;
    }

    /**
     * @dev After deploy, PoolB Ownable owner is this Treasury. Updates PoolB.treasury (LP / addLiquidity caller).
     */
    function setPoolBTreasury(address _newTreasury) external onlyOwner {
        require(poolB != address(0), "Treasury: PoolB not set");
        (bool ok, ) = poolB.call(
            abi.encodeWithSignature("setTreasury(address)", _newTreasury)
        );
        require(ok, "Treasury: PoolB setTreasury failed");
    }

    /**
     * @dev SethBridge mints sUSDC, transfers to this contract, then calls here with native SETH.
     *      PoolB.treasury must be this contract. Relayer -> SethBridge -> Treasury -> PoolB.
     */
    function injectFromBridge(uint256 amountSUSDC, uint256 amountSETH) external payable onlyBridge {
        require(poolB != address(0), "Treasury: PoolB not set");
        require(amountSUSDC > 0 || amountSETH > 0, "Treasury: Zero amounts");
        require(msg.value >= amountSETH, "Treasury: Insufficient native SETH sent");

        if (amountSUSDC > 0) {
            _approve(susdcToken, poolB, amountSUSDC);
        }
        (bool success, ) = poolB.call{value: amountSETH}(
            abi.encodeWithSignature("addLiquidity(uint256)", amountSUSDC)
        );
        require(success, "Treasury: Failed to add liquidity");

        totalInjectedToPoolB += amountSUSDC;
        emit FundsInjectedToPoolB(amountSUSDC, amountSETH, block.timestamp);
    }

    /**
     * @notice Quote sUSDC out for a SETH amount (same math as PoolB.sellSETH). For UI / minOut slippage.
     */
    function quoteSwapSethForSusdc(uint256 amountSETH) external view returns (uint256 susdcOut) {
        if (poolB == address(0) || amountSETH == 0) return 0;
        (bool okR, bytes memory rS) = poolB.staticcall(abi.encodeWithSignature("reserveSETH()"));
        (bool okU, bytes memory rU) = poolB.staticcall(abi.encodeWithSignature("reservesUSDC()"));
        if (!okR || !okU || rS.length < 32 || rU.length < 32) return 0;
        uint256 reserveSETH = abi.decode(rS, (uint256));
        uint256 reservesUSDC = abi.decode(rU, (uint256));
        if (reserveSETH == 0 || reservesUSDC == 0) return 0;
        (bool ok2, bytes memory out) = poolB.staticcall(
            abi.encodeWithSignature(
                "getAmountOut(uint256,uint256,uint256)",
                amountSETH,
                reserveSETH,
                reservesUSDC
            )
        );
        if (!ok2 || out.length == 0) return 0;
        susdcOut = abi.decode(out, (uint256));
    }

    /**
     * @dev Legacy bridge-only path (kept for compatibility).
     *      Current primary Seth→Solana withdraw path calls PoolB directly from SethBridge.
     */
    function swapSethForSusdc(uint256 minSUSDCOut) external payable onlyBridge returns (uint256 amountOut) {
        require(poolB != address(0), "Treasury: PoolB not set");
        require(bridgeContract != address(0), "Treasury: Bridge not set");
        require(msg.value > 0, "Treasury: Zero SETH");

        (bool success, bytes memory ret) = poolB.call{value: msg.value}(
            abi.encodeWithSignature("sellSETH(uint256)", minSUSDCOut)
        );
        require(success, "Treasury: Pool swap failed");
        amountOut = abi.decode(ret, (uint256));
        require(amountOut > 0, "Treasury: Zero sUSDC out");
        require(_transferToken(susdcToken, bridgeContract, amountOut), "Treasury: sUSDC to bridge failed");

        emit SethSwappedForBridgeWithdraw(msg.value, amountOut);
    }

    // ==================== Core Functions ====================
    
    /**
     * @dev Receive ecosystem funds from Solana (35%)
     * @param solanaTxSig Solana transaction signature (replay protection)
     * @param recipient Receiving address (usually Treasury itself, can be other addresses)
     * @param amount sUSDC amount
     */
    function receiveEcosystemFunds(
        bytes32 solanaTxSig,
        address recipient,
        uint256 amount
    ) external onlyRelayer {
        require(amount > 0, "Treasury: Zero amount");
        require(!processedMessages[solanaTxSig], "Treasury: Already processed");
        
        // Mark as processed
        processedMessages[solanaTxSig] = true;
        
        // Update statistics (if recipient is Treasury)
        if (recipient == address(this)) {
            totalReceivedFromSolana += amount;
        }
        
        emit EcosystemFundsReceived(solanaTxSig, amount, recipient);
    }

    /**
     * @dev Inject funds to PoolB (manual call)
     * @param amountSUSDC sUSDC amount
     * @param amountSETH Native SETH amount (sent with transaction)
     */
    function injectToPoolB(uint256 amountSUSDC, uint256 amountSETH) external payable onlyOwner {
        require(poolB != address(0), "Treasury: PoolB not set");
        require(amountSUSDC > 0 || amountSETH > 0, "Treasury: Zero amounts");
        require(msg.value >= amountSETH, "Treasury: Insufficient native SETH sent");

        if (amountSUSDC > 0) {
            _approve(susdcToken, poolB, amountSUSDC);
        }

        (bool success, ) = poolB.call{value: amountSETH}(
            abi.encodeWithSignature(
                "addLiquidity(uint256)",
                amountSUSDC
            )
        );
        require(success, "Treasury: Failed to add liquidity");
        
        // Update statistics
        totalInjectedToPoolB += amountSUSDC;
        
        emit FundsInjectedToPoolB(amountSUSDC, amountSETH, block.timestamp);
    }

    // ==================== Token Operation Helper Functions ====================
    
    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, ) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        // Some tokens don't require approve return value
    }

    function _transferToken(address token, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    // ==================== Query Functions ====================
    
    function getTreasuryState() external view returns (
        uint256 _totalReceived,
        uint256 _totalInjected,
        uint256 _nativeBalance
    ) {
        _totalReceived = totalReceivedFromSolana;
        _totalInjected = totalInjectedToPoolB;
        _nativeBalance = address(this).balance;
    }

    // ==================== Emergency Functions ====================
    
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        (bool success, ) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner(), amount)
        );
        require(success, "Treasury: Token withdraw failed");
    }
    
    function emergencyWithdrawNative(uint256 amount) external onlyOwner {
        (bool success, ) = owner().call{value: amount}("");
        require(success, "Treasury: Native withdraw failed");
    }
}