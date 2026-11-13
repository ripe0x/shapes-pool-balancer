// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";

/// @notice Creator economics on a mainnet fork with the real FWA pool, VRF service, Shapes and Draw Packs.
///         Default: ape-ball's observed draw curve (43, 44, 54, 18, 0, then 1 a day; 184 draws over 30 days), the
///         Balanced board at 12 small Shapes, a 0.2 ETH NFT relisted when won, 25% markup, 1 gwei. The creator claims
///         everything claimable after every draw. A player who finds purchases refused leaves.
///         Every run ends with the full closeout (close, unlist every prize, withdraw the NFT, claim everything), so
///         the creator's ETH result is realized, not estimated, and the Balancer must end empty.
///         Scenario knobs (env): ECON_MARKUP (bps), ECON_SMALL (small Shapes in the Balanced board), ECON_PER_DAY and
///         ECON_DAYS (a steady curve instead of ape-ball's), ECON_RUNS. Long runs need --gas-limit 100000000000.
contract EconForkTest is ForkBase {
    uint8 constant SHAPE_KIND = 2;
    uint8 constant CURATED_KIND = 1;
    uint256 constant NFT_VALUE = 0.2 ether;

    uint256 nextNft = 1;
    uint256 deposited = 5 ether;
    uint256 markup;
    uint256[] perDay;

    function setUp() public {
        setUpFork();
        markup = vm.envOr("ECON_MARKUP", uint256(2500));
        uint256 small = vm.envOr("ECON_SMALL", uint256(12));
        uint256 steady = vm.envOr("ECON_PER_DAY", uint256(0));
        if (steady == 0) {
            uint256[6] memory ape = [uint256(43), 44, 54, 18, 0, 1];
            for (uint256 i; i < 30; ++i) perDay.push(i < 6 ? ape[i] : 1);
        } else {
            uint256 days_ = vm.envOr("ECON_DAYS", uint256(30));
            for (uint256 i; i < days_; ++i) perDay.push(steady);
        }
        createBalancer(deposited);
        // shared/design.ts Balanced board: per 24 small Shapes, 8 x 0.02 pack, 12 x 0.05, 2 x 0.1, 1 x 0.5, rounded
        // half up, at least one 0.1.
        uint256[16] memory c;
        c[0] = small;
        c[9] = (small * 8 + 12) / 24;
        c[1] = (small * 12 + 12) / 24;
        c[2] = (small * 2 + 12) / 24;
        if (c[2] == 0) c[2] = 1;
        c[3] = (small + 12) / 24;
        vm.prank(creator);
        balancer.configure(uint16(markup), plan16(c));
        listCurated(nextNft++, NFT_VALUE);
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

    function _fund() internal view returns (uint256) {
        return address(balancer).balance - balancer.profit();
    }

    function _backing() internal view returns (uint256 b) {
        uint16[16] memory a = balancer.getActiveShapes();
        for (uint256 d; d < 16; ++d) b += uint256(a[d]) * balancer.denominationAmount(d);
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
        revert("no 0.5 Shape listed");
    }

    /// @dev Close, unlist every prize (redeemed for its backing), withdraw every NFT and claim everything.
    function _closeOut() internal {
        vm.prank(creator);
        balancer.close();
        try this.upkeepOnce() {} catch {}
        uint256[] memory ids = balancer.getActiveIds();
        uint256[] memory shapeIds = new uint256[](ids.length);
        uint256 n;
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = balancer.items(ids[i]);
            if (kind == CURATED_KIND) {
                vm.prank(creator);
                balancer.withdrawCurated(ids[i], creator);
            } else {
                shapeIds[n++] = ids[i];
            }
        }
        for (uint256 i; i < n; i += 20) {
            uint256 m = n - i < 20 ? n - i : 20;
            uint256[] memory chunk = new uint256[](m);
            for (uint256 j; j < m; ++j) chunk[j] = shapeIds[i + j];
            vm.prank(creator);
            balancer.unlistShapes(chunk);
        }
        _claim();
    }

    function upkeepOnce() external {
        vm.prank(keeper, keeper);
        balancer.performUpkeep();
    }

    struct R {
        uint256 draws;
        uint256 refused;
        uint256 bigWins;
        uint256 nfts;
        uint256 dry;
        uint256 topOff;
        uint256 playersPaid;
    }

    /// @param forceBigAt draw index (1-based) whose word selects the 0.5 Shape; 0 for none.
    function _run(uint256 seed, uint256 forceBigAt) internal returns (R memory r) {
        uint256 start = creator.balance;
        uint256 n;
        for (uint256 day; day < perDay.length; ++day) {
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
                assertLe(balancer.profit(), address(balancer).balance, "profit held");
                uint256 f = _fund();
                uint256 need = balancer.requiredReserve();
                if (_claim() == 0) ++r.dry;
                assertGe(_fund(), f < need ? f : need, "a claim never takes the fund");
                if (balancer.getActiveShapes()[3] < ((balancer.target() >> 48) & 0xFFFF)) ++r.topOff;
            }
            vm.warp(block.timestamp + 1 days);
        }
        int256 estimate = int256(creator.balance - start + address(balancer).balance + pool.ownerProceeds() + _backing())
            - int256(deposited);
        _closeOut();
        assertEq(address(balancer).balance, 0, "closeout leaves nothing behind");
        assertEq(balancer.getActiveIds().length, 0, "every listing returned");
        int256 realized = int256(creator.balance - start) - int256(deposited);
        assertEq(realized, estimate, "the closeout realizes the position to the wei");
        emit log_named_uint("seed", seed);
        emit log_named_uint("forced 0.5 at draw", forceBigAt);
        emit log_named_uint("draws sold", r.draws);
        emit log_named_uint("draws refused", r.refused);
        emit log_named_uint("0.5 wins", r.bigWins);
        emit log_named_uint("NFTs won", r.nfts);
        emit log_named_uint("draws with nothing to claim", r.dry);
        emit log_named_uint("draws with a top prize off the board", r.topOff);
        emit log_named_decimal_uint("players paid incl VRF", r.playersPaid, 18);
        emit log_named_decimal_int("creator ETH result after closeout", realized, 18);
        emit log_named_decimal_int("after NFTs given", realized - int256(r.nfts * NFT_VALUE), 18);
    }

    function test_econRandom() public {
        uint256 runs = vm.envOr("ECON_RUNS", uint256(2));
        emit log_named_uint("markup bps", markup);
        emit log_named_decimal_uint("ETH put in", deposited, 18);
        for (uint256 s = 1; s <= runs; ++s) {
            uint256 snap = vm.snapshotState();
            _run(s, 0);
            vm.revertToState(snap);
        }
    }

    /// The 0.5 Shape won early (draw 60) and late (draw 165). Needs a board with a 0.5 Shape (ECON_SMALL >= 12).
    function test_econBigWin() public {
        if (((balancer.target() >> 48) & 0xFFFF) == 0) return;
        uint256 snap = vm.snapshotState();
        _run(100, 60);
        vm.revertToState(snap);
        _run(101, 165);
    }
}
