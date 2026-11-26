// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IVRFService} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {MockNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {PoolInventory} from "../src/PoolInventory.sol";
import {PoolPage} from "../src/PoolPage.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

/// @dev One launch-scale successful lifecycle with three genuine historical proofs. Candidate/request accounts
/// persist across the fork advance; intervening canonical mutations to those accounts are omitted. This neither
/// demonstrates present oracle availability nor substitutes for the approved 180-draw/28-regime campaign.
abstract contract AuthenticEconomicFlowsBase is ForkBase {
    uint256[] internal requests;
    uint256 internal quotedTotal;
    uint256 internal expectedBase;
    uint256 internal buyerBefore;
    uint256 internal keeperAfterSetup;
    uint256 internal curated;
    uint256 internal setupCost;
    GasProbe internal probe;

    function _curatedOnly() internal pure virtual returns (bool) { return false; }
    function _publicProofs() internal pure virtual returns (bool) { return false; }

    function setUp() public {
        vm.createSelectFork("mainnet", bytes32(0x2d9d2a85771c6ea346a6ed9e581fe5c5c1f5aefb770f669effcee35e254f8283));
        vm.fee(565409872);
        vm.txGasPrice(565418379);
        assertEq(block.number, 26442752);
        assertEq(block.timestamp, 1795014599);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, creator, "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        factory = new BalancerFactory(address(new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS)), keeperAdmin, address(this));
        factory.setCreationPaused(false);
        nft = new MockNFT();
        vm.deal(creator, 10 ether);
        vm.deal(buyer, 10 ether);
        vm.deal(keeper, 1 ether);
        createBalancer(5 ether);
        // Approved launch board: 24 small Shapes, eight 0.02 ETH packs, twelve 0.05 Shapes,
        // two 0.1 Shapes and one 0.5 Shape: 47 prize NFTs holding 1.7 ETH in backing.
        uint256 mintCap = shapes.mintFee();
        vm.prank(creator);
        balancer.configure(2500, _curatedOnly() ? 1 : uint256(24) | (uint256(12) << 16) | (uint256(2) << 32) | (uint256(1) << 48) | (uint256(8) << 144), mintCap);
        assertEq(balancer.markupBps(), 2500, "launch reference markup is twenty-five percent");
        curated = listCurated(100, 0.2 ether);
        vm.prank(creator); balancer.open();
        assertGt(fillUp(), 0);
        if (_curatedOnly()) {
            assertEq(balancer.listedShapePrizes(), 1);
            uint256[] memory inventory = balancer.getActiveIds();
            uint256[] memory automatic = new uint256[](1);
            for (uint256 i; i < inventory.length; ++i) {
                (uint8 kind,,,,) = balancer.items(inventory[i]);
                if (kind == 2) automatic[0] = inventory[i];
            }
            vm.startPrank(creator);
            balancer.setFillGateBps(0);
            balancer.setPaidUpkeepEnabled(false);
            balancer.unlistShapes(automatic);
            vm.stopPrank();
            listCurated(101, 0.2 ether);
            listCurated(102, 0.2 ether);
        } else assertEq(balancer.listedShapePrizes(), 47);
        uint256[] memory active = balancer.getActiveIds();
        uint256 weight;
        uint256 weightedValue;
        uint256 backing;
        for (uint256 i; i < active.length; ++i) {
            (,,,,, uint256 price,, uint8 status) = pool.listings(active[i]);
            assertEq(status, 1);
            uint256 w = 1e36 / price;
            weight += w;
            weightedValue += w * price;
            (uint8 kind, uint8 denom,,,) = balancer.items(active[i]);
            if (kind == 2) backing += _backing(denom);
        }
        assertEq(backing, _curatedOnly() ? 0 : 1.7 ether, "absolute backing for the actual declared board");
        setupCost = 5 ether - address(balancer).balance - backing;
        expectedBase = weightedValue / weight;
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(3);
        assertEq(fee, expectedBase * 10500 / 10000, "independent inverse-weight EV and historical five-percent edge");
        assertGt(vrf, 0);
        assertEq(total, 3 * (fee + vrf));
        quotedTotal = total;
        buyerBefore = buyer.balance;
        requests = buy(buyer, 3);
        assertEq(buyerBefore - buyer.balance, quotedTotal, "three quoted draws actually paid by buyer");
        assertEq(requests[0], uint256(0xfd7d389c0cb11d5735fa3f963b46ca8820c7ae275a5e7136bc2e807bcc7cf889));
        assertEq(requests[1], uint256(0x02163c57dacb0912b09054c1d6b3ad647d9640a2b93cb9780acbece893d1b9c8));
        assertEq(requests[2], uint256(0xccc4d65b1080d0153691ebe850f9b4a8ee3130b2c11be32b165576f1c2e96c77));
        keeperAfterSetup = keeper.balance;
        probe = new GasProbe();
        probe.record();
        assertEq(probe.gasPrice(), 565418379);
        assertEq(probe.baseFee(), 565409872);
        address[] memory persistent = new address[](15);
        persistent[0] = address(pool); persistent[1] = address(balancer); persistent[2] = address(factory);
        persistent[3] = address(nft); persistent[4] = packs; persistent[5] = renderer;
        persistent[6] = FWA_FACTORY; persistent[7] = VRF_SERVICE;
        persistent[8] = IVRFService(VRF_SERVICE).coordinator(); persistent[9] = SHAPES;
        persistent[10] = address(PoolInventory); persistent[11] = address(PoolPage);
        persistent[12] = address(KeeperPolicyCalls); persistent[13] = factory.implementation(); persistent[14] = address(probe);
        vm.makePersistent(persistent);
        vm.makePersistent(creator, buyer, keeper);
    }

    function _backing(uint8 denom) internal pure returns (uint256) {
        if (denom == 0) return 0.01 ether;
        if (denom == 1) return 0.05 ether;
        if (denom == 2) return 0.1 ether;
        if (denom == 3) return 0.5 ether;
        if (denom == 9) return 0.02 ether;
        revert("outside declared launch board");
    }

    function _actualBacking() internal view returns (uint256 backing) {
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 denom,,,) = balancer.items(active[i]);
            if (kind != 2) continue;
            (address collection,,, uint256 tokenId,,,,) = pool.listings(active[i]);
            if (IERC721Min(collection).ownerOf(tokenId) == address(pool)) backing += _backing(denom);
        }
    }

    function _assertCostFirstProfit() internal view returns (uint256 profit) {
        uint256 actualAssets = address(balancer).balance + _actualBacking() - balancer.creatorCredit();
        uint256 capital = balancer.operatingCapital();
        profit = actualAssets > capital ? actualAssets - capital : 0;
        assertEq(balancer.bankrollProfit(), profit, "independent operating cash plus custody backing minus capital");
    }

    function _submitAuthenticProofs() internal {
        vm.rollFork(26442757);
        vm.warp(1795014659);
        vm.fee(548662718);
        vm.txGasPrice(565418379);
        probe.record();
        assertEq(probe.gasPrice(), 565418379, "inside state-changing execution");
        assertEq(probe.baseFee(), 548662718, "actual replay block base fee");
        if (_curatedOnly() || _publicProofs()) {
            // Public submission avoids the separate vm.transact replay journal after pre-reading queue counters.
            string memory corpus = vm.readFile("test/fixtures/authentic-vrf-proofs.json");
            address coordinator = IVRFService(VRF_SERVICE).coordinator();
            for (uint256 i; i < 3; ++i) {
                string memory key = string.concat(".entries[", vm.toString(i), "].");
                assertEq(vm.parseUint(vm.parseJsonString(corpus, string.concat(key, "requestId"))), requests[i]);
                bytes memory input = vm.parseJsonBytes(corpus, string.concat(key, "input"));
                (bool ok, bytes memory reason) = coordinator.call(input);
                if (!ok) assembly { revert(add(reason, 32), mload(reason)) }
            }
        } else {
            vm.transact(0x16ccbb75cd9b6cec741d78957e43f723b6bf00d7d70d0882d13e4300bb072616);
            vm.transact(0x3e361ce8123ab51584b68873e23b29b05187a575495cd3c939dc8a39b21774d8);
            vm.transact(0x9fbe95ea1760ed9e5dae0ece749cb6ae534aad8507fa02246038def196336abe);
        }
        vm.fee(548662718);
        vm.txGasPrice(565418379);
        probe.record();
        assertEq(probe.gasPrice(), 565418379, "included economic calls use nonzero declared gas price");
        assertEq(probe.baseFee(), 548662718, "included economic calls use declared replay base fee");
        emit log_named_uint("replay_unsettled", pool.unsettledAcquisitionCount());
        emit log_named_uint("replay_next_sequence", pool.nextSequenceToProcess());
        emit log_named_uint("replay_last_sequence", pool.lastIssuedSequence());
        // Curated-only callbacks can finish the entire queue; otherwise an explicit third party processes it.
        // This case does not establish keeper-only queue liveness.
        if (pool.unsettledAcquisitionCount() != 0) pool.processAcquisitions(3);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(pool.nextSequenceToProcess(), pool.lastIssuedSequence() + 1, "settled queue is coherent");
        for (uint256 i; i < requests.length; ++i) {
            (address purchaser,,, uint256 lid, uint8 status,) = pool.acquisitions(requests[i]);
            assertEq(status, 2, "genuine proof reached successful acquisition");
            assertEq(purchaser, buyer);
            assertGt(lid, 0);
            (address collection,,, uint256 tokenId,,,, uint8 listingStatus) = pool.listings(lid);
            assertEq(listingStatus, 4);
            assertEq(IERC721Min(collection).ownerOf(tokenId), buyer, "actual prize delivered to buyer");
        }
    }
}

contract AuthenticEconomicFlowsTest is AuthenticEconomicFlowsBase {
    function test_threeAuthenticLaunchDrawsCollectCreditAndCloseCreatorAssets() public {
        _submitAuthenticProofs();
        assertEq(buyerBefore - buyer.balance, quotedTotal, "no hidden buyer topup or refund");
        uint256 proceeds = pool.ownerProceeds();
        assertEq(proceeds, 3 * expectedBase, "three request-time base prices become owner proceeds");
        assertGt(proceeds, 0);
        uint256 cash = address(balancer).balance;
        emit log_named_uint("launch_setup_cost_wei", setupCost);
        emit log_named_uint("launch_owner_proceeds_wei", proceeds);
        uint256 capital = balancer.operatingCapital();
        assertEq(capital, 5 ether);
        assertEq(balancer.withdrawableSurplus(), 0, "unreconciled outcomes cannot leave as proceeds");
        balancer.collectProceeds();
        assertEq(address(balancer).balance - cash, proceeds);
        assertEq(balancer.operatingCapital(), capital, "sale receipts do not increase contributed capital");
        assertEq(pool.ownerProceeds(), 0);
        balancer.collectProceeds();
        assertEq(address(balancer).balance, cash + proceeds, "second collection creates no duplicate cash");
        vm.prank(creator); balancer.close();
        upkeep();
        assertGt(keeper.balance, keeperAfterSetup, "real reconciled work paid its keeper");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        _assertCostFirstProfit();
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind,,,,) = balancer.items(active[i]);
            if (kind == 1) { vm.prank(creator); balancer.withdrawCurated(active[i], creator); }
        }
        active = balancer.getActiveIds();
        for (uint256 start; start < active.length; start += 20) {
            uint256 n = active.length - start > 20 ? 20 : active.length - start;
            uint256[] memory batch = new uint256[](n);
            uint256 backing;
            for (uint256 i; i < n; ++i) {
                batch[i] = active[start + i];
                (uint8 kind, uint8 denom,,,) = balancer.items(batch[i]);
                assertEq(kind, 2); backing += _backing(denom);
            }
            cash = address(balancer).balance;
            vm.prank(creator); balancer.unlistShapes(batch);
            assertEq(address(balancer).balance - cash, backing, "every remaining Shape/pack returns exact backing");
        }
        _assertCostFirstProfit();
        uint256 capitalBeforeClaim = balancer.operatingCapital();
        uint256 profitBeforeClaim = balancer.creatorCredit() + balancer.bankrollProfit();
        uint256 claim = balancer.withdrawableSurplus();
        emit log_named_uint("launch_closeout_return_wei", claim);
        emit log_named_uint("launch_closeout_profit_wei", profitBeforeClaim);
        assertEq(claim, address(balancer).balance);
        assertGt(claim, 3 ether, "launch-scale creator capital survives this reached three-draw cycle");
        uint256 wallet = creator.balance;
        vm.prank(creator); balancer.claimSurplus(claim, creator);
        assertEq(creator.balance - wallet, claim);
        assertEq(address(balancer).balance, 0);
        assertEq(balancer.creatorCredit(), 0);
        uint256 returnedCapital = claim > profitBeforeClaim ? claim - profitBeforeClaim : 0;
        assertEq(balancer.operatingCapital(), capitalBeforeClaim - returnedCapital, "unrecovered losses carry after winding down");
        assertEq(balancer.getActiveIds().length, 0);
        assertEq(pool.activeListingCount(), 0);
        assertEq(pool.ownerProceeds(), 0);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        address curatedOwner = nft.ownerOf(100);
        assertTrue(curatedOwner == creator || curatedOwner == buyer, "curated asset ends only with creator or genuine winner");
    }
}

contract AuthenticPositiveProceedsTest is AuthenticEconomicFlowsBase {
    function _curatedOnly() internal pure override returns (bool) { return true; }

    function test_genuineCuratedSalesRepayCostsBeforeOpenPoolProfitLeaves() public {
        assertEq(balancer.operatingCapital(), 5 ether);
        uint256 cashBeforeSales = address(balancer).balance;
        uint256 actualSetupCosts = 5 ether - cashBeforeSales;
        assertGt(actualSetupCosts, 0, "real mint fee and actual keeper pay were spent");
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.withdrawableSurplus(), 0, "outstanding draws cannot be withdrawn");
        _submitAuthenticProofs();
        assertEq(pool.ownerProceeds(), 0.6 ether, "three real curated sales at 0.2 ETH each");
        balancer.collectProceeds();
        assertEq(balancer.withdrawableSurplus(), 0, "settled but unreconciled proceeds stay in the game");
        balancer.performUpkeepUnpaid();
        assertEq(balancer.reconciledSequence(), 3);
        assertEq(balancer.listedShapePrizes(), 1, "unpaid maintenance actually restores the automatic prize");
        uint256 actualPostSaleCosts = cashBeforeSales + 0.6 ether - address(balancer).balance - _actualBacking();
        assertEq(actualPostSaleCosts, shapes.mintFee(), "one restored Shape incurs its real mint fee");
        uint256 profit = _assertCostFirstProfit();
        uint256 feeCredit = balancer.creatorCredit();
        assertEq(profit, 0.6 ether - actualSetupCosts - actualPostSaleCosts - feeCredit);
        assertGt(profit, 0.5 ether, "no invented basis or payout deduction for the three supplied NFTs");
        emit log_named_uint("curated_sales_wei", 0.6 ether);
        emit log_named_uint("curated_setup_cost_wei", actualSetupCosts);
        emit log_named_uint("curated_restock_cost_wei", actualPostSaleCosts);
        emit log_named_uint("curated_earned_profit_wei", profit);
        uint256 mintCap = shapes.mintFee();
        vm.prank(creator);
        balancer.configure(2500, uint256(10) << 64, mintCap);
        assertGt(balancer.requiredReserve(), address(balancer).balance, "ten missing 1 ETH prizes exceed available cash");
        assertEq(balancer.bankrollProfit(), profit, "a target change does not rewrite bankroll profit");
        assertEq(balancer.withdrawableSurplus(), 0, "fund the current prize deficit before withdrawing earnings");
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(1, creator);
        vm.prank(creator);
        balancer.configure(2500, 1, mintCap);
        assertEq(balancer.bankrollProfit(), profit, "removing the deficit trigger does not manufacture income");
        uint256 spare = address(balancer).balance - feeCredit - balancer.requiredReserve();
        assertEq(balancer.withdrawableSurplus(), feeCredit + (profit < spare ? profit : spare));
        uint256 amount = balancer.withdrawableSurplus();
        uint256 wallet = creator.balance;
        vm.prank(creator); balancer.claimSurplus(amount, creator);
        assertEq(creator.balance - wallet, amount);
        assertEq(balancer.operatingCapital(), 5 ether, "claiming profit never withdraws contributed capital");
        assertEq(balancer.creatorCredit(), 0, "the creator fee bucket is paid first");
        assertEq(balancer.bankrollProfit(), profit - (amount - feeCredit));
        _assertCostFirstProfit();
        for (uint256 i; i < 3; ++i) assertEq(nft.ownerOf(100 + i), buyer);
    }
}
