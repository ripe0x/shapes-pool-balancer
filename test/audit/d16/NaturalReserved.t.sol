// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D16WorstUpkeepTest, IFwaExtra} from "./WorstUpkeep.t.sol";

/// @notice D16 re-attack, ordinary play only: no creator action after opening, no hostile party. Draws reserve the
///         Balancer's own staged restocks (restocked while other draws were in flight), lose FWA's fast path and wait
///         for upkeep. How heavy is the upkeep that processes two of them on the launch board?
contract D16NaturalReservedTest is D16WorstUpkeepTest {
    function _wordWinningPack(uint256 req, uint256 n, bytes memory salt) internal returns (uint256) {
        for (uint256 k; k < 300; ++k) {
            uint256 w = uint256(keccak256(abi.encode(salt, k)));
            uint256 snap = vm.snapshotState();
            fulfill(req, w);
            pool.processAcquisitions(n);
            (,,, uint256 lid, uint8 st,) = pool.acquisitions(req);
            (, uint8 d,,,) = balancer.items(lid);
            vm.revertToState(snap);
            if (st == 2 && d == 9) return w;
        }
        revert("no pack word");
    }

    function _keeperUntilIdle() internal {
        for (uint256 i; i < 10; ++i) {
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {} catch { return; }
        }
    }

    function test_naturalReservedRestocks() public {
        _setGas(0.5 gwei, 0.55 gwei);
        _launchBoard();
        uint256[4] memory r;
        for (uint256 i; i < 4; ++i) r[i] = buy(i % 2 == 0 ? buyer : stranger, 1)[0];
        for (uint256 i; i < 3; ++i) fulfill(r[i], _wordWinningPack(r[i], 1, abi.encode("n", i))); // fast path
        _keeperUntilIdle(); // reconciles 3 packs, restocks them: staged, draw 4 is in flight
        uint256 e = buy(buyer, 1)[0];
        uint256 resE = IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence());
        fulfill(r[3], _wordWinningPack(r[3], 1, "n3")); // fast path: draw 4 is the head and reserved nothing
        _keeperUntilIdle(); // reconciles draw 4, restocks: staged, draw e is in flight
        uint256 f = buy(stranger, 1)[0];
        uint256 resF = IFwaExtra(address(pool)).reservedListingCount(pool.lastIssuedSequence());
        emit log_named_uint("listings reserved by draw e", resE);
        emit log_named_uint("listings reserved by draw f", resF);
        fulfill(e, _wordWinningPack(e, 1, "e"));
        fulfill(f, _wordWinningPack(f, 2, "f"));
        assertEq(pool.unsettledAcquisitionCount(), 2, "reached: two ready draws wait for upkeep");
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        pool.processAcquisitions(2);
        emit log_named_uint("processAcquisitions(2) alone, gas", g - gasleft());
        vm.revertToState(snap);
        (uint256 reward, uint256 billed, uint256 measured) = _measure(0.5 gwei, 0.55 gwei);
        assertEq(pool.unsettledAcquisitionCount(), 0, "upkeep processed both");
        emit log_named_uint("measured inside performUpkeep (capped at 3.2M)", measured);
        emit log_named_uint("billed gas incl. 21000", billed);
        emit log_named_int("keeper margin at 0.55 gwei (wei)", int256(reward) - int256(billed * 0.55 gwei));
    }
}
