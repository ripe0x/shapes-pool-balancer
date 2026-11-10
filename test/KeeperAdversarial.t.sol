// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @dev Keeper contract that first clears its own storage (creating EVM refunds in the same transaction), then calls
///      upkeep. The refunds lower the keeper's billed gas; they must not change what the pool pays.
contract RefundingKeeper {
    uint256[64] internal junk;

    function prime() external {
        for (uint256 i; i < 64; ++i) {
            junk[i] = i + 1;
        }
    }

    function run(PoolBalancer b) external returns (uint256 reward) {
        for (uint256 i; i < 64; ++i) {
            junk[i] = 0;
        }
        reward = b.performUpkeep();
    }

    receive() external payable {}
}

/// @notice Attacks on the keeper reward. Each self-dealing test measures the attacker's net result across the whole
///         sequence: rewards - upkeep gas - FWA fee - VRF fee - purchase gas + value of the NFTs received, valued at
///         their FWA listing price (generous to the attacker: the creator's base is lower).
contract KeeperAdversarialTest is ForkBase {
    uint256 constant BASEFEE = 0.05 gwei; // cheap gas favours the attacker
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    address atk = makeAddr("attacker");

    function setUp() public {
        setUpFork();
        vm.deal(atk, 100 ether);
    }

    /// @dev A pool where the edge credit binds: cheap curated NFTs, 0.01 ETH Shapes, no markup.
    function _cheapPool(uint256 curatedCount, uint256 curatedBase, uint256[] memory plans, uint16 minOdds) internal {
        creator = makeAddr(string.concat("cheap", vm.toString(curatedCount), vm.toString(curatedBase), vm.toString(plans.length)));
        vm.deal(creator, 100 ether);
        createBalancer(10 ether);
        for (uint256 i; i < curatedCount; ++i) {
            listCurated(500 + i, curatedBase);
        }
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, minOdds, 0), plans);
        vm.prank(creator);
        balancer.open();
        for (uint256 i; i < 12 && balancer.admissionStatus() != 0; ++i) {
            upkeep();
        }
        assertEq(balancer.admissionStatus(), 0, "pool open");
        vm.fee(BASEFEE);
        vm.txGasPrice(BASEFEE);
    }

    function _one(uint256 p) internal pure returns (uint256[] memory ps) {
        ps = new uint256[](1);
        ps[0] = p;
    }

    /// @dev Attacker buys `count` draws selecting `words`, then runs every upkeep itself. Returns net PnL.
    function _selfDeal(uint256[] memory words) internal returns (int256 pnl) {
        uint256 count = words.length;
        (,, uint256 total) = pool.quoteAcquisitionPrice(count);
        uint256 v = pool.inventoryVersion();
        uint256 g0 = gasleft();
        vm.prank(atk, atk);
        uint256[] memory ids = pool.acquireBatch{value: total}(atk, count, 0, 0, 10_000, v, block.timestamp + 1);
        pnl -= int256(total + (g0 - gasleft()) * BASEFEE);
        // value received: the FWA listing price of every listing the batch actually drew
        uint256[] memory active = balancer.getActiveIds();
        uint256[] memory prices = new uint256[](active.length);
        for (uint256 i; i < active.length; ++i) {
            (,,,,, prices[i],,) = pool.listings(active[i]);
        }
        for (uint256 k; k < count; ++k) {
            fulfill(ids[k], words[k]);
        }
        settle();
        for (uint256 i; i < active.length; ++i) {
            (,,,,,,, uint8 st) = pool.listings(active[i]);
            if (st != 1) pnl += int256(prices[i]);
        }
        vm.recordLogs();
        for (uint256 i; i < 12; ++i) {
            vm.prank(atk, atk);
            uint256 g = gasleft();
            try balancer.performUpkeep() returns (uint256 r) {
                pnl += int256(r) - int256((g - gasleft() + 21_000) * BASEFEE);
            } catch {
                break;
            }
        }
    }

    function _words(uint256 n, uint256 salt) internal pure returns (uint256[] memory w) {
        w = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            w[i] = uint256(keccak256(abi.encode(salt, i)));
        }
    }

    /*////////////////////////////// 1. gas bids and gas limits //////////////////////////////*/

    function test_inflatedBidOrGasLimitDoesNotRaiseReward() public {
        _cheapPool(2, 0.3 ether, _one(plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0])), 0);
        uint256[] memory ids = buy(buyer, 2);
        fulfill(ids[0], uint256(keccak256("a")));
        fulfill(ids[1], uint256(keccak256("b")));
        settle();
        vm.fee(1 gwei);
        uint256 snap = vm.snapshotState();
        vm.txGasPrice(1.05 gwei); // honest: basefee + 0.05 gwei
        vm.prank(keeper, keeper);
        uint256 honest = balancer.performUpkeep{gas: 5_000_000}();
        vm.revertToState(snap);
        vm.txGasPrice(40 gwei); // ApeBall-style overbid and a huge gas limit
        vm.prank(keeper, keeper);
        uint256 greedy = balancer.performUpkeep{gas: 30_000_000}();
        assertEq(greedy, honest, "reward independent of bid above the priority cap and of the gas limit");
    }

    /*////////////////////////////// 3. caller-side refunds //////////////////////////////*/

    function test_callerRefundsDoNotChangePoolPayment() public {
        _cheapPool(2, 0.3 ether, _one(plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0])), 0);
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], uint256(keccak256("c")));
        settle();
        RefundingKeeper rk = new RefundingKeeper();
        rk.prime();
        uint256 snap = vm.snapshotState();
        vm.prank(keeper, keeper);
        uint256 plain = balancer.performUpkeep();
        vm.revertToState(snap);
        uint256 viaRefunds = rk.run(balancer);
        // Within a few hundred gas of measurement difference (warm/cold context), not the ~300k of refunds created.
        assertApproxEqAbs(viaRefunds, plain, 1_000 * BASEFEE + 1, "pool pays for its own work only");
    }

    /*////////////////////////////// 4-7. self-dealing //////////////////////////////*/

    function test_selfDealingSingleDrawCheapPool() public {
        _cheapPool(3, 0.001 ether, _one(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0])), 0);
        int256 pnl = _selfDeal(_words(1, 1));
        emit log_named_decimal_int("single cheap draw PnL (ETH)", pnl, 18);
        assertLe(pnl, 0);
    }

    function test_selfDealingRepeatedLowValuePurchases() public {
        _cheapPool(3, 0.001 ether, _one(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0])), 0);
        int256 total;
        uint256 batches;
        for (uint256 i; i < 10; ++i) {
            // an honest creator restocks cheap curated NFTs as they are drawn (worst case for the pool)
            while (balancer.admissionStatus() != 0) {
                listCurated(700 + i * 10 + batches, 0.001 ether);
                upkeep();
            }
            vm.fee(BASEFEE);
            vm.txGasPrice(BASEFEE);
            total += _selfDeal(_words(1 + (i % 5), 100 + i));
            ++batches;
        }
        emit log_named_uint("self-dealt batches", batches);
        emit log_named_decimal_int("cumulative PnL (ETH)", total, 18);
        assertEq(batches, 10, "every batch ran");
        assertLe(total, 0);
    }

    function test_selfDealingDrainsOnlyCheapCurated() public {
        uint256[] memory ps = _one(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        _cheapPool(1, 0.0001 ether, ps, 0);
        uint256[] memory w = new uint256[](1);
        w[0] = 1; // slot 1: the cheap curated NFT; the pool closes NO_CURATED afterwards
        int256 pnl = _selfDeal(w);
        emit log_named_decimal_int("drain the only cheap curated NFT, PnL (ETH)", pnl, 18);
        assertLe(pnl, 0);
    }

    function test_selfDealingForcedPlanSwitch() public {
        uint256[] memory ps = new uint256[](2);
        ps[0] = plan([uint256(40), 0, 0, 0, 0, 0, 0, 0, 0]);
        ps[1] = plan([uint256(1), 0, 0, 0, 0, 0, 0, 0, 0]);
        creator = makeAddr("switchAtk");
        vm.deal(creator, 100 ether);
        createBalancer(10 ether);
        listCurated(600, 0.0001 ether);
        listCurated(601, 0.5 ether);
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, 10, 0), ps);
        vm.prank(creator);
        balancer.open();
        for (uint256 i; i < 12 && balancer.admissionStatus() != 0; ++i) {
            upkeep();
        }
        vm.fee(BASEFEE);
        vm.txGasPrice(BASEFEE);
        uint256[] memory w = new uint256[](1);
        w[0] = 1; // the cheap curated NFT: forces a 39-Shape redemption over several calls
        int256 pnl = _selfDeal(w);
        assertEq(balancer.activePlan(), 1, "switched");
        emit log_named_decimal_int("forced plan switch, PnL across all follow-up calls (ETH)", pnl, 18);
        assertLe(pnl, 0);
    }

    /*////////////////////////////// 8-10. creator-caused work //////////////////////////////*/

    /// Repricing is creator-only and admission stays closed until it completes, so no purchase can create it or
    /// coincide with it.
    function test_noPurchasesDuringRepricing() public {
        _cheapPool(2, 0.3 ether, _one(plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0])), 0);
        vm.prank(creator);
        balancer.configure(PoolBalancer.Config(1 ether, 0, 2500), _one(plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0])));
        assertTrue(balancer.creatorWork());
        assertFalse(balancer.canPurchase(atk));
        upkeep();
        assertTrue(balancer.repricing() || balancer.canPurchase(atk));
        if (balancer.repricing()) assertFalse(balancer.canPurchase(atk));
    }

    /// A creator deposit while open never enables full incentives for purchase-caused work.
    function test_depositDoesNotUnlockFullIncentive() public {
        _cheapPool(3, 0.001 ether, _one(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0])), 0);
        vm.prank(creator);
        balancer.depositETH{value: 1 ether}();
        vm.prank(atk);
        balancer.depositETH{value: 1 wei}();
        assertFalse(balancer.creatorWork());
        int256 pnl = _selfDeal(_words(1, 7));
        assertLe(pnl, 0);
    }

    /// Accepted (I-6): a batch bought before a creator action that closes admission is reconciled with the full
    /// incentive. The buyer cannot cause or time the creator action; the extra is at most one incentive.
    function test_creatorActionDuringOutstandingBatchBound() public {
        _cheapPool(3, 0.001 ether, _one(plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0])), 0);
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.prank(atk, atk);
        uint256[] memory ids = pool.acquireBatch{value: total}(atk, 1, 0, 0, 10_000, v, block.timestamp + 1);
        fulfill(ids[0], uint256(keccak256("i6")));
        settle();
        vm.prank(creator);
        balancer.close(); // creator action: sets creator work
        vm.recordLogs();
        vm.prank(atk, atk);
        uint256 reward = balancer.performUpkeep();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 gasPaid;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
        }
        assertLe(reward - gasPaid * BASEFEE, 0.0005 ether + (gasPaid / 4 + 21_000) * BASEFEE + 0.0001 ether, "at most one incentive");
    }
}
