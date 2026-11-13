// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {StandardPool} from "./StandardPool.sol";

interface IPoolBuybackFactory {
    function fwaToken() external view returns (address);
}

interface IPoolFeeBuyback {
    function token() external view returns (address);
}

/// @notice Standard-pool implementation that sends its entire ETH purchase markup to FWAV2Buyback.
/// @dev Install through the existing factory's setImplementation while pool creation is disabled.
/// Only subsequently created clones use this implementation. The existing factory, service, token
/// launcher and fee router retain their addresses and their separate launch-tax and surplus routes.
contract StandardPoolBuyback is StandardPool {
    address payable public immutable feeBuyback;

    constructor(address factory_, address service_, address payable feeBuyback_) StandardPool(factory_, service_) {
        if (
            feeBuyback_.code.length == 0
                || IPoolFeeBuyback(feeBuyback_).token() != IPoolBuybackFactory(factory_).fwaToken()
        ) revert InvalidConfig();
        feeBuyback = feeBuyback_;
    }

    /// @notice Fund the existing FWA buyback with all accrued ETH purchase fees, with or without a pool token.
    /// @dev Buyback execution and main-pool purchaser rewards remain in their existing contracts.
    /// A failed ETH transfer reverts the accrual reset, keeping the complete amount available for retry.
    function payoutProtocolFees() external override nonReentrant returns (uint256 amount) {
        amount = accruedProtocolFees;
        if (amount == 0) revert NoProtocolFees();
        accruedProtocolFees = 0;
        SafeTransferLib.safeTransferETH(feeBuyback, amount);
        emit ProtocolFeesPaidOut(feeBuyback, amount);
    }
}
