// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IFWAPoolFactory, IFWAPool} from "../../../src/interfaces/External.sol";

/// Integration lane — real FWA path, no mocks. Creates a real FWA StandardPool through the live factory at the pinned
/// block and measures the VRF service fee's dependence on tx.gasprice (packet section 4 timing claim), and confirms the
/// live factory parameters our contract requires at initialize are actually present (maxAcquisitionsPerTx==5,
/// maxStagedListings==0, implementation==FWA_IMPL).
contract FwaVrfTimingTest is Test {
    address constant FAC = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    string RPC = "https://mainnet.gateway.tenderly.co";

    function _fork(uint256 blk) internal {
        vm.createSelectFork(RPC, blk);
    }

    /// The live factory still serves exactly what initialize() checks, at both blocks.
    function testFactoryParamsLiveAtPinned() public {
        _fork(26382349);
        _assertParams();
    }

    function testFactoryParamsLiveAtRecent() public {
        _fork(26405755);
        _assertParams();
    }

    function _assertParams() internal view {
        IFWAPoolFactory fac = IFWAPoolFactory(FAC);
        assertEq(fac.implementation(), FWA_IMPL, "implementation drift");
        assertEq(FWA_IMPL.codehash, FWA_CODEHASH, "codehash drift");
        assertEq(fac.maxAcquisitionsPerTx(), 5, "batch drift (MAX_BATCH)");
        assertEq(fac.maxStagedListings(), 0, "staging-cap drift (initialize requires 0)");
        assertEq(fac.edgeBps(), 500, "edgeBps drift (planner assumes 500)");
        assertEq(fac.globalWithdrawOnly(), false, "globalWithdrawOnly set");
    }

    /// Create a real FWA pool (as our contract does: createPool(bytes32(0), FWA_IMPL)) and read vrfServiceFee at a
    /// range of tx.gasprice values. Proves whether FWA's VRF fee moves with the inclusion-block gas price, which is the
    /// basis of the packet's "simulate at gas price 0 underpays the VRF fee" concern for anything that forwards it.
    function testVrfFeeMovesWithGasPrice() public {
        _fork(26382349);
        address pool = IFWAPoolFactory(FAC).createPool(bytes32(0), FWA_IMPL);
        assertEq(IFWAPool(pool).owner(), address(this), "owner");

        uint256[6] memory prices = [uint256(0), 0.1 gwei, 1 gwei, 3 gwei, 5 gwei, 50 gwei];
        uint256 prev;
        for (uint256 i; i < prices.length; ++i) {
            vm.txGasPrice(prices[i]);
            uint256 vrf = IFWAPool(pool).vrfServiceFee();
            emit log_named_uint("gasprice(wei)", prices[i]);
            emit log_named_uint("  vrfServiceFee(wei)", vrf);
            if (i > 0) {
                // Monotonic non-decreasing in gas price is the property that makes a gas-price-0 quote an underestimate.
                assertGe(vrf, prev, "vrf should not fall as gas price rises");
            }
            prev = vrf;
        }
        // The headline: the fee at 0 gas price vs a realistic inclusion price.
        vm.txGasPrice(0);
        uint256 atZero = IFWAPool(pool).vrfServiceFee();
        vm.txGasPrice(5 gwei);
        uint256 atFive = IFWAPool(pool).vrfServiceFee();
        emit log_named_uint("vrf @ gasprice 0", atZero);
        emit log_named_uint("vrf @ gasprice 5gwei", atFive);
        emit log_named_uint("underestimate (5gwei - 0)", atFive - atZero);
    }
}
