// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {PoolBalancer} from "../../../../../src/PoolBalancer.sol";
import {BalancerFactory} from "../../../../../src/BalancerFactory.sol";

// Creator-controlled ERC721 whose reported custody diverges from its actual ledger.
// It is an adversarial listed asset, not a replacement for FWA or Shapes.
contract HostileCreator is ERC721 {
    PoolBalancer public balancer;
    address public reportedOwner;

    constructor() ERC721("Hostile Creator Asset", "HCA") { _mint(address(this), 1); }

    receive() external payable {}

    function makePool(BalancerFactory factory) external payable {
        balancer = PoolBalancer(payable(factory.createBalancer{value: msg.value}(bytes32(uint256(541)))));
        balancer.configure(0, 1);
        this.approve(address(balancer), 1);
    }

    function list() external returns (uint256) { return balancer.listCurated(address(this), 1, 0.1 ether); }
    function open() external { balancer.open(); }
    function close() external { balancer.close(); }
    function unlist(uint256[] calldata ids) external { balancer.unlistShapes(ids); }
    function claimAll() external { balancer.claimSurplus(address(balancer).balance, address(this)); }
    function handoff(address next) external { balancer.transferCreator(next); }
    function actualOwner() external view returns (address) { return _ownerOf(1); }

    function ownerOf(uint256 tokenId) public view override returns (address) {
        if (tokenId == 1 && reportedOwner != address(0)) return reportedOwner;
        return super.ownerOf(tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (tokenId == 1 && from == address(this) && to == address(balancer)) {
            reportedOwner = to;
            return;
        }
        if (tokenId == 1 && from == address(balancer) && to == address(balancer.pool())) {
            reportedOwner = to;
            return;
        }
        super.transferFrom(from, to, tokenId);
    }

    function approve(address to, uint256 tokenId) public override {
        if (msg.sender == address(balancer)) return;
        super.approve(to, tokenId);
    }
}
