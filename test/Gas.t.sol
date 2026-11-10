// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";

/// @notice Mainnet-fork gas measurements used to set keeper reward bounds (docs/GAS.md).
///         Run: forge test --match-contract GasBench -vv
contract GasBench is ForkBase {
    function setUp() public {
        setUpFork();
        createBalancer(20 ether);
        listCurated(1, 0.3 ether);
        listCurated(2, 0.5 ether);
    }

    function _configure(uint256 p) internal {
        uint256[] memory plans = new uint256[](1);
        plans[0] = p;
        configure(1 ether, 10 ether, 0, plans);
        vm.prank(creator);
        balancer.open();
    }

    function _measureUpkeep(string memory label) internal returns (uint256 used) {
        uint256 g = gasleft();
        upkeep();
        used = g - gasleft();
        emit log_named_uint(label, used);
    }

    function _drawShapes(uint256 n) internal {
        uint256[] memory ids = buy(buyer, n);
        uint256 lastId = lastListingId();
        for (uint256 i; i < n; ++i) {
            (,,,,,, uint256 slot, uint8 st) = pool.listings(lastId - i);
            require(st == 1, "not active");
            fulfill(ids[i], wordForSlot(slot));
        }
        settle();
    }

    function test_gas_initialFill10() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        _measureUpkeep("upkeep: first fill step, 6 Shapes (mint+list)");
    }

    function test_gas_replaceOne() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(1);
        _measureUpkeep("upkeep: reconcile + replace 1 Shape");
    }

    function test_gas_replaceFive() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        _measureUpkeep("upkeep: reconcile + replace 5 Shapes");
    }

    function test_gas_replaceFiveMixed() public {
        _configure(plan([uint256(4), 2, 2, 1, 1, 0, 0, 0, 0]));
        fillUp();
        _drawShapes(5);
        _measureUpkeep("upkeep: reconcile + replace 5 Shapes across 4 denominations");
    }

    function test_gas_refundOnlyRecheckpoint() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        uint256[] memory ids = buy(buyer, 1);
        ids; // never fulfilled: expires after the word deadline and is refunded
        vm.roll(block.number + 40);
        pool.processAcquisitions(1);
        _measureUpkeep("upkeep: reconcile refund-only batch + checkpoint");
    }

    function test_gas_fullListingSet() public {
        // 40 Shapes => 7 upkeeps at MAX_OPS = 6
        _configure(plan([uint256(20), 10, 10, 0, 0, 0, 0, 0, 0]));
        for (uint256 i; i < 7; ++i) {
            _measureUpkeep("upkeep: fill step (<= 6 ops)");
        }
        assertTrue(balancer.canPurchase(buyer));
    }

    function test_gas_purchaseWithOperator() public {
        _configure(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        fillUp();
        (,, uint256 total) = pool.quoteAcquisitionPrice(5);
        uint256 v = pool.inventoryVersion();
        vm.prank(buyer, buyer);
        uint256 g = gasleft();
        pool.acquireBatch{value: total}(buyer, 5, 0, 0, 10_000, v, block.timestamp + 1);
        emit log_named_uint("FWA acquireBatch(5) incl. operator check", g - gasleft());
    }

    function test_gas_createBalancer() public {
        address c = makeAddr("gasCreator");
        vm.prank(c);
        uint256 g = gasleft();
        factory.createBalancer(bytes32(0));
        emit log_named_uint("createBalancer (clone + FWA pool + operator + approval)", g - gasleft());
    }
}
