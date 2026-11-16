// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "../utils/ForkBase.sol";
import {PoolBalancer} from "../../src/PoolBalancer.sol";
import {console} from "forge-std/console.sol";

/// @dev Reads tx.gasprice and basefee from inside a state-changing call.
contract GasProbe {
    uint256 public gp;
    uint256 public bf;

    function hit() external {
        gp = tx.gasprice;
        bf = block.basefee;
    }
}

/// @notice Measures the information figures in O10's text (asset-flow.json): what a player pays against the Shape
///         backing of a draw outside the launch board at steady normal gas, which the gate itself checks. Ported from
///         the step-B launch audit (`audit/launch-05e6b60-B/AttackB.t.sol.txt`) so the figures can be rerun after any
///         change. Run: forge test --match-path test/audit/O10Ratios.t.sol --gas-limit 100000000000 -vv
contract O10Ratios is ForkBase {
    uint8 internal constant SHAPE_KIND = 2;
    GasProbe internal probe;

    function setUp() public {
        setUpFork();
        probe = new GasProbe();
    }

    function _gas(uint256 basefee, uint256 price) internal {
        vm.fee(basefee);
        vm.txGasPrice(price);
        probe.hit();
        assertEq(probe.gp(), price, "tx.gasprice reached the call");
        assertEq(probe.bf(), basefee, "basefee reached the call");
    }

    function _launchBoard() internal pure returns (uint256[16] memory c) {
        // FlowBreakdown's launch board: 24 x 0.01, 8 x 0.02 pack, 12 x 0.05, 2 x 0.1, 1 x 0.5
        (c[0], c[9], c[1], c[2], c[3]) = (24, 8, 12, 2, 1);
    }

    function _open(uint256[16] memory c, uint16 markup, uint256 deposit, uint256 nftBase) internal {
        createBalancer(deposit);
        vm.prank(creator);
        balancer.configure(markup, plan16(c));
        listCurated(1, nftBase);
        vm.prank(creator);
        balancer.open();
        for (uint256 i; i < 200; ++i) {
            vm.prank(keeper, keeper);
            try balancer.performUpkeep() {} catch { break; }
        }
        assertEq(balancer.admissionStatus(), 0, "open");
    }

    /// @dev O10's metric: FWA's all-in quote for one draw against the Shape backing weighted as FWA weighs draws.
    function _ratioBps() internal view returns (uint256) {
        (,, uint256 total) = pool.quoteAcquisitionPrice(1);
        uint256 w;
        uint256 wb;
        uint256[] memory ids = balancer.getActiveIds();
        for (uint256 k; k < ids.length; ++k) {
            (,,,, uint256 weight,,, uint8 st) = pool.listings(ids[k]);
            if (st != 1) continue;
            w += weight;
            (uint8 kind, uint8 d,,,) = balancer.items(ids[k]);
            if (kind == SHAPE_KIND) wb += weight * balancer.denominationAmount(d);
        }
        return total * 10_000 * w / wb;
    }

    function _play(uint256 n, bytes32 tag, uint256 relistFrom) internal returns (uint256 sold) {
        for (uint256 i; i < n; ++i) {
            // a won NFT is relisted as the creator would, so the gate stays open
            if (balancer.admissionStatus() == 3) listCurated(relistFrom + i, 0.2 ether);
            if (balancer.admissionStatus() != 0) break;
            uint256[] memory r = buy(buyer, 1);
            fulfill(r[0], uint256(keccak256(abi.encode(tag, i))));
            settle();
            fillUp();
            ++sold;
        }
    }

    function test_launchBoardAtNormalGas() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 r = _ratioBps();
        console.log("launch board, markup 25%, basefee 0.1 gwei: price/backing bps", r);
        assertLe(r, 15_000, "O10 holds on the launch board");
    }

    function test_launchBoardAtMaxMarkup() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 10_000, 10 ether, 0.2 ether);
        uint256 r = _ratioBps();
        console.log("launch board, markup 100%, basefee 0.1 gwei: price/backing bps", r);
        assertGt(r, 15_000, "a creator's own markup can exceed 1.5x");
    }

    function test_launchBoardAtMinMarkup() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 1_000, 10 ether, 0.2 ether);
        console.log("launch board, markup 10%, basefee 0.1 gwei: price/backing bps", _ratioBps());
    }

    function test_smallestBoard() public {
        uint256[16] memory c;
        c[0] = 1;
        _gas(0.1 gwei, 0.15 gwei);
        _open(c, 2_500, 1 ether, 0.2 ether);
        console.log("one 0.01 Shape, markup 25%, basefee 0.1 gwei: price/backing bps", _ratioBps());
    }

    /// @dev Prices are fixed at listing, so a spike's restocking fee stays in every prize relisted during it.
    function test_afterSpike() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 before = _ratioBps();
        _gas(4.95 gwei, 5 gwei);
        uint256 sold = _play(60, "spike", 100);
        _gas(0.1 gwei, 0.15 gwei);
        uint256 afterSpike = _ratioBps();
        console.log("draws sold during the 5 gwei spike", sold);
        console.log("ratio at 0.1 gwei before the spike (bps)", before);
        console.log("ratio at 0.1 gwei after the spike (bps)", afterSpike);
        assertGt(afterSpike, 15_000, "after a spike prices stay higher until restocked");
    }

    function test_spikeRecovery() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        _gas(1.95 gwei, 2 gwei);
        _play(30, "spike2", 100);
        _gas(0.1 gwei, 0.15 gwei);
        console.log("after 30 draws at 2 gwei, ratio at 0.1 gwei (bps)", _ratioBps());
        uint256 n;
        for (uint256 i; i < 400 && _ratioBps() > 15_000; ++i) n += _play(1, keccak256(abi.encode("calm", i)), 1000 + i);
        console.log("draws at 0.1 gwei until the ratio is back under 1.5x", n);
        console.log("ratio then (bps)", _ratioBps());
    }

    /// @dev 20 NFTs the creator values at 50 ETH each: won almost never, yet each raises FWA's draw price.
    function test_overpricedCurated() public {
        _gas(0.1 gwei, 0.15 gwei);
        _open(_launchBoard(), 2_500, 10 ether, 0.2 ether);
        uint256 before = _ratioBps();
        PoolBalancer.CuratedInput[] memory in_ = new PoolBalancer.CuratedInput[](20);
        vm.startPrank(creator);
        for (uint256 k; k < 20; ++k) {
            nft.mint(creator, 900 + k);
            nft.approve(address(balancer), 900 + k);
            in_[k] = PoolBalancer.CuratedInput(address(nft), 900 + k, 50 ether);
        }
        balancer.listCuratedBatch(in_);
        vm.stopPrank();
        _gas(0.1 gwei, 0.15 gwei);
        console.log("ratio before (bps)", before);
        console.log("ratio with 20 NFTs valued at 50 ETH (bps)", _ratioBps());
        assertEq(balancer.admissionStatus(), 0, "still admitted");
    }
}
