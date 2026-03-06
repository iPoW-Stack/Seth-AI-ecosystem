// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PoolB - Seth Pricing Pool
 * @notice SETH/sUSDC 定价池，仅允许国库作为 LP
 * @dev Ownable 功能已内联，不依赖外部库
 *      池 B 仅允许国库作为唯一 LP，防止外部操纵
 * 
 * 重要说明：SETH 是 Seth 链的原生代币（类似 ETH），不是 ERC20 代币
 */
contract PoolB {
    // ==================== Ownable 功能（内联） ====================
    
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

    // ==================== 合约状态 ====================
    
    // 代币接口
    // SETH 是原生代币，不需要合约地址
    address public susdcToken;     // sUSDC 代币地址
    address public treasury;       // 国库地址（唯一LP）
    
    // 储备量
    uint256 public reserveSETH;    // 原生 SETH 储备
    uint256 public reservesUSDC;   // sUSDC 储备
    
    // 累计交易量（用于统计）
    uint256 public totalVolumeSETH;
    uint256 public totalVolumesUSDC;
    uint256 public totalTransactions;
    
    // 价格历史记录（用于价格发现）
    struct PriceRecord {
        uint256 timestamp;
        uint256 price;         // SETH 价格（以 sUSDC 计价）
        uint256 volume;        // 交易量
    }
    
    PriceRecord[] public priceHistory;
    uint256 public constant MAX_PRICE_RECORDS = 1000;
    
    // ==================== 事件 ====================
    
    event LiquidityAdded(uint256 amountSETH, uint256 amountSUSDC, uint256 newReserveSETH, uint256 newReservesUSDC);
    event LiquidityRemoved(uint256 amountSETH, uint256 amountSUSDC, address to);
    event SwapExecuted(
        address indexed user,
        bool isBuySETH,          // true: 买SETH, false: 卖SETH
        uint256 amountIn,
        uint256 amountOut,
        uint256 price,
        uint256 timestamp
    );
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event NativeSETHReceived(address indexed from, uint256 amount);

    modifier onlyTreasury() {
        require(msg.sender == treasury, "PoolB: Only treasury can call");
        _;
    }

    // ==================== 构造函数 ====================

    constructor(address _susdcToken, address _treasury) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        susdcToken = _susdcToken;
        treasury = _treasury;
    }

    // 接收原生 SETH
    receive() external payable {
        emit NativeSETHReceived(msg.sender, msg.value);
    }

    // ==================== 配置函数 ====================

    /**
     * @dev 更新国库地址
     */
    function setTreasury(address _newTreasury) external onlyOwner {
        emit TreasuryUpdated(treasury, _newTreasury);
        treasury = _newTreasury;
    }

    // ==================== 价格计算 ====================

    /**
     * @dev 获取当前价格（1 SETH = ? sUSDC）
     * @return price SETH 价格（18位精度）
     */
    function getPrice() public view returns (uint256 price) {
        if (reserveSETH == 0) return 0;
        // price = sUSDC reserve / SETH reserve
        price = (reservesUSDC * 1e18) / reserveSETH;
    }

    /**
     * @dev 计算交易输出量
     * @param amountIn 输入数量
     * @param reserveIn 输入代币储备
     * @param reserveOut 输出代币储备
     * @return amountOut 输出数量
     */
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure returns (uint256 amountOut) {
        require(amountIn > 0, "PoolB: Zero input");
        require(reserveIn > 0 && reserveOut > 0, "PoolB: Insufficient liquidity");
        
        // 恒定乘积公式: amountOut = (amountIn * reserveOut) / (reserveIn + amountIn)
        uint256 amountInWithFee = amountIn; // 池B无手续费，国库独享
        amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
    }

    // ==================== 交易功能 ====================

    /**
     * @dev 买入 SETH（用 sUSDC 购买）
     * @param amountSUSDCIn 输入的 sUSDC 数量
     * @param minSETHOut 最小输出的 SETH 数量（滑点保护）
     * @return amountSETHOut 获得的 SETH 数量
     */
    function buySETH(uint256 amountSUSDCIn, uint256 minSETHOut) external returns (uint256 amountSETHOut) {
        // 1. 转入 sUSDC
        require(_transferFrom(susdcToken, msg.sender, address(this), amountSUSDCIn), "PoolB: sUSDC transfer failed");
        
        // 2. 计算输出
        amountSETHOut = getAmountOut(amountSUSDCIn, reservesUSDC, reserveSETH);
        require(amountSETHOut >= minSETHOut, "PoolB: Slippage exceeded");
        
        // 3. 更新储备
        reservesUSDC += amountSUSDCIn;
        reserveSETH -= amountSETHOut;
        
        // 4. 转出原生 SETH
        (bool success, ) = msg.sender.call{value: amountSETHOut}("");
        require(success, "PoolB: SETH transfer failed");
        
        // 5. 记录价格
        _recordPrice(amountSUSDCIn, true);
        
        // 6. 更新统计
        totalVolumesUSDC += amountSUSDCIn;
        totalVolumeSETH += amountSETHOut;
        totalTransactions++;
        
        emit SwapExecuted(msg.sender, true, amountSUSDCIn, amountSETHOut, getPrice(), block.timestamp);
    }

    /**
     * @dev 卖出 SETH（获得 sUSDC）- 发送原生 SETH
     * @param minSUSDCOut 最小输出的 sUSDC 数量（滑点保护）
     * @return amountSUSDCOut 获得的 sUSDC 数量
     */
    function sellSETH(uint256 minSUSDCOut) external payable returns (uint256 amountSUSDCOut) {
        uint256 amountSETHIn = msg.value;
        require(amountSETHIn > 0, "PoolB: Zero SETH input");
        
        // 1. 计算输出
        amountSUSDCOut = getAmountOut(amountSETHIn, reserveSETH, reservesUSDC);
        require(amountSUSDCOut >= minSUSDCOut, "PoolB: Slippage exceeded");
        
        // 2. 更新储备（原生 SETH 已通过 msg.value 进入合约）
        reserveSETH += amountSETHIn;
        reservesUSDC -= amountSUSDCOut;
        
        // 3. 转出 sUSDC
        require(_transfer(susdcToken, msg.sender, amountSUSDCOut), "PoolB: sUSDC transfer failed");
        
        // 4. 记录价格
        _recordPrice(amountSETHIn, false);
        
        // 5. 更新统计
        totalVolumeSETH += amountSETHIn;
        totalVolumesUSDC += amountSUSDCOut;
        totalTransactions++;
        
        emit SwapExecuted(msg.sender, false, amountSETHIn, amountSUSDCOut, getPrice(), block.timestamp);
    }

    // ==================== 流动性管理 ====================

    /**
     * @dev 国库添加流动性 - 发送原生 SETH
     * @param amountSUSDC sUSDC 数量
     */
    function addLiquidity(uint256 amountSUSDC) external payable onlyTreasury {
        uint256 amountSETH = msg.value;
        require(amountSETH > 0, "PoolB: Zero SETH amount");
        require(amountSUSDC > 0, "PoolB: Zero sUSDC amount");
        
        require(_transferFrom(susdcToken, msg.sender, address(this), amountSUSDC), "PoolB: sUSDC transfer failed");
        
        // 原生 SETH 已通过 msg.value 进入合约
        reserveSETH += amountSETH;
        reservesUSDC += amountSUSDC;
        
        emit LiquidityAdded(amountSETH, amountSUSDC, reserveSETH, reservesUSDC);
    }

    /**
     * @dev 国库移除流动性
     * @param amountSETH 要移除的 SETH 数量
     * @param amountSUSDC 要移除的 sUSDC 数量
     * @param to 接收地址
     */
    function removeLiquidity(uint256 amountSETH, uint256 amountSUSDC, address payable to) external onlyTreasury {
        require(amountSETH <= reserveSETH && amountSUSDC <= reservesUSDC, "PoolB: Insufficient reserves");
        
        reserveSETH -= amountSETH;
        reservesUSDC -= amountSUSDC;
        
        // 发送原生 SETH
        (bool successSETH, ) = to.call{value: amountSETH}("");
        require(successSETH, "PoolB: SETH transfer failed");
        
        // 发送 sUSDC
        require(_transfer(susdcToken, to, amountSUSDC), "PoolB: sUSDC transfer failed");
        
        emit LiquidityRemoved(amountSETH, amountSUSDC, to);
    }

    // ==================== 价格历史 ====================

    /**
     * @dev 记录价格历史
     */
    function _recordPrice(uint256 volume, bool isBuy) internal {
        uint256 currentPrice = getPrice();
        
        if (priceHistory.length >= MAX_PRICE_RECORDS) {
            // 移除最旧的记录
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
            });
        }
    }

    /**
     * @dev 获取价格历史记录数量
     */
    function getPriceHistoryLength() external view returns (uint256) {
        return priceHistory.length;
    }

    /**
     * @dev 批量获取价格历史
     * @param start 起始索引
     * @param limit 数量限制
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

    // ==================== 查询函数 ====================

    /**
     * @dev 获取池子状态
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

    // ==================== 转账辅助函数 ====================

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

    // ==================== 紧急函数 ====================

    /**
     * @dev 紧急提取原生 SETH (仅Owner)
     */
    function emergencyWithdrawNative(uint256 amount) external onlyOwner {
        (bool success, ) = owner().call{value: amount}("");
        require(success, "PoolB: Native withdraw failed");
    }

    /**
     * @dev 紧急提取 ERC20 代币 (仅Owner)
     */
    function emergencyWithdrawToken(address token, uint256 amount) external onlyOwner {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", owner(), amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "PoolB: Token withdraw failed");
    }
}