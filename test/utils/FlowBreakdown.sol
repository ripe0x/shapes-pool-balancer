// SPDX-License-Identifier: MIT
pragma solidity >=0.8.20;

import {Test} from "forge-std/Test.sol";

/// @dev Reads tx.gasprice and block.basefee from inside a state-changing call (Foundry runs those at 0 unless set).
contract GasProbe {
    uint256 public gasPrice;
    uint256 public baseFee;

    function record() external {
        gasPrice = tx.gasprice;
        baseFee = block.basefee;
    }
}

/// @notice Asset-flow kit. The project supplies five small views (cumulative counters and current holdings); the kit
///         diffs two snapshots, prints where every inflow ended up, where assets sit against each holder's own need,
///         and which one-way flows have a return path, cross-checks counters against holdings, and writes one JSON
///         scorecard per regime for asset_gate.py. Amounts are wei (or any integer unit); names must not contain `"`.
///         Usage: `Snap a = flowBegin(gas, basefee, forkBlock); ...drive the regime...; flowReport("quiet", a, facts);`
abstract contract FlowBreakdown is Test {
    struct Item { string name; uint256 amount; } // cumulative counter
    struct Bucket { string name; uint256 held; bool hasImplied; uint256 implied; bool hasNeed; uint256 need; }
    struct Flow { string name; uint256 amount; bool hasReturn; uint256 returned; } // cumulative, bucket to bucket
    struct Fact { string key; uint256 value; } // proof the regime reached its claimed state
    struct Snap { Item[] inflows; Item[] outflows; Bucket[] buckets; Flow[] flows; }
    struct Out { int256 base; string dest; string bk; string fl; string mm; }

    /// @dev Cumulative amounts that entered the system from outside.
    function flowInflows() internal view virtual returns (Item[] memory);
    /// @dev Cumulative amounts that left the system or were spent (not held anywhere in it).
    function flowOutflows() internal view virtual returns (Item[] memory);
    /// @dev Current holdings. `implied` = what the contract's own counters say it should hold; `need` = its stated need.
    function flowBuckets() internal view virtual returns (Bucket[] memory);
    /// @dev Cumulative flows between buckets, with the matching return counter where one exists.
    function flowFlows() internal view virtual returns (Flow[] memory);
    /// @dev Directory (inside fs_permissions read-write) for the regime JSON files.
    function flowDir() internal view virtual returns (string memory);
    /// @dev Largest counter-versus-holding gap (and inflow-versus-destination gap) that is rounding, not a finding.
    function flowTolerance() internal view virtual returns (uint256) { return 0; }

    GasProbe private fbProbe;
    uint256 private fbGas;
    uint256 private fbFee;
    uint256 private fbBlock;

    function flowSnap() internal view returns (Snap memory s) {
        s.inflows = flowInflows();
        s.outflows = flowOutflows();
        s.buckets = flowBuckets();
        s.flows = flowFlows();
    }

    /// @dev Sets and proves the gas price and basefee inside a state-changing call, then snapshots.
    function flowBegin(uint256 gasPrice_, uint256 baseFee_, uint256 forkBlock_) internal returns (Snap memory) {
        require(gasPrice_ != 0 && baseFee_ != 0, "declare non-zero gas price and basefee");
        (fbGas, fbFee, fbBlock) = (gasPrice_, baseFee_, forkBlock_);
        vm.txGasPrice(gasPrice_);
        vm.fee(baseFee_);
        fbProbe = new GasProbe();
        fbCheckGas();
        return flowSnap();
    }

    function fbCheckGas() private {
        fbProbe.record();
        assertEq(fbProbe.gasPrice(), fbGas, "tx.gasprice inside a state-changing call");
        assertEq(fbProbe.baseFee(), fbFee, "block.basefee inside a state-changing call");
    }

    function flowReport(string memory regime, Snap memory a, Fact[] memory reached) internal {
        fbCheckGas();
        Snap memory b = flowSnap();
        Out memory r;
        for (uint256 i; i < b.inflows.length; ++i) r.base += int256(b.inflows[i].amount) - int256(a.inflows[i].amount);
        fbLog("");
        fbLog(string.concat("FLOW BREAKDOWN  ", regime, "   gas ", vm.toString(fbProbe.gasPrice()), " / basefee ",
            vm.toString(fbProbe.baseFee()), " wei, fork block ", vm.toString(fbBlock)));
        fbLog("TABLE 1  Where the inflows went");
        for (uint256 i; i < b.inflows.length; ++i) {
            fbRow(string.concat("in: ", b.inflows[i].name), int256(b.inflows[i].amount) - int256(a.inflows[i].amount), r.base);
        }
        fbDestinations(a, b, r);
        fbLog("TABLE 2  Where assets sit at the end (held, what counters imply, own stated need)");
        fbBuckets(b, r);
        fbLog("TABLE 3  One-way flows (amount | return)");
        fbFlows(a, b, r);
        fbWrite(regime, reached, r);
    }

    function fbDestinations(Snap memory a, Snap memory b, Out memory r) private {
        int256 dest;
        for (uint256 i; i < b.outflows.length; ++i) {
            int256 d = int256(b.outflows[i].amount) - int256(a.outflows[i].amount);
            dest += d;
            fbRow(b.outflows[i].name, d, r.base);
            r.dest = fbAdd(r.dest, fbItem(b.outflows[i].name, d, r.base));
        }
        for (uint256 i; i < b.buckets.length; ++i) {
            int256 d = int256(b.buckets[i].held) - int256(a.buckets[i].held);
            dest += d;
            string memory n = string.concat("held in ", b.buckets[i].name, " (change)");
            fbRow(n, d, r.base);
            r.dest = fbAdd(r.dest, fbItem(n, d, r.base));
        }
        fbGap("inflows - destinations", r.base - dest, r);
    }

    function fbBuckets(Snap memory b, Out memory r) private {
        for (uint256 i; i < b.buckets.length; ++i) {
            Bucket memory k = b.buckets[i];
            fbRow(string.concat(k.name, ": held"), int256(k.held), r.base);
            if (k.hasImplied) {
                fbRow("  counters imply", int256(k.implied), r.base);
                fbGap(string.concat(k.name, ": held - counters"), int256(k.held) - int256(k.implied), r);
            }
            uint256 above = k.hasNeed ? (k.held > k.need ? k.held - k.need : 0) : k.held;
            if (k.hasNeed) fbRow("  stated need", int256(k.need), r.base);
            fbRow(k.hasNeed ? "  ABOVE its need" : "  ABOVE (states no need)", int256(above), r.base);
            r.bk = fbAdd(r.bk, string.concat(
                '{"name":"', k.name, '","held":"', vm.toString(k.held), '","need":', k.hasNeed ? string.concat('"', vm.toString(k.need), '"') : "null",
                ',"above_need":"', vm.toString(above), '","bps":', vm.toString(fbBps(int256(above), r.base)), "}"
            ));
        }
    }

    function fbFlows(Snap memory a, Snap memory b, Out memory r) private {
        for (uint256 i; i < b.flows.length; ++i) {
            Flow memory f = b.flows[i];
            int256 amt = int256(f.amount) - int256(a.flows[i].amount);
            int256 ret = int256(f.returned) - int256(a.flows[i].returned);
            fbLog(string.concat("  ", fbPad(f.name, 64), fbPadL(fbE(amt), 14), " ", fbPadL(fbPct(fbBps(amt, r.base)), 9), "  | ",
                f.hasReturn ? string.concat("returned ", fbE(ret)) : "no return path"));
            r.fl = fbAdd(r.fl, string.concat(
                '{"name":"', f.name, '","wei":"', vm.toString(amt), '","has_return":', f.hasReturn ? "true" : "false",
                ',"returned":"', vm.toString(f.hasReturn ? ret : int256(0)), '","bps":', vm.toString(fbBps(amt, r.base)), "}"
            ));
        }
    }

    function fbGap(string memory label, int256 gap, Out memory r) private {
        fbLog(string.concat("  ", fbPad(label, 70), fbPadL(vm.toString(gap), 24), " wei"));
        uint256 mag = gap < 0 ? uint256(-gap) : uint256(gap);
        if (mag > flowTolerance()) {
            fbLog(string.concat("  MISMATCH: ", label, " = ", vm.toString(gap), " wei (tolerance ", vm.toString(flowTolerance()), ")"));
            r.mm = fbAdd(r.mm, string.concat('{"name":"', label, '","gap_wei":"', vm.toString(gap), '"}'));
        }
    }

    function fbWrite(string memory regime, Fact[] memory reached, Out memory r) private {
        string memory facts;
        for (uint256 i; i < reached.length; ++i) {
            facts = fbAdd(facts, string.concat('"', reached[i].key, '":', vm.toString(reached[i].value)));
        }
        string memory json = string.concat(
            '{"regime":"', regime, '","source_hash":"', vm.envOr("SOURCE_HASH", string("")), '","gas_price":',
            vm.toString(fbProbe.gasPrice()), ',"base_fee":', vm.toString(fbProbe.baseFee()), ',"fork_block":', vm.toString(fbBlock),
            ',"reached":{', facts, '},"inflow_base":"', vm.toString(r.base), '","destinations":[', r.dest
        );
        json = string.concat(json, '],"buckets":[', r.bk, '],"flows":[', r.fl, '],"mismatches":[', r.mm, "]}");
        vm.createDir(flowDir(), true);
        vm.writeFile(string.concat(flowDir(), "/", regime, ".json"), json);
    }

    // ---- output helpers

    function fbItem(string memory n, int256 d, int256 base) private pure returns (string memory) {
        return string.concat('{"name":"', n, '","wei":"', vm.toString(d), '","bps":', vm.toString(fbBps(d, base)), "}");
    }

    function fbAdd(string memory list, string memory item) private pure returns (string memory) {
        return bytes(list).length == 0 ? item : string.concat(list, ",", item);
    }

    function fbBps(int256 v, int256 base) private pure returns (int256) {
        return base == 0 ? int256(0) : v * 10_000 / base;
    }

    function fbRow(string memory label, int256 amt, int256 base) private {
        fbLog(string.concat("  ", fbPad(label, 70), fbPadL(fbE(amt), 14), " ", fbPadL(fbPct(fbBps(amt, base)), 9)));
    }

    function fbLog(string memory s) private {
        emit log_string(s);
    }

    function fbE(int256 w) private pure returns (string memory) {
        uint256 m = w < 0 ? uint256(-w) : uint256(w);
        string memory f = vm.toString((m % 1e18) / 1e14);
        while (bytes(f).length < 4) f = string.concat("0", f);
        return string.concat(w < 0 ? "-" : "", vm.toString(m / 1e18), ".", f);
    }

    function fbPct(int256 bps) private pure returns (string memory) {
        uint256 m = bps < 0 ? uint256(-bps) : uint256(bps);
        string memory f = vm.toString(m % 100);
        if (m % 100 < 10) f = string.concat("0", f);
        return string.concat(bps < 0 ? "-" : "", vm.toString(m / 100), ".", f, "%");
    }

    function fbPad(string memory s, uint256 n) private pure returns (string memory) {
        while (bytes(s).length < n) s = string.concat(s, " ");
        return s;
    }

    function fbPadL(string memory s, uint256 n) private pure returns (string memory) {
        while (bytes(s).length < n) s = string.concat(" ", s);
        return s;
    }
}
