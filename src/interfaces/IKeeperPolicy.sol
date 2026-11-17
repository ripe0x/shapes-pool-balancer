// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Version 1 of the project's read-only economic quote protocol. Work is counted by PoolBalancer after
///         successful external operations; a policy cannot execute work or decide whether it was useful.
interface IKeeperPolicy {
    struct Work {
        uint256 measuredGas;
        uint256 gasPrice;
        uint256 baseFee;
        uint256 reconciledDraws;
        uint256 listedShapeUnits;
        uint256 listedPrizes;
        uint256 processedDraws;
    }

    function interfaceVersion() external view returns (uint256);
    function version() external view returns (uint256);
    /// @dev PoolBalancer snapshots and enforces this bound; an under-declared quote can never spend above it.
    function maxReward() external view returns (uint256);
    function quoteReward(Work calldata work) external view returns (uint256);
    /// @notice Total surcharge for ONE prize, which may contain several Shapes. Existing prices never change.
    function quoteRestock(uint8 denomination, uint256 shapeUnits, uint256 baseFee) external view returns (uint256);
}
