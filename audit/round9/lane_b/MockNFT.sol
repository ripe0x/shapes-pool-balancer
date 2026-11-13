// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// Minimal ERC721 for curated listings in the harness (not a protocol contract). Also usable as a hostile collection.
contract MockNFT {
    string public name = "Mock";
    string public symbol = "MOCK";
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        require(msg.sender == ownerOf[id] || isApprovedForAll[ownerOf[id]][msg.sender], "auth");
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf[id] == from, "owner");
        require(msg.sender == from || getApproved[id] == msg.sender || isApprovedForAll[from][msg.sender], "auth");
        ownerOf[id] = to;
        getApproved[id] = address(0);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        if (to.code.length != 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, id, "") == IERC721Receiver.onERC721Received.selector,
                "recv"
            );
        }
    }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == 0x80ac58cd || i == 0x01ffc9a7;
    }
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}
