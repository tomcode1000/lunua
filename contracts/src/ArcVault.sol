// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @notice The same vault, fixed for Arc after Lunua's report.
///         - receive() credits a native wallet send as a deposit (native and ERC-20 are one asset)
///         - totalAssets() reads one view only
///         - no on-chain randomness
contract ArcVault {
    IERC20 public constant USDC = IERC20(0x3600000000000000000000000000000000000000);
    mapping(address => uint256) public shares; // 6-decimal USDC units

    event Deposited(address indexed who, uint256 amount, bool native);

    receive() external payable {
        uint256 amount = msg.value / 1e12; // 18 dp native -> 6 dp
        require(amount > 0 && amount * 1e12 == msg.value, "send whole micro-USDC");
        shares[msg.sender] += amount;
        emit Deposited(msg.sender, amount, true);
    }

    function deposit(uint256 amount) external {
        require(USDC.transferFrom(msg.sender, address(this), amount), "transfer failed");
        shares[msg.sender] += amount;
        emit Deposited(msg.sender, amount, false);
    }

    function withdraw(uint256 amount) external {
        shares[msg.sender] -= amount;
        require(USDC.transfer(msg.sender, amount), "transfer failed");
    }

    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }
}
