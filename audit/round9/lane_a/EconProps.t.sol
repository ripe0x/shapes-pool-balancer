// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";
import {SimpleNFT} from "./helpers/MockCollections.sol";

/// Economic property pass (M6 reserve protection, admission refusals, claim/fund invariant). Real FWA, no mocks.
contract EconProps is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    address keeper = address(0x1111);
    SimpleNFT nft;

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode(
            "ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2))
        );
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), address(0xA11CE));
        nft = new SimpleNFT();
    }

    function _newBalancer() internal returns (PoolBalancer b) {
        vm.prank(creator);
        b = PoolBalancer(payable(factory.createBalancer(bytes32(0))));
    }

    function _upkeep(PoolBalancer b) internal {
        for (uint256 i; i < 10; ++i) {
            vm.prank(keeper);
            try b.performUpkeep() {} catch {
                break;
            }
            if (!b.creatorWork()) break;
        }
    }

    // --- M6: while open with a healthy fund, the creator cannot withdraw below requiredReserve. ---
    function testM6CannotWithdrawBelowReserve() public {
        PoolBalancer b = _newBalancer();
        vm.prank(creator);
        b.configure(3000, 3);
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeep(b);
        uint256 reserve = b.requiredReserve();
        uint256 bal = address(b).balance;
        assertGt(bal, reserve, "funded above reserve");
        uint256 free = bal - reserve;
        // withdrawing exactly `free` is allowed
        vm.prank(creator);
        b.claimSurplus(free, creator);
        assertEq(address(b).balance, reserve, "balance pulled to the reserve");
        // one wei more must revert (reserve is protected while open)
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        b.claimSurplus(1, creator);
        // and the reserve stays funded
        assertGe(address(b).balance, b.requiredReserve(), "M6: reserve not maintained");
    }

    // --- canPurchase refuses the balancer, Shapes, Packs and the pool itself (failed/stuck-delivery addresses). ---
    function testCanPurchaseRefusals() public {
        PoolBalancer b = _newBalancer();
        vm.prank(creator);
        b.configure(3000, 3);
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeep(b);
        nft.mint(creator, 1);
        vm.prank(creator);
        nft.approve(address(b), 1);
        vm.prank(creator);
        b.listCurated(address(nft), 1, 0.3 ether);
        _upkeep(b);
        assertEq(b.admissionStatus(), 0, "admitting");
        // a normal address is admitted
        assertTrue(b.canPurchase(address(0xBEEF00)), "normal purchaser admitted");
        // these are refused regardless of admission
        assertFalse(b.canPurchase(address(b)), "balancer must be refused");
        assertFalse(b.canPurchase(SHAPES), "Shapes must be refused");
        assertFalse(b.canPurchase(packs), "Packs must be refused");
        assertFalse(b.canPurchase(address(b.pool())), "pool must be refused");
    }

    // --- Admission closes while creator work is pending and reopens only after the target is restored. ---
    function testAdmissionDuringSetup() public {
        PoolBalancer b = _newBalancer();
        vm.prank(creator);
        b.configure(3000, 3);
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        // right after open, inventory is empty -> creatorWork true -> SETTING_UP
        assertTrue(b.creatorWork());
        assertEq(b.admissionStatus(), 2, "SETTING_UP while creator work pending");
        assertFalse(b.canPurchase(address(0xBEEF00)), "no purchase during setup");
    }
}
