# PayPerCall

Pay-per-request DeFi intelligence for trading agents: a payer escrows 0.10 USDC on Arc for a uniquely identified request, a report is delivered, and unsettled payments can be refunded after 30 minutes.

Built with [Arc Studio](https://studio.arc.io)

Status: the payment contract and its tests are done (Arc Testnet only, not deployed). The backend and frontend are still to come.

## Tech stack

- Solidity 0.8.28 with Foundry and OpenZeppelin
- React, Vite, TypeScript, Tailwind CSS, wagmi, viem

## Development

Prerequisites: [Bun](https://bun.sh) and [Foundry](https://book.getfoundry.sh).

```bash
bun install
bun run dev              # start the app
bun run contracts:build  # compile the contract
bun run contracts:test   # run the Foundry tests (the full run takes a couple of minutes)
bun run check            # lint and typecheck
```

Docs live in `docs/`: architecture, contract integration notes, the contract ABI, and a security review handoff.

### Environment variables

- `ARC_TESTNET_RPC_URL` (optional): when set, enables a read-only test that checks the contract accepts the real Arc Testnet USDC. Example value: the public Arc Testnet RPC from the Arc docs.
