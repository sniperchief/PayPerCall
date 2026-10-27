# PayPerCall

Pay-per-request DeFi intelligence for trading agents. Pay 0.10 USDC on Arc for a token risk report. The report is revealed only after the payment is confirmed and settled onchain, and an unsettled payment can be refunded after 30 minutes.

Built with [Arc Studio](https://studio.arc.io)

Status: the Arc mainnet contract is not deployed yet. Until its address is configured, the app and the API stay disabled and refuse payments.

## What it does

- Connect a wallet on Arc mainnet and enter a token address and the trade size you are considering.
- Pay 0.10 USDC. The service confirms the payment from the contract itself, then builds the report.
- The report lists findings with the evidence behind each one, what could not be checked, and the data limits. Wallet and liquidity analysis are not available yet and are marked as such.
- If a report is not delivered, refund the 0.10 USDC from the app once the 30 minute deadline passes.

## Tech stack

- Solidity 0.8.28, Foundry, OpenZeppelin
- React, Vite, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit
- Vercel Functions for the API, Upstash Redis (REST) for storage

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev              # frontend on :5173 (proxies /api to :3001)
bun run dev:api          # API on :3001
bun test shared server src   # app and API tests
bun run check            # lint and typecheck
bun run contracts:build  # compile the contract
bun run contracts:test   # Foundry tests (the full run takes a couple of minutes)
```

Copy `.env.example` to `.env` for local work. For a quick local API run without Redis, set `PPC_ALLOW_MEMORY_STORE=1`. That option is refused on Vercel.

Docs are in `docs/`: architecture, contract integration notes, the contract ABI, the security review handoff, and `phase3-frontend-backend.md` (setup, API, verified network facts, open items).

### Environment variables

| Name | Purpose |
| --- | --- |
| `VITE_PAY_PER_CALL_ADDRESS` | Deployed PayPerCall contract on Arc mainnet. Leave empty until deployment; everything fails closed while empty or invalid. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Durable storage for requests (required in production). |
| `PPC_ALLOW_MEMORY_STORE` | Set to `1` for local development and tests only. |
| `ARC_MAINNET_RPC_URL` | Optional https RPC override for the server. |
| `PPC_OPERATOR_PRIVATE_KEY` | Optional, server only. Key of the contract operator, used to settle requests. Without it nothing is settled and no report is released. |
| `CRON_SECRET` | Secret for the scheduled processing endpoint `/api/v1/cron/process`; callers send it as `Authorization: Bearer <secret>`. |
| `PPC_API_PORT` | Optional local API port (default 3001). |
| `ARC_TESTNET_RPC_URL` | Optional. Enables a read-only Foundry fork test against Arc Testnet USDC. |

### Scheduled processing

Requests advance whenever their status is polled; the browser polls every 2.5 seconds. Paid requests that nobody polls are advanced by `/api/v1/cron/process`, and must settle within about 25 minutes of payment or they fall back to the payer's refund. `vercel.json` schedules Vercel Cron daily (`0 0 * * *`) because the Vercel Hobby plan allows only daily crons. For timely processing, have an external scheduler (for example cron-job.org or Upstash QStash) call `GET /api/v1/cron/process` every 5 minutes with `Authorization: Bearer <CRON_SECRET>`. Overlapping runs are safe: a run lock skips concurrent sweeps and every state change is a compare-and-set.
