// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {KeeperPolicyV1} from "../src/KeeperPolicyV1.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {IFWAPoolFactory, IShapePacks as IPacksView} from "../src/interfaces/External.sol";

/// @dev Getters of the reused Draw Packs instance and renderer that src/interfaces does not declare.
interface IReusedPacks {
    function renderer() external view returns (address);
}

interface IReusedRenderer {
    function shapes() external view returns (address);
}

/// @notice The single deployment path for mainnet and for local fork rehearsal. Values are fixed
///         mainnet addresses; the signer comes from the CLI (--account keystore, --ledger, or
///         --unlocked on a local fork). Never pass a private key on the command line.
///
///         Two dependency modes, chosen by REUSE_DEPENDENCIES (env, default false):
///         - reuse (required on chain 1): the community replacement release. Shapes, the Draw Packs instance, its
///           renderer, the FWA community factory and the reviewed FWA implementation already exist on mainnet and are
///           verified by code hash and getter readbacks before anything is broadcast. Only the linked libraries (Forge
///           skips one whose CREATE2 address already holds its exact init code), the PoolBalancer implementation,
///           KeeperPolicyV1 and BalancerFactory are created.
///         - full (local forks and historical tests): also creates this system's own Draw Packs instance
///           (lib/shape-packs, ripe0x/shape-packs `draw-packs` at 3a463f7) and its renderer. PACKS_ADMIN (env) is its
///           presentation admin: renderer and description only.
///         KEEPER_ADMIN controls eligibility; POLICY_ADMIN controls the factory's default policy and settings. Admin
///         addresses are environment values, never secrets.
contract Deploy is Script {
    address constant FWA_FACTORY = 0x8919814D825a5Af238cC04DE06b1C18c9eaA477C;
    address constant FWA_IMPL = 0x85Faf92967705dc45535eBCA74D6333F6bCBfEe7;
    bytes32 constant FWA_CODEHASH = 0x0af01fc1a6ea7ea81fd81004fdb3bd5483872df384d2e4ab4a7599e0d2f0ce02;
    address constant SHAPES = 0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0;
    address constant ENS = 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e;
    string constant PACKS_NAME = "Pool Prize Packs";
    string constant PACKS_SYMBOL = "PRIZEPACK";
    uint256 constant PACK_MIN_UNITS = 2; // the smallest pack prize is 0.02 ETH

    // Reused community dependencies (reuse mode). Packs and renderer were created by the 2026-11-22 release
    // (docs/RELEASE-RECORD.md). Code hashes read from mainnet at block 26479596; scripts/deployment-preflight.ts also
    // requires the Packs and renderer runtimes to equal the local lib/shape-packs build with their immutables.
    address constant PACKS = 0xfE11c0E794475fd86801fb3020d779bd7887cB2D;
    address constant RENDERER = 0xA998bE44f1f06E119523C33Bb0d65f45728Ea65A;
    bytes32 constant SHAPES_CODEHASH = 0x5128789aebafbd129f209fc3d84928373b7c9fa07d1721fbc71ee92a412387d7;
    bytes32 constant PACKS_CODEHASH = 0xf823982603df82f696e86d255ea1699635890085f4e203e035405dad07d03a7c;
    bytes32 constant RENDERER_CODEHASH = 0x4315f1dd1c4c69497c28249e5600d8df497786a251bcec610de64977a2b866fe;
    bytes32 constant FWA_FACTORY_CODEHASH = 0xb998454c11b09cf943751b5aa593a2607febac940de51a1a65f41b924369e36e;

    function run() external returns (BalancerFactory factory, PoolBalancer impl, address packs) {
        bool reuse = vm.envOr("REUSE_DEPENDENCIES", false);
        address keeperAdmin = vm.envAddress("KEEPER_ADMIN");
        require(keeperAdmin != address(0), "KEEPER_ADMIN");
        address policyAdmin = vm.envAddress("POLICY_ADMIN");
        require(policyAdmin != address(0), "POLICY_ADMIN");
        address packsAdmin = reuse ? address(0) : vm.envAddress("PACKS_ADMIN");
        require(reuse || packsAdmin != address(0), "PACKS_ADMIN");
        // script/deploy.sh sets this after the asset-flow gate passes (docs/ASSET-FLOW-GATE.md). A hand-set variable
        // defeats it; a local chain (31337) is not asked.
        require(
            block.chainid != 1 || keccak256(bytes(vm.envOr("ASSET_GATE_PASSED", string("")))) == keccak256("yes"),
            "asset-flow gate: deploy with script/deploy.sh"
        );
        // Preflight: the chain must still serve the reviewed FWA implementation.
        require(block.chainid == 1 || block.chainid == 31337, "mainnet or local fork only");
        require(block.chainid != 1 || reuse, "mainnet reuses the community dependencies: REUSE_DEPENDENCIES=true");
        require(IFWAPoolFactory(FWA_FACTORY).implementation() == FWA_IMPL, "FWA implementation changed: re-review");
        require(FWA_IMPL.codehash == FWA_CODEHASH, "FWA implementation code changed: re-review");
        require(IFWAPoolFactory(FWA_FACTORY).maxAcquisitionsPerTx() == 5, "FWA batch limit changed");
        if (reuse) _checkReusedDependencies();

        address renderer = RENDERER;
        packs = PACKS;
        KeeperPolicyV1 policy;
        vm.startBroadcast();
        if (!reuse) {
            renderer = vm.deployCode("out/ShapePackRenderer.sol/ShapePackRenderer.json", abi.encode(SHAPES));
            packs = vm.deployCode(
                "out/ShapePacks.sol/ShapePacks.json",
                abi.encode(SHAPES, renderer, packsAdmin, PACKS_NAME, PACKS_SYMBOL, PACK_MIN_UNITS)
            );
        }
        (impl, policy, factory) = _deploySystem(packs, keeperAdmin, policyAdmin);
        vm.stopBroadcast();

        _postflight(factory, impl, policy, packs, keeperAdmin, policyAdmin);
        if (reuse) _checkReusedDependencies(); // still intact after the broadcast

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", block.number);
        vm.serializeBool(o, "reusedDependencies", reuse);
        vm.serializeAddress(o, "poolBalancerImplementation", address(impl));
        vm.serializeAddress(o, "packs", packs);
        vm.serializeAddress(o, "renderer", renderer);
        vm.serializeAddress(o, "keeperPolicy", address(policy));
        vm.serializeAddress(o, "keeperAdmin", keeperAdmin);
        vm.serializeAddress(o, "policyAdmin", policyAdmin);
        string memory json = vm.serializeAddress(o, "balancerFactory", address(factory));
        vm.createDir("./deployments", true); // not tracked in git: a fresh clone has no such folder
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        console.log("PoolBalancer implementation", address(impl));
        console.log("BalancerFactory", address(factory));
        console.log("Packs", packs, reuse ? "(reused)" : "(created)");
    }

    /// @dev The only place that names the created contracts' constructor arguments. Merge constructor changes here.
    function _deploySystem(address packs, address keeperAdmin, address policyAdmin)
        internal
        returns (PoolBalancer impl, KeeperPolicyV1 policy, BalancerFactory factory)
    {
        impl = new PoolBalancer(FWA_FACTORY, FWA_IMPL, FWA_CODEHASH, SHAPES, packs, ENS);
        policy = new KeeperPolicyV1();
        factory = new BalancerFactory(address(impl), keeperAdmin, policyAdmin, address(policy));
    }

    /// @dev Readbacks of the created contracts. Merge constructor or initial-setting changes here.
    function _postflight(
        BalancerFactory factory,
        PoolBalancer impl,
        KeeperPolicyV1 policy,
        address packs,
        address keeperAdmin,
        address policyAdmin
    ) internal view {
        require(factory.implementation() == address(impl), "factory wiring");
        require(factory.keeperAdmin() == keeperAdmin && !factory.keepersRestricted(), "keeper list: admin set, open");
        require(factory.policyAdmin() == policyAdmin && factory.defaultKeeperPolicy() == address(policy), "policy wiring");
        require(impl.creator() == address(1), "implementation not locked");
        require(address(impl.FWA_FACTORY()) == FWA_FACTORY && impl.FWA_IMPLEMENTATION() == FWA_IMPL, "impl wiring");
        require(address(impl.SHAPES()) == SHAPES && address(impl.ENS()) == ENS, "impl wiring");
        require(address(impl.PACKS()) == packs && IPacksView(packs).shapes() == SHAPES, "packs wiring");
        require(IPacksView(packs).MIN_PACK_VALUE() == 0.02 ether, "pack minimum");
        require(address(impl).code.length > 0 && address(factory).code.length > 0, "no code");
    }

    /// @dev Reuse mode: every reused dependency still holds its recorded code and relationships. A matching code hash
    ///      implies code is present.
    function _checkReusedDependencies() internal view {
        require(SHAPES.codehash == SHAPES_CODEHASH, "Shapes code changed");
        require(PACKS.codehash == PACKS_CODEHASH, "Draw Packs code changed");
        require(RENDERER.codehash == RENDERER_CODEHASH, "renderer code changed");
        require(FWA_FACTORY.codehash == FWA_FACTORY_CODEHASH, "FWA factory code changed");
        require(IPacksView(PACKS).shapes() == SHAPES, "packs shapes");
        require(IReusedPacks(PACKS).renderer() == RENDERER, "packs renderer");
        require(IPacksView(PACKS).MIN_PACK_VALUE() == 0.02 ether, "pack minimum");
        require(IReusedRenderer(RENDERER).shapes() == SHAPES, "renderer shapes");
    }
}
