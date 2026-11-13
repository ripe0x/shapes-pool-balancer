// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

interface IFWARefund {
    function withdrawAcquisitionRefund() external;
}

// A real ERC721 counterparty with explicit creator and outsider powers.
contract AdversarialCurated is ERC721 {
    PoolBalancer public balancer;
    bool public changeMarkupOnPull;
    bool public frozen;
    bool public blockDelivery;
    bool internal changed;

    constructor() ERC721("Adversarial Curated", "AC") { _mint(address(this), 1); }

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(91)))));
        balancer.configure(0, 1); // One 0.01 ETH Shape alongside the curated token.
        this.approve(address(balancer), 1);
    }

    function list(bool callback) external returns (uint256 lid) {
        changeMarkupOnPull = callback;
        lid = balancer.listCurated(address(this), 1, 0.1 ether);
    }

    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function withdraw(uint256 lid, address to) external { balancer.withdrawCurated(lid, to); }
    function recover(uint256 lid, address to) external { balancer.recoverRefunded(lid, to); }

    function seize(address to) external { _update(to, 1, address(0)); }
    function freeze() external { frozen = true; }
    function setBlockDelivery(bool value) external { blockDelivery = value; }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (frozen && from == address(balancer.pool())) revert("Frozen");
        if (blockDelivery && from == address(balancer.pool())) revert("DeliveryRejected");
        if (changeMarkupOnPull && !changed && from == address(this) && to == address(balancer)) {
            changed = true;
            balancer.configure(10_000, 1);
        }
        super.transferFrom(from, to, tokenId);
    }
}

contract RejectingBuyer {
    receive() external payable {}

    function buy(IFWAPool pool, uint256 acquisitionFee, uint256 version) external payable returns (uint256) {
        return pool.acquire{value: msg.value}(address(this), acquisitionFee, 0, 10_000, version, block.timestamp + 1 days);
    }

    function refund(IFWAPool pool, uint256 lid) external { pool.refundFailedDelivery(lid); }
    function withdrawRefund(IFWAPool pool) external { IFWARefund(address(pool)).withdrawAcquisitionRefund(); }
}

contract HostileCuratedInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant KEEPER = address(0xBEEF);

    AdversarialCurated nft;
    PoolBalancer balancer;
    IFWAPool pool;
    uint256 curatedId;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        vm.deal(address(this), 10 ether); // The test is the funded external creator actor.
        vm.deal(KEEPER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        nft = new AdversarialCurated();
        nft.makePool{value: 2 ether}(factory);
        balancer = nft.balancer();
        pool = balancer.pool();
    }

    function testCreatorCallbackChangesMarkupDuringListing() public {
        curatedId = nft.list(true);
        (,,,,, uint256 listedPrice,,) = pool.listings(curatedId);
        assertEq(balancer.markupBps(), 10_000);
        assertEq(listedPrice, 0.1 ether);
        assertEq(nft.ownerOf(1), address(pool));
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        (,,,,, uint256 afterPrice,,) = pool.listings(curatedId);
        assertEq(afterPrice, 0.1 ether, "stale price was unexpectedly fixed");
        console2.log("F3 markup bps", balancer.markupBps());
        console2.log("F3 FWA price wei", afterPrice);
    }

    function testOutsiderFreezeBlocksOnlyCuratedExit() public {
        curatedId = nft.list(false);
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        vm.prank(address(0xBAD));
        nft.freeze();
        nft.close();
        vm.expectRevert(bytes("Frozen"));
        nft.withdraw(curatedId, address(this));
        assertEq(nft.ownerOf(1), address(pool));
        (,,,,,,, uint8 status) = pool.listings(curatedId);
        assertEq(status, 1, "active listing should remain after revert");
        console2.log("F2 frozen token owner", nft.ownerOf(1));
    }

    function testOutsiderSeizureLeavesAdmittingGhostListing() public {
        curatedId = nft.list(false);
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        uint256 count = pool.activeListingCount();
        assertEq(balancer.admissionStatus(), 0);
        vm.prank(address(0xBAD));
        nft.seize(address(0xCAFE));
        assertEq(nft.ownerOf(1), address(0xCAFE));
        assertEq(pool.activeListingCount(), count, "FWA listing count changed without a FWA call");
        (,,,,,,, uint8 status) = pool.listings(curatedId);
        assertEq(status, 1, "FWA listing unexpectedly deactivated");
        assertEq(balancer.admissionStatus(), 0, "Balancer noticed missing custody");
        console2.log("F1 ghost listing id", curatedId);
    }

    function testRejectedDeliveryRefundAndCreatorRecovery() public {
        curatedId = nft.list(false);
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        RejectingBuyer buyer = new RejectingBuyer();
        nft.setBlockDelivery(true);
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 beforeBuyer = address(buyer).balance;
        uint256 request = buyer.buy{value: total}(pool, fee, version);
        vm.roll(block.number + 1);
        uint256 tries = _selectCurated(request);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        assertEq(selected, curatedId);
        assertEq(acquisitionStatus, 7, "delivery should be pending");
        vm.prank(KEEPER);
        balancer.performUpkeep();
        (,,,,,,, uint8 pendingStatus) = pool.listings(curatedId);
        console2.log("pending listing status", pendingStatus);
        vm.warp(block.timestamp + 7 days + 1);
        buyer.refund(pool, curatedId);
        buyer.withdrawRefund(pool);
        assertEq(address(buyer).balance - beforeBuyer, fee, "buyer should recover acquisition fee");
        nft.setBlockDelivery(false);
        nft.recover(curatedId, address(0xCAFE));
        assertEq(nft.ownerOf(1), address(0xCAFE), "creator did not recover refunded NFT");
        console2.log("FWA acquisition fee wei", fee);
        console2.log("FWA VRF fee wei", vrf);
        console2.log("curated word trials", tries);
    }

    function testExpiredLocalBatchLeavesRouterCoverageRejection() public {
        curatedId = nft.list(false);
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        (uint256 fee, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(5);
        uint256 version = pool.inventoryVersion();
        uint256[] memory requests = pool.acquireBatch{value: total}(
            address(this), 5, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(requests.length, 5);
        vm.roll(block.number + 40);
        vm.warp(block.timestamp + 40 * 12);
        assertEq(pool.processAcquisitions(5), 5, "five FWA requests did not expire locally");
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0, "Balancer should still report admission open");
        (uint256 nextFee,, uint256 nextTotal) = pool.quoteAcquisitionPrice(1);
        uint256 nextVersion = pool.inventoryVersion();
        try pool.acquire{value: nextTotal}(
            address(this), nextFee, 0, 10_000, nextVersion, block.timestamp + 1 days
        ) returns (uint256) {
            fail("router accepted sixth request despite outstanding coverage");
        } catch (bytes memory reason) {
            assertGe(reason.length, 4);
            bytes4 selector = bytes4(reason);
            assertEq(selector, bytes4(keccak256("InsufficientVrfCoverage()")));
            console2.logBytes4(selector);
        }
        console2.log("F4 expired batch VRF fees wei", vrf);
    }

    function _selectCurated(uint256 requestId) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 8_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("informed-rejected-buyer", requestId, candidate)));
            vm.prank(FWA_VRF_SERVICE); // Allowed coordinator-word delivery to real FWA service.
            pool.rawFulfillRandomWords(requestId, words);
            pool.processAcquisitions(5);
            (,,, uint256 lid,,) = pool.acquisitions(requestId);
            if (lid == curatedId) return candidate;
            vm.revertToState(snapshot);
        }
        fail("curated outcome not reached");
        return 0;
    }
}
