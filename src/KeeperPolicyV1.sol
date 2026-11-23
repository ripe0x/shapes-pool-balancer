// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";

/// @notice Stateless V1 pricing algorithm over the pool's effective economics. The work fee follows processed and
///         reconciled draw sequences and created/listed Shape units, so splitting a job cannot duplicate service fees. Gas reimbursement
///         and refunds can still favor splitting. It holds no numbers: the factory or the pool supplies them.
contract KeeperPolicyV1 is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 2; }
    function version() external pure returns (uint256) { return 1; }
    function quoteReward(Work calldata w, Economics calldata e) external pure returns (uint256) {
        uint256 measured = w.measuredGas > e.maxGas ? e.maxGas : w.measuredGas;
        uint256 price = _price(w.baseFee, e);
        if (w.gasPrice < price) price = w.gasPrice;
        return (measured + e.overheadGas) * price + (w.processedDraws + w.reconciledDraws + w.listedShapeUnits) * e.workFee;
    }
    function quoteRestock(uint8, uint256 units, uint256 baseFee, Economics calldata e) external pure returns (uint256) {
        return units * (e.restockGas * _price(baseFee, e) + e.restockFlat);
    }
    function _price(uint256 baseFee, Economics calldata e) internal pure returns (uint256 price) {
        price = baseFee + e.priorityAllowance;
        if (price > e.gasPriceCeiling) price = e.gasPriceCeiling;
    }
}
