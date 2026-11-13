// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";

/// @notice Creator economics on a mainnet fork with the real FWA pool, VRF service, Shapes and Draw Packs, at
///         ape-ball's observed draw curve (43, 44, 54, 18, 0, then 1 a day; 184 draws over 30 days).
///         Balanced at 12 small Shapes, a 0.2 ETH NFT relisted when won, 25% markup, 1 gwei. The creator withdraws
///         everything claimable after every draw. A player who finds purchases refused leaves.
contract EconForkTest is ForkBase {
    uint8 constant SHAPE_KIND = 2;
    uint256 constant NFT_VALUE = 0.2 ether;

    uint256 nextNft = 1;
    uint256 deposited = 2 ether;

    function setUp() public {
        setUpFork();
        createBalancer(deposited);
        listCurated(nextNft++, NFT_VALUE);
        uint256[16] memory c;
        c[0] = 12; // 0.01
        c[1] = 6; // 0.05
        c[2] = 1; // 0.1
        c[3] = 1; // 0.5
        c[9] = 4; // 0.02 pack
        vm.prank(creator);
        balancer.configure(2500, plan16(c));
        vm.prank(creator);
        balancer.open();
        fillUp();
        deposited -= _claim();
    }

    function _claim() internal returns (uint256 s) {
        s = balancer.withdrawableSurplus();
        if (s == 0) return 0;
        vm.prank(creator);
        balancer.claimSurplus(s, creator);
    }

    function _backing() internal view returns (uint256 b) {
        uint16[16] memory a = balancer.getActiveShapes();
        b = uint256(a[0]) * 0.01 ether + uint256(a[1]) * 0.05 ether + uint256(a[2]) * 0.1 ether
            + uint256(a[3]) * 0.5 ether + uint256(a[9]) * 0.02 ether;
    }

    function _bigSlot() internal view returns (uint256 slot) {
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind, uint8 denom,,,) = balancer.items(ids[i]);
            if (kind == SHAPE_KIND && denom == 3) {
                (,,,,,, slot,) = pool.listings(ids[i]);
                return slot;
            }
        }
    }

    struct R {
        uint256 draws;
        uint256 refused;
        uint256 bigWins;
        uint256 nfts;
        uint256 withdrawn;
        uint256 playersPaid;
        uint256 dry;
        uint256 topOff;
    }

    /// @param forceBigAt draw index (1-based) whose word selects the 0.5 Shape; 0 for none.
    function _run(uint256 seed, uint256 forceBigAt) internal returns (R memory r) {
        uint256[30] memory perDay = [uint256(43), 44, 54, 18, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
        uint256 startWithdrawn = creator.balance;
        uint256 n;
        for (uint256 day; day < 30; ++day) {
            for (uint256 k; k < perDay[day]; ++k) {
                ++n;
                if (!balancer.canPurchase(buyer)) {
                    ++r.refused;
                    continue;
                }
                (,, uint256 total) = pool.quoteAcquisitionPrice(1);
                r.playersPaid += total;
                uint256[] memory ids = buy(buyer, 1);
                ++r.draws;
                uint256 word = n == forceBigAt ? wordForSlot(_bigSlot()) : uint256(keccak256(abi.encode(seed, n)));
                fulfill(ids[0], word);
                settle();
                (,,, uint256 lid,,) = pool.acquisitions(ids[0]);
                (uint8 kind, uint8 denom,,,) = balancer.items(lid);
                fillUp();
                if (kind != SHAPE_KIND) {
                    ++r.nfts;
                    listCurated(nextNft++, NFT_VALUE);
                    fillUp();
                } else if (denom == 3) {
                    ++r.bigWins;
                }
                if (_claim() == 0) ++r.dry;
                if (balancer.getActiveShapes()[3] == 0) ++r.topOff;
            }
            vm.warp(block.timestamp + 1 days);
            _claim();
        }
        r.withdrawn = creator.balance - startWithdrawn;
        uint256 position = r.withdrawn + address(balancer).balance + pool.ownerProceeds() + _backing();
        int256 eth = int256(position) - int256(deposited);
        emit log_named_uint("seed", seed);
        emit log_named_uint("forced 0.5 at draw", forceBigAt);
        emit log_named_uint("draws sold", r.draws);
        emit log_named_uint("draws refused", r.refused);
        emit log_named_uint("0.5 wins", r.bigWins);
        emit log_named_uint("NFTs won", r.nfts);
        emit log_named_uint("draws with nothing to claim", r.dry);
        emit log_named_uint("draws with the 0.5 off the board", r.topOff);
        emit log_named_decimal_uint("players paid incl VRF", r.playersPaid, 18);
        emit log_named_decimal_uint("creator withdrew", r.withdrawn, 18);
        emit log_named_decimal_int("creator ETH profit (if closed now)", eth, 18);
        emit log_named_decimal_int("after NFTs given", eth - int256(r.nfts * NFT_VALUE), 18);
        emit log_named_uint("status at end", balancer.admissionStatus());
    }

    /// More runs: ECON_RUNS=10 with --gas-limit 100000000000 (each full run uses about 370M gas).
    function test_apeballCurveRandom() public {
        uint256 runs = vm.envOr("ECON_RUNS", uint256(2));
        for (uint256 s = 1; s <= runs; ++s) {
            uint256 snap = vm.snapshotState();
            _run(s, 0);
            vm.revertToState(snap);
        }
    }

    /// The 0.5 Shape won during launch (draw 60) and after volume falls to 1 a day (draw 165).
    function test_apeballCurveBigWin() public {
        uint256 snap = vm.snapshotState();
        _run(100, 60);
        vm.revertToState(snap);
        _run(101, 165);
    }
}
