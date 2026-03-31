// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Probe for Seth query_contract multi-return decoding.
 * Shape intentionally mirrors SethBridge.getWithdrawRequest(uint256):
 * (address, bytes32, uint256, uint256, bool)
 */
contract ProbeMultiReturn {
    struct Req {
        address user;
        bytes32 solanaRecipient;
        uint256 susdcAmount;
        uint256 createdAt;
        bool processed;
    }

    mapping(uint256 => Req) private _reqs;
    uint256 public pingValue = 42;

    function setRequest(
        uint256 requestId,
        address user,
        bytes32 solanaRecipient,
        uint256 susdcAmount,
        uint256 createdAt,
        bool processed
    ) external {
        _reqs[requestId] = Req({
            user: user,
            solanaRecipient: solanaRecipient,
            susdcAmount: susdcAmount,
            createdAt: createdAt,
            processed: processed
        });
    }

    function getRequest(uint256 requestId)
        external
        view
        returns (
            address user,
            bytes32 solanaRecipient,
            uint256 susdcAmount,
            uint256 createdAt,
            bool processed
        )
    {
        Req storage r = _reqs[requestId];
        return (r.user, r.solanaRecipient, r.susdcAmount, r.createdAt, r.processed);
    }

    function getAmount(uint256 requestId) external view returns (uint256) {
        return _reqs[requestId].susdcAmount;
    }

    // Mirror SethBridge single-word withdraw getters.
    function withdrawRequestUser(uint256 requestId) external view returns (address) {
        return _reqs[requestId].user;
    }

    function withdrawRequestSolanaRecipient(uint256 requestId) external view returns (bytes32) {
        return _reqs[requestId].solanaRecipient;
    }

    function withdrawRequestSusdcAmount(uint256 requestId) external view returns (uint256) {
        return _reqs[requestId].susdcAmount;
    }

    function withdrawRequestCreatedAt(uint256 requestId) external view returns (uint256) {
        return _reqs[requestId].createdAt;
    }

    function withdrawRequestProcessed(uint256 requestId) external view returns (bool) {
        return _reqs[requestId].processed;
    }
}
