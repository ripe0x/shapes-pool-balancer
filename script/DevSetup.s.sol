// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PoolBalancer} from "../src/PoolBalancer.sol";
import {BalancerFactory} from "../src/BalancerFactory.sol";
import {ERC721} from "solady/tokens/ERC721.sol";

contract DemoNFT is ERC721 {
    function name() public pure override returns (string memory) {
        return "Demo Curated";
    }

    function symbol() public pure override returns (string memory) {
        return "DEMO";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// @notice Local fork only: creates POOLS demo Balancers (one per anvil sender in CREATORS),
///         each with two curated NFTs, a small prize target, opened but not yet upkept.
///   FACTORY=<addr> forge script script/DevSetup.s.sol --tc DevSetup --rpc-url http://127.0.0.1:8545 --unlocked --sender <creator> --broadcast
contract DevSetup is Script {
    function run() external {
        require(block.chainid == 31337, "local fork only");
        BalancerFactory factory = BalancerFactory(vm.envAddress("FACTORY"));
        bytes32 salt = bytes32(vm.envOr("SALT", uint256(0)));
        vm.startBroadcast();
        DemoNFT nft = new DemoNFT();
        (, address creator,) = vm.readCallers();
        address predicted = factory.predictBalancer(creator, salt);
        PoolBalancer.CuratedInput[] memory nfts = new PoolBalancer.CuratedInput[](2);
        for (uint256 i = 1; i <= 2; ++i) {
            nft.mint(creator, i);
            nft.approve(predicted, i);
            nfts[i - 1] = PoolBalancer.CuratedInput(address(nft), i, i * 0.25 ether);
        }
        PoolBalancer implementation = PoolBalancer(payable(factory.implementation()));
        // Demo review values: 15% Shape markup and a fixed 4% allocation of collected owner proceeds.
        PoolBalancer.CreationConfig memory config = PoolBalancer.CreationConfig(
            1500, 400, 5 | (3 << 16) | (2 << 32), implementation.SHAPES().mintFee(), false,
            factory.creationSettingsHash());
        PoolBalancer b = PoolBalancer(payable(factory.createBalancer{value: 3 ether}(salt, config, nfts)));
        vm.stopBroadcast();
        console.log("Balancer", address(b));
        console.log("Pool", address(b.pool()));
        console.log("DemoNFT", address(nft));
    }
}
