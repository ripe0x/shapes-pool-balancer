// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";

/// @dev Creation and exits use real FWA/Shapes contracts; no randomness or protocol state is fabricated.
contract FactoryPauseTest is ForkBase {
    event CreationPauseChanged(bool paused);

    function setUp() public {
        setUpFork();
        createBalancer(1 ether);
    }

    function _config(BalancerFactory f) internal view returns (PoolBalancer.CreationConfig memory) {
        return PoolBalancer.CreationConfig(MARKUP, 400, 1, shapes.mintFee(), false, f.creationSettingsHash());
    }

    function test_freshFactoryStartsPublicCreationPaused() public {
        BalancerFactory fresh = new BalancerFactory(factory.implementation(), keeperAdmin, address(this));
        assertTrue(fresh.creationPaused());
        assertEq(fresh.policyAdmin(), address(this));
        assertTrue(fresh.predictBalancer(creator, bytes32(uint256(1))) != address(0));
    }

    function test_onlyPolicyAdminCanPauseAndResume() public {
        vm.startPrank(creator);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setCreationPaused(true);
        vm.stopPrank();
        vm.prank(keeperAdmin);
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.setCreationPaused(true);
        vm.expectEmit(address(factory));
        emit CreationPauseChanged(true);
        factory.setCreationPaused(true);
        assertTrue(factory.creationPaused());
        vm.expectEmit(address(factory));
        emit CreationPauseChanged(false);
        factory.setCreationPaused(false);
        assertFalse(factory.creationPaused());
    }

    function test_pausedPublicCreationMovesNoETHOrNFTs() public {
        bytes32 salt = bytes32(uint256(11));
        address predicted = factory.predictBalancer(creator, salt);
        nft.mint(creator, 91);
        vm.prank(creator);
        nft.approve(predicted, 91);
        PoolBalancer.CuratedInput[] memory curated = new PoolBalancer.CuratedInput[](1);
        curated[0] = PoolBalancer.CuratedInput(address(nft), 91, 0.2 ether);
        PoolBalancer.CreationConfig memory config = _config(factory);
        factory.setCreationPaused(true);
        uint256 before = creator.balance;
        vm.prank(creator);
        vm.expectRevert(BalancerFactory.CreationPaused.selector);
        factory.createBalancer{value: 0.1 ether}(salt, config, curated);
        assertEq(creator.balance, before);
        assertEq(nft.ownerOf(91), creator);
        assertEq(address(factory).balance, 0);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isBalancer(predicted));
    }

    function test_policyAdminCanCreateCanaryWhilePublicCreationPaused() public {
        factory.setCreationPaused(true);
        PoolBalancer.CreationConfig memory config = _config(factory);
        vm.deal(address(this), 1 ether); // Funding the canary creator is actor setup.
        address created = factory.createBalancer{value: 0.1 ether}(bytes32(uint256(12)), config,
            new PoolBalancer.CuratedInput[](0));
        PoolBalancer b = PoolBalancer(payable(created));
        assertTrue(factory.creationPaused());
        assertTrue(factory.isBalancer(created));
        assertEq(b.creator(), address(this));
        assertEq(b.pool().owner(), created);
        assertEq(created.balance, 0.1 ether);
    }

    function test_pausePreservesExistingPoolMaintenanceAndExit() public {
        uint256 lid = listCurated(92, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        factory.setCreationPaused(true);
        fillUp();
        assertEq(balancer.listedShapePrizes(), 1);
        vm.prank(creator);
        balancer.close();
        vm.prank(creator);
        balancer.withdrawCurated(lid, creator);
        assertEq(nft.ownerOf(92), creator);
        uint256[] memory ids = balancer.getActiveIds();
        uint256 before = address(balancer).balance;
        vm.prank(creator);
        balancer.unlistShapes(ids);
        assertEq(address(balancer).balance, before + 0.01 ether, "actual Shape backing redeemed");
        uint256 amount = balancer.withdrawableSurplus();
        assertGt(amount, 0.9 ether, "creator retains its operating capital after setup");
        uint256 wallet = creator.balance;
        vm.prank(creator);
        balancer.claimSurplus(amount, creator);
        assertEq(creator.balance, wallet + amount);
        assertEq(address(balancer).balance, 0);
        assertTrue(factory.creationPaused());
    }

    function test_resumeAllowsPublicCreationWithUnchangedReviewedSettings() public {
        factory.setCreationPaused(true);
        PoolBalancer.CreationConfig memory config = _config(factory);
        address predicted = factory.predictBalancer(stranger, bytes32(uint256(13)));
        factory.setCreationPaused(false);
        vm.prank(stranger);
        address created = factory.createBalancer{value: 0.1 ether}(bytes32(uint256(13)), config,
            new PoolBalancer.CuratedInput[](0));
        assertEq(created, predicted);
        assertTrue(factory.isBalancer(created));
        assertEq(PoolBalancer(payable(created)).creator(), stranger);
    }
}
