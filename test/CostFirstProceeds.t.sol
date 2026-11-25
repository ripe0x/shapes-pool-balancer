// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {GasProbe} from "./utils/FlowBreakdown.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {IERC721Min} from "../src/interfaces/External.sol";

interface ICostFirstPackValue { function valueOf(uint256 id) external view returns (uint256); }

/// @dev A donor can force a real ETH transfer without invoking the recipient; no protocol state is fabricated.
contract CostFirstForceETH {
    constructor() payable {}
    function donate(address payable recipient) external { selfdestruct(recipient); }
}

/// @dev An accepted keeper that contributes its real reward back from inside the payment callback.
contract CostFirstDonatingKeeper {
    PoolBalancer internal immutable balancer;
    uint256 public donated;
    uint256 public paidGasPrice;
    uint256 public paidBaseFee;
    constructor(PoolBalancer b) { balancer = b; }
    function upkeep() external { balancer.performUpkeep(balancer.settingsHash(), 0, 0); }
    receive() external payable {
        require(msg.sender == address(balancer));
        donated += msg.value;
        paidGasPrice = tx.gasprice;
        paidBaseFee = block.basefee;
        (bool ok,) = address(balancer).call{value: msg.value}("");
        require(ok);
    }
}

contract CostFirstProceedsTest is ForkBase {
    function setUp() public {
        setUpFork();
        curatedRequired = false;
        createBalancer(1 ether);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "fee inside executed call");
        assertEq(probe.gasPrice(), 1 gwei, "gas price inside executed call");
        assertEq(balancer.operatingCapital(), 1 ether);
    }

    function _backingHeld() internal view returns (uint256 total) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind != 2) continue;
            (address collection,,, uint256 tokenId,,,,) = pool.listings(ids[i]);
            if (IERC721Min(collection).ownerOf(tokenId) != address(pool)) continue;
            total += collection == SHAPES ? shapes.backingOf(tokenId) : ICostFirstPackValue(collection).valueOf(tokenId);
        }
    }

    function _assertProfit() internal view {
        uint256 assets = address(balancer).balance + _backingHeld();
        uint256 capital = balancer.operatingCapital();
        assertEq(balancer.creatorCredit(), assets > capital ? assets - capital : 0, "actual cash and redeemable backing less capital");
    }

    function _stock(uint256 count) internal {
        configure(count);
        vm.startPrank(creator);
        balancer.setPaidUpkeepEnabled(false);
        balancer.open();
        vm.stopPrank();
        balancer.performUpkeepUnpaid();
        assertEq(_backingHeld(), count * 0.01 ether);
        assertEq(address(balancer).balance + _backingHeld(), 1 ether - count * shapes.mintFee(), "each mint fee is an actual cost");
        _assertProfit();
    }

    function test_depositsAreCapitalNotEarnedProceeds() public {
        assertEq(balancer.profitAccountingVersion(), 1);
        assertEq(balancer.creatorRevenueBps(), 0);
        vm.prank(stranger);
        balancer.depositETH{value: 0.25 ether}();
        assertEq(balancer.operatingCapital(), 1.25 ether);
        vm.prank(stranger);
        (bool ok,) = address(balancer).call{value: 0.125 ether}("");
        assertTrue(ok);
        assertEq(balancer.operatingCapital(), 1.375 ether, "plain transfers are contributed capital");
        assertEq(balancer.creatorCredit(), 0);
        balancer.collectProceeds();
        assertEq(balancer.operatingCapital(), 1.375 ether, "sync never counts a deposit twice");
        vm.prank(creator);
        balancer.open();
        assertEq(balancer.withdrawableSurplus(), 0, "large cash balance is not earned proceeds");
    }

    function test_forcedETHRaisesCapitalWithoutManufacturingProfit() public {
        vm.deal(address(this), 0.2 ether);
        CostFirstForceETH donor = new CostFirstForceETH{value: 0.2 ether}();
        donor.donate(payable(address(balancer)));
        assertEq(address(balancer).balance, 1.2 ether);
        assertEq(balancer.operatingCapital(), 1.2 ether);
        assertEq(balancer.creatorCredit(), 0);
        balancer.collectProceeds();
        assertEq(balancer.operatingCapital(), 1.2 ether);
        _assertProfit();
    }

    function test_keeperDonationDuringRewardRemainsCapital() public {
        vm.prank(creator);
        balancer.open();
        CostFirstDonatingKeeper donating = new CostFirstDonatingKeeper(balancer);
        donating.upkeep();
        uint256 reward = donating.donated();
        assertGt(reward, 0, "actual paid work reached its receiver");
        assertEq(donating.paidGasPrice(), 1 gwei);
        assertEq(donating.paidBaseFee(), 0.5 gwei);
        assertEq(_backingHeld(), 0.01 ether);
        assertEq(address(balancer).balance + _backingHeld(), 1 ether - shapes.mintFee(), "reward was actually returned; only mint fee left cash plus backing");
        assertEq(balancer.operatingCapital(), 1 ether + reward, "callback donation adds contributed capital");
        assertEq(balancer.creatorCredit(), 0, "reward callback cannot manufacture proceeds");
        balancer.collectProceeds();
        assertEq(balancer.operatingCapital(), 1 ether + reward, "later syncing books it exactly once");
        _assertProfit();
    }

    function test_unlistingAndReopeningNeverTurnCapitalIntoProfit() public {
        _stock(1);
        uint256 cashBefore = address(balancer).balance;
        uint256[] memory ids = balancer.getActiveIds();
        vm.prank(creator);
        balancer.unlistShapes(ids);
        assertEq(address(balancer).balance, cashBefore + 0.01 ether, "real redemption returns exact backing");
        assertEq(balancer.operatingCapital(), 1 ether, "redemption is not a new contribution");
        assertEq(balancer.creatorCredit(), 0);
        assertEq(balancer.withdrawableSurplus(), 0);
        vm.startPrank(creator);
        balancer.close();
        uint256 claim = balancer.withdrawableSurplus();
        balancer.claimSurplus(claim, creator);
        vm.stopPrank();
        assertEq(claim, 1 ether - shapes.mintFee());
        assertEq(address(balancer).balance, 0);
        assertEq(balancer.operatingCapital(), shapes.mintFee(), "unrecovered mint loss carries forward");
        vm.startPrank(creator);
        balancer.depositETH{value: 1 ether}();
        balancer.open();
        vm.stopPrank();
        assertEq(balancer.operatingCapital(), 1 ether + shapes.mintFee());
        assertEq(balancer.creatorCredit(), 0, "reopening cannot reset prior losses");
        assertEq(balancer.withdrawableSurplus(), 0);
    }

    function test_targetShrinkAndCreatorTransferDoNotReleaseCapitalAsEarnings() public {
        _stock(4);
        configure(1);
        assertEq(balancer.operatingCapital(), 1 ether);
        assertEq(balancer.withdrawableSurplus(), 0);
        vm.prank(creator);
        balancer.transferCreator(stranger);
        vm.prank(stranger);
        balancer.acceptCreator();
        assertEq(balancer.operatingCapital(), 1 ether);
        assertEq(balancer.creatorCredit(), 0);
        vm.prank(creator);
        vm.expectRevert(PoolBalancer.Unauthorized.selector);
        balancer.claimSurplus(1, creator);
        vm.startPrank(stranger);
        vm.expectRevert(PoolBalancer.InsufficientSurplus.selector);
        balancer.claimSurplus(1, stranger);
        balancer.close();
        uint256[] memory ids = balancer.getActiveIds();
        balancer.unlistShapes(ids);
        uint256 amount = balancer.withdrawableSurplus();
        uint256 before = stranger.balance;
        balancer.claimSurplus(amount, stranger);
        vm.stopPrank();
        assertEq(stranger.balance - before, 1 ether - 4 * shapes.mintFee());
        assertEq(balancer.operatingCapital(), 4 * shapes.mintFee());
    }

    function test_manualRevenueRateRejectedIncludingLegacyZeroSetter() public {
        vm.startPrank(creator);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.setCreatorRevenueBps(400);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        balancer.setCreatorRevenueBps(0);
        vm.stopPrank();
        PoolBalancer.CuratedInput[] memory none;
        bytes32 hash = factory.creationSettingsHash();
        uint256 mintFee = shapes.mintFee();
        vm.prank(stranger);
        vm.expectRevert(PoolBalancer.InvalidConfig.selector);
        factory.createBalancer{value: 0.1 ether}(bytes32(uint256(9)),
            PoolBalancer.CreationConfig(MARKUP, 400, 1, mintFee, false, hash), none);
    }
}
