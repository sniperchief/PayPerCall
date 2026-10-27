# PayPerCall Phase 3: frontend, wallet and backend integration

Scope: wallet connection, the USDC payment flow into the reviewed PayPerCall contract, a Vercel Functions backend that reads onchain request state, and report release gated on confirmed settlement. The Phase 2.1 contract and its tests were not changed.

Nothing was deployed and no transaction was sent or signed. The only network activity was read-only calls and document fetches.

## Verified production network configuration

Production target is Arc mainnet. These values were checked against official sources in this phase before being used, not taken from the request.

| Item | Value | Evidence |
| --- | --- | --- |
| Chain ID | 5042 | docs.arc.io `connect-to-arc` page (MetaMask, Rabby, Coinbase and Rainbow setup tables) lists Chain ID 5042; live `eth_chainId` on the RPC returned `0x13b2`, which is 5042; viem's `arc` chain definition is id 5042 |
| RPC | `https://rpc.mainnet.arc.io` | docs.arc.io `connect-to-arc`; it answered the live calls above |
| Explorer | `https://explorer.arc.io` | docs.arc.io `connect-to-arc` |
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000`, 6 decimals | docs.arc.io `contract-addresses` (Mainnet row); live `symbol()` returned USDC and `decimals()` returned 6 on Arc mainnet |
| Gas | `maxFeePerGas` of at least 20 gwei | docs.arc.io `evm-differences`; the settler enforces the floor |
| Finality | Deterministic on inclusion | docs.arc.io `evm-differences` |

The server checks the same facts again at runtime (see "Fail closed"). The app never lists Arc Testnet as a network.

## Components

| Path | Role |
| --- | --- |
| `shared/` | Constants (price 100000, refund delay 1800, chain 5042), request ID and params hash (cross-checked against independent `cast` vectors), typed ABI fragments (tested against `docs/PayPerCall.abi.json`) |
| `server/config.ts` | Environment validation. Fails closed |
| `server/context.ts` | Builds dependencies and runs the preflight against the live chain |
| `server/store.ts` | Upstash Redis REST client and the in-memory store (local and tests only) |
| `server/chain.ts` | Chain reads, token inspection, and the operator-side settler (viem) |
| `server/requests.ts` | Request lifecycle with compare-and-set transitions |
| `server/report.ts` | Evidence-backed report generator and canonical hashing |
| `server/http.ts`, `api/[...path].ts` | Router and the Vercel Function entry |
| `src/hooks/usePayFlow.ts` | Create request, approve, pay, with real wallet and receipt states |
| `src/hooks/useRequestView.ts` | Polls the server for status and fetches the report |
| `src/components/` | Header, form, status panel, refund panel, report view, history, configuration notice |

## Request lifecycle

`CREATED -> PAYMENT_VERIFIED -> PROCESSING -> REPORT_READY -> SETTLING -> COMPLETED`, with `FAILED`, `REFUNDED` and `EXPIRED` as exits.

1. `POST /api/v1/requests` validates the token, payer and trade size, creates a random nonce, computes `paramsHash` and the contract's `requestId`, stores a record with only the SHA-256 of the access token, and returns the token once.
2. The browser checks that the server's contract, chain and USDC match its own configuration, reads the contract's `PRICE()` and the payer's USDC balance and allowance, then sends `approve(contract, 0.10 USDC)` if needed and `createRequest(nonce, paramsHash)`. Each step waits for its receipt.
3. The server confirms payment itself by reading `requests(requestId)` from the contract: status Paid, same payer, same params hash, refund window of 1800 seconds. A transaction hash from the browser is never used or accepted as proof. Report work starts only after that read passes.
4. A worker claims the request with a compare-and-set and a 120 second lease, builds the report, stores it, and records its keccak256 hash. A crashed worker is recovered when its lease expires, with at most two attempts.
5. The operator signs the `settle(requestId, reportHash)` transaction, the signed hash is saved first, then it is broadcast. A retry re-broadcasts the identical signed transaction, so a retry cannot produce a second settlement. Settlement runs under a Redis lock so concurrent requests do not collide on the operator nonce.
6. The request completes only when the settlement transaction succeeded, the contract reports Settled, and the `RequestSettled` log from the configured contract carries the stored report's hash and the right payer.
7. `GET /api/v1/requests/:id/report` returns the report only when the record is COMPLETED, the contract still reports Settled, and the stored report still hashes to the settled hash. Otherwise it returns 409 without the report.
8. If the report cannot be delivered safely (generation fails, or less than 5 minutes remain before the refund deadline), the request is marked FAILED and nothing is settled. The payer refunds from the app after the deadline. There is deliberately no early operator refund.

Duplicate processing is prevented at four layers: a unique request ID with a unique stored record, compare-and-set on every transition, a lease on report generation, and a lock plus persisted signed transaction for settlement. The contract also rejects a second settlement.

Unauthorized access: status and report endpoints need the bearer access token. An unknown request, a malformed ID and a wrong token return the same 404. Tokens are compared in constant time on their hashes. The cron endpoint is hidden unless `CRON_SECRET` is set. New requests are refused with `503 SETTLEMENT_DISABLED` while settlement is disabled, so nobody pays for a request the server cannot settle.

## Fail closed

The API answers 503 `NOT_READY` and lists the reasons, and the UI disables payment, when any of these is true:

- `VITE_PAY_PER_CALL_ADDRESS` is empty, malformed or the zero address
- no durable store is configured (`PPC_ALLOW_MEMORY_STORE` is refused on Vercel)
- the RPC reports a chain other than 5042
- no contract code exists at the configured address, or it does not respond as a PayPerCall contract
- the contract's USDC is not the official Arc USDC, its price is not 100000, or its refund delay is not 1800
- the contract is paused (new requests only)

Settlement is disabled (and reports stay locked) when `PPC_OPERATOR_PRIVATE_KEY` is missing or its address is not the contract's operator.

Observed in this phase against the live Arc mainnet RPC (read-only): with no address configured the API reported the configuration error; with the USDC address configured it reported "does not look like a PayPerCall contract"; with an empty address it reported "No contract code". No valid PayPerCall deployment exists yet, so the ready path was exercised only against fakes.

## API (all under `/api/v1`)

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Readiness and configuration problems |
| `GET /quote` | none | Contract, USDC, price, refund delay |
| `POST /requests` | none, rate limited | Create a request: `{token, tradeSizeUsd, payer}` |
| `GET /requests/:id` | Bearer access token | Status, advances the request, includes onchain payment state |
| `GET /requests/:id/report` | Bearer access token | Report, only after confirmed settlement |
| `GET` or `POST /cron/process` | Bearer `CRON_SECRET` | Advances outstanding requests (GET is what Vercel Cron sends) |

## Setup

Local: copy `.env.example` to `.env`, set `PPC_ALLOW_MEMORY_STORE=1`, run `bun run dev` and `bun run dev:api`. The UI will show "Payments are disabled" until `VITE_PAY_PER_CALL_ADDRESS` points at a real deployment.

Vercel: create an Upstash Redis database, then set `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` and `VITE_PAY_PER_CALL_ADDRESS` in the project settings. Set `PPC_OPERATOR_PRIVATE_KEY` (server only, encrypted) and `CRON_SECRET`. Functions use a 60 second duration limit (`vercel.json`). Client polling advances requests that a browser is watching; `vercel.json` also schedules `GET /api/v1/cron/process` every 5 minutes so paid requests progress when no client polls (for example an agent that pays and stops polling). A run lock (90 seconds, longer than the function limit) keeps overlapping cron deliveries from running two sweeps at once, and every state change is a compare-and-set, so a repeated delivery settles nothing twice. The 5 minute schedule needs a Vercel Pro (or Enterprise) plan: Hobby projects only allow daily cron jobs and fail deployment with a more frequent expression.

## Tests run in this phase

- `bun test shared server src`: 56 tests across 7 files, all passing. Covers config failures, preflight failures, request ID and hash vectors, ABI drift, store atomicity and the Upstash wire format, the full lifecycle, concurrent invocations, retry idempotency, payment mismatch, deadline margin, generation failure, missing settlement key, settlement hash mismatch, tampered report, refund detection, crash recovery, authorization, rate limits, HTTP gating, and the UI stage logic.
- `bun run check` (lint and typecheck): clean.
- `bunx vite build`: succeeded.
- `forge build` and `forge test --no-match-test invariant_`: 80 passed, 0 failed, 1 skipped (the fork test, which needs `ARC_TESTNET_RPC_URL`), the same as the Phase 2.1 record. The slower invariant suite was not re-run.

## Not done and open items

- The contract is not deployed. There is no real end-to-end run (wallet, payment, settlement) and none was claimed. The ready path is covered only by fakes.
- The viem settler (`createViemSettler`) has never run against a live chain. Its signing, fee floor and nonce handling need a real test once a deployment and an operator wallet with gas USDC exist.
- The browser flow has been typechecked and built, not exercised with a real wallet.
- Wallet activity and liquidity sections of the report are not implemented. They are returned as "unavailable" with the reason. The token section uses direct Arc RPC reads only; there is no verified-source or holder data source.
- Settlement of a request whose signed transaction was lost and whose nonce was reused re-signs under the lock, up to three times, then fails the request to the refund path.
- The access token is kept in browser local storage; anyone with access to the browser profile can read the request.
- The mainnet explorer API was not usable from the sandbox (Cloudflare challenge), so no explorer-based data is used.
- Mainnet deployment, funding the operator with gas USDC, and the first real payment are yours to do outside Arc Studio, after your own review.
