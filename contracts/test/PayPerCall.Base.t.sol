// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PayPerCall} from "../PayPerCall.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

/// Shared fixture. No test functions here (every category file inherits this).
abstract contract PayPerCallBase is Test {
    PayPerCall internal ppc;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    uint256 internal constant PRICE = 100_000;
    uint64 internal constant DELAY = 30 minutes;
    uint256 internal constant START_BAL = 10 * PRICE;

    bytes32 internal constant NONCE = keccak256("nonce");
    bytes32 internal constant PARAMS = keccak256("params");
    bytes32 internal constant REPORT = keccak256("report");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        ppc = new PayPerCall(address(usdc), owner, operator, treasury);
        _fund(alice);
        _fund(bob);
        _fund(mallory);
    }

    function _fund(address who) internal {
        usdc.mint(who, START_BAL);
        vm.prank(who);
        usdc.approve(address(ppc), type(uint256).max);
    }

    function _create(address payer, bytes32 nonce, bytes32 params) internal returns (bytes32 id) {
        vm.prank(payer);
        id = ppc.createRequest(nonce, params);
    }

    function _settle(bytes32 id) internal {
        vm.prank(operator);
        ppc.settle(id, REPORT);
    }

    function _refund(address payer, bytes32 id, address recipient) internal {
        vm.prank(payer);
        ppc.refund(id, recipient);
    }

    function _status(bytes32 id) internal view returns (PayPerCall.Status s) {
        (,,, s,) = ppc.requests(id);
    }

    function _notPaid(PayPerCall.Status s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PayPerCall.NotPaid.selector, s);
    }
}
