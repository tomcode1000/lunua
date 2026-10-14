// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";

/// Lunua LUN-01 reproduction. Run with Arc Foundry (standard forge does not model native USDC):
///   arc-forge test --match-contract LUN01 -vvvv
contract LUN01 is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork("https://rpc.mainnet.arc.io", 25933812);
    }

    function test_walletSendReverts() public {
        address target = vm.parseAddress("0xa8bd8c8f580d5f00cef41bfa524555de17e3b38f");
        address probe = makeAddr("probe");
        vm.deal(probe, 1e18);
        vm.prank(probe);
        (bool ok, ) = target.call{value: 1e18}("");
        assertFalse(ok, "LUN-01 not reproduced: native send accepted");
    }

    function test_erc20RailAccepted() public {
        address target = vm.parseAddress("0xa8bd8c8f580d5f00cef41bfa524555de17e3b38f");
        address probe = makeAddr("probe");
        vm.deal(probe, 1e18); // one balance: native funding is also the ERC-20 balance
        vm.prank(probe);
        (bool ok, ) = USDC.call(abi.encodeWithSignature("transfer(address,uint256)", target, 1e6));
        assertTrue(ok, "ERC-20 rail rejected");
    }
}
