// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "solady/tokens/ERC721.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

interface IPoolRefunds {
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256 amount);
    function DELIVERY_WINDOW() external view returns (uint256);
}

/// @notice A creator-controlled ERC-721 that behaves while it is listed and turns hostile once armed. This is the
///         untrusted third party the system accepts by design (any collection a creator lists), not a stand-in for a
///         party the system relies on.
contract HostileCollection is ERC721 {
    enum Mode {
        Honest,
        RefuseDelivery, // refuses transfers out of the FWA pool, except back to its owner side (recovery works)
        RefuseAll, // refuses every transfer out of the FWA pool, recovery included
        Paused, // refuses every transfer while paused
        Seize // transfers work; the owner can take any token back from anyone afterwards
    }

    address public immutable owner;
    address public pool;
    address public ownerSide; // the creator's Balancer, which FWA's recovery pays
    Mode public mode;

    constructor() {
        owner = msg.sender;
    }

    function name() public pure override returns (string memory) {
        return "Hostile";
    }

    function symbol() public pure override returns (string memory) {
        return "HOST";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        require(msg.sender == owner);
        _mint(to, id);
    }

    function arm(Mode m, address pool_, address ownerSide_) external {
        require(msg.sender == owner);
        (mode, pool, ownerSide) = (m, pool_, ownerSide_);
    }

    function seize(uint256 id, address to) external {
        require(msg.sender == owner && mode == Mode.Seize);
        _transfer(ownerOf(id), to, id);
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        if (from == address(0)) return;
        Mode m = mode;
        if (m == Mode.Paused) revert("paused");
        if (from != pool) return;
        if (m == Mode.RefuseAll) revert("refused");
        // the pool's recovery sends the token to its owner, the Balancer; a winner is anyone else
        if (m == Mode.RefuseDelivery && to != ownerSide) revert("refused");
    }
}

/// @notice Audit rc-ec5259c finding 8: a curated collection the creator controls, through the real FWA pool, randomness
///         service and Shapes on the pinned mainnet fork. For each variant: where the NFT, the player's payment and the
///         randomness fee end up, and what the player who "wins" it gets.
contract HostileCollectionTest is ForkBase {
    GasProbe probe;
    HostileCollection hostile;
    uint256 nftListing;
    uint256 constant ID = 1;
    uint256 constant VALUE = 0.2 ether;
    uint256 gasPrice;

    // what the winning player experienced
    uint256 paid; // draw price + randomness fee
    uint256 vrfFee;

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
        probe.record();
        gasPrice = probe.gasPrice();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee inside a transaction");
        assertEq(gasPrice, 1 gwei, "gas price inside a transaction");
    }

    /// @dev Ten 0.01 Shapes and one hostile NFT (behaving at listing), open and stocked.
    function _open() internal {
        createBalancer(5 ether);
        configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.startPrank(creator);
        hostile = new HostileCollection();
        hostile.mint(creator, ID);
        hostile.approve(address(balancer), ID);
        nftListing = balancer.listCurated(address(hostile), ID, VALUE);
        balancer.open();
        vm.stopPrank();
        fillUp();
        assertEq(hostile.ownerOf(ID), address(pool), "listed: FWA holds the NFT");
    }

    function _arm(HostileCollection.Mode m) internal {
        vm.prank(creator);
        hostile.arm(m, address(pool), address(balancer));
    }

    /// @dev The buyer draws once and the word selects the NFT.
    function _winNft() internal {
        (, uint256 vrf, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 before = buyer.balance;
        uint256 version = pool.inventoryVersion(); // read before the prank, which the next call consumes
        vm.prank(buyer, buyer);
        uint256[] memory ids = pool.acquireBatch{value: total}(buyer, 1, 0, 0, 10_000, version, block.timestamp + 1);
        paid = before - buyer.balance;
        vrfFee = vrf;
        assertEq(paid, total, "the player paid the quote");
        (,,,,,, uint256 slot,) = pool.listings(nftListing);
        fulfill(ids[0], wordForSlot(slot));
        settle();
    }

    function _status() internal view returns (uint8 st) {
        (,,,,,,, st) = pool.listings(nftListing);
    }

    function _log(string memory what) internal {
        emit log(what);
        emit log_named_address("  NFT owner", hostile.ownerOf(ID));
        emit log_named_uint("  FWA listing status", _status());
        emit log_named_decimal_uint("  player paid (draw + randomness fee)", paid, 18);
        emit log_named_decimal_uint("  of which randomness fee", vrfFee, 18);
        emit log_named_decimal_uint("  player refund credit at FWA", IPoolRefunds(address(pool)).acquisitionRefundCredit(buyer), 18);
        emit log_named_decimal_uint("  owner proceeds at FWA", pool.ownerProceeds(), 18);
    }

    /// Refuses delivery, the player takes the refund after 7 days, the creator recovers the NFT.
    function test_refuseDelivery_playerRefunded_creatorRecovers() public {
        _open();
        _arm(HostileCollection.Mode.RefuseDelivery);
        uint256 proceeds0 = pool.ownerProceeds();
        _winNft();
        assertEq(_status(), 6, "reached: FWA marked the delivery pending (failed)");
        assertEq(hostile.ownerOf(ID), address(pool), "FWA still holds the NFT");
        assertEq(pool.ownerProceeds(), proceeds0, "no proceeds for an undelivered prize");
        vm.expectRevert();
        pool.retryNFTDelivery(nftListing); // anyone may retry; the collection still refuses
        _log("refused, before the deadline");

        vm.warp(block.timestamp + IPoolRefunds(address(pool)).DELIVERY_WINDOW());
        vm.prank(buyer);
        pool.refundFailedDelivery(nftListing);
        uint256 credit = IPoolRefunds(address(pool)).acquisitionRefundCredit(buyer);
        uint256 b0 = buyer.balance;
        vm.prank(buyer, buyer);
        IPoolRefunds(address(pool)).withdrawAcquisitionRefund();
        assertEq(buyer.balance - b0, credit, "refund paid");
        assertEq(paid - credit, vrfFee, "the player lost exactly the randomness fee (plus gas and 7 days)");

        upkeep(); // the Balancer marks the item pending
        vm.prank(creator);
        balancer.recoverRefunded(nftListing, creator);
        assertEq(hostile.ownerOf(ID), creator, "the creator has the NFT back");
        _log("after refund and recovery");
    }

    /// Same, but the player never asks for the refund: the NFT and the payment stay at FWA, the creator cannot recover.
    function test_refuseDelivery_playerNeverRefunds() public {
        _open();
        _arm(HostileCollection.Mode.RefuseDelivery);
        _winNft();
        vm.warp(block.timestamp + 30 days);
        upkeep();
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.InvalidItem.selector);
        balancer.recoverRefunded(nftListing, creator);
        assertEq(hostile.ownerOf(ID), address(pool), "the NFT stays at FWA");
        assertEq(IPoolRefunds(address(pool)).acquisitionRefundCredit(buyer), 0, "nothing credited until the player acts");
        _log("player never refunds (30 days)");
    }

    /// Refuses delivery and recovery: the player is refunded, the NFT is stuck at FWA for good (the creator's loss).
    function test_refuseAll_nftStuck() public {
        _open();
        _arm(HostileCollection.Mode.RefuseAll);
        _winNft();
        vm.warp(block.timestamp + IPoolRefunds(address(pool)).DELIVERY_WINDOW());
        vm.prank(buyer);
        pool.refundFailedDelivery(nftListing);
        upkeep();
        vm.prank(creator);
        vm.expectRevert();
        balancer.recoverRefunded(nftListing, creator);
        assertEq(hostile.ownerOf(ID), address(pool), "stuck at FWA");
        assertEq(paid - IPoolRefunds(address(pool)).acquisitionRefundCredit(buyer), vrfFee, "player loses the randomness fee");
        _log("refuses delivery and recovery");
    }

    /// Paused at the win, unpaused inside the window: anyone's retry delivers, proceeds are credited.
    function test_paused_thenRetried() public {
        _open();
        _arm(HostileCollection.Mode.Paused);
        uint256 proceeds0 = pool.ownerProceeds();
        _winNft();
        assertEq(_status(), 6, "reached: delivery failed while paused");
        _arm(HostileCollection.Mode.Honest);
        pool.retryNFTDelivery(nftListing);
        assertEq(hostile.ownerOf(ID), buyer, "delivered on retry");
        assertGt(pool.ownerProceeds(), proceeds0, "proceeds credited on delivery");
        _log("paused, then retried");
    }

    /// Delivery succeeds, proceeds are credited, then the creator takes the NFT back from the winner.
    function test_seize_afterDelivery() public {
        _open();
        _arm(HostileCollection.Mode.Seize);
        uint256 proceeds0 = pool.ownerProceeds();
        _winNft();
        assertEq(hostile.ownerOf(ID), buyer, "reached: delivered to the winner");
        uint256 credited = pool.ownerProceeds() - proceeds0;
        assertGt(credited, 0, "FWA credited the draw to the pool owner");
        vm.prank(creator);
        hostile.seize(ID, creator);
        assertEq(hostile.ownerOf(ID), creator, "the creator took it back");
        emit log_named_decimal_uint("  proceeds credited to the Balancer for this draw", credited, 18);
        _log("seized after delivery");
    }
}
