// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Optional version-one linear-policy display parameters. These values grant no authority. For V1,
///         incentive is per verified draw or listed Shape unit and restockFlat is the TOTAL flat surcharge.
struct Settings {
    uint64 maxGasPrice;
    uint64 priorityCap;
    uint64 incentive;
    uint64 restockFlat;
    uint32 maxGas;
    uint32 overheadGas;
    uint32 restockGas;
    uint32 maxPrizes;
}

library SettingsLib {
    function defaults() internal pure returns (Settings memory) {
        return Settings(5 gwei, 0.05 gwei, 0.00002 ether, 0.0002 ether, 3_200_000, 50_000, 900_000, 1_000);
    }
}
