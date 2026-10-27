# PayPerCall Phase 4: end-to-end validation and deployment readiness

Baseline: `main` at `bb949c1` (Phase 3), one commit ahead of `origin/main`, clean apart from the untracked `payper-call-phase3.patch`. The contract and the Phase 2.1 security decisions were not changed. Nothing was deployed, pushed, committed, signed or sent.

## Defects found and fixed

| # | Defect | Effect | Fix | Regression tests |
| --- | --- | --- | --- | --- |
| 1 | `checkSettlement` read the contract state before the receipt. A settlement mined between the two reads was seen as "receipt success, contract still Paid" | Request marked `FAILED / SETTLEMENT_MISMATCH` although it settled correctly: payer charged, report never released | On a success receipt, read the contract again; while the node lags its own receipt, wait instead of failing | `server/requests.test.ts`: "a settlement mined between the contract read and the receipt read…", "a successful receipt from a node whose contract view still lags…" |
| 2 | The cron sweep processed the first 20 members of the active set. Redis returns set members in a stable order | With more than 20 active requests (unpaid ones linger 30 min), the same 20 were swept every run and paid requests from non-polling agents could starve until the refund deadline | Shuffle the members and process up to 200 within a 40 s budget (inside the 60 s function limit) | "a backlog of unpaid requests cannot starve a paid request…", "the scheduled sweep stops starting requests once its time budget is spent" |
| 3 | Vercel routes a catch-all file outside Next.js for one path segment only (`vercel build` emitted `^/api/([^/]+)$`) | Every real route, including the cron path `/api/v1/cron/process`, would return 404 | `vercel.json` rewrite `/api/:path*` to `/api/[...path]` | `server/deploy.test.ts`: "vercel.json sends every /api path…" |
| 4 | Vercel transpiles each file to ESM without bundling and keeps extensionless relative imports | The built function failed to load (`ERR_MODULE_NOT_FOUND: …/server/context`), so every API call would fail | `.js` extensions on relative imports in the function's import graph (`api/`, `server/`, `shared/`) | `server/deploy.test.ts`: "every relative import reachable from the Vercel function names its .js file" |

Defects 3 and 4 were found by running Vercel's own builder locally (`vercel@65.4.0 build`) and loading its output with Node. After the fixes, the build emits a route for any `/api` depth and the built module loads and exports `GET` and `POST`.

## Additional failure-path coverage (no defect found)

Settlement reverted while still Paid, settlement pending past the refund deadline, operator nonce repeatedly taken (re-signed at most three times, then `SETTLE_BROADCAST_FAILED`), payment arriving after expiry (never processed, shown as refundable), and a storage outage at the HTTP layer (502, nothing created).

## Checks run

| Check | Result |
| --- | --- |
| `bun test shared server src` | 79 pass, 0 fail, 8 files (68 at baseline) |
| `bun run typecheck` | exit 0 |
| Lint (`oxlint --type-aware …` and `oxlint .`, run through bash) | exit 0, no findings |
| `bunx vite build` | succeeded |
| `forge test --no-match-test invariant_` (WSL, Foundry 1.7.1) | 80 passed, 0 failed, 1 skipped (fork test), same as Phase 2.1 |
| `vercel build` (local, no deploy) | succeeded before and after the fixes |

The invariant campaign was not re-run because the contract did not change.

## Simulated versus real infrastructure

Everything in the request lifecycle (payment verification, report generation, settlement, report-hash verification, refunds, concurrency, cron locking, RPC lag, reverted and replaced transactions) was exercised against in-memory fakes. None of it ran against Arc mainnet, a real wallet, a real Upstash database or a deployed Vercel function.

Real tooling: Vercel's builder output and a local Node load of the built function. `vercel dev` could not be used (the project is not linked), so the router seeing the original URL after the rewrite is unverified.

## Remaining blockers and risks

- No PayPerCall deployment exists on Arc mainnet; the ready path has only run against fakes.
- `createViemSettler` (signing, fee floor, nonce handling) has never run against a live chain.
- Preview deployment checks still needed: `/api/v1/health` and a three-segment route reach the router with the original path, cron returns 401 without the secret.
- Vercel Cron runs only on production deployments. After Phase 4 the schedule was changed to daily (`0 0 * * *`) to fit the Vercel Hobby plan; an external scheduler calling `/api/v1/cron/process` every 5 minutes with the `CRON_SECRET` bearer is needed so paid requests nobody polls settle before the refund deadline (see README, "Scheduled processing").
- Upstash must keep eviction disabled (records, locks and the active set must not be evicted); `EVAL` scripting is used and has not been tried against a real Upstash database.
- A request that reaches `FAILED` is never reconciled if a settlement of ours later becomes visible as Settled (for example through RPC lag at the refund deadline). This is narrower after fix 1 but not eliminated.
- A settlement tx stuck below the fee market blocks later operator nonces until it is mined or dropped.
- The Arc Testnet real-token run from Phase 2.1 is still open, and the app has no testnet mode.
