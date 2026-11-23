// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// A cached declaration is an additional ceiling; trivial work is first limited by immutable gas and service bounds.

import {Vm} from "forge-std/Vm.sol";
import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IKeeperPolicy} from "../src/interfaces/IKeeperPolicy.sol";

/// @dev An untrusted, deliberately mutable policy, accepted by the core interface by design.
contract MutableReviewPolicy is IKeeperPolicy {
    bool public attack;
    PoolBalancer public ownedPool;
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 404; }
    function arm() external { attack = true; }
    function becomeCreator(PoolBalancer b) external { ownedPool = b; b.acceptCreator(); }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) { return units * 0.0007 ether; }
    function quoteReward(Work calldata, Economics calldata) external view returns (uint256) {
        if (address(ownedPool) != address(0)) {
            // This policy also has creator authority, so authority checks alone do not close the callback path.
            (bool withdrew,) = address(ownedPool).staticcall(abi.encodeCall(PoolBalancer.claimSurplus, (1 ether, address(this))));
            (bool changed,) = address(ownedPool).staticcall(abi.encodeCall(PoolBalancer.transferCreator, (address(0xbad))));
            (bool disabled,) = address(ownedPool).staticcall(abi.encodeCall(PoolBalancer.setPaidUpkeepEnabled, (false)));
            require(!withdrew && !changed && !disabled, "static callback changed state");
        }
        return attack ? type(uint256).max : 0.0001 ether;
    }
}

/// @dev A valid stateless alternative with intentionally distinct listing economics.
contract AlternativeSurchargePolicy is IKeeperPolicy {
    function interfaceVersion() external pure returns (uint256) { return 3; }
    function version() external pure returns (uint256) { return 405; }
    function quoteReward(Work calldata, Economics calldata) external pure returns (uint256) { return 0.0001 ether; }
    function quoteRestock(uint8, uint256 units, uint256, Economics calldata) external pure returns (uint256) { return units * 0.004 ether; }
}

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

    function _adopt(MutableReviewPolicy policy) internal {
        vm.prank(creator); balancer.setKeeperPolicy(address(policy));
    }
    function _expire() internal {
        buy(buyer, 1);
        vm.roll(vm.getBlockNumber() + 50); // past FWA's word deadline and the 50-block processing grace
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(pool.lastIssuedSequence(), 1);
    }

    /// A policy that turns hostile after selection quotes the maximum; the effective economics still bound the payment
    /// to the verified work, and the reserve never consults the policy. (Policies declare no maximum since interface v2.)
    function test_mutatingPolicyCannotRaiseLiability() public {
        MutableReviewPolicy policy = new MutableReviewPolicy();
        _adopt(policy);
        uint256 maximum = balancer.policyMaxReward();
        policy.arm();
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
        assertEq(balancer.requiredReserve(), reserve, "policy mutation cannot change reserve formula");
        assertEq(balancer.reconciledSequence(), 1);
        assertEq(IReviewRefunds(address(pool)).acquisitionRefundCredit(buyer), playerFee, "entire real player refund stays theirs");
        assertEq(address(pool).balance - fwaHeld, playerFee, "keeper payout took none of the FWA refund backing");
        assertEq(pool.ownerProceeds(), 0, "expiry creates no creator proceeds");
        vm.prank(keeper); vm.expectRevert(PoolBalancer.NoUpkeepNeeded.selector); balancer.performUpkeep(hash, 0, 0);
    }

    function test_policyThatAlsoOwnsPoolCannotUseStaticCallbackAuthority() public {
        MutableReviewPolicy policy = new MutableReviewPolicy();
        _adopt(policy);
        vm.prank(creator); balancer.transferCreator(address(policy));
        policy.becomeCreator(balancer);
        assertEq(balancer.creator(), address(policy));
        _expire();
        bytes32 hash = balancer.settingsHash();
        uint256 held = address(balancer).balance;
        vm.prank(keeper); assertEq(balancer.performUpkeep(hash, 0.0001 ether, 0), 0.0001 ether);
        assertEq(balancer.creator(), address(policy));
        assertEq(balancer.pendingCreator(), address(0));
        assertTrue(balancer.paidUpkeepEnabled());
        assertEq(address(policy).balance, 0);
        assertEq(held - address(balancer).balance, 0.0001 ether);
        assertEq(balancer.reconciledSequence(), 1);
    }

    function test_minimumFailureRollsBackDrawPaymentAndReceiverCallback() public {
        MutableReviewPolicy policy = new MutableReviewPolicy();
        _adopt(policy);
        _expire();
        ReviewReceiver receiver = new ReviewReceiver();
        uint256 held = address(balancer).balance;
        uint256 allowance = balancer.keeperAllowance();
        uint256 pending = pool.nextSequenceToProcess();
        vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        receiver.run(balancer, 0.0001 ether + 1);
        assertEq(receiver.callbacks(), 0);
        assertEq(address(receiver).balance, 0);
        assertEq(address(balancer).balance, held);
        assertEq(balancer.keeperAllowance(), allowance);
        assertEq(balancer.reconciledSequence(), 0);
        assertEq(pool.nextSequenceToProcess(), pending, "external FWA processing rolls back too");
        assertEq(receiver.run(balancer, 0.0001 ether), 0.0001 ether);
        assertEq(receiver.callbacks(), 1);
        assertEq(address(receiver).balance, 0.0001 ether);
        assertEq(balancer.reconciledSequence(), 1);
    }
    function test_unpaidMaintenanceRespectsHealthySelectedSurcharge() public {
        AlternativeSurchargePolicy policy = new AlternativeSurchargePolicy();
        vm.prank(creator); balancer.setKeeperPolicy(address(policy));
        assertEq(balancer.restockFeeFor(0), 0.004 ether, "healthy selected policy quotes its price (within the 0.00475 bound)");
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
        assertEq(price - base, 0.004 ether, "unpaid caller cannot replace a healthy selected pricing schedule");
    }

    function test_priceIndexedMinimumUsesMinedPriceAndIsAtomic() public {
        MutableReviewPolicy policy = new MutableReviewPolicy();
        _adopt(policy);
        _expire();
        bytes32 expected = balancer.settingsHash();
        uint256 held = address(balancer).balance;
        uint256 allowance = balancer.keeperAllowance();
        // 200k gas at 0.55 gwei is 0.00011 ETH, above this policy's fixed 0.0001 ETH offer.
        vm.prank(keeper); vm.expectRevert(PoolBalancer.MinimumPaymentNotMet.selector);
        balancer.performUpkeep(expected, 0, 200_000);
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
        // At 0.2 gwei the policy's offer, capped by the economics envelope, meets the 200k-gas minimum.
        vm.prank(keeper); uint256 reward = balancer.performUpkeep(expected, 0, 200_000);
        assertGe(reward, 200_000 * 0.2 gwei, "the price-indexed minimum is met at the mined price");
        assertLe(reward, 0.0001 ether);
        assertEq(balancer.reconciledSequence(), 1);
    }

}
