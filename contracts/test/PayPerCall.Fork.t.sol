// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PayPerCall} from "../PayPerCall.sol";

/// @notice Read-only sanity check against the live Arc Testnet USDC. Skipped unless
/// ARC_TESTNET_RPC_URL is set. Standard Foundry cannot reproduce Arc's native-USDC
/// transfer semantics, so this test never moves USDC; it only checks that the real
/// token passes the constructor's token validation.
contract PayPerCallForkTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    function test_fork_constructorAcceptsRealArcTestnetUsdc() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
        }
        vm.createSelectFork(rpc);

        assertEq(block.chainid, ARC_TESTNET_CHAIN_ID, "wrong chain");
        assertGt(ARC_USDC.code.length, 0, "no USDC code");
        assertEq(IERC20Metadata(ARC_USDC).decimals(), 6, "USDC decimals");
        assertEq(IERC20Metadata(ARC_USDC).symbol(), "USDC", "USDC symbol");

        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        address treasury = makeAddr("treasury");
        PayPerCall c = new PayPerCall(ARC_USDC, owner, operator, treasury);

        assertEq(address(c.USDC()), ARC_USDC);
        assertEq(c.PRICE(), 100_000);
        assertEq(c.TREASURY(), treasury);
        assertEq(c.operator(), operator);
    }
}
