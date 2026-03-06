// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Treasury - Seth AI Ecosystem 国库
 * @notice 接收来自 Solana 链的 35% 生态资金
 * @dev Ownable 功能已内联，不依赖外部库
 *      分账逻辑在 Solana 链上完成，此合约仅负责：
 *      1. 接收跨链资金（通过 SethBridge 铸造的 sUSDC）
 *      2. 管理资金
 *      3. 可选：注入池B支撑 SETH 价格
 */
contract Treasury {
    // ==================== Ownable 功能（内联） ====================
    
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

    // ==================== 合约状态 ====================
    
    // sUSDC 代币地址
    address public susdcToken;
    
    // SethBridge 合约地址（有 mint 权限）
    address public bridgeContract;
    
    // 池B地址（可选，用于注入流动性）
    address public poolB;
    
    // Relayer 地址
    address public trustedRelayer;
    
    // 统计数据
    uint256 public totalReceivedFromSolana;  // 从 Solana 接收的资金
    uint256 public totalInjectedToPoolB;     // 注入池B的资金
    
    // 已处理的跨链消息（防重放）
    mapping(bytes32 => bool) public processedMessages;
    
    // ==================== 事件 ====================
    
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

    // ==================== 修饰器 ====================
    
    modifier onlyRelayer() {
        require(msg.sender == trustedRelayer, "Treasury: Not trusted relayer");
        _;
    }

    // ==================== 构造函数 ====================

    constructor(address _susdcToken, address _relayer) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        susdcToken = _susdcToken;
        trustedRelayer = _relayer;
        // bridgeContract 和 poolB 通过 setter 设置，避免循环依赖
    }

    // 接收原生 SETH
    receive() external payable {
        // 用于接收原生 SETH（如果需要）
    }

    // ==================== 配置函数 ====================
    
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

    // ==================== 核心功能 ====================
    
    /**
     * @dev 接收来自 Solana 的生态资金 (35%)
     * @param solanaTxSig Solana 交易签名 (防重放)
     * @param recipient 接收地址（通常是 Treasury 自身，也可以是其他地址）
     * @param amount sUSDC 金额
     */
    function receiveEcosystemFunds(
        bytes32 solanaTxSig,
        address recipient,
        uint256 amount
    ) external onlyRelayer {
        require(amount > 0, "Treasury: Zero amount");
        require(!processedMessages[solanaTxSig], "Treasury: Already processed");
        
        // 标记已处理
        processedMessages[solanaTxSig] = true;
        
        // 更新统计（如果接收者是 Treasury）
        if (recipient == address(this)) {
            totalReceivedFromSolana += amount;
        }
        
        emit EcosystemFundsReceived(solanaTxSig, amount, recipient);
    }

    /**
     * @dev 注入资金到池B（手动调用）
     * @param amountSUSDC sUSDC 数量
     * @param amountSETH 原生 SETH 数量（随交易发送）
     */
    function injectToPoolB(uint256 amountSUSDC, uint256 amountSETH) external payable onlyOwner {
        require(poolB != address(0), "Treasury: PoolB not set");
        require(amountSUSDC > 0, "Treasury: Zero sUSDC amount");
        require(msg.value >= amountSETH, "Treasury: Insufficient native SETH sent");
        require(amountSETH > 0, "Treasury: Zero SETH amount");
        
        // 1. 授权池B使用 sUSDC
        _approve(susdcToken, poolB, amountSUSDC);
        
        // 2. 添加流动性到池B（发送原生 SETH）
        (bool success, ) = poolB.call{value: amountSETH}(
            abi.encodeWithSignature(
                "addLiquidity(uint256)",
                amountSUSDC
            )
        );
        require(success, "Treasury: Failed to add liquidity");
        
        // 更新统计
        totalInjectedToPoolB += amountSUSDC;
        
        emit FundsInjectedToPoolB(amountSUSDC, amountSETH, block.timestamp);
    }

    // ==================== 代币操作辅助函数 ====================
    
    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, ) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        // 某些代币不需要 approve 返回值
    }

    // ==================== 查询函数 ====================
    
    function getTreasuryState() external view returns (
        uint256 _totalReceived,
        uint256 _totalInjected,
        uint256 _nativeBalance
    ) {
        _totalReceived = totalReceivedFromSolana;
        _totalInjected = totalInjectedToPoolB;
        _nativeBalance = address(this).balance;
    }

    // ==================== 紧急函数 ====================
    
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