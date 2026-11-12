// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";

// Creator-controlled ERC721 whose reported custody diverges from its actual ledger.
// It is an adversarial listed asset, not a replacement for FWA or Shapes.
contract MultiHostileCreator is ERC721 {
    PoolBalancer public balancer;
    mapping(uint256 => address) public reportedOwner;

    constructor() ERC721("Hostile Creator Assets", "HCA") {
        for (uint256 i = 1; i <= 5; ++i) _mint(address(this), i);
    }

    receive() external payable {}

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(541)))));
        balancer.configure(0, 20);
        for (uint256 i = 1; i <= 5; ++i) this.approve(address(balancer), i);
    }

    function listMany() external returns (uint256[] memory ids) {
        ids = new uint256[](5);
        for (uint256 i = 1; i <= 5; ++i) ids[i - 1] = balancer.listCurated(address(this), i, 0.1 ether);
    }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll() external { balancer.claimSurplus(address(balancer).balance, address(this)); }
    function handoff(address next) external { balancer.transferCreator(next); }
    function actualOwner(uint256 id) external view returns (address) { return _ownerOf(id); }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        if (reportedOwner[tokenId] != address(0)) return reportedOwner[tokenId];
        return super.ownerOf(tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (from == address(this) && to == address(balancer)) {
            reportedOwner[tokenId] = to;
            return;
        }
        if (from == address(balancer) && to == address(balancer.pool())) {
            reportedOwner[tokenId] = to;
            return;
        }
        super.transferFrom(from, to, tokenId);
    }

    function approve(address to, uint256 tokenId) public override {
        if (msg.sender == address(balancer)) return;
        super.approve(to, tokenId);
    }
}
