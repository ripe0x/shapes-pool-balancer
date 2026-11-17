// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../../utils/ForkBase.sol";
import {PoolBalancer} from "../../../src/PoolBalancer.sol";
import {KeeperPolicyV1} from "../../../src/KeeperPolicyV1.sol";
import {BalancerFactory} from "../../../src/BalancerFactory.sol";
import {MockNFT} from "../../utils/Mocks.sol";
import {IFWAPool} from "../../../src/interfaces/External.sol";

contract LaunchAContext {
    uint256 public basefee;
    uint256 public gasprice;
    function record() external {
        basefee = block.basefee;
        gasprice = tx.gasprice;
    }
}

contract RecentBlockLifecycleTest is ForkBase {
    uint256 internal constant RECENT_BLOCK = 26_436_099;

    function setUp() public {
        vm.createSelectFork("mainnet", RECENT_BLOCK);
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        LaunchAContext witness = new LaunchAContext();
        witness.record();
        assertEq(witness.basefee(), 0.5 gwei);
        assertEq(witness.gasprice(), 0.55 gwei);
        assertEq(FWA_IMPL.codehash, FWA_CODEHASH, "live FWA implementation matches the pin");

        address renderer = deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
        packs = deployCode("out/ShapePacks.sol/ShapePacks.json", abi.encode(SHAPES, renderer, makeAddr("packsAdmin"), "Pool Prize Packs", "PRIZEPACK", uint256(2)));
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        factory = new BalancerFactory(address(impl), keeperAdmin, address(this), address(new KeeperPolicyV1()));
        nft = new MockNFT();
        vm.deal(creator, 5 ether);
        vm.deal(buyer, 5 ether);
        vm.deal(keeper, 1 ether);
    }

    function test_recentBlockPurchaseExpiryCloseout() public {
        createBalancer(1 ether);
        uint256[9] memory counts;
        counts[0] = 4;
        configure(plan(counts));
        uint256 curated = listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "purchases open");

        buy(buyer, 1);
        assertEq(pool.lastIssuedSequence(), 1, "real FWA purchase issued");
        vm.roll(block.number + 40);
        assertEq(pool.processAcquisitions(1), 1, "expired without randomness");
        bytes32 uh1 = balancer.settingsHash();
        vm.prank(keeper, keeper);
        balancer.performUpkeep(uh1);
        assertEq(balancer.reconciledSequence(), 1, "keeper reconciled");

        vm.prank(creator);
        balancer.close();
        uint256[] memory all = balancer.getActiveIds();
        uint256 count;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) ++count;
        }
        uint256[] memory shapesToUnlist = new uint256[](count);
        uint256 next;
        for (uint256 i; i < all.length; ++i) {
            (uint8 kind,,,,) = balancer.items(all[i]);
            if (kind == 2) shapesToUnlist[next++] = all[i];
        }
        vm.prank(creator);
        balancer.unlistShapes(shapesToUnlist);
        vm.prank(creator);
        balancer.withdrawCurated(curated, creator);
        assertEq(pool.ownerProceeds(), 0, "no uncollected creator proceeds");
        uint256 claimable = balancer.withdrawableSurplus();
        vm.prank(creator);
        balancer.claimSurplus(claimable, creator);
        assertEq(address(balancer).balance, 0, "closed Balancer has no stranded ETH");
        vm.prank(creator);
        balancer.retire();
        assertTrue(pool.retired(), "FWA pool retired");
    }
}
