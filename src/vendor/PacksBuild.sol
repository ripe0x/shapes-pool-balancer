// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Compiles the Draw Packs contracts (vendored in lib/shape-packs, MIT) so their bytecode is available to deploy an
// instance. Nothing in this file is deployed.
import {ShapePacks} from "packs/ShapePacks.sol";
import {ShapePackRenderer} from "packs/ShapePackRenderer.sol";
