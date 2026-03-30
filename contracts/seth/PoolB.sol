// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PoolB - Seth Pricing Pool
 * @notice SETH/sUSDC pricing pool, only allows Treasury/Bridge as LP
 * @dev Ownable functionality inlined, no external dependencies
 *      Pool B only allows Treasury and Bridge as LP to prevent external manipulation
 * 
 * Important: SETH is the native token of Seth chain (similar to ETH), not an ERC20 token
 */
contract PoolB {
    // ==================== Ownable Functionality (Inlined) ====================
    
    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == _owner, "PoolB: Not owner");
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
        require(newOwner != address(0), "PoolB: New owner is zero address");
        emit OwnershipTransferred(_owner, newOwner);
        _owner = newOwner;
    }

    // ==================== Contract State ====================
    
    // Token interface
    // SETH is native token, no contract address needed
    address public susdcToken;     // sUSDC token address
    address public treasury;       // Treasury address (sole LP)
    address public bridge;         // Bridge contract address (allowed to addLiquidity)
    
    // Reserves
    uint256 public reserveSETH;    // Native SETH reserve
    uint256 public reservesUSDC;   // sUSDC reserve
    
    // Cumulative trading volume (for statistics)
    uint256 public totalVolumeSETH;
    uint256 public totalVolumesUSDC;
    uint256 public totalTransactions;
    
    // Price history (for price discovery)
    struct PriceRecord {
        uint256 timestamp;
        uint256 price;         // SETH price (denominated in sUSDC)
        uint256 volume;        // Trading volume
    }
    
    PriceRecord[] public priceHistory;
    uint256 public constant MAX_PRICE_RECORDS = 1000;
    
    // ==================== Events ====================
    
    event LiquidityAdded(uint256 amountSETH, uint256 amountSUSDC, uint256 newReserveSETH, uint256 newReservesUSDC);
    event LiquidityRemoved(uint256 amountSETH, uint256 amountSUSDC, address to);
    event SwapExecuted(
        address indexed user,
        bool isBuySETH,          // true: buy SETH, false: sell SETH
        uint256 amountIn,
        uint256 amountOut,
        uint256 price,
        uint256 timestamp,
        bytes32 solanaRecipient  // Solana recipient address (32 bytes, base58 encoded as bytes32)
    );
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event BridgeUpdated(address oldBridge, address newBridge);
    event NativeSETHReceived(address indexed from, uint256 amount);

    modifier onlyTreasury() {
        require(
            msg.sender == treasury || msg.sender == bridge,
            "PoolB: Only treasury or bridge can call"
        );
        _;
    }

    // ==================== Constructor ====================

    constructor(address _susdcToken, address _treasury) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        susdcToken = _susdcToken;
        treasury = _treasury;
    }

    // Receive native SETH
    receive() external payable {
        emit NativeSETHReceived(msg.sender, msg.value);
    }

    // ==================== Configuration Functions ====================

    /**
     * @dev Update treasury address
     */
    function setTreasury(address _newTreasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _newTreasury);
        treasury = _newTreasury;
    }

    /**
     * @dev Update bridge address
     */
    function setBridge(address _newBridge) external onlyOwner {
        emit BridgeUpdated(bridge, _newBridge);
        bridge = _newBridge;
    }

    // ==================== Price Calculation ====================

    /**
     * @dev Get current price (1 SETH = ? sUSDC)
     * @return price SETH price (18 decimal precision)
     */
    function getPrice() public view returns (uint256 price) {
        if (reserveSETH == 0) return 0;
        // price = sUSDC reserve / SETH reserve
        price = (reservesUSDC * 1e18) / reserveSETH;
    }

    /**
     * @dev Calculate trade output amount
     * @param amountIn Input amount
     * @param reserveIn Input token reserve
     * @param reserveOut Output token reserve
     * @return amountOut Output amount
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "PoolB: Zero input");
        require(reserveIn > 0 && reserveOut > 0, "PoolB: Insufficient liquidity");
        
        // Constant product formula: amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
        uint256 amountInWithFee = amountIn; // Pool B has no fee, treasury exclusive
        amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
    }

    // ==================== Trading Functions ====================

    /**
     * @dev Buy SETH (using sUSDC) - local swap only, no cross-chain
     * @param amountSUSDCIn Input sUSDC amount
     * @param minSETHOut Minimum output SETH amount (slippage protection)
     * @return amountSETHOut Received SETH amount
     */
    function buySETH(uint256 amountSUSDCIn, uint256 minSETHOut) external returns (uint256 amountSETHOut) {
        // 1. Transfer in sUSDC
        require(_transferFrom(susdcToken, msg.sender, address(this), amountSUSDCIn), "PoolB: sUSDC transfer failed");
        
        // 2. Calculate output
        amountSETHOut = getAmountOut(amountSUSDCIn, reservesUSDC, reserveSETH);
        require(amountSETHOut >= minSETHOut, "PoolB: Slippage exceeded");
        
        // 3. Update reserves
        reservesUSDC += amountSUSDCIn;
        reserveSETH -= amountSETHOut;
        
        // 4. Transfer out native SETH
        (bool success, ) = msg.sender.call{value: amountSETHOut}("");
        require(success, "PoolB: SETH transfer failed");
        
        // 5. Record price
        _recordPrice(amountSUSDCIn, true);
        
        // 6. Update statistics
        totalVolumesUSDC += amountSUSDCIn;
        totalVolumeSETH += amountSETHOut;
        totalTransactions++;
        
        // solanaRecipient is bytes32(0) for buySETH (no cross-chain)
        emit SwapExecuted(msg.sender, true, amountSUSDCIn, amountSETHOut, getPrice(), block.timestamp, bytes32(0));
    }

    /**
     * @dev Sell SETH (receive sUSDC) - Send native SETH, specify Solana address for cross-chain withdrawal
     * @param minSUSDCOut Minimum output sUSDC amount (slippage protection)
     * @param solanaRecipient Solana recipient address (32 bytes) for cross-chain withdrawal
     * @return amountSUSDCOut Received sUSDC amount
     */
    function sellSETH(uint256 minSUSDCOut, bytes32 solanaRecipient) external payable returns (uint256 amountSUSDCOut) {
        uint256 amountSETHIn = msg.value;
        require(amountSETHIn > 0, "PoolB: Zero SETH input");
        require(solanaRecipient != bytes32(0), "PoolB: Zero Solana recipient");
        
        // 1. Calculate output
        amountSUSDCOut = getAmountOut(amountSETHIn, reserveSETH, reservesUSDC);
        require(amountSUSDCOut >= minSUSDCOut, "PoolB: Slippage exceeded");
        
        // 2. Update reserves (native SETH already in contract via msg.value)
        reserveSETH += amountSETHIn;
        reservesUSDC -= amountSUSDCOut;
        
        // 3. For cross-chain withdrawal, sUSDC is burned (not transferred to user)
        // The sUSDC will be minted on Solana by the relayer
        require(_burn(susdcToken, amountSUSDCOut), "PoolB: sUSDC burn failed");
        
        // 4. Record price
        _recordPrice(amountSETHIn, false);
        
        // 5. Update statistics
        totalVolumeSETH += amountSETHIn;
        totalVolumesUSDC += amountSUSDCOut;
        totalTransactions++;
        
        emit SwapExecuted(msg.sender, false, amountSETHIn, amountSUSDCOut, getPrice(), block.timestamp, solanaRecipient);
    }

    // ==================== Liquidity Management ====================

    /**
     * @dev Treasury/Bridge adds liquidity - Send native SETH
     * @param amountSUSDC sUSDC amount
     */
    function addLiquidity(uint256 amountSUSDC) external payable onlyTreasury {
        uint256 amountSETH = msg.value;
        require(amountSETH > 0, "PoolB: Zero SETH amount");
        require(amountSUSDC > 0, "PoolB: Zero sUSDC amount");
        
        require(_transferFrom(susdcToken, msg.sender, address(this), amountSUSDC), "PoolB: sUSDC transfer failed");
        
        // Native SETH already in contract via msg.value
        reserveSETH += amountSETH;
        reservesUSDC += amountSUSDC;
        
        emit LiquidityAdded(amountSETH, amountSUSDC, reserveSETH, reservesUSDC);
    }

    /**
     * @dev Treasury removes liquidity
     * @param amountSETH SETH amount to remove
     * @param amountSUSDC sUSDC amount to remove
     * @param to Receiving address
     */
    function removeLiquidity(uint256 amountSETH, uint256 amountSUSDC, address payable to) external onlyTreasury {
        require(amountSETH <= reserveSETH && amountSUSDC <= reservesUSDC, "PoolB: Insufficient reserves");
        
        reserveSETH -= amountSETH;
        reservesUSDC -= amountSUSDC;
        
        // Send native SETH
        (bool successSETH, ) = to.call{value: amountSETH}("");
        require(successSETH, "PoolB: SETH transfer failed");
        
        // Send sUSDC
        require(_transfer(susdcToken, to, amountSUSDC), "PoolB: sUSDC transfer failed");
        
        emit LiquidityRemoved(amountSETH, amountSUSDC, to);
    }

    // ==================== Price History ====================

    /**
     * @dev Record price history
     */
    function _recordPrice(uint256 volume, bool isBuy) internal {
        uint256 currentPrice = getPrice();
        
        if (priceHistory.length >= MAX_PRICE_RECORDS) {
            // Remove oldest record
            for (uint256 i = 0; i < priceHistory.length - 1; i++) {
                priceHistory[i] = priceHistory[i + 1];
            }
            priceHistory[priceHistory.length - 1] = PriceRecord({
                timestamp: block.timestamp,
                price: currentPrice,
                volume: volume
            });
        } else {
            priceHistory.push(PriceRecord({
                timestamp: block.timestamp,
                price: currentPrice,
                volume: volume
            }));
        }
    }

    /**
     * @dev Get price history record count
     */
    function getPriceHistoryLength() external view returns (uint256) {
        return priceHistory.length;
    }

    /**
     * @dev Batch get price history
     * @param start Start index
     * @param limit Quantity limit
     */
    function getPriceHistory(uint256 start, uint256 limit) external view returns (PriceRecord[] memory) {
        require(start < priceHistory.length, "PoolB: Start index out of bounds");
        
        uint256 end = start + limit;
        if (end > priceHistory.length) {
            end = priceHistory.length;
        }
        
        uint256 length = end - start;
        PriceRecord[] memory result = new PriceRecord[](length);
        
        for (uint256 i = 0; i < length; i++) {
            result[i] = priceHistory[start + i];
        }
        
        return result;
    }

    // ==================== Query Functions ====================

    /**
     * @dev Get pool state
     */
    function getPoolState() external view returns (
        uint256 _reserveSETH,
        uint256 _reservesUSDC,
        uint256 _price,
        uint256 _totalTx,
        uint256 _totalVolSETH,
        uint256 _totalVolSUSDC,
        uint256 _nativeBalance
    ) {
        _reserveSETH = reserveSETH;
        _reservesUSDC = reservesUSDC;
        _price = getPrice();
        _totalTx = totalTransactions;
        _totalVolSETH = totalVolumeSETH;
        _totalVolSUSDC = totalVolumesUSDC;
        _nativeBalance = address(this).balance;
    }

    // ==================== Transfer Helper Functions ====================

    function _transfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _transferFrom(address token, address from, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _burn(address token, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("burn(address,uint256)", address(this), amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    // ==================== Emergency Functions ====================

    /**
     * @dev Emergency withdraw native SETH (Owner only)
     */
    function emergencyWithdrawNative(uint256 amount) external onlyOwner {
        (bool success, ) = owner().call{value: amount}("");
        require(success, "PoolB: Native withdraw failed");
    }

    /**
     * @dev Emergency withdraw ERC20 tokens (Owner only)
     */
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner(), amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "PoolB: Token withdraw failed");
    }
}