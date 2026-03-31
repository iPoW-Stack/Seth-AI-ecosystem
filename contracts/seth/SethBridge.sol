// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SethBridge
 * @notice Cross-chain bridge contract with centralized Relayer model (Solana -> Seth)
 * @dev Only trusts specific Relayer address calls, uses Solana transaction signature for replay protection
 *      Ownable functionality inlined, no external dependencies
 *
 * Cross-chain flow (35% ecosystem leg):
 * Relayer → SethBridge → Treasury → PoolB (mint sUSDC, transfer to Treasury, Treasury.injectFromBridge).
 * The 35% share only adds liquidity to PoolB; there is no mining or SETH reward tied to deposits on Seth.
 *
 * Seth → Solana withdraw (user-facing, user only calls SethBridge):
 * - Primary: `requestWithdrawToSolanaFromSETH` — forwards SETH directly to PoolB.sellSETH.
 *   PoolB transfers sUSDC to this contract; bridge escrows and opens withdraw request for the relayer.
 * - Legacy: `requestWithdrawToSolana` — user already holds sUSDC and approves the bridge (transferFrom).
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

    // Treasury: receives minted sUSDC and forwards native SETH into PoolB via Treasury.injectFromBridge
    address public treasury;

    // Replay protection: record processed Solana transaction signatures
    mapping(bytes32 => bool) public processedTxs;

    /// @dev Relayer passes sUSDC amounts in **6-decimal raw** units (same as token `decimals`).
    ///      Keep 1 unless you add an off-chain adapter that sends another scale.
    uint256 public constant DECIMALS_SCALE = 1;

    // Statistics
    uint256 public totalInjectedToPoolB;
    uint256 public totalTransactions;

    struct WithdrawRequest {
        uint256 id;
        address user;
        bytes32 solanaRecipient;
        uint256 susdcAmount;
        uint256 createdAt;
        bool processed;
    }

    uint256 public totalWithdrawRequests;
    mapping(uint256 => WithdrawRequest) public withdrawRequests;

    // ==================== Events ====================

    event EcosystemFundsInjected(
        bytes32 indexed solanaTxSig,
        uint256 amountSUSDC,
        uint256 amountSETH,
        uint256 timestamp
    );

    event PoolBUpdated(address oldPoolB, address newPoolB);
    event RelayerUpdated(address oldRelayer, address newRelayer);

    event WithdrawToSolanaRequested(
        uint256 indexed requestId,
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 susdcAmount
    );
    event WithdrawToSolanaProcessed(uint256 indexed requestId);
    // Seth-side lock semantics for Seth -> Solana bridge leg (mirrors Solana lock/release model).
    event LockToSolanaRequested(
        uint256 indexed lockId,
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 susdcAmount,
        bytes32 lockKey
    );
    event LockToSolanaProcessed(uint256 indexed lockId, bytes32 lockKey);

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

    // ==================== Core Functions ====================

    /**
     * @dev Process cross-chain message: ecosystem funds
     * @param solanaTxSig Solana transaction signature (replay protection)
     * @param ecosystemAmount Ecosystem funds amount (35% leg) - minted, sent to Treasury, then PoolB
     * @param amountSETH Native SETH amount (sent with transaction, for paired injection to PoolB)
     */
    function processCrossChainMessage(
        bytes32 solanaTxSig,
        uint256 ecosystemAmount,
        uint256 amountSETH
    ) external payable onlyRelayer {
        require(!processedTxs[solanaTxSig], "SethBridge: Transaction already processed");
        require(ecosystemAmount > 0, "SethBridge: Zero amount");

        processedTxs[solanaTxSig] = true;

        if (ecosystemAmount > 0) {
            require(poolB != address(0), "SethBridge: PoolB not set");
            require(treasury != address(0), "SethBridge: Treasury not set");
            require(msg.value >= amountSETH, "SethBridge: Insufficient native SETH");

            uint256 amountSUSDC = ecosystemAmount * DECIMALS_SCALE;
            _injectEcosystemToPoolB(amountSUSDC, amountSETH);
        }

        totalTransactions++;

        emit EcosystemFundsInjected(solanaTxSig, ecosystemAmount * DECIMALS_SCALE, amountSETH, block.timestamp);
    }

    /**
     * @dev V2: Cross-chain inject to PoolB (35% leg + optional native SETH pairing).
     * @param recipient Seth-side address associated with the deposit (informational; pool liquidity is shared).
     */
    function processCrossChainMessageV2(
        bytes32 solanaTxSig,
        uint256 ecosystemAmount,
        uint256 amountSETH,
        address recipient
    ) external payable onlyRelayer {
        require(!processedTxs[solanaTxSig], "SethBridge: Transaction already processed");
        require(ecosystemAmount > 0 || amountSETH > 0, "SethBridge: Zero amounts");
        if (ecosystemAmount > 0 || amountSETH > 0) {
            require(recipient != address(0), "SethBridge: Invalid recipient");
        }

        processedTxs[solanaTxSig] = true;

        if (ecosystemAmount > 0 || amountSETH > 0) {
            require(poolB != address(0), "SethBridge: PoolB not set");
            require(treasury != address(0), "SethBridge: Treasury not set");
            require(msg.value >= amountSETH, "SethBridge: Insufficient native SETH");

            uint256 amountSUSDC = ecosystemAmount * DECIMALS_SCALE;
            _injectEcosystemToPoolB(amountSUSDC, amountSETH);
        }

        totalTransactions++;
        emit EcosystemFundsInjected(solanaTxSig, ecosystemAmount * DECIMALS_SCALE, amountSETH, block.timestamp);
    }

    /**
     * @dev Execute standard cross-chain mint (backup, for users or Treasury)
     * @param amount sUSDC amount in **6-decimal raw** units (same as `sUSDC.decimals()`), minted 1:1
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

    /**
     * @dev Mint sUSDC when amountSUSDC > 0, then Treasury.injectFromBridge (SETH-only, sUSDC-only, or both).
     */
    function _injectEcosystemToPoolB(uint256 amountSUSDC, uint256 amountSETH) internal {
        if (amountSUSDC > 0) {
            _mintSUSDC(address(this), amountSUSDC);
            (bool t1, ) = sUSDC.call(
                abi.encodeWithSignature("transfer(address,uint256)", treasury, amountSUSDC)
            );
            require(t1, "SethBridge: sUSDC transfer to Treasury failed");
            totalInjectedToPoolB += amountSUSDC;
        }
        (bool t2, ) = treasury.call{value: amountSETH}(
            abi.encodeWithSignature("injectFromBridge(uint256,uint256)", amountSUSDC, amountSETH)
        );
        require(t2, "SethBridge: Treasury injectFromBridge failed");
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

    /**
     * @notice Quote sUSDC out for a native SETH amount (direct PoolB formula).
     * @param amountSETH SETH amount in chain base unit.
     * @return susdcOut Expected sUSDC (6-decimal raw); 0 if pool unset or illiquid.
     */
    function quoteWithdrawSethToSolana(uint256 amountSETH) external view returns (uint256 susdcOut) {
        if (poolB == address(0) || amountSETH == 0) return 0;
        (bool okR, bytes memory rS) = poolB.staticcall(
            abi.encodeWithSignature("reserveSETH()")
        );
        (bool okU, bytes memory rU) = poolB.staticcall(
            abi.encodeWithSignature("reservesUSDC()")
        );
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
     * @notice User sends native SETH only; Bridge directly calls PoolB.sellSETH and receives sUSDC for escrow.
     * @param solanaRecipient 32-byte Solana pubkey (raw bytes) for the USDC recipient.
     * @param minSUSDCOut Minimum sUSDC (6-decimal raw) from the swap — slippage protection.
     */
    function requestWithdrawToSolanaFromSETH(bytes32 solanaRecipient, uint256 minSUSDCOut) external payable {
        require(poolB != address(0), "SethBridge: PoolB not set");
        require(solanaRecipient != bytes32(0), "SethBridge: Invalid Solana recipient");
        uint256 amountSETH = msg.value;
        require(amountSETH > 0, "SethBridge: Zero SETH");

        // Workaround for Seth multi-hop call instability:
        // call PoolB directly instead of Bridge->Treasury->Pool chain.
        (bool success, bytes memory ret) = poolB.call{value: amountSETH}(
            abi.encodeWithSignature("sellSETH(uint256)", minSUSDCOut)
        );
        require(success, "SethBridge: Pool swap failed");
        uint256 susdcAmount = abi.decode(ret, (uint256));
        require(susdcAmount > 0, "SethBridge: Zero sUSDC out");

        uint256 requestId = ++totalWithdrawRequests;
        withdrawRequests[requestId] = WithdrawRequest({
            id: requestId,
            user: msg.sender,
            solanaRecipient: solanaRecipient,
            susdcAmount: susdcAmount,
            createdAt: block.timestamp,
            processed: false
        });

        bytes32 lockKey = keccak256(abi.encodePacked(address(this), requestId));
        emit WithdrawToSolanaRequested(requestId, msg.sender, solanaRecipient, susdcAmount);
        emit LockToSolanaRequested(requestId, msg.sender, solanaRecipient, susdcAmount, lockKey);
    }

    /**
     * @dev User already holds sUSDC: bridge-back to Solana (approves transferFrom). Prefer
     *      `requestWithdrawToSolanaFromSETH` when the user only holds native SETH.
     * Relayer picks this request and executes the Solana-side unlock.
     */
    function requestWithdrawToSolana(bytes32 solanaRecipient, uint256 susdcAmount) external {
        require(solanaRecipient != bytes32(0), "SethBridge: Invalid Solana recipient");
        require(susdcAmount > 0, "SethBridge: Zero amount");

        (bool ok, ) = sUSDC.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), susdcAmount)
        );
        require(ok, "SethBridge: transferFrom failed");

        uint256 requestId = ++totalWithdrawRequests;
        withdrawRequests[requestId] = WithdrawRequest({
            id: requestId,
            user: msg.sender,
            solanaRecipient: solanaRecipient,
            susdcAmount: susdcAmount,
            createdAt: block.timestamp,
            processed: false
        });

        bytes32 lockKey = keccak256(abi.encodePacked(address(this), requestId));
        emit WithdrawToSolanaRequested(requestId, msg.sender, solanaRecipient, susdcAmount);
        emit LockToSolanaRequested(requestId, msg.sender, solanaRecipient, susdcAmount, lockKey);
    }

    /**
     * @dev Mark withdraw request as processed after relayer completes Solana leg.
     */
    function markWithdrawToSolanaProcessed(uint256 requestId) external onlyRelayer {
        WithdrawRequest storage req = withdrawRequests[requestId];
        require(req.id != 0, "SethBridge: Request not found");
        require(!req.processed, "SethBridge: Request already processed");
        req.processed = true;
        emit WithdrawToSolanaProcessed(requestId);
        emit LockToSolanaProcessed(requestId, keccak256(abi.encodePacked(address(this), requestId)));
    }

    function getWithdrawRequest(uint256 requestId) external view returns (
        address user,
        bytes32 solanaRecipient,
        uint256 susdcAmount,
        uint256 createdAt,
        bool processed
    ) {
        WithdrawRequest memory req = withdrawRequests[requestId];
        return (req.user, req.solanaRecipient, req.susdcAmount, req.createdAt, req.processed);
    }

    // Single-word getters for Seth query_contract compatibility.
    // Some Seth nodes are unstable on tuple/multi-value query responses.
    function withdrawRequestUser(uint256 requestId) external view returns (address) {
        return withdrawRequests[requestId].user;
    }

    function withdrawRequestSolanaRecipient(uint256 requestId) external view returns (bytes32) {
        return withdrawRequests[requestId].solanaRecipient;
    }

    function withdrawRequestSusdcAmount(uint256 requestId) external view returns (uint256) {
        return withdrawRequests[requestId].susdcAmount;
    }

    function withdrawRequestCreatedAt(uint256 requestId) external view returns (uint256) {
        return withdrawRequests[requestId].createdAt;
    }

    function withdrawRequestProcessed(uint256 requestId) external view returns (bool) {
        return withdrawRequests[requestId].processed;
    }

    // Lock-style aliases for compatibility with Solana-side naming and relayer polling.
    function lockRequestUser(uint256 requestId) external view returns (address) {
        return withdrawRequests[requestId].user;
    }

    function lockRequestSolanaRecipient(uint256 requestId) external view returns (bytes32) {
        return withdrawRequests[requestId].solanaRecipient;
    }

    function lockRequestSusdcAmount(uint256 requestId) external view returns (uint256) {
        return withdrawRequests[requestId].susdcAmount;
    }

    function lockRequestCreatedAt(uint256 requestId) external view returns (uint256) {
        return withdrawRequests[requestId].createdAt;
    }

    function lockRequestProcessed(uint256 requestId) external view returns (bool) {
        return withdrawRequests[requestId].processed;
    }

    /**
     * @notice Canonical unique key for Seth->Solana withdraw request.
     * @dev Includes bridge address to avoid collisions across redeploys.
     */
    function withdrawRequestKey(uint256 requestId) external view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), requestId));
    }

    function lockRequestKey(uint256 requestId) external view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), requestId));
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
