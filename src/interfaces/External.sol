// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Subset of the deployed FWA PoolFactory (0x8919814D825a5Af238cC04DE06b1C18c9eaA477C).
interface IFWAPoolFactory {
    function implementation() external view returns (address);
    function poolImplementation(address pool) external view returns (address);
    function createPool(bytes32 userSalt, address expectedImplementation) external returns (address pool);
    function edgeBps() external view returns (uint16);
    function maxAcquisitionsPerTx() external view returns (uint16);
    function globalWithdrawOnly() external view returns (bool);
}

/// @dev Subset of the deployed FWA StandardPoolBuyback (0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7).
interface IFWAPool {
    struct ListingInput {
        address collection;
        uint256 tokenId;
        uint256 price;
    }

    // owner inventory
    function listNFT(address collection, uint256 tokenId, uint256 price) external returns (uint256 listingId);
    function listNFTs(ListingInput[] calldata items) external returns (uint256[] memory listingIds);
    function updatePrice(uint256 listingId, uint256 newPrice) external;
    function withdrawListingTo(uint256 listingId, address recipient) external;
    function withdrawListingsTo(uint256[] calldata listingIds, address recipient) external;
    function recoverRefundedNFT(uint256 listingId) external;
    function withdrawOwnerProceeds() external returns (uint256 amount);

    // owner config
    function setBool(uint256 key, bool value) external;
    function setPurchaseOperator(address newOperator) external;
    function retirePool() external;

    // purchases (used by tests and the keeper only; players use FWA directly)
    function acquire(
        address purchaser,
        uint256 maxAcquisitionFee,
        uint256 minWeightedValue,
        uint256 maxNegativeSlippageBps,
        uint256 expectedInventoryVersion,
        uint256 deadline
    ) external payable returns (uint256 requestId);
    function acquireBatch(
        address purchaser,
        uint256 count,
        uint256 maxAcquisitionFee,
        uint256 minWeightedValue,
        uint256 maxNegativeSlippageBps,
        uint256 expectedInventoryVersion,
        uint256 deadline
    ) external payable returns (uint256[] memory requestIds);
    function acquireWithToken(
        address purchaser,
        uint256 count,
        uint256 minWeightedValue,
        uint256 maxNegativeSlippageBps,
        uint256 expectedInventoryVersion,
        uint256 expectedOfferVersion,
        uint256 deadline
    ) external payable returns (uint256[] memory requestIds);
    function configureTokenOffer(uint256 price, uint256 maxPulls, bool enabled) external;
    function processAcquisitions(uint256 maxCount) external returns (uint256 processed);
    function quoteAcquisitionPrice(uint256 count) external view returns (uint256 fee, uint256 vrf, uint256 total);

    // views
    function owner() external view returns (address);
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
    function requestIdAtSequence(uint64 sequence) external view returns (uint256);
    function lastIssuedSequence() external view returns (uint64);
    function nextSequenceToProcess() external view returns (uint64);
    function unsettledAcquisitionCount() external view returns (uint256);
    function inventoryVersion() external view returns (uint256);
    function totalWeight() external view returns (uint256);
    function weightedBackingTotal() external view returns (uint256);
    function activeListingCount() external view returns (uint256);
    function acquisitionFee() external view returns (uint256);
    function ownerProceeds() external view returns (uint256);
    function purchaseOperator() external view returns (address);
    function tokenOfferEnabled() external view returns (bool);
    function retired() external view returns (bool);
    function localPurchasesEnabled() external view returns (bool);
    function vrfServiceFee() external view returns (uint256);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
    function retryNFTDelivery(uint256 listingId) external;
    function refundFailedDelivery(uint256 listingId) external;
}

/// @dev Subset of the deployed Shapes token (0x6fe9193276bf7abcbee44ab7afd717d637d6faf0).
interface IShapes {
    function mintFee() external view returns (uint256);
    function mintBatch(uint256 amountWei, uint256 quantity) external payable returns (uint256 firstTokenId);
    function redeemBatch(uint256[] calldata tokenIds) external returns (uint256 totalWei);
    function denominationAt(uint8 index) external pure returns (uint256);
    function denomIndexOf(uint256 tokenId) external view returns (uint8);
    function backingOf(uint256 tokenId) external view returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC721Min {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
}

interface IENS {
    function owner(bytes32 node) external view returns (address);
}

interface IReverseRegistrar {
    function setName(string calldata name) external returns (bytes32);
}

/// @dev Draw Packs (ripe0x/shape-packs `draw-packs` at 3a463f7): an ERC-721 whose token holds Shapes in custody and
///      redeems for exactly their backing. Only what the Balancer calls.
interface IShapePacks {
    function createPackTo(uint256[] calldata shapeIds, uint32[] calldata mintCounts, address to)
        external
        payable
        returns (uint256 packId);
    function redeem(uint256 packId) external;
    function shapes() external view returns (address);
    function MIN_PACK_VALUE() external view returns (uint256);
    function setApprovalForAll(address operator, bool approved) external;
}
