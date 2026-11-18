// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase, IVRFService} from "../../utils/ForkBase.sol";
import {GasProbe} from "../../utils/FlowBreakdown.sol";

/// @notice Liveness under sustained play after D16 F1 (a call that processes skips restocking). One block per step:
///         randomness arrives `lat` blocks after a purchase (through the real VRF service), a buyer buys `per` draws
///         whenever admission is OK, and one keeper calls upkeep once per block. Counts why sales were refused.
contract D16bSustainedPlayTest is ForkBase {
    uint256[] reqs;
    uint256[] readyAt;
    uint256 head;

    function setUp() public {
        setUpFork();
    }

    function _setGas(uint256 basefee, uint256 bid) internal {
        vm.fee(basefee);
        vm.txGasPrice(bid);
        GasProbe probe = new GasProbe();
        probe.record();
        assertEq(probe.baseFee(), basefee);
        assertEq(probe.gasPrice(), bid);
    }

    function _shapes() internal view returns (uint256 n) {
        uint16[16] memory a = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) n += a[d];
    }

    bool buyFirst;

    function _fulfillDue(uint256 now_) internal {
        while (head < reqs.length && readyAt[head] <= now_) {
            uint256[] memory w = new uint256[](1);
            w[0] = uint256(keccak256(abi.encode(reqs[head], "sp")));
            vm.prank(IVRFService(VRF_SERVICE).coordinator());
            IVRFService(VRF_SERVICE).rawFulfillRandomWords{gas: 5_000_000}(reqs[head], w);
            ++head;
        }
    }

    function _play(uint256 blocks, uint256 per, uint256 lat) internal {
        _setGas(0.1 gwei, 0.15 gwei);
        createBalancer(10 ether);
        uint256[16] memory c;
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        for (uint256 i; i < 10; ++i) listCurated(1 + i, 0.2 ether);
        vm.prank(creator);
        balancer.open();
        fillUp();
        uint256[8] memory status;
        uint256 sold;
        uint256 procCalls;
        uint256 restockCalls;
        uint256 minShapes = type(uint256).max;
        for (uint256 b; b < blocks; ++b) {
            vm.roll(vm.getBlockNumber() + 1);
            uint256 now_ = vm.getBlockNumber();
            if (!buyFirst) _fulfillDue(now_);
            uint8 st = balancer.admissionStatus();
            status[st]++;
            if (st == 0) {
                uint256 n = per;
                uint256 room = 5 - pool.unsettledAcquisitionCount();
                if (n > room) n = room;
                uint256[] memory ids = buy(buyer, n);
                for (uint256 i; i < ids.length; ++i) {
                    reqs.push(ids[i]);
                    readyAt.push(now_ + lat);
                }
                sold += ids.length;
            }
            if (buyFirst) _fulfillDue(now_);
            uint64 nx = pool.nextSequenceToProcess();
            uint256 sh = _shapes();
            bytes32 uh1 = balancer.settingsHash();
            vm.prank(keeper, keeper);
            try balancer.performUpkeep(uh1, 0, 0) {
                if (pool.nextSequenceToProcess() != nx) ++procCalls;
                if (_shapes() > sh || pool.nextSequenceToProcess() == nx) ++restockCalls;
            } catch {}
            uint256 s2 = _shapes();
            if (s2 < minShapes) minShapes = s2;
        }
        emit log_named_uint("blocks", blocks);
        emit log_named_uint("draws per purchase", per);
        emit log_named_uint("randomness latency (blocks)", lat);
        emit log_named_uint("sold", sold);
        emit log_named_uint("blocks OK", status[0]);
        emit log_named_uint("blocks BUSY", status[4]);
        emit log_named_uint("blocks LOW_INVENTORY", status[6]);
        emit log_named_uint("blocks SETTING_UP", status[2]);
        emit log_named_uint("blocks NO_CURATED", status[3]);
        emit log_named_uint("blocks MINT_FEE_ROSE", status[5]);
        emit log_named_uint("upkeeps that processed", procCalls);
        emit log_named_uint("upkeeps that did not process (restock/reconcile)", restockCalls);
        emit log_named_uint("fewest listed prizes", minShapes);
        emit log_named_uint("listed prizes at end", _shapes());
        assertEq(status[6], 0, "skipping restock after processing never ran inventory low");
    }

    function test_sustained_one_per_block_lat2() public {
        _play(150, 1, 2);
    }

    function test_sustained_five_per_block_lat2() public {
        _play(150, 5, 2);
    }

    function test_sustained_five_per_block_lat5() public {
        _play(150, 5, 5);
    }

    function test_sustained_buyFirst_one_per_block_lat2() public {
        buyFirst = true;
        _play(150, 1, 2);
    }

    function test_sustained_buyFirst_five_per_block_lat2() public {
        buyFirst = true;
        _play(150, 5, 2);
    }

    function test_sustained_buyFirst_two_per_block_lat1() public {
        buyFirst = true;
        _play(150, 2, 1);
    }
}
