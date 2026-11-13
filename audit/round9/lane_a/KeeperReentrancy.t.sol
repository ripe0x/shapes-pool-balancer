// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";
import {SimpleNFT, ReentrantNFT} from "./helpers/MockCollections.sol";

/// Keeper-incentive (M1) and reentrancy pass on a mainnet fork. No protocol contract is mocked.
contract KeeperReentrancy is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;

    PoolBalancer impl;
    BalancerFactory factory;
    address packs;
    address creator = address(0xC0FFEE);
    address keeper = address(0x1111);
    address player = address(0x9A9A);
    SimpleNFT nft;

    event KeeperPaid(address indexed keeper, uint256 amount, uint256 gasUsed);

    function setUp() public {
        vm.createSelectFork("https://mainnet.gateway.tenderly.co", 26382349);
        address renderer = deployCode("ShapePackRenderer.sol:ShapePackRenderer", abi.encode(SHAPES));
        packs = deployCode(
            "ShapePacks.sol:ShapePacks", abi.encode(SHAPES, renderer, address(0xBEEF), "P", "P", uint256(2))
        );
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin());
        nft = new SimpleNFT();
    }

    function keeperAdmin() internal pure returns (address) {
        return address(0xA11CE);
    }

    function _newBalancer(address c) internal returns (PoolBalancer b) {
        vm.prank(c);
        b = PoolBalancer(payable(factory.createBalancer(bytes32(uint256(uint160(c))))));
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

    function _openPool() internal returns (PoolBalancer b) {
        b = _newBalancer(creator);
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
    }

    function _drawOnce(PoolBalancer b, uint256 word) internal {
        IFWAPool p = b.pool();
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(1);
        vm.deal(player, player.balance + total);
        uint256 iv = p.inventoryVersion();
        vm.prank(player);
        uint256 rid = p.acquire{value: total}(player, fee, 0, 10_000, iv, block.timestamp + 1000);
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(VRF_SERVICE);
        p.rawFulfillRandomWords(rid, words);
    }

    // --- M1: bidding up the priority fee does not raise the keeper reward above basefee + 0.05 gwei (capped). ---
    function testM1PriorityBidCapped() public {
        PoolBalancer b = _openPool();
        // a draw to create reconcile+restock work (so a non-creator-work reward is paid)
        _drawOnce(b, uint256(keccak256("p")));

        // keeper bids a huge priority fee; basefee is modest. The reward price must be basefee + 0.05 gwei.
        uint256 basefee = 2 gwei;
        vm.fee(basefee);
        vm.txGasPrice(100 gwei); // keeper tries to bid 100 gwei priority
        uint256 creditBefore = b.keeperCredit();

        vm.recordLogs();
        vm.prank(keeper);
        uint256 reward = b.performUpkeep();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 paid;
        uint256 gasUsed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KeeperPaid.selector && logs[i].topics[1] == bytes32(uint256(uint160(keeper)))) {
                (paid, gasUsed) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        console.log("reward:", reward, "gasUsed:", gasUsed);
        console.log("creditBefore:", creditBefore, "creditAfter:", b.keeperCredit());
        // M1 priority-bid protection: the reward price is min(bid, basefee + 0.05 gwei, 5 gwei). A 100 gwei bid must
        // NOT be used. The reward (which this call also bounds by keeperCredit) can never exceed the capped-price value.
        uint256 cappedPrice = basefee + 0.05 gwei; // the honest cap
        uint256 rewardAtBid = gasUsed * 100 gwei + 0.0005 ether; // if the bid WERE used (the exploit)
        uint256 rewardAtCap = gasUsed * cappedPrice + 0.0005 ether;
        assertLt(reward, rewardAtBid, "M1: reward used the 100 gwei bid");
        assertLe(reward, rewardAtCap, "M1: reward exceeded the capped-price value");
        // reward is a lane-A keeper reward only; it came from restock-fee credit this call earned (creditBefore was 0).
        assertGt(reward, 0, "a reconcile+restock call should pay the keeper");
    }

    // --- M1: a non-creator-work upkeep cannot pay a reward exceeding keeperCredit (no leak from the markup/fund). ---
    function testM1ReconcileOnlyBoundedByCredit() public {
        PoolBalancer b = _openPool();
        // Drain credit to zero is hard; instead assert that after close, keeperCredit is zeroed and upkeep pays nothing.
        _drawOnce(b, uint256(keccak256("q")));
        vm.prank(creator);
        b.close();
        assertEq(b.keeperCredit(), 0, "credit cleared on close");
        // an upkeep after close earns the keeper nothing (reconcile still runs, but reward is credit-bound = 0)
        uint256 kBefore = keeper.balance;
        vm.prank(keeper);
        try b.performUpkeep() {} catch {}
        assertEq(keeper.balance, kBefore, "M1: keeper paid after close with zero credit");
    }

    // --- Reentrancy: a hostile curated collection cannot reenter a guarded entry during listCurated. ---
    function testReentrancyHostileCollectionOnList() public {
        PoolBalancer b = _newBalancer(creator);
        vm.prank(creator);
        b.configure(3000, 3);
        vm.deal(address(b), 10 ether);
        vm.prank(creator);
        b.open();
        _upkeep(b);

        ReentrantNFT eve = new ReentrantNFT();
        eve.mint(creator, 7);
        // arm it to reenter claimSurplus (a nonReentrant creator fn) during transferFrom
        eve.arm(address(b), abi.encodeCall(PoolBalancer.claimSurplus, (1, creator)));
        vm.prank(creator);
        // the reentrant inner call must revert under the guard, bubbling up to fail listCurated
        vm.expectRevert();
        b.listCurated(address(eve), 7, 0.1 ether);
    }

    // --- Reentrancy: hostile collection during recoverUntrackedNFT cannot reenter. ---
    function testReentrancyRecoverUntracked() public {
        PoolBalancer b = _newBalancer(creator);
        vm.prank(creator);
        b.configure(3000, 3);
        ReentrantNFT eve = new ReentrantNFT();
        eve.mint(address(b), 9); // owned by balancer -> untracked recovery path
        eve.arm(address(b), abi.encodeCall(PoolBalancer.claimSurplus, (1, creator)));
        vm.prank(creator);
        vm.expectRevert();
        b.recoverUntrackedNFT(address(eve), 9, creator);
    }
}
