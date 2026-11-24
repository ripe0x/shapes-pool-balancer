// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Trivial work is paid only for its own gas and service bounds (R95: the formula is in the library, no policy quotes).

import {Vm} from "forge-std/Vm.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyCalls} from "../src/KeeperPolicyCalls.sol";

contract ReviewReceiver {
    uint256 public callbacks;
    function run(PoolBalancer b, uint256 min) external returns (uint256) { return b.performUpkeep(b.settingsHash(), min, 0); }
    receive() external payable { ++callbacks; }
}

interface IReviewRefunds {
    function acquisitionRefundCredit(address) external view returns (uint256);
}

contract ReviewGasContext {
    uint256 public base;
    uint256 public price;
    function record() external { base = block.basefee; price = tx.gasprice; }
}

contract PolicySecurityReviewTest is ForkBase {
    function setUp() public {
        setUpFork();
        vm.fee(0.5 gwei);
        vm.txGasPrice(0.55 gwei);
        ReviewGasContext context = new ReviewGasContext();
        context.record();
        assertEq(context.base(), 0.5 gwei);
        assertEq(context.price(), 0.55 gwei);
        createBalancer(5 ether);
        configure(plan([uint256(20), 0, 0, 0, 0, 0, 0, 0, 0]));
        listCurated(1, 0.2 ether);
        vm.prank(creator); balancer.open();
        fillUp();
        assertEq(balancer.listedShapePrizes(), 20);
    }

    function _expire() internal {
        buy(buyer, 1);
        vm.roll(vm.getBlockNumber() + 50); // past FWA's word deadline and the 50-block processing grace
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(pool.lastIssuedSequence(), 1);
    }

    /// Trivial work is paid for its own gas and work fees, far below the derived maximum, and paying it leaves the
    /// reserve formula alone. R95 removed the hostile policy this test once armed; the payment bound is the formula.
    function test_mutatingPolicyCannotRaiseLiability() public {
        uint256 maximum = balancer.policyMaxReward();
        uint256 reserve = balancer.requiredReserve();
        (uint256 playerFee,,) = pool.quoteAcquisitionPrice(1);
        uint256 weightShape = uint256(1e36) / 0.0132005 ether;
        uint256 weightNft = 1e36 / 0.2 ether;
        uint256 independent = ((20 * weightShape * 0.0132005 ether + weightNft * 0.2 ether) / (20 * weightShape + weightNft)) * 10500 / 10000;
        assertEq(playerFee, independent, "absolute FWA acquisition price at this board and gas");
        uint256 fwaHeld = address(pool).balance;
        _expire();
        bytes32 hash = balancer.settingsHash();
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper, keeper); uint256 paid = balancer.performUpkeep(hash, 1, 0);
        Vm.Log[] memory logs=vm.getRecordedLogs();
        uint256 measured;
        for(uint256 i;i<logs.length;++i)if(logs[i].emitter==address(balancer)&&logs[i].topics[0]==keccak256("KeeperPaid(address,uint256,uint256)"))
            (,measured)=abi.decode(logs[i].data,(uint256,uint256));
        assertGt(paid,0);
        uint256 envelope=((measured>2_150_000?2_150_000:measured)+V1_OVERHEAD)*0.55 gwei+0.00004 ether; // process + reconcile fees
        assertEq(paid,envelope,"trivial work cannot obtain the full payment maximum");
        assertLt(paid, maximum);
        assertEq(keeper.balance - before,paid);
        assertEq(balancer.policyMaxReward(), maximum);
        assertEq(balancer.requiredReserve(), reserve, "paying trivial work cannot change the reserve formula");
        assertEq(balancer.reconciledSequence(), 1);
        assertEq(IReviewRefunds(address(pool)).acquisitionRefundCredit(buyer), playerFee, "entire real player refund stays theirs");
        assertEq(address(pool).balance - fwaHeld, playerFee, "keeper payout took none of the FWA refund backing");
        assertEq(pool.ownerProceeds(), 0, "expiry creates no creator proceeds");
        vm.prank(keeper); vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector); balancer.performUpkeep(hash, 0, 0);
    }

    function test_minimumFailureRollsBackDrawPaymentAndReceiverCallback() public {
        _expire();
        ReviewReceiver receiver = new ReviewReceiver();
        uint256 held = address(balancer).balance;
        uint256 allowance = balancer.keeperAllowance();
        uint256 pending = pool.nextSequenceToProcess();
        vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        receiver.run(balancer, 1 ether);
        assertEq(receiver.callbacks(), 0);
        assertEq(address(receiver).balance, 0);
        assertEq(address(balancer).balance, held);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(pool.nextSequenceToProcess(), pending, "external FWA processing rolls back too");
        uint256 reward = receiver.run(balancer, 0);
        assertGt(reward, 0.00004 ether, "gas plus the process and reconcile work fees");
        assertEq(receiver.callbacks(), 1);
        assertEq(address(receiver).balance, reward);
        assertEq(held - address(balancer).balance, reward);
        assertEq(balancer.reconciledSequence(), 1);
    }
    /// R95: the selected schedule is now local economics with a larger flat charge, not an alternative policy.
    function test_unpaidMaintenanceRespectsHealthySelectedSurcharge() public {
        KeeperPolicyCalls.Economics memory e = factory.economics();
        e.restockFlat = 0.0035 ether;
        vm.prank(creator); balancer.setLocalEconomics(e);
        uint256 selected = 910_000 * 0.55 gwei + 0.0035 ether;
        assertEq(balancer.restockFeeFor(0), selected, "the selected local schedule prices the restock");
        uint256[] memory one = new uint256[](1);
        one[0] = balancer.getActiveIds()[1];
        vm.prank(creator); balancer.unlistShapes(one);
        assertEq(balancer.getActiveShapes()[0], 19);
        uint256 before = stranger.balance;
        vm.prank(stranger); assertEq(balancer.performUpkeepUnpaid(), 0);
        assertEq(balancer.getActiveShapes()[0], 20);
        assertEq(stranger.balance, before, "the caller volunteered unpaid work");
        uint256 listed = lastListingId();
        (,,, uint256 base, uint256 price) = balancer.items(listed);
        (,,,,, uint256 fwaPrice,,) = pool.listings(listed);
        assertEq(fwaPrice, price);
        assertEq(price - base, selected, "unpaid caller cannot replace the selected pricing schedule");
    }

    function test_priceIndexedMinimumUsesMinedPriceAndIsAtomic() public {
        _expire();
        bytes32 expected = balancer.settingsHash();
        uint256 held = address(balancer).balance;
        uint256 allowance = balancer.keeperAllowance();
        // The reward is G * price + two work fees (R95 formula). A minimum of G + 136k gas fails at 0.55 gwei (the fees
        // cover only 72,727 gas there) and passes at 0.2 gwei (they cover 200,000). G comes from a reverted dry run.
        uint256 snap = vm.snapshotState();
        vm.prank(keeper); uint256 dry = balancer.performUpkeep(expected, 0, 0);
        assertTrue(vm.revertToState(snap));
        uint256 minimumGas = (dry - 0.00004 ether) / 0.55 gwei + 136_000;
        vm.prank(keeper); vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        balancer.performUpkeep(expected, 0, minimumGas);
        assertEq(address(balancer).balance, held);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.reconciledSequence(), 0);
        // The same pending offer becomes sufficient at the actual lower inclusion price.
        vm.fee(0.15 gwei);
        vm.txGasPrice(0.2 gwei);
        ReviewGasContext context = new ReviewGasContext();
        context.record();
        assertEq(context.base(), 0.15 gwei);
        assertEq(context.price(), 0.2 gwei);
        vm.prank(keeper); uint256 reward = balancer.performUpkeep(expected, 0, minimumGas);
        assertGe(reward, minimumGas * 0.2 gwei, "the price-indexed minimum is met at the mined price");
        assertLt(reward, dry, "the same work pays less at the lower mined price");
        assertEq(balancer.reconciledSequence(), 1);
    }

}
