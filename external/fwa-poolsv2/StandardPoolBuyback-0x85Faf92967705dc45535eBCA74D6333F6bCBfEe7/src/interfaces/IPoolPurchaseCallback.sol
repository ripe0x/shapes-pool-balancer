// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IPoolPurchaseCallback
/// @notice Optional ERC-165 collection notification after a PoolsV2 NFT purchase is delivered.
/// @dev Receivers must authenticate both the notifier (`msg.sender`) and `purchase.pool`, and may
///      verify the canonical listing and acquisition. Notifications are best-effort, have bounded
///      gas, and are not retried. A receiver must not depend on a notification for correctness.
interface IPoolPurchaseCallback {
    struct Purchase {
        address pool;
        uint256 requestId;
        uint256 listingId;
        uint256 tokenId;
        address purchaser;
        address resolver;
        // Zero for native ETH; otherwise the pool's payment token.
        address paymentToken;
        // Gross acquisition payment in wei or payment-token base units, excluding the VRF fee.
        uint256 amountPaid;
        // Owner-assigned listing price in wei; this is neither backing nor an appraisal.
        uint256 listingPrice;
        // Exact authenticated VRF word, including zero; no modulo or other transformation.
        uint256 randomWord;
    }

    /// @notice Called once after verified NFT delivery and final settlement accounting.
    /// @param purchase Canonical purchase receipt; `resolver` called the successful processor/retry
    ///        path, or is the pool itself when the VRF callback's self-call delivered the NFT.
    function onPoolPurchase(Purchase calldata purchase) external;
}
