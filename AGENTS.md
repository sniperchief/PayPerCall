# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

PayPerCall: pay-per-request DeFi intelligence for agents. A payer escrows 0.10 USDC on Arc for a uniquely identified request; an operator settles after the report is produced; the payer can refund after 30 minutes if unsettled. Backend will run on Vercel Functions (Phase 3). Token scope is Arc-only.

## Status

- Phase 1: architecture in `docs/architecture.md`.
- Phase 2: `contracts/PayPerCall.sol` and Foundry tests done. NOT deployed. Arc Testnet only. Integration notes in `docs/payper-call-integration.md`, ABI in `docs/PayPerCall.abi.json`, review handoff in `docs/phase2-security-handoff.md`.
- Phase 2.1: independent Claude Code reviews and remediation applied: refunds to this contract or to the USDC token contract rejected (`InvalidRecipient`), pragma pinned to 0.8.28, invariant campaign strengthened (14 actions, exact per-action counts in `afterInvariant`), missing regression tests added, operational risks documented. Final review: no critical/high/medium findings; its three low findings fixed.
- Phase 2.1 validation (Foundry 1.7.1, 2026-10-26): build OK; 80 non-invariant tests passed, 1 fork-test skip (fork test passes separately with the testnet RPC); 5 invariants passed at 256 runs x depth 500; `PayPerCall.sol` coverage 100% lines/statements/branches/functions; generated ABI identical to `docs/PayPerCall.abi.json`; Slither 4 informational results. Details, and which results were carried forward, in `docs/phase2-security-handoff.md`.
- Still open before any deployment: real-token Arc Testnet run (real USDC behavior is untested) and an independent review of the final diff.
- Locked decisions: price 0.10 USDC, refund timeout 30 minutes, Arc-only tokens, Vercel Functions backend, Arc Testnet for this phase, independent review by Claude Code.
- Deployed addresses: none yet.
- Phase 2 changes from Phase 1: no operator early-refund and no anyone-callable refund; only the payer refunds, to a recipient they choose; treasury is immutable; settle valid while `now < refundableAt`, refund while `now >= refundableAt`.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
