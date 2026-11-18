// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IKeeperPolicy} from "./interfaces/IKeeperPolicy.sol";

/// @notice Immutable starting policy. The work fee follows completed draw sequences and created/listed Shape units,
///         so splitting a job cannot duplicate service fees. Gas reimbursement and refunds can still favor splitting.
contract KeeperPolicyV1 is IKeeperPolicy {
    uint256 public constant WORK_FEE = 0.00002 ether;
    uint256 public constant MAX_GAS = 3_200_000;
    uint256 public constant OVERHEAD_GAS = 50_000;
    uint256 public constant GAS_PRICE_CEILING = 5 gwei;
    uint256 public constant PRIORITY_ALLOWANCE = 0.05 gwei;
    uint256 public constant RESTOCK_GAS = 900_000;
    uint256 public constant RESTOCK_FLAT = 0.0002 ether;

    function interfaceVersion() external pure returns (uint256) { return 1; }
    function version() external pure returns (uint256) { return 1; }
    function maxReward() public pure returns (uint256) {
        return (MAX_GAS + OVERHEAD_GAS) * GAS_PRICE_CEILING + 10 * WORK_FEE;
    }
    function quoteReward(Work calldata w) external pure returns (uint256) {
        uint256 measured = w.measuredGas > MAX_GAS ? MAX_GAS : w.measuredGas;
        uint256 price = _price(w.baseFee);
        if (w.gasPrice < price) price = w.gasPrice;
        return (measured + OVERHEAD_GAS) * price + (w.reconciledDraws + w.listedShapeUnits) * WORK_FEE;
    }
    function quoteRestock(uint8, uint256 units, uint256 baseFee) external pure returns (uint256) {
        return units * (RESTOCK_GAS * _price(baseFee) + RESTOCK_FLAT);
    }
    function _price(uint256 baseFee) internal pure returns (uint256 price) {
        price = baseFee + PRIORITY_ALLOWANCE;
        if (price > GAS_PRICE_CEILING) price = GAS_PRICE_CEILING;
    }
}
