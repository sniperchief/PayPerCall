// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PayPerCall} from "../PayPerCall.sol";
import {ReentrantToken} from "./mocks/Mocks.sol";

/// Required test 14. The payment token itself re-enters PayPerCall during
/// transferFrom (inside createRequest) or transfer (inside settle / refund).
/// The token is also the operator, so settle re-entry is blocked by the guard only.
contract PayPerCallReentrancyTest is Test {
    uint256 internal constant PRICE = 100_000;
    uint8 internal constant OUT_CREATE = 0;
    uint8 internal constant OUT_SETTLE = 1;
    uint8 internal constant OUT_REFUND = 2;
    uint8 internal constant ATK_CREATE = 0;
    uint8 internal constant ATK_SETTLE = 1;
    uint8 internal constant ATK_REFUND = 2;

    bytes32 internal constant N1 = keccak256("n1");
    bytes32 internal constant P1 = keccak256("p1");
    bytes32 internal constant N9 = keccak256("n9");
    bytes32 internal constant P9 = keccak256("p9");
    bytes32 internal constant REPORT = keccak256("report");

    ReentrantToken internal rt;
    PayPerCall internal ppc;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal victimId; // bob's pre-existing Paid request: must never be touched

    function setUp() public {
        vm.warp(1_700_000_000);
        rt = new ReentrantToken();
        ppc = new PayPerCall(address(rt), owner, address(rt), treasury); // token is the operator
        rt.setTarget(address(ppc));
        rt.mint(alice, 10 * PRICE);
        rt.mint(bob, 10 * PRICE);
        vm.prank(alice);
        rt.approve(address(ppc), type(uint256).max);
        vm.prank(bob);
        rt.approve(address(ppc), type(uint256).max);
        vm.prank(bob);
        victimId = ppc.createRequest(keccak256("victim"), keccak256("victimParams"));
    }

    function _attackData(uint8 kind) internal view returns (bytes memory) {
        if (kind == ATK_CREATE) return abi.encodeCall(ppc.createRequest, (N9, P9));
        if (kind == ATK_SETTLE) return abi.encodeCall(ppc.settle, (victimId, REPORT));
        return abi.encodeCall(ppc.refund, (victimId, address(rt)));
    }

    function _st(bytes32 id) internal view returns (PayPerCall.Status s) {
        (,,, s,) = ppc.requests(id);
    }

    function _runOuter(uint8 outer, bytes32 aId) internal {
        if (outer == OUT_CREATE) {
            vm.prank(alice);
            ppc.createRequest(N1, P1);
        } else if (outer == OUT_SETTLE) {
            rt.forward(abi.encodeCall(ppc.settle, (aId, REPORT)));
        } else {
            vm.prank(alice);
            ppc.refund(aId, alice);
        }
    }

    function _run(uint8 outer, uint8 kind, bool bubble) internal {
        bytes32 aId = ppc.computeRequestId(alice, N1, P1);
        if (outer != OUT_CREATE) {
            vm.prank(alice);
            ppc.createRequest(N1, P1);
        }
        if (outer == OUT_REFUND) skip(30 minutes);

        rt.configure(_attackData(kind), outer == OUT_CREATE ? 1 : 2, bubble);
        bytes32 attackerId = ppc.computeRequestId(address(rt), N9, P9);

        uint256 supply = rt.totalSupply();
        uint256 pBefore = rt.balanceOf(address(ppc));
        uint256 aBefore = rt.balanceOf(alice);
        uint256 tBefore = rt.balanceOf(treasury);

        if (bubble) {
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            _runOuter(outer, aId);
            // Whole tx rolled back.
            assertEq(rt.balanceOf(address(ppc)), pBefore);
            assertEq(rt.balanceOf(alice), aBefore);
            assertEq(rt.balanceOf(treasury), tBefore);
            assertEq(uint8(_st(aId)), outer == OUT_CREATE ? uint8(PayPerCall.Status.None) : uint8(PayPerCall.Status.Paid));
        } else {
            _runOuter(outer, aId);
            assertTrue(rt.attackAttempted(), "attack not attempted");
            assertFalse(rt.attackSucceeded(), "re-entry succeeded");
            assertEq(bytes4(rt.attackRevertData()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            if (outer == OUT_CREATE) {
                assertEq(rt.balanceOf(address(ppc)), pBefore + PRICE);
                assertEq(rt.balanceOf(alice), aBefore - PRICE);
                assertEq(rt.balanceOf(treasury), tBefore);
                assertEq(uint8(_st(aId)), uint8(PayPerCall.Status.Paid));
            } else if (outer == OUT_SETTLE) {
                assertEq(rt.balanceOf(address(ppc)), pBefore - PRICE);
                assertEq(rt.balanceOf(treasury), tBefore + PRICE); // paid exactly once
                assertEq(uint8(_st(aId)), uint8(PayPerCall.Status.Settled));
            } else {
                assertEq(rt.balanceOf(address(ppc)), pBefore - PRICE);
                assertEq(rt.balanceOf(alice), aBefore + PRICE); // refunded exactly once
                assertEq(rt.balanceOf(treasury), tBefore);
                assertEq(uint8(_st(aId)), uint8(PayPerCall.Status.Refunded));
            }
        }
        // Common: the victim's escrow is untouched, the attacker holds nothing, supply is conserved,
        // and the escrow still covers every remaining Paid request.
        assertEq(uint8(_st(victimId)), uint8(PayPerCall.Status.Paid));
        assertEq(uint8(_st(attackerId)), uint8(PayPerCall.Status.None));
        assertEq(rt.balanceOf(address(rt)), 0);
        assertEq(rt.totalSupply(), supply);
        assertGe(rt.balanceOf(address(ppc)), PRICE);
    }

    // transferFrom hook inside createRequest
    function test_14_createReenters_create_bubbled() public { _run(OUT_CREATE, ATK_CREATE, true); }
    function test_14_createReenters_create_caught() public { _run(OUT_CREATE, ATK_CREATE, false); }
    function test_14_createReenters_settle_bubbled() public { _run(OUT_CREATE, ATK_SETTLE, true); }
    function test_14_createReenters_settle_caught() public { _run(OUT_CREATE, ATK_SETTLE, false); }
    function test_14_createReenters_refund_bubbled() public { _run(OUT_CREATE, ATK_REFUND, true); }
    function test_14_createReenters_refund_caught() public { _run(OUT_CREATE, ATK_REFUND, false); }

    // transfer hook inside settle
    function test_14_settleReenters_create_bubbled() public { _run(OUT_SETTLE, ATK_CREATE, true); }
    function test_14_settleReenters_create_caught() public { _run(OUT_SETTLE, ATK_CREATE, false); }
    function test_14_settleReenters_settle_bubbled() public { _run(OUT_SETTLE, ATK_SETTLE, true); }
    function test_14_settleReenters_settle_caught() public { _run(OUT_SETTLE, ATK_SETTLE, false); }
    function test_14_settleReenters_refund_bubbled() public { _run(OUT_SETTLE, ATK_REFUND, true); }
    function test_14_settleReenters_refund_caught() public { _run(OUT_SETTLE, ATK_REFUND, false); }

    // transfer hook inside refund
    function test_14_refundReenters_create_bubbled() public { _run(OUT_REFUND, ATK_CREATE, true); }
    function test_14_refundReenters_create_caught() public { _run(OUT_REFUND, ATK_CREATE, false); }
    function test_14_refundReenters_settle_bubbled() public { _run(OUT_REFUND, ATK_SETTLE, true); }
    function test_14_refundReenters_settle_caught() public { _run(OUT_REFUND, ATK_SETTLE, false); }
    function test_14_refundReenters_refund_bubbled() public { _run(OUT_REFUND, ATK_REFUND, true); }
    function test_14_refundReenters_refund_caught() public { _run(OUT_REFUND, ATK_REFUND, false); }
}
