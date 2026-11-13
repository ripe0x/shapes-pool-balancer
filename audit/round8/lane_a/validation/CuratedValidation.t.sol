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

interface IVRFService {
    function coordinator() external view returns (address);
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external;
}

interface IFWARefund {
    function withdrawAcquisitionRefund() external;
}

contract AdversarialOwnerAndApproval is ERC721 {
    enum Mode { Normal, OwnerLieAfterPull, FakePullOnly, FakeEscrow, ApproveRevert, ApproveCallback, FakeEscrowRefund }

    PoolBalancer public balancer;
    Mode public mode;
    address public reportedOwner;

    constructor() ERC721("Adversarial Owner and Approval", "AOA") { _mint(address(this), 1); }

    receive() external payable {}

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(541)))));
        balancer.configure(0, 1);
        this.approve(address(balancer), 1);
    }

    function setMode(Mode next) external { mode = next; reportedOwner = address(0); }
    function list() external returns (uint256) { return balancer.listCurated(address(this), 1, 0.1 ether); }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll(address to) external { balancer.claimSurplus(address(balancer).balance, to); }
    function actualOwner(uint256 tokenId) external view returns (address) { return _ownerOf(tokenId); }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        address actual = _ownerOf(tokenId);
        if (mode == Mode.OwnerLieAfterPull && actual == address(balancer.pool())) return address(0xBAD);
        if ((mode == Mode.FakePullOnly || mode == Mode.FakeEscrow || mode == Mode.FakeEscrowRefund) && reportedOwner != address(0)) {
            return reportedOwner;
        }
        return super.ownerOf(tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if ((mode == Mode.FakePullOnly || mode == Mode.FakeEscrow || mode == Mode.FakeEscrowRefund) && from == address(this) && to == address(balancer)) {
            reportedOwner = to;
            return; // This collection violates ERC721 custody semantics while claiming success.
        }
        if ((mode == Mode.FakeEscrow || mode == Mode.FakeEscrowRefund) && from == address(balancer) && to == address(balancer.pool())) {
            reportedOwner = to;
            return;
        }
        if (mode == Mode.FakeEscrow && from == address(balancer.pool())) {
            reportedOwner = to;
            return; // FWA sees a reported delivery, while the internal token owner never moves.
        }
        super.transferFrom(from, to, tokenId);
    }

    function approve(address to, uint256 tokenId) public override {
        if (msg.sender == address(balancer) && mode == Mode.ApproveRevert) revert("ApprovalBlocked");
        if (msg.sender == address(balancer) && mode == Mode.ApproveCallback) {
            balancer.configure(10_000, 1);
        }
        if (msg.sender == address(balancer) && (mode == Mode.FakeEscrow || mode == Mode.FakeEscrowRefund)) return;
        super.approve(to, tokenId);
    }
}

contract CuratedValidationInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant KEEPER = address(0xBEEF);
    address constant PLAYER = address(0xB0B);
    address constant PLAYER2 = address(0xCAFE);
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;

    AdversarialOwnerAndApproval nft;
    PoolBalancer balancer;
    IFWAPool pool;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(KEEPER.code.length, 0);
        assertEq(PLAYER.code.length, 0);
        assertEq(PLAYER2.code.length, 0);
        assertEq(IVRFService(FWA_VRF_SERVICE).coordinator(), COORDINATOR);
        vm.deal(address(this), 5 ether); // Test wallet funds a real creator actor through factory creation.
        vm.deal(KEEPER, 1 ether);
        vm.deal(PLAYER, 1 ether);
        vm.deal(PLAYER2, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        nft = new AdversarialOwnerAndApproval();
        nft.makePool{value: 1 ether}(factory);
        balancer = nft.balancer();
        pool = balancer.pool();
    }

    function testChangingOwnerOfAfterPullRollsBackWholeListing() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.OwnerLieAfterPull);
        vm.expectRevert();
        nft.list();
        assertEq(nft.actualOwner(1), address(nft), "real token moved despite reverted FWA owner check");
        assertEq(nft.ownerOf(1), address(nft));
        assertEq(pool.activeListingCount(), 0);
        assertEq(balancer.getActiveIds().length, 0);
        assertEq(balancer.markupBps(), 0);
        assertEq(address(balancer).balance, 1 ether, "failed listing moved creator capital");
    }

    function testOwnerOfLieAloneFailsButFullyDishonestCollectionListsGhost() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.FakePullOnly);
        vm.expectRevert();
        nft.list();
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(pool.activeListingCount(), 0);
        assertEq(balancer.getActiveIds().length, 0);

        nft.setMode(AdversarialOwnerAndApproval.Mode.FakeEscrow);
        uint256 lid = nft.list();
        assertEq(nft.actualOwner(1), address(nft), "ghost token left creator's real ledger");
        assertEq(nft.ownerOf(1), address(pool), "reported owner did not move to FWA");
        assertEq(pool.activeListingCount(), 1);
        (,,,,,,, uint8 listingStatus) = pool.listings(lid);
        assertEq(listingStatus, 1);
        (uint8 kind,, uint8 state,, uint112 listedPrice) = balancer.items(lid);
        assertEq(kind, 1);
        assertEq(state, 1);
        assertEq(listedPrice, 0.1 ether);
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0, "ghost custody prevented local admission");
        console2.log("ghost listing id", lid);
        console2.log("actual creator token owner", nft.actualOwner(1));
        console2.log("reported FWA token owner", nft.ownerOf(1));
    }

    function testApproveRevertRollsBackAndCallbackLeavesOldPrice() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.ApproveRevert);
        vm.expectRevert(bytes("ApprovalBlocked"));
        nft.list();
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(pool.activeListingCount(), 0);
        assertEq(balancer.getActiveIds().length, 0);
        assertEq(balancer.markupBps(), 0);
        assertEq(address(balancer).balance, 1 ether);

        nft.setMode(AdversarialOwnerAndApproval.Mode.ApproveCallback);
        uint256 lid = nft.list();
        assertEq(balancer.markupBps(), 10_000);
        assertEq(nft.actualOwner(1), address(pool));
        (,,,,, uint256 fwaPrice,,) = pool.listings(lid);
        assertEq(fwaPrice, 0.1 ether, "pre-approve listing price was repriced");
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        console2.log("approval callback current markup bps", balancer.markupBps());
        console2.log("FWA old-price listing wei", fwaPrice);
    }

    function testFakeEscrowAndFakeDeliveryChargePlayerWithoutRealToken() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.FakeEscrow);
        uint256 ghostId = nft.list();
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), address(pool));
        assertEq(balancer.admissionStatus(), 0);

        (uint256 acquisitionFee, uint256 vrfFee, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        uint256 creatorBefore = address(nft).balance;
        uint256 balancerBefore = address(balancer).balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, acquisitionFee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(playerBefore - PLAYER.balance, total, "external EOA did not fund FWA draw");
        vm.roll(block.number + 1);
        uint256 trials = _selectGhost(request, ghostId);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        assertEq(selected, ghostId);
        (,,,,,,, uint8 listingStatus) = pool.listings(ghostId);
        assertEq(acquisitionStatus, 2, "FWA did not mark dishonest delivery fulfilled");
        assertEq(listingStatus, 4, "FWA did not mark dishonest listing delivered");
        assertGt(pool.ownerProceeds(), 0, "creator proceeds were not allocated");
        assertEq(nft.ownerOf(1), PLAYER, "collection did not report player ownership");
        console2.log("post-draw acquisition status", acquisitionStatus);
        console2.log("post-draw listing status", listingStatus);
        console2.log("actual token owner", nft.actualOwner(1));
        console2.log("reported token owner", nft.ownerOf(1));
        console2.log("FWA owner proceeds wei", pool.ownerProceeds());
        console2.log("word trials", trials);
        assertEq(nft.actualOwner(1), address(nft), "collection actually transferred the token");

        vm.prank(KEEPER);
        balancer.performUpkeep();
        uint256 liquidAfterUpkeep = address(balancer).balance;
        vm.warp(block.timestamp + 7 days + 1);
        bytes4 refundSelector = _assertNoRefund(PLAYER, ghostId);
        vm.prank(PLAYER);
        vm.expectRevert();
        nft.transferFrom(PLAYER, address(0xCAFE), 1);
        assertEq(nft.actualOwner(1), address(nft));

        nft.close();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1);
        nft.unlist(ids);
        uint256 creatorClaim = address(balancer).balance;
        nft.claimAll(address(nft));
        assertEq(address(balancer).balance, 0);
        console2.log("player spent wei", total);
        console2.log("router fee wei", vrfFee);
        console2.log("acquisition fee wei", acquisitionFee);
        console2.log("Balancer before draw wei", balancerBefore);
        console2.log("Balancer after upkeep wei", liquidAfterUpkeep);
        console2.log("creator pre-draw wallet wei", creatorBefore);
        console2.log("creator final wallet wei", address(nft).balance);
        console2.log("creator net over 1 ETH funded capital wei", address(nft).balance - 1 ether);
        console2.log("creator final liquid claim wei", creatorClaim);
        console2.log("refund rejection selector");
        console2.logBytes4(refundSelector);
    }

    function testFakeDeliveryCanRelistSameActualTokenForSecondPlayer() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.FakeEscrow);
        uint256 firstLid = nft.list();
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        uint256 balancerBefore = address(balancer).balance;
        uint256 firstPlayerBefore = PLAYER.balance;
        (uint256 firstFee, uint256 firstVrf, uint256 firstTotal) = pool.quoteAcquisitionPrice(1);
        uint256 firstVersion = pool.inventoryVersion();
        vm.prank(PLAYER);
        uint256 firstRequest = pool.acquire{value: firstTotal}(
            PLAYER, firstFee, 0, 10_000, firstVersion, block.timestamp + 1 days
        );
        vm.roll(block.number + 1);
        uint256 firstTrials = _selectGhost(firstRequest, firstLid);
        (,,, uint256 firstSelected, uint8 firstStatus,) = pool.acquisitions(firstRequest);
        assertEq(firstSelected, firstLid);
        assertEq(firstStatus, 2);
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), PLAYER);
        uint256 firstProceeds = pool.ownerProceeds();
        assertGt(firstProceeds, 0);
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(address(balancer).balance, balancerBefore + firstProceeds);
        assertEq(balancer.admissionStatus(), 3, "no curated NFT remains before relist");

        uint256 secondLid = nft.list();
        assertGt(secondLid, firstLid);
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), address(pool));
        assertEq(balancer.admissionStatus(), 0);
        uint256 secondPlayerBefore = PLAYER2.balance;
        (uint256 secondFee, uint256 secondVrf, uint256 secondTotal) = pool.quoteAcquisitionPrice(1);
        uint256 secondVersion = pool.inventoryVersion();
        vm.prank(PLAYER2);
        uint256 secondRequest = pool.acquire{value: secondTotal}(
            PLAYER2, secondFee, 0, 10_000, secondVersion, block.timestamp + 1 days
        );
        vm.roll(block.number + 1);
        uint256 secondTrials = _selectGhost(secondRequest, secondLid);
        (,,, uint256 secondSelected, uint8 secondStatus,) = pool.acquisitions(secondRequest);
        assertEq(secondSelected, secondLid);
        assertEq(secondStatus, 2);
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), PLAYER2);
        uint256 secondProceeds = pool.ownerProceeds();
        assertGt(secondProceeds, 0);
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(address(balancer).balance, balancerBefore + firstProceeds + secondProceeds);

        vm.warp(block.timestamp + 7 days + 1);
        bytes4 firstRefundSelector = _assertNoRefund(PLAYER, firstLid);
        bytes4 secondRefundSelector = _assertNoRefund(PLAYER2, secondLid);
        assertEq(firstRefundSelector, secondRefundSelector);
        assertEq(firstPlayerBefore - PLAYER.balance, firstTotal);
        assertEq(secondPlayerBefore - PLAYER2.balance, secondTotal);
        assertEq(nft.actualOwner(1), address(nft));

        nft.close();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1);
        uint256 beforeUnlist = address(balancer).balance;
        nft.unlist(ids);
        assertEq(address(balancer).balance - beforeUnlist, 0.01 ether);
        nft.claimAll(address(nft));
        assertEq(address(balancer).balance, 0);
        console2.log("first player total wei", firstTotal);
        console2.log("first router fee wei", firstVrf);
        console2.log("first owner proceeds wei", firstProceeds);
        console2.log("second player total wei", secondTotal);
        console2.log("second router fee wei", secondVrf);
        console2.log("second owner proceeds wei", secondProceeds);
        console2.log("creator final wallet wei", address(nft).balance);
        console2.log("creator net over 1 ETH funded capital wei", address(nft).balance - 1 ether);
        console2.log("first/second word trials", firstTrials, secondTrials);
        console2.log("both refund rejection selector");
        console2.logBytes4(firstRefundSelector);
    }

    function testGhostEscrowWithStandardDeliveryRefundsAcquisitionFee() public {
        nft.setMode(AdversarialOwnerAndApproval.Mode.FakeEscrowRefund);
        uint256 ghostId = nft.list();
        nft.open();
        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), address(pool));
        assertEq(balancer.admissionStatus(), 0);

        (uint256 fee, uint256 vrfFee, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        uint256 playerBefore = PLAYER.balance;
        uint256 balancerBefore = address(balancer).balance;
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(
            PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        vm.roll(block.number + 1);
        uint256 trials = _selectGhost(request, ghostId);
        (,,, uint256 selected, uint8 acquisitionStatus,) = pool.acquisitions(request);
        (,,,,,,, uint8 listingStatus) = pool.listings(ghostId);
        assertEq(selected, ghostId);
        assertEq(acquisitionStatus, 7, "expected failed delivery acquisition status");
        assertEq(listingStatus, 6, "expected pending delivery listing status");
        assertEq(pool.ownerProceeds(), 0);
        assertEq(nft.actualOwner(1), address(nft));
        assertEq(nft.ownerOf(1), address(pool));

        vm.prank(KEEPER);
        balancer.performUpkeep();
        assertEq(address(balancer).balance, balancerBefore);
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(PLAYER);
        pool.refundFailedDelivery(ghostId);
        vm.prank(PLAYER);
        IFWARefund(address(pool)).withdrawAcquisitionRefund();
        assertEq(PLAYER.balance, playerBefore - vrfFee, "player VRF fee should remain spent");
        (,,,,,,, uint8 refundedStatus) = pool.listings(ghostId);
        assertEq(refundedStatus, 7);
        assertEq(nft.actualOwner(1), address(nft));
        console2.log("standard delivery acquisition/listing status", acquisitionStatus, refundedStatus);
        console2.log("refund player loss wei", playerBefore - PLAYER.balance);
        console2.log("refund VRF fee wei", vrfFee);
        console2.log("refund total acquisition wei", total);
        console2.log("refund owner proceeds wei", pool.ownerProceeds());
        console2.log("refund word trials", trials);
    }

    function _assertNoRefund(address player, uint256 lid) internal returns (bytes4 selector) {
        (,,,,,,, uint8 status) = pool.listings(lid);
        assertEq(status, 4, "wrong FWA listing ID or not delivered");
        vm.prank(player);
        (bool accepted, bytes memory reason) = address(pool).call(
            abi.encodeCall(IFWAPool.refundFailedDelivery, (lid))
        );
        assertFalse(accepted, "FWA refunded a delivered listing");
        assertGe(reason.length, 4, "refund did not return a selector");
        selector = bytes4(reason);
    }

    function _selectGhost(uint256 requestId, uint256 wantedLid) internal returns (uint256) {
        for (uint256 candidate = 1; candidate <= 5_000; ++candidate) {
            uint256 snapshot = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lying-erc721-ghost", requestId, candidate)));
            vm.prank(COORDINATOR); // Actual coordinator → real service → real FWA pool.
            IVRFService(FWA_VRF_SERVICE).rawFulfillRandomWords(requestId, words);
            pool.processAcquisitions(5);
            (,,, uint256 lid,,) = pool.acquisitions(requestId);
            if (lid == wantedLid) return candidate;
            vm.revertToState(snapshot);
        }
        fail("ghost outcome not reached");
        return 0;
    }
}
