// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {FreezableNFT} from "./utils/Mocks.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {PoolInventory} from "../src/PoolInventory.sol";
import {PoolPage} from "../src/PoolPage.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";
import {IVRFService} from "./utils/ForkBase.sol";

import {BalancerFactory} from "../src/BalancerFactory.sol";

/// @dev Genuine historical proofs on a fork with candidate/request accounts preserved across the block advance.
/// Intervening canonical mutations to those accounts are intentionally omitted; this does not test new oracle availability.
interface IAuthenticRefundCredit {
    function acquisitionRefundCredit(address who) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
}

contract AuthenticRefundRecoveryTest is ForkBase {
    uint256[] internal lids;

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
        nft = new FreezableNFT();
        vm.deal(creator, 10 ether);
        vm.deal(buyer, 10 ether);
        createBalancer(1 ether);
        lids = new uint256[](3);
        for (uint256 i; i < 3; ++i) lids[i] = listCurated(100 + i, 0.01 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        uint256[] memory active = balancer.getActiveIds();
        uint256[] memory shape = new uint256[](1);
        for (uint256 i; i < active.length; ++i) { (uint8 kind,,,,) = balancer.items(active[i]); if (kind == 2) shape[0] = active[i]; }
        vm.startPrank(creator);
        balancer.setFillGateBps(0);
        balancer.setPaidUpkeepEnabled(false);
        balancer.unlistShapes(shape);
        vm.stopPrank();
        FreezableNFT(address(nft)).setFrozen(true);
        assertEq(pool.acquisitionFee(), 0.0105 ether, "three equal 0.01 ETH listings plus historical 5% edge");
        uint256[] memory ids = buy(buyer, 3);
        assertEq(ids[0], uint256(0xfd7d389c0cb11d5735fa3f963b46ca8820c7ae275a5e7136bc2e807bcc7cf889));
        assertEq(ids[1], uint256(0x02163c57dacb0912b09054c1d6b3ad647d9640a2b93cb9780acbece893d1b9c8));
        assertEq(ids[2], uint256(0xccc4d65b1080d0153691ebe850f9b4a8ee3130b2c11be32b165576f1c2e96c77));
        // Preserve state reached through actual calls when transact advances/reselects the historical fork.
        // No protocol slots, balances, code or randomness are replaced.
        address[] memory persistent = new address[](14);
        persistent[0] = address(pool); persistent[1] = address(balancer); persistent[2] = address(factory);
        persistent[3] = address(nft); persistent[4] = packs; persistent[5] = renderer;
        persistent[6] = FWA_FACTORY; persistent[7] = VRF_SERVICE;
        persistent[8] = IVRFService(VRF_SERVICE).coordinator(); persistent[9] = SHAPES;
        persistent[10] = address(PoolInventory); persistent[11] = address(PoolPage);
        persistent[12] = address(KeeperPolicyCalls); persistent[13] = factory.implementation();
        vm.makePersistent(persistent);
        vm.makePersistent(creator, buyer);
    }

    function test_authenticProofReplayAndRefundBatch() public {
        vm.rollFork(26442757);
        vm.warp(1795014659);
        vm.fee(548662718);
        assertEq(block.number, 26442757);
        assertEq(block.basefee, 548662718);
        assertGe(tx.gasprice, block.basefee);
        vm.transact(0x16ccbb75cd9b6cec741d78957e43f723b6bf00d7d70d0882d13e4300bb072616);
        vm.transact(0x3e361ce8123ab51584b68873e23b29b05187a575495cd3c939dc8a39b21774d8);
        vm.transact(0x9fbe95ea1760ed9e5dae0ece749cb6ae534aad8507fa02246038def196336abe);
        pool.processAcquisitions(3);
        for (uint256 i; i < 3; ++i) { (,,,,,,, uint8 status) = pool.listings(lids[i]); assertEq(status, 6, "authentic failed delivery reached"); }
        vm.prank(creator); balancer.close();
        balancer.performUpkeepUnpaid();
        vm.warp(block.timestamp + 7 days + 1);
        vm.startPrank(buyer);
        for (uint256 i; i < 3; ++i) pool.refundFailedDelivery(lids[i]);
        vm.stopPrank();
        assertEq(IAuthenticRefundCredit(address(pool)).acquisitionRefundCredit(buyer), 0.0315 ether);
        uint256 walletBefore = buyer.balance;
        vm.prank(buyer);
        IAuthenticRefundCredit(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - walletBefore, 0.0315 ether, "actual buyer refund paid, including edge");
        assertEq(IAuthenticRefundCredit(address(pool)).acquisitionRefundCredit(buyer), 0);
        assertEq(pool.ownerProceeds(), 0, "failed delivery creates no creator sale proceeds");
        FreezableNFT(address(nft)).setFrozen(false);
        vm.prank(creator); balancer.recoverRefundedBatch(lids, creator);
        for (uint256 i; i < 3; ++i) {
            assertEq(nft.ownerOf(100 + i), creator);
            (,,,,,,, uint8 status) = pool.listings(lids[i]);
            assertEq(status, 3, "FWA records withdrawn after actual recovery");
            (uint8 kind,,,,) = balancer.items(lids[i]); assertEq(kind, 0);
        }
        assertEq(balancer.getActiveIds().length, 0);
    }
}
