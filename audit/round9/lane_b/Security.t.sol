// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {MockNFT} from "./MockNFT.sol";

/// Security pass: access control, keeper-list gating, untracked-NFT recovery guards, ERC-1271 epoching, init lock.
contract SecurityTest is Harness {
    address attacker = address(0xBAD);

    function setUp() public {
        _fork();
        _deploy();
    }

    function _basicOpenPool() internal {
        _newPool(3 ether);
        vm.prank(creator);
        bal.configure(2000, uint256(3));
        _listCurated(0.05 ether);
        uint256 g;
        while (bal.creatorWork() && g++ < 10) _upkeep(creator);
        vm.prank(creator);
        bal.open();
    }

    function testCreatorOnlyGating() public {
        _newPool(1 ether);
        vm.startPrank(attacker);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.configure(2000, uint256(1));
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.open();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.close();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.claimSurplus(1, attacker);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.listCurated(address(nft), 1, 0.01 ether);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.retire();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.transferCreator(attacker);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.revokePoolPages();
        vm.stopPrank();
    }

    function testKeeperRestriction() public {
        _basicOpenPool();
        // open by default: anyone can keep (NoUpkeepNeeded means nothing to do, not auth failure)
        assertTrue(factory.canKeep(attacker));
        // restrict to approved keepers
        factory.setKeepersRestricted(true); // this test contract is keeperAdmin
        assertFalse(factory.canKeep(attacker));
        vm.prank(attacker);
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        bal.performUpkeep();
        // creator may always keep
        vm.prank(creator);
        try bal.performUpkeep() {} catch (bytes memory r) {
            // only NoUpkeepNeeded is acceptable here
            assertEq(bytes4(r), PoolBalancer.NoUpkeepNeeded.selector, "creator upkeep wrongly blocked");
        }
        // approve attacker
        factory.setKeeperApproved(attacker, true);
        assertTrue(factory.canKeep(attacker));
    }

    function testRecoverUntrackedGuards() public {
        _newPool(1 ether);
        // cannot recover the FWA pool or factory as if an NFT
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        bal.recoverUntrackedNFT(address(pool), 1, creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        bal.recoverUntrackedNFT(address(FWA_FACTORY), 1, creator);
        // an NFT the balancer does not own -> ProtectedAsset (ownerOf != this)
        MockNFT other = new MockNFT();
        other.mint(attacker, 7);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        bal.recoverUntrackedNFT(address(other), 7, creator);
        // a genuinely untracked NFT sent to the balancer can be recovered
        other.mint(address(bal), 8);
        bal.recoverUntrackedNFT(address(other), 8, creator);
        assertEq(other.ownerOf(8), creator);
        vm.stopPrank();
    }

    function testPoolPageEpochInvalidation() public {
        _newPool(1 ether);
        vm.prank(creator);
        bytes32 d = bal.approvePoolPage("2026-11-10T12:34:56.789Z", keccak256("meta"));
        assertEq(bal.isValidSignature(d, ""), bytes4(0x1626ba7e), "approved digest should validate");
        // transfer creator -> epoch bumps on accept -> old approval invalid
        vm.prank(creator);
        bal.transferCreator(attacker);
        vm.prank(attacker);
        bal.acceptCreator();
        assertEq(bal.isValidSignature(d, ""), bytes4(0xffffffff), "approval survived creator change");
        // former creator cannot approve anymore
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        bal.approvePoolPage("2026-11-10T12:34:56.789Z", keccak256("meta"));
    }

    function testImplementationLockedAndNoReinit() public {
        // the implementation itself is locked (creator == address(1))
        assertEq(impl.creator(), address(1));
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        impl.initialize(attacker);
        // a live clone cannot be re-initialized
        _newPool(0);
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        bal.initialize(attacker);
    }

    function testCanPurchaseRefusesProtected() public {
        _basicOpenPool();
        assertFalse(bal.canPurchase(address(bal)));
        assertFalse(bal.canPurchase(SHAPES));
        assertFalse(bal.canPurchase(packs));
        assertFalse(bal.canPurchase(address(pool)));
        // a normal purchaser is admitted iff the admission gate is open
        console.log("admissionStatus", bal.admissionStatus());
        assertEq(bal.canPurchase(player), bal.admissionStatus() == 0, "canPurchase(player) != gate");
    }
}
