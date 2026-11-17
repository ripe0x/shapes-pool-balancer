// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolBalancer} from "./PoolBalancer.sol";
import {KeeperPolicyCalls} from "./KeeperPolicyCalls.sol";
import {IFWAPool, IShapes, IShapePacks, IERC721Min} from "./interfaces/External.sol";

/// @dev Compiler-linked immutable inventory implementation, not a creator-selected policy. Delegatecall preserves
///      the Balancer as NFT owner and FWA operator. There is no configurable execution target or upgrade mechanism.
library PoolInventory {
    struct Item {
        uint8 kind;
        uint8 denom;
        uint8 state;
        uint16 markupBps; // Shape markup when listed (zero for curated): the creator's part of its price is its backing x this
        uint104 base; // creator value (curated) or the price less its restocking fees: backing, mint fees, markup (Shape)
        uint104 price; // price listed on FWA
    }

    struct State {
        mapping(uint256 => Item) items;
        uint256[] activeIds;
        mapping(uint256 => uint256) activeIndexPlusOne;
        uint16[16] activeShapes;
        uint256 profitShareSum;
        uint256 listedFees;
        uint256 listedPrizes;
    }
    struct Fill {
        uint256 plan;
        uint256 markup;
        uint256 keep;
        uint256 fee;
        address shapes;
        address packs;
        address pool;
        address policy;
        bool paid;
    }
    uint256 constant MAX_OPS = 5;
    uint256 constant DENOMS = 16;
    uint256 constant SHAPE_DENOMS = 9;
    uint256 constant MAX_RESTOCK_SIZES = 4;
    uint8 constant SHAPE = 2;
    uint8 constant ACTIVE = 1;
    uint256 constant BY_VALUE = 0x87f65ed43cb21a90;
    uint256 constant AMOUNTS = 0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;
    uint256 constant SHAPES_IN = 0x3323232111111111;
    event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost);
    event ShapeListed(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId, uint256 price);
    error InvalidItem();

    event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price);
    event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price);
    event CuratedWithdrawn(uint256 indexed listingId, address indexed to);
    event RefundedRecovered(uint256 indexed listingId, address indexed to, uint256 eth);
    error InvalidBatch();
    error InvalidRecipient();
    error ValueTooHigh();
    error ShapesNotCurated();

    function listCurated(State storage s, IFWAPool pool, address shapes, address packs,
        PoolBalancer.CuratedInput[] calldata inputs) public returns (uint256[] memory listingIds)
    {
        uint256 n = inputs.length;
        if (n == 0 || n > 20) revert InvalidBatch();
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](n);
        for (uint256 i; i < n; ++i) {
            PoolBalancer.CuratedInput calldata c = inputs[i];
            if (c.collection == shapes || c.collection == packs) revert ShapesNotCurated();
            IERC721Min token = IERC721Min(c.collection);
            token.transferFrom(msg.sender, address(this), c.tokenId);
            if (token.ownerOf(c.tokenId) != address(this)) revert InvalidItem();
            token.approve(address(pool), c.tokenId);
            _checkValue(c.base);
            batch[i] = IFWAPool.ListingInput(c.collection, c.tokenId, c.base);
        }
        listingIds = pool.listNFTs(batch);
        for (uint256 i; i < n; ++i) {
            uint256 lid = listingIds[i];
            s.items[lid] = Item(1, 0, ACTIVE, 0, uint104(inputs[i].base), uint104(inputs[i].base));
            addActive(s, lid);
            emit CuratedListed(lid, inputs[i].collection, inputs[i].tokenId, inputs[i].base, inputs[i].base);
        }
    }
    function updateCurated(State storage s, IFWAPool pool, uint256 lid, uint256 base) public {
        Item storage it = s.items[lid];
        if (it.kind != 1 || it.state != ACTIVE) revert InvalidItem();
        _checkValue(base);
        it.base = uint104(base);
        if (base != it.price) {
            pool.updatePrice(lid, base);
            it.price = uint104(base);
        }
        emit CuratedRepriced(lid, base, base);
    }
    function withdrawCurated(State storage s, IFWAPool pool, uint256 lid, address to) public {
        Item storage it = s.items[lid];
        if (it.kind != 1 || it.state != ACTIVE) revert InvalidItem();
        if (to == address(0)) revert InvalidRecipient();
        removeActive(s, lid);
        delete s.items[lid];
        pool.withdrawListingTo(lid, to);
        emit CuratedWithdrawn(lid, to);
    }
    function recoverRefunded(State storage s, IFWAPool pool, address shapes, address packs, uint256 lid, address to)
        public returns (uint256 eth)
    {
        Item storage it = s.items[lid];
        if (it.state != 2 || to == address(0)) revert InvalidItem();
        (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(lid);
        if (status != 7) revert InvalidItem();
        uint8 kind = it.kind;
        uint8 d = it.denom;
        delete s.items[lid];
        pool.recoverRefundedNFT(lid);
        if (kind == 1) IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        else {
            uint256 before = address(this).balance;
            IShapePacks(d < 9 ? shapes : packs).redeem(tokenId);
            eth = address(this).balance - before;
        }
        emit RefundedRecovered(lid, to, eth);
    }
    function _checkValue(uint256 base) internal pure {
        if (base == 0 || base > type(uint104).max) revert ValueTooHigh();
    }

    function fill(State storage st, Fill memory f) public returns (uint256 used, uint256 listed, uint256 added) {
        IFWAPool p = IFWAPool(f.pool);
        IShapes SHAPES = IShapes(f.shapes);
        IShapePacks PACKS = IShapePacks(f.packs);
        uint256 plan = f.plan;
        uint256 markup = f.markup;
        uint256 keep = f.keep;
        uint256 fee = f.fee;
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](MAX_OPS);
        uint8[] memory sizes = new uint8[](MAX_OPS);
        uint256 n;
        uint256 restocked; // sizes
        for (uint256 k; k < DENOMS; ++k) {
            uint256 d = (BY_VALUE >> (4 * k)) & 0xF;
            uint256 have = st.activeShapes[d];
            uint256 want = _count(plan, d);
            if (have >= want) continue;
            uint256 w = _shapesIn(d);
            uint256 need = want - have;
            if (need > (MAX_OPS - used) / w) need = (MAX_OPS - used) / w;
            uint256 each = _cost(d, fee);
            uint256 bal = address(this).balance;
            uint256 affordable = bal > keep ? (bal - keep) / each : 0;
            if (need > affordable) need = affordable;
            if (need == 0) break; // stop at the first size not fully restocked, so restocking stays in value order
            uint256 price = _prizeBase(d, fee, markup) + KeeperPolicyCalls.restock(f.policy, uint8(d), w, f.paid, block.basefee);
            if (d < SHAPE_DENOMS) {
                uint256 first = SHAPES.mintBatch{value: need * each}(_amount(d), need);
                emit ShapesMinted(uint8(d), first, need, need * each);
                for (uint256 j; j < need; ++j) {
                    sizes[n] = uint8(d);
                    batch[n++] = IFWAPool.ListingInput(address(SHAPES), first + j, price);
                }
            } else {
                // One pack per prize, each minting its Shapes inside; the pack token comes to this contract.
                uint32[] memory makeup = _makeup(d);
                for (uint256 j; j < need; ++j) {
                    uint256 id = PACKS.createPackTo{value: each}(new uint256[](0), makeup, address(this));
                    if (j == 0) emit ShapesMinted(uint8(d), id, need, need * each);
                    sizes[n] = uint8(d);
                    batch[n++] = IFWAPool.ListingInput(address(PACKS), id, price);
                }
            }
            used += need * w;
            if (need < want - have || ++restocked == MAX_RESTOCK_SIZES) break;
        }
        if (n == 0) return (0, 0, 0);
        assembly ("memory-safe") {
            mstore(batch, n)
        }
        uint256[] memory lids = p.listNFTs(batch);
        for (uint256 i; i < n; ++i) {
            uint8 d = sizes[i];
            uint256 base = _prizeBase(d, fee, markup);
            st.items[lids[i]] = PoolInventory.Item(SHAPE, d, ACTIVE, uint16(markup), uint104(base), uint104(batch[i].price));
            addActive(st, lids[i]);
            ++st.activeShapes[d];
            added += _weight(d);
            emit ShapeListed(lids[i], d, batch[i].tokenId, batch[i].price);
        }
        listed = n;
    }

    function addActive(State storage s, uint256 lid) public {
        Item storage it = s.items[lid];
        if (it.kind == SHAPE) {
            s.listedFees += uint256(it.price) - it.base;
            ++s.listedPrizes;
        }
        s.activeIds.push(lid);
        s.activeIndexPlusOne[lid] = s.activeIds.length;
        s.profitShareSum += _share(it);
    }
    function removeActive(State storage s, uint256 lid) public {
        uint256 idx = s.activeIndexPlusOne[lid];
        if (idx == 0) revert InvalidItem();
        Item storage it = s.items[lid];
        if (it.kind == SHAPE) {
            s.listedFees -= uint256(it.price) - it.base;
            --s.listedPrizes;
        }
        s.profitShareSum -= _share(it);
        uint256 lastId = s.activeIds[s.activeIds.length - 1];
        s.activeIds[idx - 1] = lastId;
        s.activeIndexPlusOne[lastId] = idx;
        s.activeIds.pop();
        delete s.activeIndexPlusOne[lid];
    }
    function _share(Item storage it) internal view returns (uint256) {
        if (it.kind == 1) return 0;
        return _amount(it.denom) * (it.markupBps - 1_000) * 1e18 / (10_000 * it.price);
    }
    function _weight(uint256 d) internal pure returns (uint256) { return 1e36 / _amount(d); }
    function _prizeBase(uint256 d, uint256 fee, uint256 markup) internal pure returns (uint256) {
        return _cost(d, fee) + _amount(d) * markup / 10_000;
    }
    function _cost(uint256 d, uint256 fee) internal pure returns (uint256) { return _amount(d) + fee * _shapesIn(d); }
    function _count(uint256 plan, uint256 d) internal pure returns (uint256) { return (plan >> (16 * d)) & 0xFFFF; }
    function _amount(uint256 d) internal pure returns (uint256) { return ((AMOUNTS >> (16 * d)) & 0xFFFF) * 0.01 ether; }
    function _shapesIn(uint256 d) internal pure returns (uint256) { return (SHAPES_IN >> (4 * d)) & 0xF; }
    function _makeup(uint256 d) internal pure returns (uint32[] memory m) {
        m = new uint32[](SHAPE_DENOMS);
        uint256 rest = _amount(d);
        for (uint256 i = SHAPE_DENOMS; i != 0;) {
            uint256 a = _amount(--i);
            m[i] = uint32(rest / a);
            rest %= a;
        }
    }

    /// @dev Shapes inside one prize of size `d`, each paying the Shapes mint fee.
}
