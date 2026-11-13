// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {PriceCapsMeasure} from "../scenario/PriceCaps.t.sol";
contract NormalGasBoundary is PriceCapsMeasure {
    function test_normalBoundaryAtPointOneGwei() public { _measure(0.1 gwei); }
}
