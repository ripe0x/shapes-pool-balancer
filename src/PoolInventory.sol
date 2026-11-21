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
        uint104 base; // creator value (curated) or the price less its restocking fees: backing, mint fees, markup (Shape)
        uint104 price; // price listed on FWA
    }

    struct State {
        mapping(uint256 => Item) items;
        uint256[] activeIds;
        mapping(uint256 => uint256) activeIndexPlusOne;
        uint16[16] activeShapes;
        uint256 listedPrizes;
        uint256 shapeStageUpper;
        uint256 curatedWitness;
        uint256 curatedWitnessSlot;
    }
    struct Fill {
        uint256 plan;
        uint256 markup;
        uint256 keep;
        uint256 maxReward;
        uint256 draws;
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
    /// @dev Size values in units of 0.01 ETH, 16 bits each, size 0 in the low bits:
    ///      0.01 0.05 0.1 0.5 1 5 10 50 100 | 0.02 0.03 0.2 0.25 2 2.5 25. Sizes 0-8 are the mainnet Shapes ladder,
    ///      checked against `Shapes.denominationAt` in the PoolBalancer constructor.
    uint256 constant AMOUNTS = 0x9c400fa00c800190014000300022710138803e801f400640032000a00050001;
    /// @dev Shapes inside one prize of each size, 4 bits each (1 for a Shape; 2 or 3 for a pack), each paying the mint fee.
    uint256 constant SHAPES_IN = 0x3323232111111111;
    event ShapesMinted(uint8 indexed denom, uint256 firstTokenId, uint256 quantity, uint256 cost);
    event ShapeListed(uint256 indexed listingId, uint8 indexed denom, uint256 tokenId, uint256 price);
    error InvalidItem();

    event ShapesUnlisted(uint256 count, uint256 ethRedeemed);
    event CuratedListed(uint256 indexed listingId, address indexed collection, uint256 tokenId, uint256 base, uint256 price);
    event CuratedRepriced(uint256 indexed listingId, uint256 base, uint256 price);
    event CuratedWithdrawn(uint256 indexed listingId, address indexed to);
    event CuratedWitnessRefreshed(uint256 indexed listingId, uint256 slot);
    event RefundedRecovered(uint256 indexed listingId, address indexed to, uint256 eth);
    event UntrackedNFTRecovered(address indexed collection, uint256 tokenId, address indexed to);
    error InvalidBatch();
    error InvalidRecipient();
    error ValueTooHigh();
    error ShapesNotCurated();
    error InvalidConfig();
    error InvalidPlan();
    error ProtectedAsset();

    function validateTarget(uint256 plan, uint256 markup) public pure returns (uint256 weight) {
        if (markup < 1_000 || markup > 10_000) revert InvalidConfig();
        uint256 prizes;
        for (uint256 d; d < DENOMS; ++d) {
            uint256 n = _count(plan, d);
            if (n == 0) continue;
            prizes += n;
            weight += n * _weight(d);
        }
        if (prizes == 0 || prizes > 1_000) revert InvalidPlan();
    }

    function recoverUntracked(address pool, address factory, address collection, uint256 tokenId, address to) public {
        if (to == address(0)) revert InvalidRecipient();
        if (collection == pool || collection == factory) revert ProtectedAsset();
        if (IERC721Min(collection).ownerOf(tokenId) != address(this)) revert ProtectedAsset();
        IERC721Min(collection).safeTransferFrom(address(this), to, tokenId);
        emit UntrackedNFTRecovered(collection, tokenId, to);
    }

    /// @dev Curated NFTs are optional unless `curatedRequired`. The Shapes mint fee is not checked here: it limits
    ///      minting in upkeep, while already listed prizes stay purchasable under the weight gate below.
    function admission(State storage s, IFWAPool pool, bool curatedRequired,
        uint256 targetWeight, uint256 prizeWeight, uint64 reconciledSequence) public view returns (uint8)
    {
        if (curatedRequired && s.activeIds.length == s.listedPrizes) return 3;
        uint256 unsettled = pool.unsettledAcquisitionCount();
        if (unsettled >= 5) return 4;
        uint256 active = pool.activeListingCount();
        // Active Shapes are a subset of tracked Shapes. Otherwise require a fresh identity proof: tracked
        // curated includes staging and unreconciled wins. Ambiguity intentionally pauses until public refresh.
        if (curatedRequired && active <= s.listedPrizes && !_hasCuratedWitness(s, pool)) return 7;
        uint256 unavailable = pool.lastIssuedSequence() - reconciledSequence;
        uint256 stageUpper = s.shapeStageUpper;
        if (stageUpper == 0) {
            uint256 lost = unavailable * (1e36 / 0.01 ether);
            return prizeWeight < lost || (prizeWeight - lost) * 10_000 < 7_000 * targetWeight ? 6 : 0;
        }
        uint256 shapeBound = unavailable + stageUpper;
        uint256 tracked = s.activeIds.length;
        // Earlier reserved batches and the next six staged records activate before the first new selection.
        // Inactive records are staged or already won; max(q, C-activation+u) avoids counting a win twice.
        uint256 inactive = tracked > active ? tracked - active : 0;
        uint256 activation = pool.reservedStagedCount() + 6;
        uint256 afterActivation = (inactive > activation ? inactive - activation : 0) + unsettled;
        if (afterActivation > unavailable) unavailable = afterActivation;
        if (shapeBound < unavailable) unavailable = shapeBound;
        uint256 lost = unavailable * (1e36 / 0.01 ether);
        if (prizeWeight < lost || (prizeWeight - lost) * 10_000 < 7_000 * targetWeight) return 6;
        return 0;
    }

    function _hasCuratedWitness(State storage s, IFWAPool pool) private view returns (bool) {
        uint256 lid = s.curatedWitness;
        return lid != 0 && s.activeIndexPlusOne[lid] != 0 && s.items[lid].kind == 1
            && pool.slotToListing(s.curatedWitnessSlot) == lid;
    }

    /// @dev A caller supplies discovery, never authority. Slot identities are rechecked on every admission.
    function refreshCuratedWitness(State storage s, IFWAPool pool, uint256 lid) public returns (bool changed) {
        Item storage it = s.items[lid];
        if (it.kind != 1 || it.state != ACTIVE || s.activeIndexPlusOne[lid] == 0) revert InvalidItem();
        (,,,,,, uint256 slot, uint8 status) = pool.listings(lid);
        if (slot == 0 || status != ACTIVE) revert InvalidItem();
        // Permissionless callers cannot replace an already valid proof with a less durable candidate.
        if (_hasCuratedWitness(s, pool)) return false;
        _setCuratedWitness(s, lid, slot);
        return true;
    }

    function _setCuratedWitness(State storage s, uint256 lid, uint256 slot) private {
        s.curatedWitness = lid;
        s.curatedWitnessSlot = slot;
        emit CuratedWitnessRefreshed(lid, slot);
    }

    function listCurated(State storage s, IFWAPool pool, address shapes, address packs, address source,
        PoolBalancer.CuratedInput[] calldata inputs) public returns (uint256[] memory listingIds)
    {
        uint256 n = inputs.length;
        if (n == 0 || n > 20) revert InvalidBatch();
        // Clear stale Shape uncertainty before adding curated staging, only with proof all tracked records are active.
        if (s.shapeStageUpper != 0 && pool.activeListingCount() == s.activeIds.length) s.shapeStageUpper = 0;
        IFWAPool.ListingInput[] memory batch = new IFWAPool.ListingInput[](n);
        for (uint256 i; i < n; ++i) {
            PoolBalancer.CuratedInput calldata c = inputs[i];
            if (c.collection == shapes || c.collection == packs) revert ShapesNotCurated();
            IERC721Min token = IERC721Min(c.collection);
            token.transferFrom(source, address(this), c.tokenId);
            if (token.ownerOf(c.tokenId) != address(this)) revert InvalidItem();
            token.approve(address(pool), c.tokenId);
            _checkValue(c.base);
            batch[i] = IFWAPool.ListingInput(c.collection, c.tokenId, c.base);
        }
        listingIds = pool.listNFTs(batch);
        for (uint256 i; i < n; ++i) {
            uint256 lid = listingIds[i];
            s.items[lid] = Item(1, 0, ACTIVE, uint104(inputs[i].base), uint104(inputs[i].base));
            addActive(s, lid);
            emit CuratedListed(lid, inputs[i].collection, inputs[i].tokenId, inputs[i].base, inputs[i].base);
        }
        if (!_hasCuratedWitness(s, pool)) {
            // At most the newly listed batch (20). Discovering other surviving inventory is caller-supplied,
            // so neither listing nor the 100k purchase hook scans an uncapped curated inventory.
            for (uint256 i; i < n; ++i) {
                (,,,,,, uint256 slot, uint8 status) = pool.listings(listingIds[i]);
                if (slot != 0 && status == ACTIVE) {
                    _setCuratedWitness(s, listingIds[i], slot);
                    break;
                }
            }
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
    function unlistShapes(State storage s, IFWAPool pool, address shapes, address packs, uint256[] calldata ids)
        public returns (uint256 removedWeight)
    {
        uint256 n = ids.length;
        uint256[] memory tokens = new uint256[](n);
        uint8[] memory sizes = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            Item storage it = s.items[ids[i]];
            if (it.kind != SHAPE) revert InvalidItem();
            removeActive(s, ids[i]);
            (,,, tokens[i],,,,) = pool.listings(ids[i]);
            sizes[i] = it.denom;
            --s.activeShapes[it.denom];
            removedWeight += _weight(it.denom);
            delete s.items[ids[i]];
        }
        pool.withdrawListingsTo(ids, address(this));
        uint256 before = address(this).balance;
        for (uint256 i; i < n; ++i) IShapePacks(sizes[i] < 9 ? shapes : packs).redeem(tokens[i]);
        emit ShapesUnlisted(n, address(this).balance - before);
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
            // Only the candidate work's enforced bound is held, not the policy's unrelated full-call maximum.
            while (need != 0) {
                uint256 reward = f.paid
                    ? KeeperPolicyCalls.listingPaymentBound(f.maxReward, f.draws, used + need * w, n + need)
                    : 0;
                if (bal >= keep + need * each + reward) break;
                --need;
            }
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
            st.items[lids[i]] = PoolInventory.Item(SHAPE, d, ACTIVE, uint104(base), uint104(batch[i].price));
            addActive(st, lids[i]);
            ++st.activeShapes[d];
            added += _weight(d);
            emit ShapeListed(lids[i], d, batch[i].tokenId, batch[i].price);
        }
        listed = n;
        // Every new Shape/pack prize may be staged; activation/removal can only reduce this upper bound.
        uint256 stageUpper = st.shapeStageUpper + n;
        if (stageUpper > st.listedPrizes) stageUpper = st.listedPrizes;
        if (p.activeListingCount() == st.activeIds.length) stageUpper = 0;
        st.shapeStageUpper = stageUpper;
    }

    function missingUnits(State storage s, uint256 plan) public view returns (uint256 units) {
        for (uint256 d; d < DENOMS; ++d) {
            uint256 want = _count(plan, d);
            uint256 have = s.activeShapes[d];
            if (want > have) units += (want - have) * _shapesIn(d);
        }
    }

    function addActive(State storage s, uint256 lid) public {
        Item storage it = s.items[lid];
        if (it.kind == SHAPE) {
            ++s.listedPrizes;
        }
        s.activeIds.push(lid);
        s.activeIndexPlusOne[lid] = s.activeIds.length;
    }
    function removeActive(State storage s, uint256 lid) public {
        uint256 idx = s.activeIndexPlusOne[lid];
        if (idx == 0) revert InvalidItem();
        Item storage it = s.items[lid];
        if (it.kind == SHAPE) {
            --s.listedPrizes;
        }
        uint256 lastId = s.activeIds[s.activeIds.length - 1];
        s.activeIds[idx - 1] = lastId;
        s.activeIndexPlusOne[lastId] = idx;
        s.activeIds.pop();
        delete s.activeIndexPlusOne[lid];
    }

    /// @dev A prize's weight in the fill gate: 1 / its backing (1e36 is FWA StandardPool's constant). Listed prices keep
    ///      the markup and fees of their listing block, so weighing by price would let a lower markup or mint fee push a
    ///      full board under the gate with nothing for upkeep to restock. Backing is fixed per size: the gate measures the mix.
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
