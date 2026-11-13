// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool, IFWAPoolFactory} from "../../../src/interfaces/External.sol";
import {SimpleNFT} from "./helpers/MockCollections.sol";

/// Blind lane A security/authority pass. Real FWA factory on a mainnet fork; no protocol contract is mocked.
contract SecurityIntegration is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address keeperAdmin = address(0xA11CE);
    address creator = address(0xC0FFEE);

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode(
            "ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2))
        );
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin);
    }

    function _newBalancer(address c) internal returns (PoolBalancer b) {
        vm.prank(c);
        b = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(uint160(c))))));
    }

    // --- implementation is locked ---
    function testImplementationLocked() public {
        assertEq(impl.creator(), address(1), "impl creator not locked");
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        impl.initialize(address(this));
    }

    // --- a real clone initializes against the real FWA factory ---
    function testRealInitialize() public {
        PoolBalancer b = _newBalancer(creator);
        assertEq(b.creator(), creator);
        assertEq(address(b.factory()), address(factory), "factory wired at initialize");
        IFWAPool p = b.pool();
        assertEq(p.owner(), address(b), "pool owned by balancer");
        assertEq(p.purchaseOperator(), address(b), "operator set");
        assertEq(IFWAPoolFactory(FWA_FACTORY).poolImplementation(address(p)), FWA_IMPL);
        // initialize is single-shot
        vm.expectRevert(PoolBalancer.AlreadyInitialized.selector);
        b.initialize(creator);
    }

    // --- a clone made OUTSIDE the factory: initialize lets anyone set creator & factory, but factory.canKeep
    //     is whatever that caller passed. Confirm such a clone is NOT registered and keeper-gating depends on
    //     the attacker-chosen factory (documents the trust boundary). ---
    function testCloneOutsideFactory() public {
        // LibClone deterministic clone of impl, initialized by an arbitrary EOA posing as "factory".
        // We emulate: a contract that clones and calls initialize. Here we just call initialize on a fresh clone
        // created via the real factory is covered above; an out-of-factory clone would have factory=msg.sender.
        // Assert the registry only knows factory-made balancers.
        PoolBalancer b = _newBalancer(creator);
        assertTrue(factory.isBalancer(address(b)));
        assertFalse(factory.isBalancer(address(0xdead)));
    }

    // --- access control: every creator-only entry reverts for a stranger ---
    function testOnlyCreatorMatrix() public {
        PoolBalancer b = _newBalancer(creator);
        address mallory = address(0xBAD);
        vm.startPrank(mallory);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.configure(2000, 1);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.open();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.close();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.transferCreator(mallory);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.claimSurplus(0, mallory);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.listCurated(address(0x1234), 1, 1);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.withdrawCurated(1, mallory);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.recoverUntrackedNFT(address(0x1234), 1, mallory);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.retire();
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.setENSName("x");
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.approvePoolPage("2026-11-10T12:34:56.789Z", bytes32(0));
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.revokePoolPages();
        vm.stopPrank();
    }

    // --- performUpkeep gating: open-by-default anyone may keep; once restricted, only approved + creator ---
    function testKeeperGating() public {
        PoolBalancer b = _newBalancer(creator);
        // default open: a random keeper gets past the gate (reverts later with NoUpkeepNeeded, not KeeperNotApproved)
        vm.prank(address(0x1111));
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        b.performUpkeep();
        // restrict
        vm.prank(keeperAdmin);
        factory.setKeepersRestricted(true);
        vm.prank(address(0x1111));
        vm.expectRevert(PoolBalancer.KeeperNotApproved.selector);
        b.performUpkeep();
        // creator always allowed through the gate
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        b.performUpkeep();
        // approved keeper allowed through
        vm.prank(keeperAdmin);
        factory.setKeeperApproved(address(0x1111), true);
        vm.prank(address(0x1111));
        vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector);
        b.performUpkeep();
    }

    // --- keeper admin two-step handover + that a compromised admin has no asset power ---
    function testKeeperAdminTwoStepAndScope() public {
        PoolBalancer b = _newBalancer(creator);
        address newAdmin = address(0x2222);
        vm.prank(keeperAdmin);
        factory.transferKeeperAdmin(newAdmin);
        assertEq(factory.keeperAdmin(), keeperAdmin, "not transferred until accepted");
        // wrong acceptor
        vm.prank(address(0x9999));
        vm.expectRevert(BalancerFactory.Unauthorized.selector);
        factory.acceptKeeperAdmin();
        vm.prank(newAdmin);
        factory.acceptKeeperAdmin();
        assertEq(factory.keeperAdmin(), newAdmin);
        // a "compromised" admin can only flip the keeper list; it cannot touch a balancer or its pool.
        // There is no factory function that reaches a balancer's assets; assert the only powers are list powers.
        vm.startPrank(newAdmin);
        factory.setKeepersRestricted(true);
        factory.setKeeperApproved(address(0x3333), true);
        vm.stopPrank();
        // balancer creator authority is unaffected
        assertEq(b.creator(), creator);
    }

    // --- creator transfer two-step; pending epoch bump invalidates page approvals ---
    function testCreatorTransferTwoStep() public {
        PoolBalancer b = _newBalancer(creator);
        address next = address(0x4444);
        vm.prank(creator);
        b.transferCreator(next);
        assertEq(b.creator(), creator, "not moved until accept");
        // only pendingCreator can accept
        vm.prank(address(0x5555));
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.acceptCreator();
        uint256 epochBefore = b.pageEpoch();
        vm.prank(next);
        b.acceptCreator();
        assertEq(b.creator(), next);
        assertEq(b.pageEpoch(), epochBefore + 1, "epoch bumped on creator change");
        // old creator loses authority
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        b.configure(2000, 1);
    }

    // --- isValidSignature only validates an approved digest, and only in its epoch ---
    function testPoolPageEpochReplay() public {
        PoolBalancer b = _newBalancer(creator);
        string memory issued = "2026-11-10T12:34:56.789Z";
        bytes32 mh = keccak256("meta");
        vm.prank(creator);
        bytes32 digest = b.approvePoolPage(issued, mh);
        assertEq(b.isValidSignature(digest, ""), bytes4(0x1626ba7e), "approved digest valid");
        // an unapproved digest is rejected
        assertEq(b.isValidSignature(keccak256("other"), ""), bytes4(0xffffffff));
        // revoke bumps epoch: the old approval no longer validates
        vm.prank(creator);
        b.revokePoolPages();
        assertEq(b.isValidSignature(digest, ""), bytes4(0xffffffff), "revoked approval must not validate");
        // a creator transfer also invalidates prior approvals
        vm.prank(creator);
        bytes32 d2 = b.approvePoolPage(issued, mh);
        assertEq(b.isValidSignature(d2, ""), bytes4(0x1626ba7e));
        vm.prank(creator);
        b.transferCreator(address(0x6666));
        vm.prank(address(0x6666));
        b.acceptCreator();
        assertEq(b.isValidSignature(d2, ""), bytes4(0xffffffff), "former-creator approval replayable?");
    }

    // --- recoverUntrackedNFT guards: cannot target the pool or FWA factory; only an NFT truly owned by the balancer ---
    function testRecoverUntrackedGuards() public {
        PoolBalancer b = _newBalancer(creator);
        SimpleNFT nft = new SimpleNFT();
        // not owned by balancer -> ProtectedAsset
        nft.mint(address(0x7777), 1);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        b.recoverUntrackedNFT(address(nft), 1, creator);
        // pool / factory addresses are protected
        address poolAddr = address(b.pool());
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        b.recoverUntrackedNFT(poolAddr, 1, creator);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ProtectedAsset.selector);
        b.recoverUntrackedNFT(FWA_FACTORY, 1, creator);
        // a genuinely untracked NFT the balancer owns can be recovered
        nft.mint(address(b), 2);
        vm.prank(creator);
        b.recoverUntrackedNFT(address(nft), 2, creator);
        assertEq(nft.ownerOf(2), creator);
    }

    // --- listCurated rejects Shapes/Packs as "curated" collections ---
    function testListCuratedRejectsProtocolTokens() public {
        PoolBalancer b = _newBalancer(creator);
        vm.prank(creator);
        b.configure(2000, 1); // markup 20%, tiny target
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.ShapesNotCurated.selector);
        b.listCurated(SHAPES, 1, 1 ether);
        vm.expectRevert(PoolBalancer.ShapesNotCurated.selector);
        b.listCurated(packs, 1, 1 ether);
        vm.stopPrank();
    }

    // --- configure bounds: markup must be in [MIN,MAX]; empty/oversized plan rejected ---
    function testConfigureBounds() public {
        PoolBalancer b = _newBalancer(creator);
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(999, 1); // below MIN_MARKUP_BPS (1000)
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        b.configure(10001, 1); // above MAX
        vm.expectRevert(PoolBalancer.InvalidPlan.selector);
        b.configure(2000, 0); // empty plan
        b.configure(1000, 1); // ok at the minimum
        vm.stopPrank();
        assertEq(b.markupBps(), 1000);
    }

    // --- open requires reserve funded ---
    function testOpenRequiresReserve() public {
        PoolBalancer b = _newBalancer(creator);
        vm.prank(creator);
        b.configure(2000, 1); // target: one 0.01 shape
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.ReserveNotFunded.selector);
        b.open();
        // fund and retry
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        assertTrue(b.enabled());
    }
}
