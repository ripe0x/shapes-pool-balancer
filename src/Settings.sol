// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Keeper-pay and pool-size values (decision 88). The BalancerFactory's keeper admin sets the defaults every
///         Balancer reads; a pool's creator may override the four marked "creator" for their own pool. Each field is
///         checked on its own against the limits in `SettingsLib.check`, so any mix of defaults and overrides is in
///         range. None of them touches prize backing: they set what keepers are paid from the creator's ETH, the
///         restocking fee built into new prize prices, and how many prizes a saved design may hold.
struct Settings {
    uint64 maxGasPrice; // creator: the most a keeper is reimbursed per gas, and the gas price restocking fees use
    uint64 priorityCap; // creator: reimbursed priority over basefee
    uint64 incentive; // creator: flat reward per paid upkeep
    uint64 restockFlat; // creator: flat part of each Shape's restocking fee
    uint32 maxGas; // measured gas paid per upkeep, at most
    uint32 overheadGas; // gas paid per upkeep outside the measured span
    uint32 restockGas; // gas part of each Shape's restocking fee
    uint32 maxPrizes; // prizes a saved design may hold
}

library SettingsLib {
    error SettingOutOfRange();

    /// @dev The values in force before settings were adjustable (decisions 54, 58, 73, 74, 87).
    function defaults() internal pure returns (Settings memory) {
        return Settings(5 gwei, 0.05 gwei, 0.0001 ether, 0.0002 ether, 3_200_000, 50_000, 900_000, 200);
    }

    /// @dev Limits that keep the system working at any setting: keepers are always paid at least the gas of the worst
    ///      measured upkeep (2.78M of maxGas) and its outside-span overhead (measured 24k-46k of overheadGas); a gas
    ///      price cap of at least 1 gwei; at most 1,000 prizes. Upper limits bound what a keeper call can cost the
    ///      creator: (6M + 200k) x 50 gwei + 0.001 ETH = 0.311 ETH.
    function check(Settings memory s) internal pure {
        if (
            s.maxGasPrice < 1 gwei || s.maxGasPrice > 50 gwei || s.priorityCap > 2 gwei || s.incentive > 0.001 ether
                || s.restockFlat > 0.002 ether || s.maxGas < 3_200_000 || s.maxGas > 6_000_000 || s.overheadGas < 50_000
                || s.overheadGas > 200_000 || s.restockGas < 500_000 || s.restockGas > 2_000_000 || s.maxPrizes == 0
                || s.maxPrizes > 1_000
        ) revert SettingOutOfRange();
    }

    /// @dev The most one upkeep can pay: (maxGas + overheadGas) x maxGasPrice + incentive.
    function maxReward(Settings memory s) internal pure returns (uint256) {
        return (uint256(s.maxGas) + s.overheadGas) * s.maxGasPrice + s.incentive;
    }

    /// @dev Reimbursed price: min(bid, basefee + priorityCap, maxGasPrice).
    function rewardPrice(Settings memory s, uint256 bid) internal view returns (uint256 price) {
        price = block.basefee + s.priorityCap;
        if (bid < price) price = bid;
        if (price > s.maxGasPrice) price = s.maxGasPrice;
    }

    /// @dev Restocking fee per Shape for a prize listed now: restockGas x min(basefee + priorityCap, maxGasPrice) +
    ///      restockFlat.
    function restockFee(Settings memory s) internal view returns (uint256) {
        return uint256(s.restockGas) * rewardPrice(s, type(uint256).max) + s.restockFlat;
    }
}
