// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Keeper-pay and pool-size values. The BalancerFactory's keeper admin sets the defaults every
///         Balancer reads; a pool's creator may override the four marked "creator" for their own pool. Each field is
///         checked on its own against the limits in `SettingsLib.check`, so any mix of defaults and overrides is in
///         range. None of them touches prize backing: they set what keepers are paid from the creator's ETH, the
///         restocking fee built into new prize prices, and how many prizes a saved design may hold.
struct Settings {
    uint64 maxGasPrice; // creator: the most a keeper is reimbursed per gas, and the gas price restocking fees use
    uint64 priorityCap; // creator: reimbursed priority over basefee
    uint64 incentive; // creator: flat reward per paid upkeep
    uint64 restockFlat; // creator: the creator's margin in each Shape's restocking fee, over gas and incentive
    uint32 maxGas; // measured gas paid per upkeep, at most
    uint32 overheadGas; // gas paid per upkeep outside the measured span
    uint32 restockGas; // gas part of each Shape's restocking fee, at least overheadGas + 850k
    uint32 maxPrizes; // prizes a saved design may hold
}

library SettingsLib {
    error SettingOutOfRange();

    /// @dev The factory's settings at deployment. Upkeep work is bounded per call (reconciles, Shape units, sizes and
    ///      processed draws), not by pool size: the worst upkeep measured 2,646,324 gas at 200 prizes and 2,646,369 at
    ///      1,000. FWA's processing grows with its listing count; with a curated collection that spends every FWA gas
    ///      allowance, billed gas measured 2.77M at 1,024 listings, 2.82M at 2,048 and 2.87M at 4,096.
    function defaults() internal pure returns (Settings memory) {
        return Settings(5 gwei, 0.05 gwei, 0.0001 ether, 0.0001 ether, 3_200_000, 50_000, 900_000, 1_000);
    }

    /// @dev Limits that keep the system working at any setting: maxGas covers the billed gas of the worst measured
    ///      upkeep (2.87M, with a curated collection that spends every FWA gas allowance, at 4,096 listings) and
    ///      overheadGas its outside-span gas (measured 24k-46k); the
    ///      restocking fee's gas covers a restock-one upkeep and its overhead (restockGas >= overheadGas + 850k; the fee
    ///      also carries the incentive), so a prize's fee pays its own restock under the settings and gas price of its
    ///      listing block, less up to 14k gas when restockFlat is 0 (restocks measured up to 864k gas against the 850k
    ///      floor; the creator pays that part). A listed fee never changes: if pay settings or gas rise later, restocking an older prize
    ///      costs the creator the difference until it is won and relisted; a gas price cap of at least
    ///      1 gwei; at most 1,000 prizes. Upper limits bound what a keeper call can cost the creator:
    ///      (6M + 200k) x 50 gwei + 0.001 ETH = 0.311 ETH.
    function check(Settings memory s) internal pure {
        if (
            s.maxGasPrice < 1 gwei || s.maxGasPrice > 50 gwei || s.priorityCap > 2 gwei || s.incentive > 0.001 ether
                || s.restockFlat > 0.002 ether || s.maxGas < 3_200_000 || s.maxGas > 6_000_000 || s.overheadGas < 50_000
                || s.overheadGas > 200_000 || s.restockGas < uint256(s.overheadGas) + 850_000 || s.restockGas > 2_000_000 || s.maxPrizes == 0
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
    ///      incentive + restockFlat.
    function restockFee(Settings memory s) internal view returns (uint256) {
        return uint256(s.restockGas) * rewardPrice(s, type(uint256).max) + s.incentive + s.restockFlat;
    }
}
