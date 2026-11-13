// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";

/// Records what a state-changing call actually sees. Foundry runs test transactions at gas price 0, and at basefee 0
/// inside calls, unless the test sets them; the test body and view calls show the forked block's basefee instead.
contract FeeWitness {
    uint256 public basefee;
    uint256 public gasprice;

    function record() external {
        basefee = block.basefee;
        gasprice = tx.gasprice;
    }
}

/// @notice Guards the gas context every fork test runs in, and checks fee amounts against an independent calculation
///         rather than the contract's own quote.
contract ForkContextTest is ForkBase {
    function setUp() public {
        setUpFork();
    }

    function test_callsSeeTheConfiguredBasefeeAndGasPrice() public {
        FeeWitness w = new FeeWitness();
        w.record();
        assertEq(w.basefee(), 0.5 gwei, "state-changing calls run at the ForkBase basefee");
        assertEq(w.gasprice(), 1 gwei, "state-changing calls run at the ForkBase gas price");
    }

    /// A listed 0.01 ETH Shape's price, computed here from the published formula at the context's basefee:
    /// backing + mint fee + backing x markup + 900,000 gas x min(basefee + 0.05 gwei, 5 gwei) + 0.0002 ETH.
    /// And FWA's VRF fee: 2,340,000 gas x the transaction's gas price.
    function test_listedFeesMatchAnIndependentCalculation() public {
        createBalancer(1 ether);
        uint256[9] memory c;
        c[0] = 1;
        configure(plan(c));
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256[] memory ids = balancer.getActiveIds();
        assertEq(ids.length, 1, "one Shape listed");
        (,,,, uint112 price) = balancer.items(ids[0]);
        uint256 restock = 900_000 * (0.5 gwei + 0.05 gwei) + 0.0002 ether;
        uint256 expected = 0.01 ether + shapes.mintFee() + 0.01 ether * uint256(MARKUP) / 10_000 + restock;
        assertEq(price, expected, "listing carries the restocking fee at the real basefee");
        assertGt(restock, 900_000 * 0.05 gwei + 0.0002 ether, "not the zero-basefee fee");

        listCurated(1, 0.1 ether);
        (uint256 fee,, uint256 total) = pool.quoteAcquisitionPrice(1);
        assertEq(total - fee, 2_340_000 * 1 gwei, "VRF fee at the 1 gwei gas price");
    }
}
