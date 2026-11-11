// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @notice Records real FWA prices, odds and reserves on a fork for the TypeScript planner parity
///         test (shared/planner.test.ts). Regenerate with: forge test --match-path test/Parity.t.sol
///         Each case records the target (packed counts), curated bases, markup, mint fee, the FWA draw
///         price and curated odds once the target is fully listed, and `requiredReserve()` while open and
///         fully reconciled (no draws): deficit 0 + 1 largest prize + (ceil(3/6)+1)=2 keeper rewards.
contract ParityFixture is ForkBase {
    string json;
    uint256 n;

    function setUp() public {
        setUpFork();
    }

    function _case(uint16 markup, uint256[] memory bases, uint256 target) internal {
        address c = makeAddr(string.concat("creator", vm.toString(n)));
        vm.deal(c, 1_000 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 200 ether}(bytes32(0))));
        // Configure the markup first so the curated NFTs are listed at that markup: the planner models every
        // listing at the current markup, which the contract only produces when nothing predates the markup
        // (listings made before `configure`, or before a markup change, keep their original price).
        vm.startPrank(c);
        b.configure(markup, target);
        for (uint256 i; i < bases.length; ++i) {
            uint256 id = 10_000 * (n + 1) + i;
            nft.mint(c, id);
            nft.approve(address(b), id);
            b.listCurated(address(nft), id, bases[i]);
        }
        b.open();
        vm.stopPrank();
        // Fully list the target (the gate opens at 70% inventory; the fixture needs every prize listed).
        for (uint256 i; i < 40; ++i) {
            vm.prank(keeper, keeper);
            try b.performUpkeep() {} catch {
                break;
            }
        }
        require(b.admissionStatus() == 0, "not admitted");
        {
            uint16[16] memory have = b.getActiveShapes();
            for (uint256 d; d < 16; ++d) {
                require(have[d] == (target >> (16 * d)) & 0xFFFF, "target not fully listed");
            }
        }
        // No draws have occurred, so lastIssuedSequence == reconciledSequence: requiredReserve() holds the
        // reconciled-open reserve the TS planner computes with requiredReserveAt(target, target, mintFee).
        require(b.pool().lastIssuedSequence() == b.reconciledSequence(), "unreconciled");
        uint256 cW;
        uint256[] memory ids = b.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = b.items(ids[i]);
            (,,,, uint256 w,,,) = b.pool().listings(ids[i]);
            if (kind == 1) cW += w;
        }
        string memory key = vm.toString(n);
        string memory o = "case";
        vm.serializeUint(o, "markupBps", markup);
        vm.serializeUint(o, "bases", bases);
        vm.serializeString(o, "target", vm.toString(target));
        vm.serializeString(o, "drawPrice", vm.toString(b.pool().acquisitionFee()));
        vm.serializeString(o, "curatedOddsBps", vm.toString(cW * 10_000 / b.pool().totalWeight()));
        vm.serializeString(o, "mintFee", vm.toString(shapes.mintFee()));
        string memory out = vm.serializeString(o, "reserve", vm.toString(b.requiredReserve()));
        json = vm.serializeString("root", key, out);
        ++n;
    }

    function _bases(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        uint256 len = c == 0 ? (b == 0 ? 1 : 2) : 3;
        r = new uint256[](len);
        r[0] = a;
        if (len > 1) r[1] = b;
        if (len > 2) r[2] = c;
    }

    function test_writeParityFixture() public {
        _case(1500, _bases(0.3 ether, 0.5 ether, 0), plan([uint256(5), 3, 2, 0, 0, 0, 0, 0, 0]));
        _case(0, _bases(1 ether, 0, 0), plan([uint256(0), 0, 4, 1, 0, 0, 0, 0, 0]));
        _case(3000, _bases(2.5 ether, 0.77 ether, 13 ether), plan([uint256(0), 0, 0, 2, 3, 1, 0, 0, 0]));
        _case(777, _bases(0.123456789 ether, 4.2 ether, 0), plan([uint256(3), 0, 7, 0, 1, 0, 0, 0, 0]));
        _case(10_000, _bases(50 ether, 0, 0), plan([uint256(0), 0, 0, 0, 0, 0, 1, 1, 0]));
        // Pack sizes (9-15: 0.02, 0.03, 0.2, 0.25, 2, 2.5, 25 ETH), alone and mixed with Shapes.
        _case(1500, _bases(0.3 ether, 0, 0), plan16([uint256(4), 0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 0, 1, 0, 0, 0]));
        _case(2500, _bases(1.5 ether, 0.05 ether, 0), plan16([uint256(0), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 0]));
        vm.writeJson(json, "./test/fixtures/parity.json");
    }
}
