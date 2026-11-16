// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";

interface IReservedListings {
    function reservedListingCount(uint64 sequence) external view returns (uint256);
}

/// @notice Launch audit B, S1 (owner decision D16): a draw whose request reserved a staged restock skips FWA's randomness
///         fast path and waits for `processAcquisitions`. Only players, the randomness service and the keeper act here:
///         the test never processes FWA's queue itself. Upkeep must process it. Fails on the contract before D16 (draws
///         stay unsettled and sales stop at BUSY). Mainnet fork, real FWA pool, randomness service and Shapes.
contract ProcessQueueTest is ForkBase {

    function setUp() public {
        setUpFork();
        vm.txGasPrice(0.55 gwei); // a keeper bids basefee + the 0.05 gwei the Balancer reimburses
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee inside a transaction");
        assertEq(probe.gasPrice(), 0.55 gwei, "gas price inside a transaction");
        vm.deal(stranger, 100 ether);
    }

    function _keeper() internal {
        vm.prank(keeper, keeper);
        try balancer.performUpkeep() {} catch {}
    }

    function test_upkeepSettlesDrawsThatReservedAStagedRestock() public {
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1); // the launch board
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        assertEq(balancer.admissionStatus(), 0, "open");

        uint256 reserved;
        uint256 refused;
        uint256 nft = 1;
        for (uint256 i; i < 40; ++i) {
            if (balancer.admissionStatus() == 3) listCurated(++nft, 0.2 ether); // an NFT was won: the creator relists
            if (!balancer.canPurchase(buyer)) {
                ++refused;
                _keeper();
                continue;
            }
            uint256[] memory a = buy(buyer, 1);
            _keeper(); // runs while that draw is in flight: earlier wins' restocks are staged
            uint256[] memory b;
            if (balancer.canPurchase(stranger)) {
                b = buy(stranger, 1); // a second player, while the first draw is unsettled
                if (IReservedListings(address(pool)).reservedListingCount(pool.lastIssuedSequence()) != 0) ++reserved;
            }
            fulfill(a[0], uint256(keccak256(abi.encode("a", i))));
            if (b.length != 0) fulfill(b[0], uint256(keccak256(abi.encode("b", i))));
            // nobody touches FWA's queue; the keeper's next upkeep comes with the next player
        }
        assertGt(reserved, 0, "reached: draws reserved a staged restock and lost the randomness fast path");
        // keepers alone settle everything that has its randomness; with --isolate each call is its own transaction, so
        // the keeper's real cost (billed gas after refunds, plus 21,000) can be set against its reward
        for (uint256 k; k < 10 && pool.unsettledAcquisitionCount() != 0; ++k) {
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            vm.recordLogs();
            try balancer.performUpkeep() returns (uint256 reward) {
                Vm.Log[] memory logs = vm.getRecordedLogs();
                for (uint256 q; q < logs.length; ++q) {
                    if (logs[q].topics[0] == keccak256("KeeperPaid(address,uint256,uint256)")) {
                        (, uint256 measured) = abi.decode(logs[q].data, (uint256, uint256));
                        emit log_named_uint("  measured inside performUpkeep", measured);
                    }
                    if (logs[q].topics[0] == keccak256("AcquisitionFulfilled(uint256,uint256,address)")) emit log("  a draw settled");
                }
                (bool ok, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
                require(ok, "lastCallGas");
                (, uint64 used,,,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
                assertEq(keeper.balance - before, reward, "paid");
                emit log_named_uint("processing upkeep: reward (wei)", reward);
                emit log_named_uint("  billed gas incl. 21000", uint256(used) + 21_000);
                int256 margin = int256(reward) - int256((uint256(used) + 21_000) * 0.55 gwei);
                emit log_named_int("  keeper margin over billed gas (wei)", margin);
                assertGe(margin, 0, "a processing upkeep pays the keeper at least its billed gas");
            } catch {}
        }
        assertEq(pool.unsettledAcquisitionCount(), 0, "upkeep processed FWA's queue");
        assertEq(balancer.reconciledSequence(), pool.lastIssuedSequence(), "and reconciled every draw");
        assertEq(balancer.admissionStatus(), 0, "sales open");
        emit log_named_uint("draws that reserved a staged restock", reserved);
        emit log_named_uint("purchase attempts refused along the way", refused);
    }
}
