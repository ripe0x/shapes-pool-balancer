// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Bid comparisons use each call's measured span and billed expense because EVM gas changes can alter a few measured units.

import {Vm} from "forge-std/Test.sol";
import {ReceiptGas} from "./utils/ReceiptGas.sol";
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

    function run(PoolBalancer b, bytes32 settingsHash) external returns (uint256 reward) {
        for (uint256 i; i < 64; ++i) {
            junk[i] = 0;
        }
        reward = b.performUpkeep(settingsHash, 0, 0);
    }

    receive() external payable {}
}

/// @notice Attacks on the keeper reward. Each self-dealing test measures the attacker's net result across the whole
///         sequence: rewards - upkeep gas - FWA fee - VRF fee - purchase gas + value of the prizes received: a Shape or
///         pack at the ETH it redeems for, a curated NFT at its FWA listing price (generous to the attacker: the
///         creator's base is lower).
contract KeeperAdversarialTest is ForkBase {
    uint256 constant BASEFEE = 0.05 gwei; // cheap gas favours the attacker
    bytes32 constant KEEPER_PAID = keccak256("KeeperPaid(address,uint256,uint256)");
    address atk = makeAddr("attacker");

    function setUp() public {
        setUpFork();
        vm.deal(atk, 100 ether);
    }

    /// @dev A pool where the edge credit binds: cheap curated NFTs, 0.01 ETH Shapes, no markup.
    function _cheapPool(uint256 curatedCount, uint256 curatedBase, uint256 target) internal {
        creator = makeAddr(string.concat("cheap", vm.toString(curatedCount), vm.toString(curatedBase), vm.toString(target)));
        vm.deal(creator, 100 ether);
        createBalancer(10 ether);
        vm.startPrank(creator);
        balancer.configure(1000, target, shapes.mintFee());
        vm.stopPrank();
        for (uint256 i; i < curatedCount; ++i) {
            listCurated(500 + i, curatedBase);
        }
        vm.prank(creator);
        balancer.open();
        for (uint256 i; i < 16 && balancer.admissionStatus() != 0; ++i) {
            upkeep();
        }
        assertEq(balancer.admissionStatus(), 0, "pool open");
        vm.fee(BASEFEE);
        vm.txGasPrice(BASEFEE);
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
        uint256[] memory active = balancer.getActiveIds();
        uint256[] memory prices = new uint256[](active.length);
        for (uint256 i; i < active.length; ++i) {
            (uint8 kind, uint8 d,,,) = balancer.items(active[i]);
            if (kind == 2) prices[i] = _backing(d);
            else (,,,,, prices[i],,) = pool.listings(active[i]);
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
            bytes32 uh1 = balancer.settingsHash();
            vm.prank(atk, atk);
            uint256 g = gasleft();
            try balancer.performUpkeep(uh1, 0, 0) returns (uint256 r) {
                pnl += int256(r) - int256((g - gasleft() + 21_000) * BASEFEE);
            } catch {
                break;
            }
        }
    }

    /// @dev ETH a prize of size `d` redeems for (PoolBalancer's size table).
    function _backing(uint8 d) internal pure returns (uint256) {
        uint256[16] memory v = [uint256(0.01 ether), 0.05 ether, 0.1 ether, 0.5 ether, 1 ether, 5 ether, 10 ether,
            50 ether, 100 ether, 0.02 ether, 0.03 ether, 0.2 ether, 0.25 ether, 2 ether, 2.5 ether, 25 ether];
        return v[d];
    }

    function _words(uint256 n, uint256 salt) internal pure returns (uint256[] memory w) {
        w = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            w[i] = uint256(keccak256(abi.encode(salt, i)));
        }
    }

    /*////////////////////////////// 1. gas bids and gas limits //////////////////////////////*/

    function test_inflatedBidOrGasLimitDoesNotRaiseReward() public {
        _cheapPool(2, 0.3 ether, plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        uint256[] memory ids = buy(buyer, 2);
        fulfill(ids[0], uint256(keccak256("a")));
        fulfill(ids[1], uint256(keccak256("b")));
        settle();
        vm.fee(1 gwei);
        uint256 snap = vm.snapshotState();
        (uint256 honest,uint256 honestBilled,uint256 honestMeasured,uint256 honestUnits)=_sample(5_000_000,1.05 gwei);
        vm.revertToState(snap);
        (uint256 greedy,uint256 greedyBilled,uint256 greedyMeasured,uint256 greedyUnits)=_sample(15_000_000,40 gwei);
        assertEq(honestUnits,greedyUnits,"same objectively completed work");
        assertEq(honest,(honestMeasured+V1_OVERHEAD)*1.05 gwei+honestUnits*0.00002 ether);
        assertEq(greedy,(greedyMeasured+V1_OVERHEAD)*1.05 gwei+greedyUnits*0.00002 ether,"actual measured span uses identical capped reference");
        assertLt(int256(greedy)-int256(greedyBilled*40 gwei),int256(honest)-int256(honestBilled*1.05 gwei),"overbidding cannot improve the caller's full economics");
    }

    function _sample(uint256 gasLimit,uint256 bid) internal returns(uint256 reward,uint256 billed,uint256 measured,uint256 units) {
        vm.txGasPrice(bid);
        bytes32 generation=balancer.settingsHash();
        uint256 sequence=balancer.reconciledSequence();
        vm.recordLogs();
        vm.prank(keeper,keeper);reward=balancer.performUpkeep{gas:gasLimit}(generation, 0, 0);
        billed=ReceiptGas.lastBilled();
        Vm.Log[] memory logs=vm.getRecordedLogs();
        units=balancer.reconciledSequence()-sequence;
        for(uint256 i;i<logs.length;++i)if(logs[i].emitter==address(balancer)) {
            if(logs[i].topics[0]==KEEPER_PAID)(,measured)=abi.decode(logs[i].data,(uint256,uint256));
            if(logs[i].topics[0]==keccak256("ShapesMinted(uint8,uint256,uint256,uint256)")) {
                (,uint256 quantity,)=abi.decode(logs[i].data,(uint256,uint256,uint256));units+=quantity;
            }
        }
        assertLt(measured,3_200_000,"reached sample is below V1 measured cap");
    }

    /*////////////////////////////// 3. caller-side refunds //////////////////////////////*/

    function test_callerRefundsDoNotChangePoolPayment() public {
        _cheapPool(2, 0.3 ether, plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        uint256[] memory ids = buy(buyer, 1);
        fulfill(ids[0], uint256(keccak256("c")));
        settle();
        RefundingKeeper rk = new RefundingKeeper();
        rk.prime();
        bytes32 uh4 = balancer.settingsHash();
        uint256 snap = vm.snapshotState();
        vm.prank(keeper, keeper);
        uint256 plain = balancer.performUpkeep(uh4, 0, 0);
        vm.revertToState(snap);
        uint256 viaRefunds = rk.run(balancer, uh4);
        assertApproxEqAbs(viaRefunds, plain, 1_000 * BASEFEE + 1, "pool pays for its own work only");
    }

    /*////////////////////////////// 4-7. self-dealing //////////////////////////////*/

    function test_selfDealingSingleDrawCheapPool() public {
        _cheapPool(3, 0.001 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        int256 pnl = _selfDeal(_words(1, 1));
        emit log_named_decimal_int("single cheap draw PnL (ETH)", pnl, 18);
        assertLe(pnl, 0);
    }

    function test_selfDealingRepeatedLowValuePurchases() public {
        _cheapPool(3, 0.001 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        int256 total;
        uint256 batches;
        for (uint256 i; i < 10; ++i) {
            // an honest creator restocks cheap curated NFTs as they are drawn (worst case for the pool)
            while (balancer.admissionStatus() != 0) {
                listCurated(700 + i * 10 + batches, 0.001 ether);
                if (balancer.admissionStatus() == 2 || balancer.admissionStatus() == 6) upkeep();
            }
            vm.fee(BASEFEE);
            vm.txGasPrice(BASEFEE);
            total += _selfDeal(_words(1 + (i % 5), 100 + i));
            ++batches;
        }
        emit log_named_decimal_int("cumulative PnL (ETH)", total, 18);
        assertEq(batches, 10, "every batch ran");
        assertLe(total, 0);
    }

    function test_selfDealingDrainsOnlyCheapCurated() public {
        _cheapPool(1, 0.0001 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        uint256[] memory w = new uint256[](1);
        w[0] = 1; // slot 1: the cheap curated NFT; the pool closes NO_CURATED afterwards
        int256 pnl = _selfDeal(w);
        emit log_named_decimal_int("drain the only cheap curated NFT, PnL (ETH)", pnl, 18);
        assertLe(pnl, 0);
    }

    /*////////////////////////////// 8-10. creator-caused work //////////////////////////////*/

    /// Creator work (SETTING_UP) is creator-only and admission stays closed until it completes, so no purchase can
    /// create it or coincide with it.
    function test_noPurchasesDuringCreatorWork() public {
        _cheapPool(2, 0.3 ether, plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        vm.startPrank(creator);
        balancer.configure(1000, plan([uint256(9), 6, 4, 0, 0, 0, 0, 0, 0]), shapes.mintFee()); // grow the target
        vm.stopPrank();
        assertFalse(balancer.creatorWork(),"operating edits do not restart initial setup");
        assertEq(balancer.admissionStatus(),6,"real missing weight blocks purchases");
        assertFalse(balancer.canPurchase(atk));
        fillUp();
        assertEq(balancer.admissionStatus(),0,"funded replacement restores actual admission weight");
    }

    /// A deposit changes nothing about pay: each of the attacker's upkeep calls gets measured gas at the reimbursed
    /// price plus one flat reward. (Its P&L here also carries prize luck, so the bound is asserted on the rewards.)
    function test_depositDoesNotUnlockFullIncentive() public {
        _cheapPool(3, 0.001 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        vm.prank(creator);
        balancer.depositETH{value: 1 ether}();
        vm.prank(atk);
        balancer.depositETH{value: 1 wei}();
        assertFalse(balancer.creatorWork());
        uint256 lastBefore = lastListingId();
        // Draw a Shape prize, so a replacement is listed and credited.
        uint256[] memory word = new uint256[](1);
        uint256[] memory listed = balancer.getActiveIds();
        for (uint256 i; i < listed.length; ++i) {
            (uint8 kind,,,,) = balancer.items(listed[i]);
            if (kind != 2) continue;
            (,,,,,, uint256 slot,) = pool.listings(listed[i]);
            word[0] = wordForSlot(slot);
            break;
        }
        _selfDeal(word);
        uint256 credited;
        uint256[] memory active = balancer.getActiveIds();
        for (uint256 i; i < active.length; ++i) {
            if (active[i] <= lastBefore) continue;
            (uint8 kind,,, uint112 base, uint112 price) = balancer.items(active[i]);
            if (kind == 2) credited += price - base;
        }
        uint256 calls;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) {
                (uint256 r, uint256 g) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(r, (g + V1_OVERHEAD) * BASEFEE + 2 * 0.00002 ether, "measured gas and one draw plus one listed Shape unit");
                ++calls;
            }
        }
        assertGt(credited, 0, "a Shape prize was drawn and replaced");
        assertEq(calls, 1, "one draw, one paid call");
    }

    /// Accepted (I-6): a batch bought before a creator action that sets creator work is reconciled with the full
    /// incentive. The buyer cannot cause or time the creator action; the extra is at most one incentive.
    function test_creatorActionDuringOutstandingBatchBound() public {
        _cheapPool(3, 0.001 ether, plan([uint256(10), 0, 0, 0, 0, 0, 0, 0, 0]));
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 v = pool.inventoryVersion();
        vm.prank(atk, atk);
        uint256[] memory ids = pool.acquireBatch{value: total}(atk, 1, 0, 0, 10_000, v, block.timestamp + 1);
        fulfill(ids[0], uint256(keccak256("i6")));
        settle();
        // creator action that sets creator work: grow the target so restocking runs under the full incentive
        vm.startPrank(creator);
        balancer.configure(1000, plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]), shapes.mintFee());
        vm.stopPrank();
        assertFalse(balancer.creatorWork(),"ordinary target growth uses inventory admission, not initial setup");
        assertEq(balancer.admissionStatus(),6,"grown target is genuinely below the70percent inventory threshold");
        bytes32 uh5 = balancer.settingsHash();
        vm.recordLogs();
        vm.prank(atk, atk);
        uint256 reward = balancer.performUpkeep(uh5, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 gasPaid;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == KEEPER_PAID) (, gasPaid) = abi.decode(logs[i].data, (uint256, uint256));
        }
        assertLe(reward - gasPaid * BASEFEE, 0.0001 ether + (gasPaid / 4 + V1_OVERHEAD) * BASEFEE + 0.0001 ether, "at most one incentive");
    }
}
