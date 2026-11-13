// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {KeeperPayTest} from "./KeeperPay.t.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

contract ChallengeTest is KeeperPayTest {
    function test_closedSplitAtMaxGas() public {
        _open(4.95 gwei);
        fillUp();
        buy(buyer, 5);
        vm.prank(creator);
        balancer.close();
        uint256 held = balancer.requiredReserve();
        assertEq(held, balancer.MAX_KEEPER_REWARD());
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claimable, creator);
        assertEq(address(balancer).balance, held);
        vm.roll(block.number + 40);
        uint256 paid;
        for (uint256 i; i < 5; ++i) {
            pool.processAcquisitions(1);
            (uint256 reward,, int256 pnl) = _paid();
            paid += reward;
            emit log_named_decimal_uint("paid", reward, 18);
            emit log_named_int("keeper pnl wei", pnl);
            assertGt(reward, 0);
            assertGe(pnl, 0);
        }
        assertEq(balancer.reconciledSequence(), 5);
        emit log_named_decimal_uint("held", held, 18);
        emit log_named_decimal_uint("total paid", paid, 18);
    }
}

contract ChallengePriceTest is ForkBase {
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    function setUp() public { setUpFork(); }

    function test_normalPriceAndMaxGasGate() public {
        _board(0.05 gwei);
        uint256 backing = _expectedBacking();
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        emit log_named_decimal_uint("normal gas price", total, 18);
        emit log_named_decimal_uint("expected backing", backing, 18);
        assertLe(total * 2, backing * 3, "at 0.1 gwei, price <= 1.5x backing");
        assertEq(balancer.admissionStatus(), 0, "normal gas gate open");

        vm.fee(4.95 gwei);
        vm.txGasPrice(5 gwei);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 4.95 gwei);
        assertEq(probe.gasPrice(), 5 gwei);
        assertEq(balancer.admissionStatus(), 0, "5 gwei gate open");
    }

    function _board(uint256 basefee) internal {
        vm.fee(basefee);
        vm.txGasPrice(basefee + 0.05 gwei);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), basefee);
        assertEq(probe.gasPrice(), basefee + 0.05 gwei);
        createBalancer(5 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        uint256 id = 300;
        address holder;
        while ((holder = IERC721Min(BAYC).ownerOf(id)).code.length != 0) ++id;
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        balancer.listCurated(BAYC, id, 0.2 ether);
        vm.stopPrank();
        vm.prank(creator);
        balancer.open();
        fillUp();
    }

    function _expectedBacking() internal view returns (uint256 backing) {
        uint256 weighted;
        uint256 totalWeight;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,, uint112 base,) = balancer.items(ids[i]);
            (,,,, uint256 weight,,,) = pool.listings(ids[i]);
            weighted += weight * (kind == 2 ? balancer.denominationAmount(d) : base);
            totalWeight += weight;
        }
        return weighted / totalWeight;
    }
}

contract ChallengeTopHeavyGateTest is ForkBase {
    address constant BAYC = 0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D;
    function setUp() public { setUpFork(); }

    function test_topHeavyBoardStopsAtOnePendingDraw() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 0.55 gwei);
        createBalancer(100 ether);
        uint256[16] memory c;
        c[0] = 1; // 0.01 ETH Shape
        c[15] = 1; // 25 ETH Pack
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        uint256 id = 300;
        address holder;
        while ((holder = IERC721Min(BAYC).ownerOf(id)).code.length != 0) ++id;
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        balancer.listCurated(BAYC, id, 0.2 ether);
        balancer.open();
        vm.stopPrank();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "initial sales open");
        uint256[] memory ids = buy(buyer, 1);
        assertEq(ids.length, 1, "one draw bought");
        assertEq(pool.unsettledAcquisitionCount(), 1, "draw pending");
        assertEq(balancer.admissionStatus(), 6, "low inventory after one pending draw");
        assertFalse(balancer.canPurchase(buyer), "second sale blocked at normal gas");
        (,, uint256 nextCost) = pool.quoteAcquisitionPrice(1);
        emit log_named_decimal_uint("blocked second draw quote", nextCost, 18);
        uint256 version = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        vm.expectRevert();
        pool.acquireBatch{value: nextCost}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        assertEq(pool.lastIssuedSequence(), 1, "second paid purchase was refused");
        emit log_named_uint("active listing count", pool.activeListingCount());
        emit log_named_uint("target weight", balancer.targetWeight());
        emit log_named_uint("prize weight", balancer.prizeWeight());
        vm.roll(block.number + 40);
        assertEq(pool.processAcquisitions(1), 1, "expired draw processed");
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0, "sales resume after reconciliation");
    }


    function test_topOnlyTwoWinsThenDropTopAndResumeSales() public {
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei);
        assertEq(probe.gasPrice(), 0.55 gwei);
        createBalancer(80 ether);
        uint256[16] memory c;
        c[15] = 1; // 25 ETH Pack is the sole Shape/Pack prize
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        uint256 id = 300;
        address holder;
        while ((holder = IERC721Min(BAYC).ownerOf(id)).code.length != 0) ++id;
        vm.prank(holder);
        IERC721Min(BAYC).transferFrom(holder, creator, id);
        vm.startPrank(creator);
        IERC721Min(BAYC).approve(address(balancer), id);
        balancer.listCurated(BAYC, id, 0.2 ether);
        balancer.open();
        vm.stopPrank();
        fillUp();
        assertEq(balancer.admissionStatus(), 0);
        emit log_named_decimal_uint("fund after first fill", address(balancer).balance, 18);
        for (uint256 win; win < 2; ++win) {
            uint256[] memory lids = balancer.getActiveIds();
            uint256 topLid;
            for (uint256 i; i < lids.length; ++i) {
                (uint8 kind, uint8 d,,,) = balancer.items(lids[i]);
                if (kind == 2 && d == 15) topLid = lids[i];
            }
            assertGt(topLid, 0, "25 ETH pack listed");
            uint256[] memory request = buy(buyer, 1);
            (,,,,,, uint256 slot,) = pool.listings(topLid);
            fulfill(request[0], wordForSlot(slot));
            settle();
            (,,, uint256 tokenId,,,, uint8 status) = pool.listings(topLid);
            assertEq(status, 4, "top prize won");
            assertEq(IERC721Min(packs).ownerOf(tokenId), buyer, "buyer owns 25 ETH pack");
            if (win == 0) {
                vm.prank(keeper, keeper);
                balancer.performUpkeep();
                assertEq(balancer.admissionStatus(), 0, "sales resumed after first restock");
                emit log_named_decimal_uint("fund after first top win and restock", address(balancer).balance, 18);
            }
        }
        emit log_named_decimal_uint("fund after second top win before pivot", address(balancer).balance, 18);
        emit log_named_decimal_uint("top target reserve before pivot", balancer.requiredReserve(), 18);
        c[15] = 0;
        c[0] = 1; // continue with 0.01 ETH Shape
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        assertEq(balancer.admissionStatus(), 2, "creator setup required");
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
        assertEq(balancer.getActiveShapes()[15], 0, "top omitted");
        assertEq(balancer.getActiveShapes()[0], 1, "small prize listed");
        assertEq(balancer.admissionStatus(), 0, "sales resumed after pivot");
        uint256[] memory next = buy(buyer, 1);
        assertEq(next.length, 1, "post-pivot purchase succeeded");
        emit log_named_decimal_uint("fund after pivot", address(balancer).balance, 18);
    }
}
