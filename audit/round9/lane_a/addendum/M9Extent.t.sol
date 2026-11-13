// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {console} from "forge-std/Test.sol";
import {AddendumBase} from "./AddendumBase.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";

/// Extent of the M9 finding: for every creator action and collection timing, compare profit booked on IDENTICAL
/// proceeds under (honest) collect-first vs (action)-then-collect, in the game-first regime (fund < reserve).
/// All draws delivered through the real coordinator -> VRF service -> pool route.
contract M9Extent is AddendumBase {
    // Put the pool into the game-first regime with accrued proceeds, curated + shapes intact, nothing reconciled.
    // Returns the curated listing id. Uses 5x0.01 shapes + 1 curated, `markup`.
    function _short(PoolBalancer b, uint16 markup) internal returns (uint256 curatedId) {
        curatedId = openPool(b, one(D_001, 5), markup, 10 ether, 0.3 ether);
        // pull balance down to the reserve
        uint256 bal = address(b).balance;
        uint256 reserve = b.requiredReserve();
        if (bal > reserve) {
            vm.prank(creator);
            b.claimSurplus(bal - reserve, creator);
        }
        // one real draw that hits a shape (curated survives), not reconciled -> reserve inflated -> fund < reserve
        bool ok;
        for (uint256 w = 1; w <= 40 && !ok; ++w) {
            uint256 s = vm.snapshotState();
            drawReal(b, uint256(keccak256(abi.encode("short", w))));
            if (_curatedIntact(b, curatedId)) ok = true;
            else vm.revertToState(s);
        }
        require(ok, "could not hit a shape");
        require(b.pool().ownerProceeds() > 0, "no proceeds");
        require(fundVal(b) < b.requiredReserve(), "not short");
    }

    function _curatedIntact(PoolBalancer b, uint256 curatedId) internal view returns (bool) {
        (uint8 kind,, uint8 state,,) = b.items(curatedId);
        return kind == 1 && state == 1;
    }

    // T1 — withdrawCurated then collect books MORE profit (the proven lever), via the real route.
    function testT1WithdrawCurated() public {
        PoolBalancer b = newBalancer();
        uint256 cid = _short(b, 3000);
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        vm.prank(creator);
        b.withdrawCurated(cid, creator);
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("T1 withdrawCurated honest/acted:", honest, acted);
        assertGt(acted, honest, "T1: withdrawCurated inflates profit");
    }

    // T2 — collection timing lever: the creator calling collectProceeds standalone (draws in flight, NOT reconciled)
    // books MORE profit than the keeper path (performUpkeep reconciles first, which drops the draws-in-flight reserve
    // term so the game-first gate no longer fires). So WHO collects first, and whether they reconcile, changes the
    // split of the same proceeds.
    function testT2CollectTimingLever() public {
        PoolBalancer b = newBalancer();
        _short(b, 3000);
        uint256 snap = vm.snapshotState();
        b.collectProceeds(); // creator collects, no reconcile: reserve stays inflated -> profit booked
        uint256 viaCollect = b.profit();
        vm.revertToState(snap);
        vm.prank(keeper);
        b.performUpkeep(); // keeper reconciles first -> reserve drops -> no profit booked
        uint256 viaUpkeep = b.profit();
        console.log("T2 collect-first / keeper-first profit:", viaCollect, viaUpkeep);
        assertGt(viaCollect, viaUpkeep, "T2: collection timing changes profit booked on the same proceeds");
    }

    // T3 — unlistShapes of a subset does NOT increase profit (identical-denomination shapes have positive share, so
    // removing one lowers the numerator proportionally). Closes this attempt.
    function testT3UnlistShapes() public {
        PoolBalancer b = newBalancer();
        _short(b, 3000);
        // find a shape listing id
        uint256[] memory ids = b.getActiveIds();
        uint256[] memory one_ = new uint256[](1);
        bool got;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,, uint8 state,,) = b.items(ids[i]);
            if (kind == 2 && state == 1) {
                one_[0] = ids[i];
                got = true;
                break;
            }
        }
        require(got, "no shape");
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        vm.prank(creator);
        b.unlistShapes(one_);
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("T3 unlistShapes honest/acted:", honest, acted);
        assertLe(acted, honest, "T3: unlistShapes does not increase profit");
    }

    // T4 — listing MORE curated before collect DECREASES profit (fund-favorable); not an attack.
    function testT4ListCurated() public {
        PoolBalancer b = newBalancer();
        _short(b, 3000);
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        listNewCurated(b, 0.3 ether); // adds a 0-share listing, n++
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("T4 listCurated honest/acted:", honest, acted);
        assertLe(acted, honest, "T4: listing curated does not increase profit");
    }

    // T5 — creator transfer does not change the split of already-accrued proceeds.
    function testT5CreatorTransfer() public {
        PoolBalancer b = newBalancer();
        _short(b, 3000);
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        vm.prank(creator);
        b.transferCreator(address(0xD00D));
        vm.prank(address(0xD00D));
        b.acceptCreator();
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("T5 transfer honest/acted:", honest, acted);
        assertEq(acted, honest, "T5: creator transfer must not change profit split");
    }

    // T6 — configure to a BIGGER target raises requiredReserve; does it book more of the same proceeds as profit?
    function testT6ConfigureBiggerTarget() public {
        PoolBalancer b = newBalancer();
        _short(b, 3000);
        uint256 snap = vm.snapshotState();
        b.collectProceeds();
        uint256 honest = b.profit();
        vm.revertToState(snap);
        vm.prank(creator);
        b.configure(3000, one(D_001, 20)); // much bigger target -> bigger reserve
        b.collectProceeds();
        uint256 acted = b.profit();
        console.log("T6 configure-bigger honest/acted:", honest, acted);
        // report direction; configure changes the fund<reserve gate, not the share ratio
        if (acted > honest) emit log_string("T6: configure bigger target books MORE profit (reserve gate flip)");
    }
}
