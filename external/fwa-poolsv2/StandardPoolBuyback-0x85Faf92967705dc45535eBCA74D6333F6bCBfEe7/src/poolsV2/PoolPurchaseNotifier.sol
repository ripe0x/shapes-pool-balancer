// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IFWAPurchaseCallback} from "../interfaces/IFWAPurchaseCallback.sol";
import {IPoolPurchaseCallback} from "../interfaces/IPoolPurchaseCallback.sol";

interface IPoolPurchaseNotifierFactory {
    function isPool(address pool) external view returns (bool);
    function poolImplementation(address pool) external view returns (address);
}

interface IPoolPurchaseNotifierPool {
    function purchaseNotifier() external view returns (address);
    function paymentToken() external view returns (address);

    function listings(uint256 listingId)
        external
        view
        returns (
            address collection,
            address depositor,
            address purchaser,
            uint256 tokenId,
            uint256 weight,
            uint256 price,
            uint256 slot,
            uint8 status
        );

    function acquisitions(uint256 requestId)
        external
        view
        returns (
            address purchaser,
            uint256 requestBlock,
            uint256 priceEscrowed,
            uint256 listingId,
            uint8 status,
            bool tokenPayment
        );

    function acquisitionMeta(uint256 requestId)
        external
        view
        returns (
            uint64 sequence,
            uint64 wordDeadlineBlock,
            uint64 rewardEpoch,
            uint16 maxPositiveSlippageBps,
            uint16 maxNegativeSlippageBps,
            uint256 randomWord
        );
}

/// @title PoolPurchaseNotifier
/// @notice Authenticated, bounded collection callbacks for one PoolsV2 implementation's clones.
/// @dev The implementation creates this immutable adapter. Only its registered clones can dispatch,
///      and every receipt is read from their completed settlement state. Downstream failures never
///      propagate. Receivers must authenticate the notifier and originating pool themselves.
contract PoolPurchaseNotifier {
    uint256 internal constant MIN_ENTRY_GAS = 290_000;
    uint256 internal constant ERC165_GAS_STIPEND = 30_000;
    uint256 internal constant CALLBACK_GAS_STIPEND = 100_000;
    uint8 internal constant LISTING_SETTLED = 4;
    uint8 internal constant ACQUISITION_FULFILLED = 2;

    address public immutable factory;
    address public immutable implementation;

    error InvalidFactory();
    error UnauthorizedPool();
    error InvalidPurchase();

    event PurchaseCallbackAttempted(
        address indexed pool,
        address indexed collection,
        uint256 indexed requestId,
        uint256 listingId,
        bool withRandomness,
        bool success
    );

    constructor(address factory_) {
        if (factory_ == address(0) || factory_.code.length == 0) revert InvalidFactory();
        factory = factory_;
        implementation = msg.sender;
    }

    function notifyPurchase(uint256 listingId, uint256 requestId, address resolver, uint256 ownerProceeds) external {
        // The pool must propagate this failure so underfunding the outer transaction cannot silently
        // omit dispatch. The fixed budget covers canonical reads, both probes and one receiver call.
        if (gasleft() < MIN_ENTRY_GAS) {
            assembly ("memory-safe") {
                revert(0, 0)
            }
        }

        IPoolPurchaseNotifierFactory registry = IPoolPurchaseNotifierFactory(factory);
        IPoolPurchaseNotifierPool pool = IPoolPurchaseNotifierPool(msg.sender);
        if (
            !registry.isPool(msg.sender) || registry.poolImplementation(msg.sender) != implementation
                || pool.purchaseNotifier() != address(this)
        ) revert UnauthorizedPool();

        (address collection,, address listingPurchaser, uint256 tokenId,, uint256 price,, uint8 listingStatus) =
            pool.listings(listingId);
        (address purchaser,, uint256 paid, uint256 acquiredListingId, uint8 acquisitionStatus, bool tokenPayment) =
            pool.acquisitions(requestId);
        if (
            listingStatus != LISTING_SETTLED || acquisitionStatus != ACQUISITION_FULFILLED
                || acquiredListingId != listingId || purchaser == address(0) || listingPurchaser != purchaser
                || collection == address(0)
        ) revert InvalidPurchase();

        (,,,,, uint256 randomWord) = pool.acquisitionMeta(requestId);
        address paymentToken = tokenPayment ? pool.paymentToken() : address(0);
        if (tokenPayment && paymentToken == address(0)) revert InvalidPurchase();

        if (_supportsCallback(collection, type(IPoolPurchaseCallback).interfaceId)) {
            IPoolPurchaseCallback.Purchase memory purchase = IPoolPurchaseCallback.Purchase({
                pool: msg.sender,
                requestId: requestId,
                listingId: listingId,
                tokenId: tokenId,
                purchaser: purchaser,
                resolver: resolver,
                paymentToken: paymentToken,
                amountPaid: paid,
                listingPrice: price,
                randomWord: randomWord
            });
            _callReceiver(
                collection, requestId, listingId, true, abi.encodeCall(IPoolPurchaseCallback.onPoolPurchase, (purchase))
            );
            // A failed rich callback must not trigger a second call through the legacy interface.
            return;
        }

        // Legacy settlement amounts are ETH-denominated. Token burns have no compatible outcome.
        if (!tokenPayment && _supportsCallback(collection, type(IFWAPurchaseCallback).interfaceId)) {
            uint256 settlementAmount = ownerProceeds < paid ? ownerProceeds : paid;
            _callReceiver(
                collection,
                requestId,
                listingId,
                false,
                abi.encodeCall(
                    IFWAPurchaseCallback.onFWAPurchase,
                    (
                        msg.sender,
                        listingId,
                        purchaser,
                        resolver,
                        0,
                        settlementAmount,
                        IFWAPurchaseCallback.Outcome.PurchaserKeptNFT
                    )
                )
            );
        }
    }

    function _callReceiver(
        address collection,
        uint256 requestId,
        uint256 listingId,
        bool withRandomness,
        bytes memory callData
    ) internal {
        bool success;
        uint256 gasStipend = CALLBACK_GAS_STIPEND;
        // Never copy receiver returndata, including unbounded revert data.
        assembly ("memory-safe") {
            success := call(gasStipend, collection, 0, add(callData, 0x20), mload(callData), 0, 0)
        }
        emit PurchaseCallbackAttempted(msg.sender, collection, requestId, listingId, withRandomness, success);
    }

    /// @dev Reject malformed/noncanonical responses using fixed input and output buffers. A probe
    ///      that reverts or exhausts its stipend is treated as unsupported.
    function _supportsCallback(address target, bytes4 callbackInterface) internal view returns (bool) {
        if (target.code.length == 0) return false;

        uint32 selector = uint32(0x01ffc9a7); // supportsInterface(bytes4)
        uint32 interfaceId = uint32(callbackInterface);
        uint256 gasStipend = ERC165_GAS_STIPEND;
        uint256 result;
        bool success;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, shl(224, selector))
            mstore(add(ptr, 0x04), shl(224, interfaceId))
            success := staticcall(gasStipend, target, ptr, 0x24, ptr, 0x20)
            success := and(success, eq(returndatasize(), 0x20))
            result := mload(ptr)
        }
        return success && result == 1;
    }
}
