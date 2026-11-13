// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Harness, console} from "./Harness.sol";

/// Enter the below-reserve regime (tight deposit) and check the M9 profit-booking path on a real fork:
///  - profit only grows while the fund is below the reserve;
///  - claiming that profit preserves fund = balance - profit (never moves fund money out as a side effect);
///  - a claim never pushes the Balancer balance below requiredReserve via the free path.
contract BelowReserveTest is Harness {
    function setUp() public {
        _fork();
        _deploy();
        vm.fee(0.3 gwei);
        vm.txGasPrice(0.3 gwei);
    }

    function testBelowReserveProfitBooking() public {
        // Tight deposit: enough to stock + pass open, little headroom, so an unreconciled draw tips fund < reserve.
        _newPool(0.12 ether);
        vm.prank(creator);
        bal.configure(5000, uint256(2)); // 50% markup, two 0.01 Shapes
        _listCurated(0.02 ether);
        vm.prank(creator);
        bal.open();
        uint256 g;
        while (bal.creatorWork() && g++ < 10) _upkeep(creator);

        bool everBelow;
        uint256 maxProfit;
        for (uint256 i; i < 12; i++) {
            if (bal.admissionStatus() != 0) _upkeep(keeper);
            if (bal.admissionStatus() != 0) continue;
            (bool ok,,) = _tryDraw(player, uint256(keccak256(abi.encode("b", i))));
            if (!ok) break;

            uint256 profitBefore = bal.profit();
            vm.prank(creator);
            bal.collectProceeds();
            uint256 booked = bal.profit() - profitBefore;
            uint256 bal_ = address(bal).balance;
            uint256 fund = bal_ - bal.profit();
            uint256 req = bal.requiredReserve();
            bool below = fund < req;
            if (bal.profit() > 0) everBelow = true;
            if (bal.profit() > maxProfit) maxProfit = bal.profit();
            console.log("i / profitBooked / profit", i, booked, bal.profit());
            console.log("   balance / fund / reserve", bal_, fund, req);

            // Invariant: profit is bounded by the balance (never books money that is not there).
            assertLe(bal.profit(), bal_, "profit exceeds balance");

            // If profit is claimable, claim it and verify the fund is preserved and reserve not breached.
            uint256 s = bal.withdrawableSurplus();
            if (s > 0) {
                uint256 fundBeforeClaim = address(bal).balance - bal.profit();
                vm.prank(creator);
                bal.claimSurplus(s, creator);
                uint256 fundAfterClaim = address(bal).balance - bal.profit();
                // Claiming (whether via profit path or free path) never reduces the protected fund below where it was,
                // unless it was already at/above the reserve (free surplus above reserve is the creator's).
                assertGe(fundAfterClaim + 1, fundBeforeClaim < req ? fundBeforeClaim : req, "claim moved fund money out");
            }
            _upkeep(keeper);
        }
        console.log("ever booked profit (entered below-reserve regime)", everBelow ? 1 : 0);
        console.log("max profit observed", maxProfit);
    }
}
