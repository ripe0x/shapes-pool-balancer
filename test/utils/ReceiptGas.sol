// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Requires `forge test --isolate`, pinned Foundry 1.8.1. The five-field response's `used` is already billed gas,
///      including intrinsic and its applied refund. SettingsTest's real storage-clear CALL guards this interpretation.
library ReceiptGas {
    address constant VM = address(uint160(uint256(keccak256("hevm cheat code"))));
    function lastBilled() internal view returns (uint256 billed) {
        (bool ok, bytes memory data) = VM.staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok, "lastCallGas");
        (, uint64 used,,,) = abi.decode(data, (uint64, uint64, uint64, int64, uint64));
        return uint256(used);
    }
}
