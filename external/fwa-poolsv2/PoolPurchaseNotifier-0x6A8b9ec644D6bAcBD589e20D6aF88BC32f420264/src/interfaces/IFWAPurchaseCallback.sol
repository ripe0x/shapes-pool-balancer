// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IFWAPurchaseCallback
/// @notice Settlement notification for a registry-recognized FWAIR launch or an ERC-165-opted-in NFT collection.
/// @dev Implementations must authenticate both `msg.sender` (the notifier trusted by `fwa`) and
///      `fwa`. Notifications are best-effort, so correctness must not depend on receiving one.
interface IFWAPurchaseCallback {
    enum Outcome {
        PurchaserKeptNFT,
        PurchaserTookETH,
        PurchaserTookFWA,
        PurchaserRelistedNFT
    }

    /// @param fwa Pool in which the purchase settled.
    /// @param listingId Settled FWA listing.
    /// @param purchaser Address originally allocated the NFT by FWA.
    /// @param resolver Address that submitted the successful settlement transaction.
    /// @param backing Gross ETH backing attached to the listing.
    /// @param settlementAmount Net ETH returned to the depositor for NFT/relist outcomes, or the ETH paid
    ///        to the purchaser/consumed by the token buy for backing outcomes.
    /// @param outcome Asset/result selected by the successful resolution path.
    function onFWAPurchase(
        address fwa,
        uint256 listingId,
        address purchaser,
        address resolver,
        uint256 backing,
        uint256 settlementAmount,
        Outcome outcome
    ) external;
}
