// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice DEMO ONLY. A savings vault written the Ethereum way and copied to Arc unchanged.
///         It has three Arc bugs that Arc Preflight catches:
///         1. no receive(): a wallet "Send USDC" (native) reverts
///         2. totalAssets() adds the native balance and the ERC-20 balance: double counts
///         3. weekly prize draw uses block.prevrandao, which is always 0 on Arc
contract PortedVault {
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    mapping(address => uint256) public shares;
    address[] public savers;

    function deposit(uint256 amount) external {
        USDC.transferFrom(msg.sender, address(this), amount);
        if (shares[msg.sender] == 0) savers.push(msg.sender);
        shares[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external {
        shares[msg.sender] -= amount;
        USDC.transfer(msg.sender, amount);
    }

    /// "ETH tips + token deposits" - on Arc both are the same USDC, so this counts it twice.
    function totalAssets() external view returns (uint256) {
        return address(this).balance / 1e12 + USDC.balanceOf(address(this));
    }

    function prizeWinner() external view returns (address) {
        return savers.length == 0 ? address(0) : savers[block.prevrandao % savers.length];
    }
}
