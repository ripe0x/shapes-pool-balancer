// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ForkBase} from "./utils/ForkBase.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";

/// @notice Records real FWA prices, odds and reserves on a fork for the TypeScript planner parity
///         test (shared/planner.test.ts). Regenerate with: forge test --match-contract Parity
contract ParityFixture is ForkBase {
    string json;
    uint256 n;

    function setUp() public {
        setUpFork();
    }

    function _case(uint16 markup, uint256[] memory bases, uint256 p) internal {
        address c = makeAddr(string.concat("creator", vm.toString(n)));
        vm.deal(c, 1_000 ether);
        vm.prank(c);
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 200 ether}(bytes32(0))));
        vm.startPrank(c);
        for (uint256 i; i < bases.length; ++i) {
            uint256 id = 10_000 * (n + 1) + i;
            nft.mint(c, id);
            nft.approve(address(b), id);
            b.listCurated(address(nft), id, bases[i]);
        }
        uint256[] memory plans = new uint256[](1);
        plans[0] = p;
        b.configure(PoolBalancer.Config(type(uint128).max, 200 ether, 0, markup), plans);
        b.open();
        vm.stopPrank();
        for (uint256 i; i < 12 && b.admissionStatus() != 0; ++i) {
            b.performUpkeep();
        }
        require(b.admissionStatus() == 0, "not admitted");
        uint256 cW;
        uint256[] memory ids = b.getActiveIds();
        for (uint256 i; i < ids.length; ++i) {
            (uint8 kind,,,,) = b.items(ids[i]);
            (,,,, uint256 w,,,) = b.pool().listings(ids[i]);
            if (kind == 1) cW += w;
        }
        (,,,, uint256 reserve) = b.checkpoint();
        string memory key = vm.toString(n);
        string memory o = "case";
        vm.serializeUint(o, "markupBps", markup);
        vm.serializeUint(o, "bases", bases);
        vm.serializeString(o, "plan", vm.toString(p));
        vm.serializeString(o, "drawPrice", vm.toString(b.pool().acquisitionFee()));
        vm.serializeString(o, "curatedOddsBps", vm.toString(cW * 10_000 / b.pool().totalWeight()));
        vm.serializeString(o, "mintFee", vm.toString(shapes.mintFee()));
        string memory out = vm.serializeString(o, "reserve", vm.toString(reserve));
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
        vm.writeJson(json, "./test/fixtures/parity.json");
    }
}
