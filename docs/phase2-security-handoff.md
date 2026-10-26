# PayPerCall Phase 2: security review handoff (for Claude Code)

Scope: `contracts/PayPerCall.sol` (177 lines after Phase 2.1, Solidity 0.8.28, evm `cancun`, OpenZeppelin 5.6.1). Not deployed. Arc Testnet (5042002) is the only intended target. Please review the contract and its tests independently; the checks below were run by Arc Studio and are not a substitute.

## What the contract is supposed to guarantee

1. A request exists only after exactly 100000 USDC base units (0.10 USDC, 6 decimals) moved into the contract in the same transaction.
2. `requestId = keccak256(abi.encode(chainId, contract, payer, nonce, paramsHash))`, with payer = `msg.sender`. IDs are never reusable, including after Settled or Refunded.
   A refund recipient cannot be the zero address, this contract, or the USDC token contract (Phase 2.1).
3. `settle` (operator only, `now < refundableAt`) and `refund` (original payer only, `now >= refundableAt`) are mutually exclusive, and a request leaves `Paid` at most once.
4. Escrow leaves the contract only through `settle` (to the immutable treasury) or `refund` (to a recipient chosen by the original payer). There is no withdraw, sweep, rescue, upgrade, or treasury setter.
5. A stolen operator key can only send escrow to the treasury (a false completion, costing each affected payer 0.10 USDC). A stolen owner key can rotate the operator and pause creation. Neither can steal escrow or block refunds.
6. Pause blocks `createRequest` only.

## Please attack these

- Order of effects and interactions in `createRequest` (state written before `transferFrom`, then a balance-delta check), `settle`, and `refund`.
- The balance-delta check with Arc's native-backed USDC, where the ERC-20 balance is a truncated view of an 18-decimal native balance.
- Behavior if USDC blocklists the contract, the treasury, the payer, or the refund recipient (see limitations).
- The exclusive boundary at `refundableAt` given that Arc block timestamps are non-decreasing and can repeat.
- Whether any path lets someone create, settle, or refund a request they should not control (payer binding, operator rotation, `Ownable2Step`, disabled renounce).
- Griefing: can anyone block a legitimate payer or force the escrow into an unrecoverable state?
- NatSpec and event data versus actual behavior (events are the integration evidence).

## What was run

| Check | Result |
| --- | --- |
| Internal rule-based review (balanced) | No material findings |
| Internal functional and adversary review (balanced) | No material findings |
| Slither (single file) | Only informational: `block.timestamp` comparisons (intended for the 30 minute rule) and naming of `USDC` and `TREASURY` constants |
| Foundry suite | See the results table in the Phase 2 report; coverage of `PayPerCall.sol` was reported at 100% lines, statements, branches and functions |

Run it yourself:

```bash
bun run contracts:build
bun run contracts:test                       # full suite incl. fuzz and invariants (slow: the 256 x 500 campaign took about 61 minutes in WSL)
forge test --no-match-test invariant_        # skips the slow invariant runs
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io forge test --match-path contracts/test/PayPerCall.Fork.t.sol -vv
```

## Known limitations and unresolved assumptions

- Standard Foundry runs a normal EVM. It cannot reproduce Arc's native-USDC semantics, so every transfer test uses mocks (including a mock blocklist). Real USDC `transferFrom`, `transfer`, and blocklist behavior on Arc has not been exercised. Phase 2.1 validation used standard Foundry 1.7.1; Arc Foundry (`arc-anvil`, `arc-forge`) has not been used anywhere yet. Only a read-only fork check confirms the constructor accepts the real USDC (6 decimals). A real-token test on Arc Testnet should happen before any mainnet consideration.
- The USDC at `0x3600...0000` is an upgradeable proxy (its code exposes admin and implementation selectors). Circle can change its behavior; the contract cannot defend against that.
- If USDC blocklists the escrow contract itself, funds are stuck and no logic here can fix it. A blocklisted payer can recover by refunding to another recipient; a blocklisted treasury makes `settle` revert, after which the payer refunds at the deadline.
- Native USDC force-sent to the contract (for example through `selfdestruct`) is unrecoverable and is never counted as escrow.
- No operator early-refund path: if report generation fails, the payer waits up to 30 minutes to refund. This is a product tradeoff, not a bug.
- The operator is trusted to attest delivery. The contract checks authorization and a non-zero `reportHash` only; it cannot verify the report.
- Single operator key, single treasury (immutable). Key custody is decided in Phase 3.
- Permit and EIP-3009 support on Arc USDC were not verified and are not used.
- Mainnet is not configured and nothing is deployed.

## Phase 2.1 remediation (after the independent Claude Code review)

Initial review verdict: CONDITIONAL PASS, no critical or high findings. Final review (2026-10-26): no critical, high or medium findings; its three low findings (L-1 to L-3 below) are fixed. All changes have been compiled and tested with Foundry 1.7.1; see "Validation results".

| Item | Change |
| --- | --- |
| Refund to the escrow itself | `refund` reverts with `InvalidRecipient()` when `recipient == address(this)`. Before, such a refund marked the request Refunded while the 0.10 USDC stayed locked in the contract with no way out. |
| Refund to the USDC token contract (final review L-1) | `refund` also reverts with `InvalidRecipient()` when `recipient == address(USDC)`, which would otherwise strand the escrow on the token contract. Same error, so the ABI is unchanged. Regression test: `test_10_usdcTokenRecipientRefundReverts`. |
| Compiler | Pragma pinned to `0.8.28`, matching `foundry.toml`. |
| Invariant campaign | 14 handler actions. Guided settle and refund actions, and `pausedLifecycle` (settles and refunds while paused, then restores the pause state), find or create a request the authorized caller can move. Adversarial actions (unauthorized settle by strangers, payers, the owner and rotated-out operators; unauthorized refund; self-recipient refund) also find or create a valid target first, so every call reaches its guard, and `invariant_guardsHold` checks the exact revert selector. `afterInvariant` compares each guided and adversarial action's call count with its outcome count, so it is exact, and a short or shrunk replay reports the invariant actually violated instead of failing on missing transitions (final review L-3 extended this to `refundUnauthorized`). Guided creation preserves the current pause state. `foundry.toml` states `runs = 256`, `depth = 500` and `show_metrics = true`. |
| New regression tests | Self-recipient and USDC-token-recipient refunds; pending owner has no owner powers; treasury as payer (settle and refund) and treasury as refund recipient; operator as payer gets no shortcut; USDC global pause during create, settle and past the deadline (state preserved, recovery after unpause); balance decrease during the pull (`BalanceDecreasingToken`) exercising the `balanceAfter < balanceBefore` branch. |

## Validation results (Foundry 1.7.1 in WSL Ubuntu, Slither 0.11.6)

These are local results against mocks plus one read-only testnet fork read. They do not show how real Arc USDC behaves; see steps 8 and 9 below.

**Latest round (2026-10-26, after the L-1 and L-3 fixes), all rerun:**

| Check | Command | Result |
| --- | --- | --- |
| Build | `forge build` | Compiler run successful, no compiler warnings. forge-lint style notes only (timestamp comparisons, `bytes4(reason)` casts in the handler, one intentional unchecked `transfer` in a test). |
| Non-invariant tests | `forge test --no-match-test invariant_ -vv` | 80 passed, 0 failed, 1 skipped. The skip is the fork test, which needs `ARC_TESTNET_RPC_URL`. 80 = the previous round's 79 plus the new L-1 regression test. |
| Invariant campaign | `forge test --match-test invariant_ -vv` (no persisted failures) | 5 of 5 invariants passed, 256 runs x depth 500 = 128,000 calls each, 0 reverts, 3,665 s. Each of the 14 actions ran 9,004 to 9,295 times. |
| Fork test | `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io forge test --match-path contracts/test/PayPerCall.Fork.t.sol -vv` | 1 passed (read-only; no USDC moved). |
| Coverage | `FOUNDRY_INVARIANT_RUNS=32 FOUNDRY_INVARIANT_DEPTH=100 forge coverage --report summary --report lcov` | 85 passed, 1 skipped. `PayPerCall.sol`: 100% lines (57/57), statements (79/79), branches (20/20), functions (10/10). The invariant campaign is reduced under coverage instrumentation. Forge does not count the two halves of `a \|\| b` separately; the mutation check below shows the `balanceAfter < balanceBefore` half is tested. |
| ABI | `forge inspect PayPerCall abi --json`, compared with this file | Identical, 50 entries. |
| Slither | `slither . --filter-paths "lib/\|node_modules/\|contracts/test/\|contracts/script/"` (on a copy with identical source) | 4 informational results: two `block.timestamp` comparisons (the intended 30-minute rule) and `USDC` / `TREASURY` not in mixedCase. |
| Mutation and handler checks (scratch copy) | Each mutant starts with no persisted failures | Removing the USDC-recipient guard fails `test_10_usdcTokenRecipientRefundReverts`; removing the payer check fails `invariant_guardsHold`. A depth-5 campaign passes (no spurious `afterInvariant` failure). Over 32 runs x depth 500, every guided and adversarial action's outcome count equals its call count in every run (for example 25 to 47 `NotPayer` rejections per run). |

**Carried forward from the previous round (2026-10-25, not rerun):** mutants M1 to M6 (self-recipient guard, balance-decrease guard, `onlyOperator`, payer check, pause check, settlement window) were each caught by the intended unit test and invariant, and a persisted M3 failure replayed as the real violation, not an `afterInvariant` artifact. The contract changes since then are the USDC-recipient guard and its comment.

## Operational limitations and response

## Operational limitations and response

**Fixed treasury.** `TREASURY` is immutable and there is no setter. If the treasury is blocklisted by USDC, every `settle` reverts and every open request falls through to refund, so the service stops collecting revenue until a new contract is deployed. If the treasury key is lost, settled revenue is lost. Escrow already in the contract stays safe through refunds in both cases. Use a cold or multisig treasury that is not the operator or owner. Migration: pause the old contract, deploy a new one with a new treasury, point the backend at it, let open requests on the old contract settle or refund.

**Circle USDC controls.** USDC on Arc is an upgradeable FiatToken proxy. On Arc Testnet, read-only calls on 2026-10-24 returned an implementation and admin in the legacy proxy slots, plus `owner()`, `pauser()`, `blacklister()` and `masterMinter()` roles. Consequences:
- A global USDC pause makes `createRequest`, `settle` and `refund` all revert. State is preserved; if the pause outlasts a request's settlement window, that request can only be refunded after unpause.
- Blocklisting this contract locks its escrow permanently; no contract logic can recover it.
- Blocklisting a payer or refund recipient only blocks transfers involving that address; the payer can refund to another recipient.
- An upgrade can change token behavior. The received-amount check makes `createRequest` fail closed if the token stops delivering exactly 0.10 USDC.

**Operator compromise response.** `pause()` blocks only new requests, so it does not stop a stolen operator key. The first action is `setOperator(newOperator)` from the owner key. Until then the attacker can settle open Paid requests to the treasury: no escrow is stolen, but each affected payer loses 0.10 USDC without a report (exposure is bounded by requests created in the last 30 minutes). Afterwards, list `RequestSettled` events from the compromised operator, compare them with delivered reports, and repay affected payers from the treasury off-chain. Keep the owner key separate from the operator key and offline.

**Owner compromise.** A stolen owner key can rotate the operator (same impact as above) or pause creation indefinitely. It cannot move escrow, change the treasury or block refunds. Ownership transfer is two-step and renounce is disabled.

## Required independent verification before deployment

Nothing may be deployed, on testnet or mainnet, until each item has actually been run and its output recorded. Status as of 2026-10-26: steps 1 to 7 are done (results above); steps 8 and 9 are **open**.

1. `forge build` with solc 0.8.28 succeeds with no new warnings.
2. `forge test --no-match-test invariant_ -vv` passes in full, including the new regression tests.
3. `forge test --match-test invariant_ -vv` passes with 256 runs and depth 500; record the `show_metrics` table and confirm `settleGuided`, `refundGuided`, `settleUnauthorized`, `refundUnauthorized`, `refundToSelf`, `togglePause`, `rotateOperator` and `pausedLifecycle` all executed. `afterInvariant` compares each guided or adversarial action's call count with its outcome count, so a campaign where those actions were called but missed their target fails.
4. `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io forge test --match-path contracts/test/PayPerCall.Fork.t.sol -vv` passes.
5. `forge coverage --report summary` reported; any branch below 100% explained.
6. Slither run on `contracts/PayPerCall.sol` with the OpenZeppelin remapping; findings triaged.
7. `docs/PayPerCall.abi.json` regenerated with `forge inspect PayPerCall abi --json` and diffed against the committed file.
8. **Open.** A real-token Arc Testnet run with faucet USDC and fresh test keys: create and settle; duplicate, unauthorized-settle, early-refund and non-payer-refund rejections; a second request left past its deadline (settle rejected, refund to another address succeeds); self-recipient and USDC-token-recipient refunds rejected; pause blocks creation while settle and refund still work. Record the transaction hashes. Until this runs, real USDC behavior on Arc is untested.
9. **Open.** An independent review of the final diff, including the L-1 and L-3 fixes.

`contracts/out/` was regenerated by `forge build` in the latest round.

## Files

- `contracts/PayPerCall.sol`
- `contracts/test/PayPerCall.t.sol`, `PayPerCall.Base.t.sol`, `PayPerCall.Lifecycle.t.sol`, `PayPerCall.Admin.t.sol`, `PayPerCall.Reentrancy.t.sol`, `PayPerCall.Invariant.t.sol`, `PayPerCall.Fork.t.sol`
- `contracts/test/mocks/Mocks.sol`
- `docs/PayPerCall.abi.json`, `docs/payper-call-integration.md`
