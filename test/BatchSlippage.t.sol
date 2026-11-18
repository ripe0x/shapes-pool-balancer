// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface IBatchSlippagePool {
    function selectionSlippageBps() external view returns (uint256);
    function acquisitionRefundCredit(address purchaser) external view returns (uint256);
    function withdrawAcquisitionRefund() external returns (uint256);
    function acquisitionEscrowTotal() external view returns (uint256);
    function deliveryEscrowTotal() external view returns (uint256);
}

interface IBatchSlippageService {
    function requestStatus(uint256 requestId) external view returns (uint8);
}

/// @notice A controlled real-FWA comparison, not a signed-node or demand experiment. Both paths start from the same
///         snapshot and use the same five words through the owner-retained real-coordinator exception.
contract BatchSlippageTest is ForkBase {
    uint256 internal constant BASE = 0.08 gwei;
    uint256 internal constant BID = 0.08 gwei;
    uint256 internal constant VRF_PER_DRAW = 0.0001872 ether; // Real service: 2,340,000 gas at the asserted bid.
    uint256 internal constant WORD = 6e18; // Exactly after the two curated listings' actual inverse-price weights.
    bytes32 internal constant VRF_PAID = keccak256("VrfServiceFeePaid(address,uint256)");
    bytes32 internal constant SLIPPAGE_REFUND =
        keccak256("AcquisitionRefundedSlippage(uint256,address,uint256,uint256,uint256)");
    GasProbe internal probe;

    struct Result {
        uint256 fulfilled;
        uint256 refunded;
        uint256 refund;
        uint256 vrf;
        uint256 vrfEvents;
    }

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
        _context();
        assertEq(shapes.mintFee(), 0.001 ether, "actual deployed Shapes mint fee");
        createBalancer(3 ether);
        uint256[9] memory counts;
        counts[0] = 5;
        counts[1] = 3;
        counts[2] = 2;
        configure(plan(counts));
        // These are creator-issued, untrusted prize NFTs, not substitutes for FWA, Shapes or its price/random source.
        listCurated(1, 0.25 ether);
        listCurated(2, 0.5 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        _assertFull();
        assertEq(IBatchSlippagePool(address(pool)).selectionSlippageBps(), 1_000);
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,, uint112 price) = balancer.items(ids[i]);
            if (kind != 2) continue;
            uint256 backing = balancer.denominationAmount(d);
            assertEq(uint256(price), backing + 0.001 ether + backing * 1500 / 10_000 + 0.000317 ether,
                "actual listing price includes distinct markup and V1 surcharge at 0.08 basefee");
        }
    }

    function test_sameWordsBatchRefundsButSequentialRestockedDrawsDeliver() public {
        uint256 snapshot = vm.snapshotState();
        uint256 initialLiquid = address(balancer).balance;
        uint256 initialBuyer = buyer.balance;
        uint256 quote = pool.acquisitionFee();
        uint256 firstCheap = _assertWordSelectsCheapShape();

        _context();
        vm.recordLogs();
        uint256[] memory batched = buy(buyer, 5);
        for (uint256 i; i < 5; ++i) {
            _context();
            fulfill(batched[i], WORD);
        }
        settle();
        Result memory batch = _outcomes(batched);
        _checkLogs(batch);
        (,,, uint256 won,,) = pool.acquisitions(batched[0]);
        assertEq(won, firstCheap, "the first batch draw really removed the cheap Shape");
        assertEq(batch.fulfilled, 1);
        assertEq(batch.refunded, 4, "subsequent draws hit real FWA's positive-price guard");
        assertEq(batch.refund, 4 * quote);
        assertEq(batch.vrf, 5 * VRF_PER_DRAW);
        assertEq(batch.vrfEvents, 1, "one real five-request purchase");
        _withdrawRefund(batch.refund);
        assertEq(initialBuyer - buyer.balance, quote + 5 * VRF_PER_DRAW,
            "principal net of actual refund still includes every nonrefundable VRF charge, excluding actor gas");
        _context();
        fillUp();
        _assertFull();

        assertTrue(vm.revertToState(snapshot), "restore the identical funded board, wallets and protocol state");
        assertEq(address(balancer).balance, initialLiquid);
        assertEq(buyer.balance, initialBuyer);
        assertEq(pool.lastIssuedSequence(), 0);
        assertEq(pool.acquisitionFee(), quote);
        _assertFull();
        uint256[] memory singles = new uint256[](5);
        vm.recordLogs();
        for (uint256 i; i < 5; ++i) {
            _context();
            _assertWordSelectsCheapShape();
            assertEq(pool.acquisitionFee(), quote, "full restock restores the same independently quoted board price");
            singles[i] = buy(buyer, 1)[0];
            _context();
            fulfill(singles[i], WORD);
            settle();
            _assertDelivered(singles[i]);
            uint256 keeperBefore = keeper.balance;
            _context();
            fillUp();
            assertGt(keeper.balance, keeperBefore, "real paid reconciliation and restocking, not harness topups");
            _assertFull();
        }
        Result memory sequential = _outcomes(singles);
        _checkLogs(sequential);
        assertEq(sequential.fulfilled, 5);
        assertEq(sequential.refunded, 0);
        assertEq(sequential.refund, 0);
        assertEq(sequential.vrf, 5 * VRF_PER_DRAW);
        assertEq(sequential.vrfEvents, 5, "each single draw really paid for a fresh request");
        assertEq(initialBuyer - buyer.balance, 5 * (quote + VRF_PER_DRAW));
        assertEq(IBatchSlippagePool(address(pool)).acquisitionRefundCredit(buyer), 0);
        assertEq(IBatchSlippagePool(address(pool)).selectionSlippageBps(), 1_000,
            "purchaser protection was never loosened");
        assertEq(pool.ownerProceeds(), 0, "actual paid upkeep collected completed proceeds");
        emit log_named_uint("fork block", FORK_BLOCK);
        emit log_named_uint("batch fulfilled / five requests", batch.fulfilled);
        emit log_named_uint("sequential fulfilled / five requests", sequential.fulfilled);
        emit log_named_decimal_uint("VRF spent on the four batch refunds", 4 * VRF_PER_DRAW, 18);
        emit log_named_decimal_uint("VRF paid in each five-draw path", sequential.vrf, 18);
    }

    function _context() internal {
        vm.fee(BASE);
        vm.txGasPrice(BID);
        probe.record();
        assertEq(probe.baseFee(), BASE, "actual state-changing call basefee");
        assertEq(probe.gasPrice(), BID, "actual state-changing call bid");
    }

    function _outcomes(uint256[] memory requests) internal view returns (Result memory r) {
        for (uint256 i; i < requests.length; ++i) {
            assertEq(IBatchSlippageService(VRF_SERVICE).requestStatus(requests[i]), 4,
                "the real service delivered every original authenticated word");
            (,, uint256 escrow,, uint8 status,) = pool.acquisitions(requests[i]);
            if (status == 2) {
                ++r.fulfilled;
                _assertDelivered(requests[i]);
            } else {
                assertEq(status, 4, "no expiry, missing randomness or failed delivery accepted as slippage");
                ++r.refunded;
                r.refund += escrow;
            }
        }
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(IBatchSlippagePool(address(pool)).acquisitionEscrowTotal(), 0);
        assertEq(IBatchSlippagePool(address(pool)).deliveryEscrowTotal(), 0);
    }

    function _checkLogs(Result memory r) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 refunded;
        uint256 amount;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] == VRF_PAID) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), buyer);
                r.vrf += abi.decode(logs[i].data, (uint256));
                ++r.vrfEvents;
            } else if (logs[i].topics[0] == SLIPPAGE_REFUND) {
                assertEq(address(uint160(uint256(logs[i].topics[2]))), buyer);
                (uint256 refund, uint256 escrow, uint256 live) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256));
                assertEq(refund, escrow);
                assertGt(live, escrow + escrow / 10, "actual positive drift exceeded unchanged 10% guard");
                ++refunded;
                amount += refund;
            }
        }
        assertEq(refunded, r.refunded, "actual FWA slippage events match every refund");
        assertEq(amount, r.refund);
    }

    function _withdrawRefund(uint256 amount) internal {
        IBatchSlippagePool more = IBatchSlippagePool(address(pool));
        assertEq(more.acquisitionRefundCredit(buyer), amount);
        uint256 before = buyer.balance;
        _context();
        vm.prank(buyer, buyer);
        assertEq(more.withdrawAcquisitionRefund(), amount);
        assertEq(buyer.balance - before, amount, "real purchaser refund round trip");
        assertEq(more.acquisitionRefundCredit(buyer), 0);
    }

    function _assertDelivered(uint256 request) internal view {
        (address purchaser,,, uint256 lid, uint8 status,) = pool.acquisitions(request);
        assertEq(purchaser, buyer);
        assertEq(status, 2);
        (address collection,,, uint256 tokenId,,,, uint8 listingStatus) = pool.listings(lid);
        assertEq(listingStatus, 4);
        assertEq(collection, SHAPES, "the chosen word won a real backed Shape");
        assertEq(IERC721Min(collection).ownerOf(tokenId), buyer, "actual prize ownership");
    }

    function _assertFull() internal view {
        uint16[16] memory have = balancer.getActiveShapes();
        assertEq(have[0], 5);
        assertEq(have[1], 3);
        assertEq(have[2], 2);
        assertEq(balancer.listedShapePrizes(), 10);
        assertEq(pool.activeListingCount(), 12);
        assertEq(pool.unsettledAcquisitionCount(), 0);
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence());
        assertEq(balancer.admissionStatus(), 0);
        uint256 backing;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            (address collection,,, uint256 tokenId,,,, uint8 status) = pool.listings(ids[i]);
            assertEq(status, 1);
            assertEq(IERC721Min(collection).ownerOf(tokenId), address(pool));
            if (kind == 2) backing += shapes.backingOf(tokenId);
        }
        assertEq(backing, 0.4 ether, "actual remaining Shape backing, not unsold fees");
    }

    function _assertWordSelectsCheapShape() internal view returns (uint256 lid) {
        uint256 firstSlot = type(uint256).max;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(ids[i]);
            (,,,,,, uint256 slot, uint8 status) = pool.listings(ids[i]);
            if (kind == 2 && d == 0 && status == 1 && slot < firstSlot) {
                firstSlot = slot;
                lid = ids[i];
            }
        }
        assertGt(lid, 0);
        assertEq(wordForSlot(firstSlot), WORD, "same precommitted word selects a cheap Shape in both paths");
    }
}
