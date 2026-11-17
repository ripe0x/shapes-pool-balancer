// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FlowBreakdown} from "./utils/FlowBreakdown.sol";
import {LibString} from "solady/utils/LibString.sol";

/// @dev Exercises report inputs/serialization only, with no substitute protocol counterparty.
contract FlowReportingTest is FlowBreakdown {
    bool private recorded;

    function flowInflows() internal view override returns (Item[] memory items) {
        items = new Item[](1);
        items[0] = Item("report input", recorded ? 1.926 ether : 0);
    }
    function flowOutflows() internal pure override returns (Item[] memory) { return new Item[](0); }
    function flowFlows() internal pure override returns (Flow[] memory) { return new Flow[](0); }
    function flowDir() internal pure override returns (string memory) { return "test/fixtures"; }
    function flowBuckets() internal view override returns (Bucket[] memory buckets) {
        buckets = new Bucket[](5);
        buckets[0] = Bucket("unknown", recorded ? 0.2 ether : 0, false, 0, false, 0);
        buckets[1] = Bucket("backing", recorded ? 1.7 ether : 0, false, 0, true, 1.7 ether);
        buckets[2] = Bucket("withdrawable", recorded ? 0.01 ether : 0, false, 0, true, 0);
        buckets[3] = Bucket("shortfall", recorded ? 0.001 ether : 0, false, 0, true, 0.02 ether);
        buckets[4] = Bucket("known excess", recorded ? 0.015 ether : 0, false, 0, true, 0.005 ether);
    }

    function testUnknownNeedIsNullAndKnownObligationsRemainEncumbered() public {
        Snap memory before = flowBegin(0.55 gwei, 0.5 gwei, 0);
        recorded = true;
        flowReport("flow-reporting", before, new Fact[](0));
        string memory report = vm.readFile("test/fixtures/flow-reporting.json");
        assertTrue(LibString.contains(report,
            '"name":"unknown","held":"200000000000000000","need":null,"above_need":null,"bps":null'));
        assertEq(vm.parseJsonString(report, ".buckets[1].need"), "1700000000000000000");
        assertEq(vm.parseJsonString(report, ".buckets[1].above_need"), "0");
        assertEq(vm.parseJsonString(report, ".buckets[2].above_need"), "10000000000000000");
        assertEq(vm.parseJsonString(report, ".buckets[3].above_need"), "0");
        assertEq(vm.parseJsonString(report, ".buckets[4].above_need"), "10000000000000000");
        assertEq(vm.parseJsonArrayLength(report, ".mismatches"), 0);
        // The golden report is itself hashed evidence; never embed that hash back into its own input.
        vm.writeJson('""', "test/fixtures/flow-reporting.json", ".source_hash");
    }
}
