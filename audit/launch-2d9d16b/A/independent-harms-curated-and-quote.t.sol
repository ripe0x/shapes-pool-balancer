// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {GasProbe} from "../utils/FlowBreakdown.sol";

contract IndependentHarms is ForkBase {
    function test_emptyCuratedModeIsAnEffectiveCreatorChoice() public {
        setUpFork();
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), 0.5 gwei, "basefee inside executed call");
        assertEq(probe.gasPrice(), 1 gwei, "gas price inside executed call");

        PoolBalancer.CuratedInput[] memory none = new PoolBalancer.CuratedInput[](0);
        PoolBalancer.CreationConfig memory required = PoolBalancer.CreationConfig(
            1500, 400, 20, shapes.mintFee(), true
        );
        vm.prank(creator, creator);
        PoolBalancer a = PoolBalancer(payable(factory.createBalancer{value: 1 ether}(bytes32(uint256(31)), required, none)));
        assertTrue(a.curatedRequired());
        for (uint256 i; i < 4; ++i) {
            vm.prank(keeper, keeper);
            a.performUpkeep(a.settingsHash(), 0, 0);
        }
        assertEq(a.getActiveShapes()[0], 20, "actual Shapes stocked through FWA");
        assertEq(a.admissionStatus(), 3, "chosen curated requirement pauses until listing");
        vm.prank(creator, creator);
        a.setCuratedRequired(false);
        assertEq(a.admissionStatus(), 0, "creator can choose standard mode without curated inventory");
        (uint256 fee, uint256 vrf, uint256 total) = a.pool().quoteAcquisitionPrice(1);
        assertGt(vrf, 0, "player pays separate live randomness fee");
        assertEq(total, fee + vrf, "actual FWA wallet amount");
        emit log_named_decimal_uint("FWA draw fee", fee, 18);
        emit log_named_decimal_uint("FWA randomness fee", vrf, 18);
        emit log_named_decimal_uint("FWA total player payment", total, 18);
    }
}
