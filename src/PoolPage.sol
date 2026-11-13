// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LibString} from "solady/utils/LibString.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

/// @title PoolPage
/// @notice Builds the digest of FWA's "Publish FWA Pools page" message for one pool. An external library (called by
///         DELEGATECALL, pure) so this rarely used code sits outside PoolBalancer's 24 KB limit.
library PoolPage {
    /// @dev Same signature as PoolBalancer.InvalidConfig, so callers see the error they always did.
    error InvalidConfig();

    /// @dev FWA Pools V1 factory, named in FWA's pool-page message next to the V2 PoolFactory.
    string internal constant FWA_V1_FACTORY = "0xf5a3a153164791ab579c3d9ba5dbecf7cdfd300c";

    /// @notice personal_sign digest of the exact message pools.fwa.fun asks a pool owner to sign. `issuedAt` is the
    ///         ISO-8601 time the site will submit (24 chars, e.g. 2026-11-10T12:34:56.789Z); `metadataHash` is
    ///         keccak256 of the page JSON. Format verified against pools.fwa.fun's client code 2026-11-10.
    function digest(address fwaFactory, address pool, string calldata issuedAt, bytes32 metadataHash)
        external
        pure
        returns (bytes32)
    {
        bytes calldata t = bytes(issuedAt);
        if (t.length != 24) revert InvalidConfig();
        for (uint256 i; i < 24; ++i) {
            bytes1 c = t[i];
            if ((c < "0" || c > "9") && c != "-" && c != ":" && c != "." && c != "T" && c != "Z") revert InvalidConfig();
        }
        return SignatureCheckerLib.toEthSignedMessageHash(
            abi.encodePacked(
                "Publish FWA Pools page\nSite: pools.fwa.fun\nChain: 1\nFactories: ",
                LibString.toHexString(fwaFactory),
                ", ",
                FWA_V1_FACTORY,
                "\nPool: ",
                LibString.toHexString(pool),
                "\nIssued at: ",
                issuedAt,
                "\nMetadata hash: ",
                LibString.toHexString(uint256(metadataHash), 32)
            )
        );
    }
}
