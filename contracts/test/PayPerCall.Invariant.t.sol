// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PayPerCall} from "../PayPerCall.sol";
import {PayPerCallBase} from "./PayPerCall.Base.t.sol";
import {MockUSDC} from "./mocks/Mocks.sol";

/// Handler: the only surface the invariant fuzzer drives.
/// Random actions (create / settle / refund / warp / roll / forceMint) explore arbitrary states.
/// Guided actions (settleGuided / refundGuided) pick or create a request that the authorized caller
/// can actually move, so every run performs real Paid -> Settled and Paid -> Refunded transitions.
/// Adversarial actions (settleUnauthorized / refundUnauthorized / refundToSelf) target requests where
/// only the guard under test can stop them, and record any wrong outcome in a violation flag.
/// Each one finds or creates such a request first, so every call reaches the guard.
/// Admin actions (togglePause / rotateOperator) change configuration mid-campaign; pausedLifecycle forces
/// the paused state and settles and refunds through it. Guided creation preserves the current pause state.
contract PayPerCallHandler is Test {
    uint8 internal constant ANY_PAID = 0;
    uint8 internal constant SETTLEABLE = 1; // Paid and now < refundableAt
    uint8 internal constant REFUNDABLE = 2; // Paid and now >= refundableAt

    PayPerCall public ppc;
    MockUSDC public usdc;
    address public owner;
    address[] public operatorCandidates;
    address[] public actors;
    address[] public recipients;

    bytes32[] public ids;
    mapping(bytes32 => bool) public tracked;
    mapping(bytes32 => PayPerCall.Status) public lastSeen;
    uint256 public guidedNonce;

    uint256 public settledCount;
    uint256 public refundedCount;
    uint256 public forceMinted;

    bool public terminalViolation;
    bool public guardViolation; // an unauthorized or self-recipient call succeeded, or failed for the wrong reason
    bool public pauseViolation; // a request was created while paused
    bool public guidedFailure; // an authorized, valid create / settle / refund reverted

    // Call metrics for reporting.
    uint256 public settledWhilePaused;
    uint256 public refundedWhilePaused;
    uint256 public createRejectedWhilePaused;
    uint256 public unauthorizedSettleRejected;
    uint256 public unauthorizedRefundRejected;
    uint256 public selfRefundRejected;
    uint256 public pauses;
    uint256 public unpauses;
    uint256 public operatorRotations;

    // Per-action call and outcome counts, checked exactly in afterInvariant. They start at zero,
    // so a short or shrunk replay that never calls an action asserts nothing about it.
    uint256 public settleGuidedCalls;
    uint256 public guidedSettles;
    uint256 public refundGuidedCalls;
    uint256 public guidedRefunds;
    uint256 public settleUnauthorizedCalls;
    uint256 public refundUnauthorizedCalls;
    uint256 public refundToSelfCalls;
    uint256 public pausedLifecycleCalls;
    uint256 public pausedLifecycleSettles;
    uint256 public pausedLifecycleRefunds;

    constructor(
        PayPerCall ppc_,
        MockUSDC usdc_,
        address owner_,
        address[] memory operatorCandidates_,
        address[] memory actors_,
        address[] memory recipients_
    ) {
        ppc = ppc_;
        usdc = usdc_;
        owner = owner_;
        operatorCandidates = operatorCandidates_;
        actors = actors_;
        recipients = recipients_;
        for (uint256 i; i < actors_.length; ++i) {
            vm.prank(actors_[i]);
            usdc.approve(address(ppc_), type(uint256).max);
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    // ------------------------------------------------------------ random actions

    function create(uint256 actorSeed, uint256 nonceSeed, uint256 paramsSeed) external {
        address payer = actors[actorSeed % actors.length];
        bytes32 nonce = bytes32(bound(nonceSeed, 0, 4)); // small range => frequent duplicate attempts
        bytes32 params = bytes32(bound(paramsSeed, 1, 3));
        usdc.mint(payer, 100_000);
        bool wasPaused = ppc.paused();
        vm.prank(payer);
        try ppc.createRequest(nonce, params) returns (bytes32 id) {
            if (wasPaused) pauseViolation = true;
            _remember(id);
        } catch {
            if (wasPaused) createRejectedWhilePaused++;
        }
        _track();
    }

    function settle(uint256 idxSeed, bytes32 report) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idxSeed % ids.length];
        bool wasPaused = ppc.paused();
        address op = ppc.operator();
        vm.prank(op);
        try ppc.settle(id, report) {
            settledCount++;
            if (wasPaused) settledWhilePaused++;
        } catch {}
        _track();
    }

    function refund(uint256 idxSeed, uint256 recipSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idxSeed % ids.length];
        (address payer,,,,) = ppc.requests(id);
        bool wasPaused = ppc.paused();
        vm.prank(payer);
        try ppc.refund(id, recipients[recipSeed % recipients.length]) {
            refundedCount++;
            if (wasPaused) refundedWhilePaused++;
        } catch {}
        _track();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 hours));
        _track();
    }

    function roll(uint256 blocks) external {
        vm.roll(block.number + bound(blocks, 1, 100));
    }

    /// Tokens sent straight to the contract, outside any request.
    function forceMint(uint256 amount) external {
        amount = bound(amount, 0, 1e9);
        usdc.mint(address(ppc), amount);
        forceMinted += amount;
    }

    // ------------------------------------------------------------ guided actions

    /// The current operator settles a request that is still inside its window, creating one if needed.
    function settleGuided(uint256 seed) external {
        settleGuidedCalls++;
        (bool found, bytes32 id) = _settleableOrFresh(seed);
        if (!found) return; // _createFresh already set guidedFailure
        bool wasPaused = ppc.paused();
        address op = ppc.operator();
        vm.prank(op);
        try ppc.settle(id, keccak256(abi.encode(id))) {
            settledCount++;
            guidedSettles++;
            if (wasPaused) settledWhilePaused++;
        } catch {
            guidedFailure = true;
        }
        _track();
    }

    /// The payer refunds an overdue Paid request, creating one if needed and warping to its deadline.
    function refundGuided(uint256 seed, uint256 recipSeed) external {
        refundGuidedCalls++;
        (bool found, bytes32 id) = _overdueOrFresh(seed);
        if (!found) return;
        (address payer,,,,) = ppc.requests(id);
        bool wasPaused = ppc.paused();
        vm.prank(payer);
        try ppc.refund(id, recipients[recipSeed % recipients.length]) {
            refundedCount++;
            guidedRefunds++;
            if (wasPaused) refundedWhilePaused++;
        } catch {
            guidedFailure = true;
        }
        _track();
    }

    /// Forces the paused state, settles one request and refunds another, then restores the previous
    /// pause state. Pause must block neither path.
    function pausedLifecycle(uint256 seed, uint256 recipSeed) external {
        pausedLifecycleCalls++;
        bool wasPaused = ppc.paused();
        if (!wasPaused) {
            vm.prank(owner);
            ppc.pause();
        }

        (bool found, bytes32 id) = _settleableOrFresh(seed);
        if (found) {
            address op = ppc.operator();
            vm.prank(op);
            try ppc.settle(id, keccak256(abi.encode(id))) {
                settledCount++;
                settledWhilePaused++;
                pausedLifecycleSettles++;
            } catch {
                guidedFailure = true;
            }
        }

        (found, id) = _overdueOrFresh(seed ^ 1);
        if (found) {
            (address payer,,,,) = ppc.requests(id);
            vm.prank(payer);
            try ppc.refund(id, recipients[recipSeed % recipients.length]) {
                refundedCount++;
                refundedWhilePaused++;
                pausedLifecycleRefunds++;
            } catch {
                guidedFailure = true;
            }
        }

        if (!wasPaused) {
            vm.prank(owner);
            ppc.unpause();
        }
        _track();
    }

    // ------------------------------------------------------------ adversarial actions

    /// Anyone but the current operator (strangers, payers, the owner, rotated-out operators) tries to
    /// settle a request the operator could settle right now.
    function settleUnauthorized(uint256 callerSeed, uint256 seed) external {
        settleUnauthorizedCalls++;
        (bool found, bytes32 id) = _settleableOrFresh(seed);
        if (!found) return;
        address caller = _nonOperator(callerSeed);
        vm.prank(caller);
        try ppc.settle(id, keccak256(abi.encode(id))) {
            guardViolation = true;
        } catch (bytes memory reason) {
            if (bytes4(reason) != PayPerCall.NotOperator.selector) guardViolation = true;
            unauthorizedSettleRejected++;
        }
        _track();
    }

    /// Someone other than the payer tries to refund a Paid request to themselves. The payer check
    /// comes before the deadline check, so any Paid request reaches the guard.
    function refundUnauthorized(uint256 callerSeed, uint256 seed) external {
        refundUnauthorizedCalls++;
        (bool found, bytes32 id) = _paidOrFresh(seed);
        if (!found) return; // _createFresh already set guidedFailure
        (address payer,,,,) = ppc.requests(id);
        address caller = _nonPayer(callerSeed, payer);
        vm.prank(caller);
        try ppc.refund(id, caller) {
            guardViolation = true;
        } catch (bytes memory reason) {
            if (bytes4(reason) != PayPerCall.NotPayer.selector) guardViolation = true;
            unauthorizedRefundRejected++;
        }
        _track();
    }

    /// The payer tries to refund an overdue request to the escrow contract itself.
    function refundToSelf(uint256 seed) external {
        refundToSelfCalls++;
        (bool found, bytes32 id) = _overdueOrFresh(seed);
        if (!found) return;
        (address payer,,,,) = ppc.requests(id);
        vm.prank(payer);
        try ppc.refund(id, address(ppc)) {
            guardViolation = true;
        } catch (bytes memory reason) {
            if (bytes4(reason) != PayPerCall.InvalidRecipient.selector) guardViolation = true;
            selfRefundRejected++;
        }
        _track();
    }

    // ------------------------------------------------------------ admin actions

    function togglePause() external {
        bool wasPaused = ppc.paused();
        vm.prank(owner);
        if (wasPaused) {
            ppc.unpause();
            unpauses++;
        } else {
            ppc.pause();
            pauses++;
        }
        _track();
    }

    function rotateOperator(uint256 seed) external {
        address next = operatorCandidates[seed % operatorCandidates.length];
        if (next == ppc.operator()) return;
        vm.prank(owner);
        ppc.setOperator(next);
        operatorRotations++;
        _track();
    }

    // ------------------------------------------------------------ helpers

    function _remember(bytes32 id) internal {
        if (!tracked[id]) {
            tracked[id] = true;
            ids.push(id);
        }
    }

    /// Creates a request with a never-used nonce. If the contract is paused, the owner unpauses for the
    /// creation and pauses again afterwards, so the caller's paused-state path is preserved.
    function _createFresh(uint256 seed) internal returns (bool ok, bytes32 id) {
        bool wasPaused = ppc.paused();
        if (wasPaused) {
            vm.prank(owner);
            ppc.unpause();
        }
        address payer = actors[seed % actors.length];
        bytes32 nonce = keccak256(abi.encode("guided", ++guidedNonce));
        usdc.mint(payer, 100_000);
        vm.prank(payer);
        try ppc.createRequest(nonce, bytes32(uint256(1))) returns (bytes32 newId) {
            _remember(newId);
            (ok, id) = (true, newId);
        } catch {
            guidedFailure = true;
        }
        if (wasPaused) {
            vm.prank(owner);
            ppc.pause();
        }
    }

    /// A Paid request that the operator can still settle now; creates one if none exists.
    function _settleableOrFresh(uint256 seed) internal returns (bool found, bytes32 id) {
        (found, id) = _findPaid(seed, SETTLEABLE);
        if (!found) (found, id) = _createFresh(seed);
    }

    /// Any Paid request, without moving time; creates one if none exists.
    function _paidOrFresh(uint256 seed) internal returns (bool found, bytes32 id) {
        (found, id) = _findPaid(seed, ANY_PAID);
        if (!found) (found, id) = _createFresh(seed);
    }

    /// A Paid request that its payer can refund now: an overdue one if any, otherwise any Paid request
    /// (or a fresh one) with time warped to its deadline.
    function _overdueOrFresh(uint256 seed) internal returns (bool found, bytes32 id) {
        (found, id) = _findPaid(seed, REFUNDABLE);
        if (found) return (found, id);
        (found, id) = _findPaid(seed, ANY_PAID);
        if (!found) (found, id) = _createFresh(seed);
        if (!found) return (found, id);
        (,, uint64 refundableAt,,) = ppc.requests(id);
        if (block.timestamp < refundableAt) vm.warp(refundableAt);
    }

    function _findPaid(uint256 seed, uint8 mode) internal view returns (bool, bytes32) {
        uint256 n = ids.length;
        if (n == 0) return (false, bytes32(0));
        uint256 start = seed % n;
        for (uint256 k; k < n; ++k) {
            bytes32 id = ids[(start + k) % n];
            (,, uint64 refundableAt, PayPerCall.Status st,) = ppc.requests(id);
            if (st != PayPerCall.Status.Paid) continue;
            if (mode == SETTLEABLE && block.timestamp >= refundableAt) continue;
            if (mode == REFUNDABLE && block.timestamp < refundableAt) continue;
            return (true, id);
        }
        return (false, bytes32(0));
    }

    /// Pool: actors, owner, every operator candidate. Returns the first one that is not the current operator.
    function _nonOperator(uint256 seed) internal view returns (address caller) {
        address current = ppc.operator();
        uint256 total = actors.length + operatorCandidates.length + 1;
        uint256 start = seed % total;
        for (uint256 k; k < total; ++k) {
            caller = _poolAt((start + k) % total);
            if (caller != current) return caller;
        }
        revert("no non-operator caller");
    }

    /// Pool: actors, owner, every operator candidate. Returns the first one that is not the payer.
    function _nonPayer(uint256 seed, address payer) internal view returns (address caller) {
        uint256 total = actors.length + operatorCandidates.length + 1;
        uint256 start = seed % total;
        for (uint256 k; k < total; ++k) {
            caller = _poolAt((start + k) % total);
            if (caller != payer) return caller;
        }
        revert("no non-payer caller");
    }

    function _poolAt(uint256 i) internal view returns (address) {
        if (i < actors.length) return actors[i];
        if (i < actors.length + operatorCandidates.length) return operatorCandidates[i - actors.length];
        return owner;
    }

    function _track() internal {
        for (uint256 i; i < ids.length; ++i) {
            (,,, PayPerCall.Status cur,) = ppc.requests(ids[i]);
            PayPerCall.Status prev = lastSeen[ids[i]];
            if (prev == PayPerCall.Status.Settled || prev == PayPerCall.Status.Refunded) {
                if (cur != prev) terminalViolation = true;
            } else if (prev == PayPerCall.Status.Paid && cur == PayPerCall.Status.None) {
                terminalViolation = true;
            }
            lastSeen[ids[i]] = cur;
        }
    }

    function countStatus(PayPerCall.Status s) external view returns (uint256 n) {
        for (uint256 i; i < ids.length; ++i) {
            (,,, PayPerCall.Status cur,) = ppc.requests(ids[i]);
            if (cur == s) n++;
        }
    }
}

contract PayPerCallInvariantTest is PayPerCallBase {
    PayPerCallHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory actors = new address[](3);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = mallory;
        address[] memory recips = new address[](3);
        recips[0] = alice;
        recips[1] = makeAddr("recipX");
        recips[2] = makeAddr("recipY");
        address[] memory ops = new address[](3);
        ops[0] = operator;
        ops[1] = makeAddr("operator2");
        ops[2] = makeAddr("operator3");
        handler = new PayPerCallHandler(ppc, usdc, owner, ops, actors, recips);

        bytes4[] memory sels = new bytes4[](14);
        sels[0] = PayPerCallHandler.create.selector;
        sels[1] = PayPerCallHandler.settle.selector;
        sels[2] = PayPerCallHandler.refund.selector;
        sels[3] = PayPerCallHandler.warp.selector;
        sels[4] = PayPerCallHandler.roll.selector;
        sels[5] = PayPerCallHandler.forceMint.selector;
        sels[6] = PayPerCallHandler.settleGuided.selector;
        sels[7] = PayPerCallHandler.refundGuided.selector;
        sels[8] = PayPerCallHandler.settleUnauthorized.selector;
        sels[9] = PayPerCallHandler.refundUnauthorized.selector;
        sels[10] = PayPerCallHandler.refundToSelf.selector;
        sels[11] = PayPerCallHandler.togglePause.selector;
        sels[12] = PayPerCallHandler.rotateOperator.selector;
        sels[13] = PayPerCallHandler.pausedLifecycle.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// token.balanceOf(contract) >= PRICE * (# Paid requests); exactly equal modulo force-minted dust.
    function invariant_escrowCoversPaidRequests() public view {
        uint256 paid = handler.countStatus(PayPerCall.Status.Paid);
        uint256 bal = usdc.balanceOf(address(ppc));
        assertGe(bal, paid * PRICE);
        assertEq(bal, paid * PRICE + handler.forceMinted());
    }

    function invariant_treasuryHoldsExactlySettledAmount() public view {
        assertEq(usdc.balanceOf(treasury), handler.settledCount() * PRICE);
        assertEq(handler.countStatus(PayPerCall.Status.Settled), handler.settledCount());
        assertEq(handler.countStatus(PayPerCall.Status.Refunded), handler.refundedCount());
    }

    function invariant_noTerminalStateEverLeft() public view {
        assertFalse(handler.terminalViolation());
    }

    function invariant_everyCreatedRequestIsInAKnownState() public view {
        uint256 n = handler.idsLength();
        assertEq(
            handler.countStatus(PayPerCall.Status.Paid) + handler.countStatus(PayPerCall.Status.Settled)
                + handler.countStatus(PayPerCall.Status.Refunded),
            n
        );
    }

    function invariant_guardsHold() public view {
        assertFalse(handler.guardViolation(), "unauthorized or self-recipient call not rejected correctly");
        assertFalse(handler.pauseViolation(), "request created while paused");
        assertFalse(handler.guidedFailure(), "authorized valid create/settle/refund reverted");
    }

    /// Runs at the end of each campaign run (and of each shrunk replay). Every guided or adversarial
    /// call must have produced exactly its intended outcome. Counts are compared per action, so an
    /// action that was never called asserts nothing and a short replay reports the invariant it
    /// actually violated.
    function afterInvariant() public view {
        assertEq(handler.guidedSettles(), handler.settleGuidedCalls(), "settleGuided call did not settle");
        assertEq(handler.guidedRefunds(), handler.refundGuidedCalls(), "refundGuided call did not refund");
        assertEq(
            handler.unauthorizedSettleRejected(),
            handler.settleUnauthorizedCalls(),
            "settleUnauthorized call did not reach a rejected settle"
        );
        assertEq(
            handler.unauthorizedRefundRejected(),
            handler.refundUnauthorizedCalls(),
            "refundUnauthorized call did not reach a rejected refund"
        );
        assertEq(
            handler.selfRefundRejected(), handler.refundToSelfCalls(), "refundToSelf call did not reach a rejected refund"
        );
        assertEq(
            handler.pausedLifecycleSettles(), handler.pausedLifecycleCalls(), "pausedLifecycle call did not settle while paused"
        );
        assertEq(
            handler.pausedLifecycleRefunds(), handler.pausedLifecycleCalls(), "pausedLifecycle call did not refund while paused"
        );
    }
}

contract PayPerCallFuzzAndSurfaceTest is PayPerCallBase {
    function testFuzz_idUniquenessAndCreateSucceeds(address payer, bytes32 nonce, bytes32 params) public {
        vm.assume(params != bytes32(0));
        vm.assume(payer != address(0) && payer != address(ppc) && payer != address(usdc) && payer != treasury);
        assumeNotPrecompile(payer);
        assumeNotForgeAddress(payer);

        usdc.mint(payer, PRICE);
        vm.prank(payer);
        usdc.approve(address(ppc), PRICE);

        bytes32 expected = keccak256(abi.encode(block.chainid, address(ppc), payer, nonce, params));
        assertEq(ppc.computeRequestId(payer, nonce, params), expected);

        uint256 before_ = usdc.balanceOf(address(ppc));
        bytes32 id = _create(payer, nonce, params);
        assertEq(id, expected);
        assertEq(usdc.balanceOf(address(ppc)), before_ + PRICE);
        (address p,,, PayPerCall.Status st, bytes32 ph) = ppc.requests(id);
        assertEq(p, payer);
        assertEq(uint8(st), uint8(PayPerCall.Status.Paid));
        assertEq(ph, params);

        // Uniqueness: payer, nonce and params are each bound into the ID.
        assertTrue(ppc.computeRequestId(alice, nonce, params) != id || alice == payer);
        assertTrue(ppc.computeRequestId(payer, bytes32(uint256(nonce) ^ 1), params) != id);
        assertTrue(ppc.computeRequestId(payer, nonce, bytes32(uint256(params) ^ 1)) != id);

        // Reuse is rejected.
        usdc.mint(payer, PRICE);
        vm.prank(payer);
        usdc.approve(address(ppc), PRICE);
        vm.prank(payer);
        vm.expectRevert(PayPerCall.RequestAlreadyExists.selector);
        ppc.createRequest(nonce, params);
    }

    /// Only createRequest, settle and refund move tokens. Every other plausible token-moving
    /// entry point (rescue / sweep / withdraw / arbitrary call / treasury change / upgrade) is absent:
    /// owner, operator and strangers all hit a revert and no balance changes.
    function test_noFunctionCanWithdrawArbitraryTokens() public {
        _create(alice, NONCE, PARAMS);
        usdc.mint(address(ppc), 5 * PRICE); // force-sent extra tokens must be unrecoverable too
        uint256 held = usdc.balanceOf(address(ppc));

        string[16] memory sigs = [
            "withdraw(address,uint256)", "withdraw(uint256)", "withdraw()", "rescueTokens(address,address,uint256)",
            "recoverERC20(address,uint256)", "sweep(address)", "sweep(address,address)", "emergencyWithdraw()",
            "execute(address,uint256,bytes)", "call(address,bytes)", "multicall(bytes[])", "setTreasury(address)",
            "transferToken(address,address,uint256)", "skim(address)", "upgradeTo(address)", "claim(bytes32)"
        ];
        address[4] memory callers = [owner, operator, alice, mallory];
        for (uint256 i; i < sigs.length; ++i) {
            for (uint256 j; j < callers.length; ++j) {
                vm.prank(callers[j]);
                (bool ok,) = address(ppc).call(
                    abi.encodeWithSelector(bytes4(keccak256(bytes(sigs[i]))), address(usdc), uint256(held), uint256(1))
                );
                assertFalse(ok, sigs[i]);
            }
        }
        // Plain ETH / empty calldata / unknown selector: no fallback or receive.
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        (bool okEmpty,) = address(ppc).call("");
        assertFalse(okEmpty);
        vm.prank(owner);
        (bool okEth,) = address(ppc).call{value: 1}("");
        assertFalse(okEth);

        assertEq(usdc.balanceOf(address(ppc)), held);
        assertEq(usdc.balanceOf(owner), 0);
        assertEq(usdc.balanceOf(operator), 0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    /// Owner / operator privileged functions cannot move escrow: after calling every one,
    /// the contract's token balance is unchanged.
    function test_privilegedFunctionsDoNotMoveTokens() public {
        _create(alice, NONCE, PARAMS);
        uint256 held = usdc.balanceOf(address(ppc));
        vm.startPrank(owner);
        ppc.pause();
        ppc.unpause();
        ppc.setOperator(makeAddr("op2"));
        ppc.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(bob);
        ppc.acceptOwnership();
        assertEq(usdc.balanceOf(address(ppc)), held);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(ppc.TREASURY(), treasury); // immutable
    }
}
