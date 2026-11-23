// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyV2, HostilePolicy} from "./Settings.t.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

/// @notice Full three-pool replacement lifecycle against deployed FWA and Shapes; Draw Packs uses the same production
///         artifacts and deployment path as launch. Deterministic words use the owner's coordinator exception.
contract PolicyLifecycleTest is ForkBase {
    function setUp() public { setUpFork(); }

    function _new(address owner, uint256 salt) internal returns (PoolBalancer b) {
        vm.prank(owner);
        b = _createFixture(owner, bytes32(salt), 5 ether);
        uint256[16] memory counts;
        counts[0] = 18;
        counts[9] = 1;
        counts[10] = 1;
        vm.startPrank(owner);
        b.configure(1500, plan16(counts), shapes.mintFee());
        nft.mint(owner, salt);
        nft.approve(address(b), salt);
        PoolBalancer.CuratedInput[] memory inputs = new PoolBalancer.CuratedInput[](1);
        inputs[0] = PoolBalancer.CuratedInput(address(nft), salt, 0.2 ether);
        b.listCuratedBatch(inputs);
        b.open();
        vm.stopPrank();
        _select(b);
        fillUp();
        assertEq(b.listedShapePrizes(), 20);
        assertEq(b.getActiveShapes()[9], 1);
        assertEq(b.getActiveShapes()[10], 1);
        _assertAccounting(b);
    }

    function _select(PoolBalancer b) internal { balancer = b; pool = b.pool(); }

    function _draw(PoolBalancer b) internal {
        _select(b);
        uint256[] memory listed = b.getActiveIds();
        uint256 lid;
        uint256 slot;
        for (uint256 i; i < listed.length; ++i) {
            (uint8 kind,,,,) = b.items(listed[i]);
            (,,,,,, uint256 s, uint8 status) = pool.listings(listed[i]);
            if (kind == 2 && status == 1) { lid = listed[i]; slot = s; break; }
        }
        assertGt(lid, 0);
        (address collection,,, uint256 tokenId,,,,) = pool.listings(lid);
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, wordForSlot(slot));
        upkeep();
        fillUp();
        assertEq(IERC721Min(collection).ownerOf(tokenId), buyer, "actual FWA delivery");
        assertEq(b.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(b.listedShapePrizes(), 20, "board restored without migration");
        _assertAccounting(b);
    }

    function _assertAccounting(PoolBalancer b) internal view {
        uint256[] memory ids = b.getActiveIds();
        uint256 fees;
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,, uint112 base, uint112 price) = b.items(ids[i]);
            if (kind != 2) continue;
            ++n;
            fees += price - base;
            (address collection,,, uint256 id,,,, uint8 status) = b.pool().listings(ids[i]);
            assertEq(status, 1);
            assertEq(IERC721Min(collection).ownerOf(id), address(b.pool()), "FWA retains exact custody");
        }
        assertEq(fees, _listedFees(b));
        assertEq(n, b.listedShapePrizes());
        assertGe(address(b).balance - b.creatorCredit(), b.requiredReserve(), "creator capital covers obligations");
        assertEq(b.pool().ownerProceeds(), 0, "all completed proceeds collected");
        assertEq(b.pool().unsettledAcquisitionCount(), 0);
    }

    function _exit(PoolBalancer b) internal {
        address owner = b.creator();
        vm.prank(owner); b.close();
        uint256[] memory ids = b.getActiveIds();
        uint256[] memory shapeIds = new uint256[](20);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = b.items(ids[i]);
            if (kind == 2) shapeIds[n++] = ids[i];
            else { vm.prank(owner); b.withdrawCurated(ids[i], owner); }
        }
        assertEq(n, 20);
        vm.prank(owner); b.unlistShapes(shapeIds);
        vm.prank(owner); b.retire();
        uint256 surplus = b.withdrawableSurplus();
        vm.prank(owner); b.claimSurplus(surplus, owner);
        assertEq(address(b).balance, 0);
        assertEq(b.getActiveIds().length, 0);
        assertEq(_listedFees(b), 0);
        assertEq(b.creatorCredit(), 0);
        assertEq(b.requiredReserve(), 0);
    }

    function test_threePoolsV1V2AndPolicyFailureNoAssetMigration() public {
        vm.fee(0.5 gwei); vm.txGasPrice(0.55 gwei);
        address owner2 = makeAddr("policy owner2");
        address owner3 = makeAddr("policy owner3");
        vm.deal(owner2, 100 ether); vm.deal(owner3, 100 ether);
        PoolBalancer first = _new(creator, 101);
        PoolBalancer second = _new(owner2, 102);
        address v1 = first.keeperPolicy();
        assertEq(second.keeperPolicy(), v1);
        _draw(first); _draw(second);

        // Spec §2: the second pool pins; a factory change then moves the follower at once and leaves the pinned pool.
        KeeperPolicyV2 v2 = new KeeperPolicyV2();
        vm.prank(owner2); second.pinEconomics();
        factory.setEconomics(_econWith(address(v2)));
        assertEq(first.keeperPolicy(), address(v2), "a follower adopts the factory change");
        assertEq(second.keeperPolicy(), v1, "a pinned pool keeps its pinned algorithm");
        PoolBalancer third = _new(owner3, 103);
        assertEq(third.keeperPolicy(), address(v2));

        uint256[] memory oldIds = first.getActiveIds();
        (,,,, uint112 oldPrice) = first.items(oldIds[1]);
        bytes32 priced = first.settingsHash();
        _select(first);
        buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1, "switch with live purchaser obligation");
        vm.prank(creator); first.setKeeperPolicy(v1);
        assertEq(first.keeperPolicy(), v1);
        assertEq(second.keeperPolicy(), v1);
        assertEq(third.keeperPolicy(), address(v2));
        (,,,, uint112 keptPrice) = first.items(oldIds[1]);
        assertEq(keptPrice, oldPrice, "old listing retains its exact historical surcharge");
        vm.prank(keeper); vm.expectRevert(PoolBalancer.StaleSettings.selector); first.performUpkeep(priced, 1, 0);
        vm.roll(vm.getBlockNumber() + 40);
        upkeep(); fillUp();
        assertEq(first.pool().unsettledAcquisitionCount(), 0);
        _draw(first); _draw(second); _draw(third);

        _select(first);
        HostilePolicy broken = new HostilePolicy(2);
        (uint256 required, uint256 shortfall) = first.maintenanceFunding(_econWith(address(broken)));
        assertEq(required, first.requiredReserve(), "another algorithm on the same numbers adds no liability");
        vm.prank(creator); first.depositETH{value: shortfall}();
        vm.prank(creator); first.setKeeperPolicy(address(broken));
        uint256 request = buy(buyer, 1)[0];
        fulfill(request, wordForSlot(2));
        uint256 received = stranger.balance;
        vm.prank(stranger); first.performUpkeepUnpaid();
        vm.prank(stranger); try first.performUpkeepUnpaid() {} catch {}
        assertEq(stranger.balance, received, "emergency maintenance paid nothing");
        assertEq(first.reconciledSequence(), first.pool().lastIssuedSequence());
        assertEq(first.listedShapePrizes(), 20, "full unpaid pricing path restored inventory");
        _assertAccounting(first);
        _exit(first); _exit(second); _exit(third);
    }
}
