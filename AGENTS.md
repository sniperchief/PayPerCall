# [App Name]

> Built with Arc Studio - money-powered apps in minutes

This is the **project memory** - what Arc Studio remembers about building this app. It helps future agents (or humans) understand and extend the project.

---

## What This App Does

PayPerCall: pay-per-request DeFi intelligence for agents. A payer escrows 0.10 USDC on Arc for a uniquely identified request; an operator settles after the report is produced; the payer can refund after 30 minutes if unsettled. Backend runs on Vercel Functions with Upstash Redis. Token scope is Arc-only.

## Status

- Phase 1: architecture in `docs/architecture.md`.
- Phase 2: `contracts/PayPerCall.sol` and Foundry tests done. NOT deployed. Arc Testnet only. Integration notes in `docs/payper-call-integration.md`, ABI in `docs/PayPerCall.abi.json`, review handoff in `docs/phase2-security-handoff.md`.
- Phase 2.1: independent Claude Code reviews and remediation applied: refunds to this contract or to the USDC token contract rejected (`InvalidRecipient`), pragma pinned to 0.8.28, invariant campaign strengthened (14 actions, exact per-action counts in `afterInvariant`), missing regression tests added, operational risks documented. Final review: no critical/high/medium findings; its three low findings fixed.
- Phase 2.1 validation (Foundry 1.7.1, 2026-10-26): build OK; 80 non-invariant tests passed, 1 fork-test skip (fork test passes separately with the testnet RPC); 5 invariants passed at 256 runs x depth 500; `PayPerCall.sol` coverage 100% lines/statements/branches/functions; generated ABI identical to `docs/PayPerCall.abi.json`; Slither 4 informational results. Details, and which results were carried forward, in `docs/phase2-security-handoff.md`.
- Still open before any deployment: real-token Arc Testnet run (real USDC behavior is untested) and an independent review of the final diff.
- Phase 3 (frontend, wallet, backend): done in the Arc Studio workspace. Details, API, env vars, verified network facts and blockers in `docs/phase3-frontend-backend.md`. Production network is Arc mainnet (5042); `VITE_PAY_PER_CALL_ADDRESS` is intentionally empty and everything fails closed until a deployed address is set. Nothing was deployed or sent. Phase 4 and 5 not started.
- Locked decisions: price 0.10 USDC, refund timeout 30 minutes, Arc-only tokens, Vercel Functions backend + Upstash Redis REST (in-memory store for local dev and tests only), independent review by Claude Code. Arc mainnet is the production target; Phase 2 testing used Arc Testnet.
- Deployed addresses: none yet.
- Phase 2 changes from Phase 1: no operator early-refund and no anyone-callable refund; only the payer refunds, to a recipient they choose; treasury is immutable; settle valid while `now < refundableAt`, refund while `now >= refundableAt`.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc mainnet (Chain ID 5042, viem `arc`). Contract tests and the optional fork test use Arc Testnet (5042002).
- Token: USDC ERC-20 interface, 6 decimals, address from `@/onchain-facts` (0x3600...0000 on both networks)
- Backend: Vercel Functions (`api/[...path].ts`) over the router in `server/`, Upstash Redis REST for state, `bun run dev:api` for local
- Tests: `bun test shared server src` (node:test files run by bun) and `forge test`
- Toasts: Sonner

## Key Files

- `src/App.tsx` - composition root; `src/components/`, `src/hooks/usePayFlow.ts` (approve + pay), `src/hooks/useRequestView.ts` (server polling), `src/lib/`
- `src/config.ts` - wagmi config (Arc mainnet only)
- `shared/` - protocol constants, request ID / params hash, typed ABI (checked against `docs/PayPerCall.abi.json`)
- `server/` - config (fail closed), store, chain access, request lifecycle, report generator, HTTP router; `api/[...path].ts` is the Vercel entry

## To Run

```bash
bun install
bun run dev        # frontend
bun run dev:api    # API on :3001 (set PPC_ALLOW_MEMORY_STORE=1 locally)
bun test shared server src
```
