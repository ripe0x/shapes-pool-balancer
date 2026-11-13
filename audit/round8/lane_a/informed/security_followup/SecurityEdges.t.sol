// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";
import {IFWAPool} from "../../../../../src/interfaces/External.sol";
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";

contract BatchCuratedActor is ERC721 {
    PoolBalancer public balancer;
    bool public callbackMarkup;
    bool public rejectSecond;
    bool public changed;
    bool public reenterOnETH;
    bool public ethReentrySucceeded;
    bytes4 public ethReentrySelector;
    bool public reenterOnNFT;
    bool public nftAttempted;
    bool public nftReentrySucceeded;
    bytes4 public nftReentrySelector;
    uint256 public secondListingId;

    constructor() ERC721("Batch Curated Actor", "BCA") {
        _mint(address(this), 1);
        _mint(address(this), 2);
    }

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(581)))));
        balancer.configure(0, 1); // one 0.01 ETH Shape target
        this.approve(address(balancer), 1);
        this.approve(address(balancer), 2);
    }

    function listBatch(bool changeMarkup, bool failSecond) external returns (uint256[] memory ids) {
        callbackMarkup = changeMarkup;
        rejectSecond = failSecond;
        PoolBalancer.CuratedInput[] memory inputs = new PoolBalancer.CuratedInput[](2);
        inputs[0] = PoolBalancer.CuratedInput(address(this), 1, 0.1 ether);
        inputs[1] = PoolBalancer.CuratedInput(address(this), 2, 0.1 ether);
        ids = balancer.listCuratedBatch(inputs);
        secondListingId = ids[1];
    }

    function listOne() external returns (uint256) { return balancer.listCurated(address(this), 1, 0.1 ether); }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function update(uint256 lid, uint256 base) external { balancer.updateCuratedPrice(lid, base); }
    function withdraw(uint256 lid, address to) external { balancer.withdrawCurated(lid, to); }
    function claim(uint256 amount) external { balancer.claimSurplus(amount, address(this)); }
    function enableETHReentry() external { reenterOnETH = true; }
    function enableNFTReentry(uint256 lid) external { secondListingId = lid; reenterOnNFT = true; }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (from == address(this) && to == address(balancer)) {
            if (rejectSecond && tokenId == 2) revert("SecondPullBlocked");
            if (callbackMarkup && !changed && tokenId == 1) {
                changed = true;
                balancer.configure(10_000, 1);
            }
        }
        super.transferFrom(from, to, tokenId);
    }

    receive() external payable {
        if (reenterOnETH) {
            (bool ok, bytes memory reason) = address(balancer).call(
                abi.encodeCall(PoolBalancer.claimSurplus, (1, address(this)))
            );
            ethReentrySucceeded = ok;
            if (reason.length >= 4) ethReentrySelector = bytes4(reason);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (reenterOnNFT) {
            nftAttempted = true;
            (bool ok, bytes memory reason) = address(balancer).call(
                abi.encodeCall(PoolBalancer.withdrawCurated, (secondListingId, address(this)))
            );
            nftReentrySucceeded = ok;
            if (reason.length >= 4) nftReentrySelector = bytes4(reason);
        }
        return this.onERC721Received.selector;
    }
}

contract ReentrantKeeperActor {
    PoolBalancer public balancer;
    bool public attempted;
    bool public reentrySucceeded;
    bytes4 public reentrySelector;

    constructor(PoolBalancer b) { balancer = b; }

    function run() external returns (uint256) { return balancer.performUpkeep(); }

    receive() external payable {
        attempted = true;
        (bool ok, bytes memory reason) = address(balancer).call(
            abi.encodeCall(PoolBalancer.performUpkeep, ())
        );
        reentrySucceeded = ok;
        if (reason.length >= 4) reentrySelector = bytes4(reason);
    }
}

contract SecurityEdgesInformedTest is Test {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    address constant FWA_VRF_SERVICE = 0x7D93Bd9de5dc121992EA4A59E61B2519Fa1Ed65d;
    address constant PLAYER = address(0xB0B);

    BatchCuratedActor actor;
    PoolBalancer balancer;
    IFWAPool pool;

    function setUp() public {
        vm.fee(1 gwei);
        vm.txGasPrice(1.05 gwei);
        assertEq(PLAYER.code.length, 0, "player address has deployed or delegated code");
        vm.deal(address(this), 10 ether);
        vm.deal(PLAYER, 1 ether);
        ShapePackRenderer renderer = new ShapePackRenderer(SHAPES);
        ShapePacks packs = new ShapePacks(SHAPES, address(renderer), address(this), "Pool Prize Packs", "PRIZEPACK", 2);
        PoolBalancer impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, address(packs), ENS);
        BalancerFactory factory = new BalancerFactory(address(impl), address(this));
        actor = new BatchCuratedActor();
        actor.makePool{value: 2 ether}(factory);
        balancer = actor.balancer();
        pool = balancer.pool();
    }

    function testBatchCallbackMixedPricesAndAtomicRollback() public {
        uint256 snapshot = vm.snapshotState();
        vm.expectRevert(bytes("SecondPullBlocked"));
        actor.listBatch(true, true);
        assertEq(actor.ownerOf(1), address(actor), "first transfer survived reverted batch");
        assertEq(actor.ownerOf(2), address(actor));
        assertEq(balancer.markupBps(), 0, "callback config survived reverted batch");
        assertEq(pool.activeListingCount(), 0);
        vm.revertToState(snapshot);

        uint256[] memory ids = actor.listBatch(true, false);
        assertEq(ids.length, 2);
        assertEq(balancer.markupBps(), 10_000);
        (,,,,, uint256 price1,,) = pool.listings(ids[0]);
        (,,,,, uint256 price2,,) = pool.listings(ids[1]);
        assertEq(price1, 0.1 ether, "first pre-callback quote changed");
        assertEq(price2, 0.2 ether, "second post-callback quote changed");
        assertEq(actor.ownerOf(1), address(pool));
        assertEq(actor.ownerOf(2), address(pool));
        actor.open();
        balancer.performUpkeep();
        assertEq(balancer.admissionStatus(), 0);
        console2.log("first batch price wei", price1);
        console2.log("second batch price wei", price2);
    }

    function testRepricingDuringUnsettledDrawRollsBackThenSucceeds() public {
        uint256 lid = actor.listOne();
        actor.open();
        balancer.performUpkeep();
        (uint8 kindBefore,,, uint112 baseBefore, uint112 priceBefore) = balancer.items(lid);
        assertEq(kindBefore, 1);
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 version = pool.inventoryVersion();
        vm.prank(PLAYER);
        uint256 request = pool.acquire{value: total}(PLAYER, fee, 0, 10_000, version, block.timestamp + 1 days);
        assertEq(pool.unsettledAcquisitionCount(), 1);
        vm.expectRevert();
        actor.update(lid, 0.2 ether);
        (,,, uint112 baseAfter, uint112 priceAfter) = balancer.items(lid);
        assertEq(baseAfter, baseBefore, "base mutation escaped FWA revert");
        assertEq(priceAfter, priceBefore);
        (,,,,, uint256 fwaPrice,,) = pool.listings(lid);
        assertEq(fwaPrice, priceBefore);

        vm.roll(block.number + 1);
        uint256 trials = _selectShape(request, lid);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        actor.update(lid, 0.2 ether);
        (,,, uint112 finalBase, uint112 finalPrice) = balancer.items(lid);
        assertEq(finalBase, 0.2 ether);
        assertEq(finalPrice, 0.2 ether);
        (,,,,, uint256 finalFwaPrice,,) = pool.listings(lid);
        assertEq(finalFwaPrice, 0.2 ether);
        console2.log("shape-select word trials", trials);
    }

    function testContractKeeperAndCreatorETHReentryBlocked() public {
        actor.listOne();
        actor.open();
        ReentrantKeeperActor keeper = new ReentrantKeeperActor(balancer);
        uint256 before = address(keeper).balance;
        uint256 reward = keeper.run();
        assertGt(reward, 0);
        assertEq(address(keeper).balance - before, reward);
        assertTrue(keeper.attempted(), "reward callback not reached");
        assertFalse(keeper.reentrySucceeded(), "keeper reentered upkeep");
        assertEq(balancer.getActiveShapes()[0], 1);

        uint256 claimable = balancer.withdrawableSurplus();
        assertGt(claimable, 0);
        uint256 actorBefore = address(actor).balance;
        actor.enableETHReentry();
        actor.claim(claimable);
        assertEq(address(actor).balance - actorBefore, claimable);
        assertFalse(actor.ethReentrySucceeded(), "creator reentered claimSurplus");
        assertEq(address(balancer).balance, balancer.requiredReserve());
        console2.log("keeper reentry selector");
        console2.logBytes4(keeper.reentrySelector());
        console2.log("creator ETH reentry selector");
        console2.logBytes4(actor.ethReentrySelector());
    }

    function testCreatorNFTReceiverCannotReenterSecondWithdrawal() public {
        uint256[] memory ids = actor.listBatch(false, false);
        assertEq(ids.length, 2);
        assertEq(actor.ownerOf(1), address(pool));
        assertEq(actor.ownerOf(2), address(pool));
        actor.enableNFTReentry(ids[1]);
        actor.withdraw(ids[0], address(actor));
        assertEq(actor.ownerOf(1), address(actor), "first NFT did not reach creator receiver");
        assertEq(actor.ownerOf(2), address(pool), "second NFT escaped nested withdrawal");
        assertTrue(actor.nftAttempted(), "FWA did not call ERC721 receiver");
        assertFalse(actor.nftReentrySucceeded(), "NFT callback reentered withdrawal");
        (uint8 firstKind,, uint8 firstState,,) = balancer.items(ids[0]);
        (uint8 secondKind,, uint8 secondState,,) = balancer.items(ids[1]);
        assertEq(firstKind, 0);
        assertEq(firstState, 0);
        assertEq(secondKind, 1);
        assertEq(secondState, 1);
        console2.log("creator NFT reentry selector");
        console2.logBytes4(actor.nftReentrySelector());
    }

    function _selectShape(uint256 request, uint256 curatedId) internal returns (uint256) {
        for (uint256 i = 1; i <= 1_000; ++i) {
            uint256 snap = vm.snapshotState();
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("followup-shape", request, i)));
            vm.prank(FWA_VRF_SERVICE);
            pool.rawFulfillRandomWords(request, words);
            pool.processAcquisitions(5);
            (,,, uint256 chosen, uint8 status,) = pool.acquisitions(request);
            if (status == 2 && chosen != curatedId) return i;
            vm.revertToState(snap);
        }
        fail("shape word not found");
        return 0;
    }
}
