// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {IFWAPoolFactory} from "../src/interfaces/External.sol";

/// @notice The single deployment path for mainnet and for local fork rehearsal. Values are fixed
///         mainnet addresses; the signer comes from the CLI (--account keystore, --ledger, or
///         --unlocked on a local fork). Never pass a private key on the command line.
///
///   Rehearsal: forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --unlocked --sender <addr> --broadcast
///   Mainnet:   forge script script/Deploy.s.sol --rpc-url https://mainnet.gateway.tenderly.co --account <keystore> --broadcast --verify
contract Deploy is Script {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;

    function run() external returns (BalancerFactory factory, PoolBalancer impl) {
        // Preflight: the chain must still serve the reviewed FWA implementation.
        require(block.chainid == 1 || block.chainid == 31337, "mainnet or local fork only");
        require(IFWAPoolFactory(FWA_FACTORY).implementation() == FWA_IMPL, "FWA implementation changed: re-review");
        require(FWA_IMPL.codehash == FWA_CODEHASH, "FWA implementation code changed: re-review");
        require(IFWAPoolFactory(FWA_FACTORY).maxAcquisitionsPerTx() == 5, "FWA batch limit changed");

        vm.startBroadcast();
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, ENS);
        factory = new BalancerFactory(address(impl));
        vm.stopBroadcast();

        // Postflight readbacks.
        require(factory.implementation() == address(impl), "factory wiring");
        require(impl.creator() == address(1), "implementation not locked");
        require(address(impl.FWA_FACTORY()) == FWA_FACTORY && impl.FWA_IMPLEMENTATION() == FWA_IMPL, "impl wiring");
        require(address(impl.SHAPES()) == SHAPES && address(impl.ENS()) == ENS, "impl wiring");
        require(address(impl).code.length > 0 && address(factory).code.length > 0, "no code");

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", block.number);
        vm.serializeAddress(o, "poolBalancerImplementation", address(impl));
        string memory json = vm.serializeAddress(o, "balancerFactory", address(factory));
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        console.log("PoolBalancer implementation", address(impl));
        console.log("BalancerFactory", address(factory));
    }
}
