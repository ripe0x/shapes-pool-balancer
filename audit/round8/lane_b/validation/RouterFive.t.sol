// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {BalancedRouterTest, IRealVRFService} from "./BalancedRouter.t.sol";
import {IFWAPoolFactory} from "../../../../src/interfaces/External.sol";

contract RouterFiveTest is BalancedRouterTest {
    function testFreshFiveRouterRequestsAndDeliveries() public {
        assertEq(IFWAPoolFactory(FWA_FACTORY).maxAcquisitionsPerTx(), 5);
        (uint256 fee,, uint256 total) = p.quoteAcquisitionPrice(5);
        uint256 version = p.inventoryVersion();
        uint256 beforePayer = PLAYER.balance;
        vm.prank(PLAYER, PLAYER);
        uint256[] memory ids = p.acquireBatch{value: total}(
            PLAYER, 5, fee, 0, 10_000, version, block.timestamp + 1 days
        );
        assertEq(beforePayer - PLAYER.balance, total);
        assertEq(ids.length, 5);
        assertEq(p.unsettledAcquisitionCount(), 5);
        vm.roll(block.number + 1);
        for (uint256 i; i < ids.length; ++i) {
            uint256[] memory words = new uint256[](1);
            words[0] = uint256(keccak256(abi.encodePacked("lane-b-five-real-router", ids[i], i)));
            vm.prank(COORDINATOR);
            IRealVRFService(VRF_SERVICE).rawFulfillRandomWords(ids[i], words);
            p.processAcquisitions(5);
            (,,,, uint8 status,) = p.acquisitions(ids[i]);
            assertEq(status, 2);
        }
        assertEq(p.unsettledAcquisitionCount(), 0);
        vm.prank(KEEPER);
        b.performUpkeep();
        assertEq(b.reconciledSequence(), 5);
        emit log_named_uint("fiveDrawTotal", total);
        emit log_named_uint("postUpkeepCredit", b.keeperCredit());
    }
}
