// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Version 2 of the project's read-only economic quote protocol. Work is counted by PoolBalancer after
///         successful external operations; a policy cannot execute work or decide whether it was useful.
///         Every quote receives the pool's effective `Economics`, resolved once per operation, so a policy holds no
///         mutable numbers of its own and a pinned pool cannot be repriced by a factory update.
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

    /// @notice One keeper economic configuration: the factory default, or a pool's local or pinned copy.
    /// @dev Field widths are the only numeric bounds: they keep every payment, reserve and listing-price product far
    ///      below uint256 and every restocking surcharge below 2^98, inside a listing's uint104 price record.
    ///      Derived, never stored: the maximum keeper payment `(maxGas + overheadGas) * gasPriceCeiling + 10 * workFee`
    ///      (10 = five reconciles plus five Shape units per call) and the maximum restocking surcharge per Shape
    ///      `restockGas * gasPriceCeiling + restockFlat`. The fallback restocking price is this same schedule.
    struct Economics {
        address policy; // pricing algorithm; its quotes are capped by the schedule below
        uint64 workFee; // per reconciled draw sequence and per listed Shape unit
        uint32 maxGas; // reimbursable measured gas per call
        uint32 overheadGas; // transaction gas outside the measured span: intrinsic, quote, payment, transfer
        uint64 gasPriceCeiling;
        uint64 priorityAllowance; // reimbursed price = min(basefee + allowance, ceiling, transaction gas price)
        uint32 restockGas; // restocking surcharge gas per Shape
        uint64 restockFlat; // restocking surcharge flat amount per Shape
        // Gas bounds per verified operation: measured gas is paid only up to their sum (and maxGas).
        uint32 baseGas;
        uint32 processGas;
        uint32 reconcileGas;
        uint32 shapeGas;
        uint32 prizeGas;
    }

    function interfaceVersion() external view returns (uint256);
    function version() external view returns (uint256);
    function quoteReward(Work calldata work, Economics calldata economics) external view returns (uint256);
    /// @notice Total surcharge for ONE prize, which may contain several Shapes. Existing prices never change.
    function quoteRestock(uint8 denomination, uint256 shapeUnits, uint256 baseFee, Economics calldata economics)
        external view returns (uint256);
}
