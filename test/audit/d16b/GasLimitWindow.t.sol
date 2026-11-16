// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16bWorstUpkeepTest, ProbeHog} from "./WorstUpkeepB.t.sol";

/// @notice F3 probe: sweep the keeper's gas limit over one upkeep that has two waiting draws (each reserved six
///         hostile curated listings) and three fast-pathed draws to reconcile. Shows where processing fails inside
///         the try while the call still succeeds, and what the keeper is paid against what it burns.
contract D16bGasLimitWindowTest is D16bWorstUpkeepTest {
    /// @dev One fast-pathed draw (little other work), then two draws that each reserved six hostile listings.
    function _buildOne() internal {
        _buildOne(true);
    }

    function _buildOne(bool armed) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        hog = new ProbeHog();
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        listCurated(1, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256 r1 = buy(buyer, 1)[0];
        _listHogs(12, 100);
        if (armed) hog.arm(address(pool));
        uint256 r4 = buy(buyer, 1)[0];
        uint256 r5 = buy(stranger, 1)[0];
        fulfill(r1, uint256(keccak256("w")));
        fulfill(r4, _hogWord(r4, 1, "d4"));
        fulfill(r5, _hogWord(r5, 2, "d5"));
        assertEq(pool.unsettledAcquisitionCount(), 2);
        assertEq(balancer.reconciledSequence() + 3, pool.lastIssuedSequence());
    }

    function test_sweep_oneOlder_fine() public {
        _buildOne();
        _loop(1_000_000, 1_700_000, 5_000);
        _loop(2_700_000, 3_100_000, 5_000);
    }

    function test_sweep_oneOlder_honest_fine() public {
        _buildOne(false);
        _loop(2_200_000, 2_900_000, 5_000);
    }

    function test_sweep_oneOlder() public {
        _buildOne();
        _loop(1_500_000, 3_300_000, 50_000);
    }

    function _sweep(uint256 pad) internal {
        _build(pad);
        _loop(1_000_000, 4_000_000, 100_000);
    }

    function _loop(uint256 lo, uint256 hi, uint256 step) internal {
        _setGas(0.5 gwei, 0.55 gwei);
        for (uint256 G = lo; G <= hi; G += step) {
            uint256 snap = vm.snapshotState();
            bytes32 uh1 = balancer.settingsHash();
            uint256 before = keeper.balance;
            vm.prank(keeper, keeper);
            (bool ok,) = address(balancer).call{gas: G}(abi.encodeCall(balancer.performUpkeep, (uh1)));
            (bool ok2, bytes memory r) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
            require(ok2);
            (, uint64 used,, int64 refunded,) = abi.decode(r, (uint64, uint64, uint64, int64, uint64));
            uint256 paid = keeper.balance - before;
            bool processed = pool.unsettledAcquisitionCount() == 0;
            uint256 cost = (uint256(used) + 21_000) * 0.55 gwei;
            emit log_string(
                string.concat(
                    "G=", vm.toString(G), " ok=", ok ? "1" : "0", " processed=", processed ? "1" : "0",
                    " billedGas=", vm.toString(uint256(used) + 21_000), " refund=", vm.toString(refunded),
                    " paidWei=", vm.toString(paid), " costWei=", vm.toString(cost),
                    " marginWei=", vm.toString(int256(paid) - int256(cost))
                )
            );
            vm.revertToState(snap);
            assertTrue(!ok || processed, "no gas limit succeeds with processing starved");
            if (ok) assertGe(paid, cost, "a successful call covers the keeper");
        }
    }

    function test_sweep_noPad() public {
        _sweep(0);
    }
}
