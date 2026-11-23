// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, ITimeout} from "test/utils/ForkBase.sol";
import {PoolBalancer} from "src/PoolBalancer.sol";
import {KeeperPolicyV1} from "src/KeeperPolicyV1.sol";
import {BalancerFactory} from "src/BalancerFactory.sol";
import {MockNFT} from "test/utils/Mocks.sol";

contract StepAGasWitness {
    uint256 public basefee;
    uint256 public gasprice;
    function record() external { basefee = block.basefee; gasprice = tx.gasprice; }
}

/// @dev Copy temporarily to test/audit/ModeTransitionAttack.t.sol to execute, then remove that copy.
///      No protocol contract or successful external reply is mocked.
contract ModeTransitionAttackTest is ForkBase {
    function setUp() public {
        vm.createSelectFork("mainnet", 26_473_800);
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(
            SHAPES, renderer, makeAddr("packsAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)
        ));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin, address(this), address(new KeeperPolicyV1()));
        nft = new MockNFT(); // optional third-party collection, unused in this zero-curated test
        vm.deal(creator, 5 ether);
        vm.deal(buyer, 5 ether);
        vm.deal(keeper, 1 ether);
        StepAGasWitness w = new StepAGasWitness();
        w.record();
        assertEq(w.basefee(), 0.5 gwei, "state changing call basefee");
        assertEq(w.gasprice(), 0.55 gwei, "state changing call gasprice");
    }

    function test_modeSwitchDuringPendingDrawNeverMovesFundsAndStandardRestarts() public {
        uint256[9] memory counts;
        counts[0] = 20;
        uint256 target = plan(counts);
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(1500, 400, target, shapes.mintFee(), false);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 0.5 ether}(
            bytes32(uint256(903)), cfg, new PoolBalancer.CuratedInput[](0)
        )));
        pool = balancer.pool();
        assertEq(balancer.creator(), creator, "wallet actor owns the pool");
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20, "full twenty-Shape board");
        assertEq(balancer.admissionStatus(), 0, "standard zero-curated mode admitted");
        assertEq(shapes.mintFee(), 0.001 ether, "real Shapes fee at pinned block");

        uint256 cash = address(balancer).balance;
        uint256 proceeds = pool.ownerProceeds();
        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 3, "required mode pauses on empty curated inventory");
        assertEq(address(balancer).balance, cash, "mode change leaves cash in place");
        assertEq(pool.ownerProceeds(), proceeds, "mode change leaves FWA proceeds in place");
        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0, "standard immediately reopens");

        (,, uint256 price) = pool.quoteAcquisitionPrice(1);
        assertGt(price, 0.01 ether, "buyer pays more than exact 0.01 ETH prize backing");
        buy(buyer, 1);
        assertEq(pool.unsettledAcquisitionCount(), 1, "real FWA draw is pending");
        assertEq(balancer.admissionStatus(), 0, "one pending draw is within 70% gate");
        vm.prank(creator);
        balancer.setCuratedRequired(true);
        assertEq(balancer.admissionStatus(), 3, "required mode pauses even with one pending draw");
        vm.prank(creator);
        balancer.setCuratedRequired(false);
        assertEq(balancer.admissionStatus(), 0, "standard reopens with pending draw");

        vm.roll(block.number + ITimeout(address(pool)).selectionTimeoutBlocks() + 1);
        upkeep(); // real FWA expiry is processed and reconciled by production upkeep
        assertEq(pool.unsettledAcquisitionCount(), 0, "expired request processed");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "keeper reconciled");
        assertEq(balancer.admissionStatus(), 0, "sales still open after expiry");
        assertEq(balancer.creatorCredit(), 0, "expired draw creates no proceeds credit");
    }

    function test_restrictedApprovedAndPublicKeeperCannotTakePayForNoWork() public {
        uint256[9] memory counts;
        counts[0] = 20;
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(1500, 400, plan(counts), shapes.mintFee(), false);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 0.5 ether}(
            bytes32(uint256(904)), cfg, new PoolBalancer.CuratedInput[](0)
        )));
        pool = balancer.pool();
        assertEq(balancer.creator(), creator, "wallet actor owns the pool");
        fillUp();
        assertEq(balancer.getActiveShapes()[0], 20);
        uint256 before = address(balancer).balance;
        uint256 keeperBefore = keeper.balance;
        bytes32 settings = balancer.settingsHash();

        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(keeper, true);
        vm.prank(keeper, keeper);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep(settings, 0, 0);
        assertEq(keeper.balance, keeperBefore, "approved operator gets no pay for no work");

        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(false);
        vm.prank(stranger, stranger);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        balancer.performUpkeep(settings, 0, 0);
        assertEq(address(balancer).balance, before, "public operator gets no cash for no work");
        assertEq(balancer.admissionStatus(), 0, "no-op attacks leave sales open");
    }

    function test_donorPlainTransferEndsAsCreatorClaimByAcceptedRule() public {
        uint256[9] memory counts;
        counts[0] = 20;
        PoolBalancer.CreationConfig memory cfg =
            PoolBalancer.CreationConfig(1500, 400, plan(counts), shapes.mintFee(), false);
        vm.prank(creator);
        balancer = PoolBalancer(payable(factory.createBalancer{value: 0.5 ether}(
            bytes32(uint256(905)), cfg, new PoolBalancer.CuratedInput[](0)
        )));
        pool = balancer.pool();
        assertEq(balancer.creator(), creator, "wallet actor owns the pool");
        fillUp();
        uint256 initialSurplus = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(initialSurplus, creator);
        assertEq(balancer.withdrawableSurplus(), 0, "before donor, no free cash");

        vm.deal(stranger, 1 ether); // external actor wallet funding only
        uint256 donorBefore = stranger.balance;
        vm.prank(stranger);
        (bool sent,) = payable(address(balancer)).call{value: 0.5 ether}("");
        assertTrue(sent, "plain ETH transfer accepted");
        assertEq(donorBefore - stranger.balance, 0.5 ether, "donor paid 0.5 ETH exactly");
        assertEq(balancer.withdrawableSurplus(), 0.5 ether, "all donor capital is creator-claimable");
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(0.5 ether, stranger);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(0.5 ether, creator);
        assertEq(creator.balance - creatorBefore, 0.5 ether, "creator receives donor's 0.5 ETH");
        assertEq(balancer.withdrawableSurplus(), 0, "round trip ends with no donor entitlement");
    }
}
