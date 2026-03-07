// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SethBridge
 * @notice 中心化 Relayer 模式的跨链桥合约 (Solana -> Seth)
 * @dev 仅信任特定的 Relayer 地址调用，使用 Solana 交易签名作为重放保护
 *      Ownable 功能已内联，不依赖外部库
 * 
 * 跨链流程：
 * Solana (35% 生态资金) → Relayer → SethBridge → PoolB (注入流动性)
 */
contract SethBridge {
    // ==================== Ownable 功能（内联） ====================
    
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

    // ==================== 合约状态 ====================
    
    // 受信任的 Relayer 地址
    address public trustedRelayer;
    
    // sUSDC 代币地址
    address public sUSDC;
    
    // PoolB 地址 (SETH/sUSDC 定价池)
    address public poolB;
    
    // 国库地址 (可选，用于特殊情况)
    address public treasury;
    
    // 重放保护：记录已处理的 Solana 交易签名
    mapping(bytes32 => bool) public processedTxs;
    
    // Solana USDC 6 位小数 → seth sUSDC 18 位小数
    uint256 public constant DECIMALS_SCALE = 1e12;
    
    // 统计
    uint256 public totalInjectedToPoolB;
    uint256 public totalTransactions;
    
    // ==================== 事件 ====================
    
    event EcosystemFundsInjected(
        bytes32 indexed solanaTxSig,
        uint256 amountSUSDC,
        uint256 amountSETH,
        uint256 timestamp
    );
    
    event PoolBUpdated(address oldPoolB, address newPoolB);
    event RelayerUpdated(address oldRelayer, address newRelayer);

    // ==================== 构造函数 ====================

    constructor(address _sUSDC, address _initialRelayer) {
        _owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        
        sUSDC = _sUSDC;
        trustedRelayer = _initialRelayer;
        // poolB 和 treasury 通过 setter 设置，避免循环依赖
    }

    modifier onlyRelayer() {
        require(msg.sender == trustedRelayer, "SethBridge: Not trusted relayer");
        _;
    }

    // 接收原生 SETH
    receive() external payable {
        // 用于接收原生 SETH
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
    
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    // ==================== 核心功能 ====================
    
    /**
     * @dev 注入 35% 生态资金到 PoolB
     * @param solanaTxSig Solana 交易签名 (防重放)
     * @param amountFromSolana 来自 Solana 的 35% 金额（6 位小数，与 CrossChainMessage.amount 一致）
     * @param amountSETH 原生 SETH 金额 (随交易发送，用于配对注入)
     */
    function injectEcosystemFunds(
        bytes32 solanaTxSig,
        uint256 amountFromSolana,
        uint256 amountSETH
    ) external payable onlyRelayer {
        // 1. 验证
        require(!processedTxs[solanaTxSig], "SethBridge: Transaction already processed");
        require(poolB != address(0), "SethBridge: PoolB not set");
        require(amountFromSolana > 0, "SethBridge: Zero amount from Solana");
        require(msg.value >= amountSETH, "SethBridge: Insufficient native SETH");
        require(amountSETH > 0, "SethBridge: Zero SETH amount");
        
        // 2. 记录已处理
        processedTxs[solanaTxSig] = true;
        
        // 3. Solana USDC 6 位 → seth sUSDC 18 位
        uint256 amountSUSDC = amountFromSolana * DECIMALS_SCALE;
        
        // 4. 铸造 sUSDC 到本合约
        _mintSUSDC(address(this), amountSUSDC);
        
        // 5. 授权 PoolB 使用 sUSDC
        _approve(sUSDC, poolB, amountSUSDC);
        
        // 6. 调用 PoolB 添加流动性（发送原生 SETH）
        (bool success, ) = poolB.call{value: amountSETH}(
            abi.encodeWithSignature("addLiquidity(uint256)", amountSUSDC)
        );
        require(success, "SethBridge: Failed to add liquidity to PoolB");
        
        // 7. 更新统计（按 18 位 sUSDC 记录）
        totalInjectedToPoolB += amountSUSDC;
        totalTransactions++;
        
        emit EcosystemFundsInjected(solanaTxSig, amountSUSDC, amountSETH, block.timestamp);
    }

    /**
     * @dev 执行普通跨链铸造（备用，给用户或 Treasury）
     * @param amount 来自 Solana 的金额（6 位小数），合约内会换算为 sUSDC 18 位
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

    // ==================== 内部函数 ====================
    
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
        // 某些代币不需要 approve 返回值
    }

    // ==================== 查询函数 ====================
    
    function getBridgeState() external view returns (
        uint256 _totalInjected,
        uint256 _totalTx,
        uint256 _nativeBalance
    ) {
        _totalInjected = totalInjectedToPoolB;
        _totalTx = totalTransactions;
        _nativeBalance = address(this).balance;
    }

    // ==================== 紧急函数 ====================
    
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