# PayPerCall: Phase 1 Architecture

Pay-per-request token, wallet, and liquidity risk reports for DeFi and trading agents, paid in USDC on Arc.

Status: planning only. Nothing is deployed and no transaction has been sent. Everything marked VERIFIED was checked this session; everything marked ASSUMPTION or NEEDS WORK has not been.

---

## 1. Scope decisions (read first)

| Decision | Choice | Why |
| --- | --- | --- |
| Target chain for intelligence | Tokens on Arc only (chain 5042 for the real demo, 5042002 for development) | Arc RPC is the only data source verified to work. Other chains need credentials and integrations that do not exist yet. |
| Build and test network | Arc Testnet first, mainnet as a gated cutover (section 9) | Arc Studio deploys to testnet only. Mainnet deploy, operator signing, and the real payment run in your hands outside Arc Studio. |
| Report engine | Deterministic, rule-based, no LLM | An LLM can invent findings. Every finding must carry evidence that points to a block, a call, or a transaction. |
| Payment mechanism | Small custom escrow contract (`PayPerCall`), approve then pay | Gives a unique request ID, an onchain payment record, and a refund path that needs no trust in the backend. |
| Price | One fixed price, set at deploy time. Proposed 0.10 USDC (100000 base units) | Decision for you. Immutable price removes a price-change attack surface. |
| Agent access | Plain HTTPS JSON API with an OpenAPI file | Any agent can call it. x402 or Gateway Nanopayments is a stretch goal, not the MVP (section 11). |

## 2. System architecture

```
 Agent / Browser UI
   |  1 POST /requests {token, tradeSizeUsd, payer}
   v
 API (Bun + Hono, port 3001, proxied at /api by Vite)
   |  creates request row, nonce, paramsHash, accessToken (hash stored)
   |  returns requestId + exact contract call to make
   |
   |  2 payer wallet: USDC.approve(PayPerCall, price) then PayPerCall.pay(paramsHash, nonce)
   v
 Arc  --------  PayPerCall contract (escrow, onchain payment record, events)
   ^
   |  3 Payment Verifier: reads receipt + logs + contract state over RPC (never trusts the client)
   |  4 Job runner claims the request atomically
   |  5 Intelligence service (RPC reads, Uniswap reads, explorer where reachable)
   |  6 Report builder: structured JSON, hash
   |  7 Operator settles onchain: settle(requestId, reportHash)  OR refunds
   v
 Report released only after the onchain state is Settled
```

Responsibilities:

| Component | Owns | Never does |
| --- | --- | --- |
| Frontend (React, wagmi, ConnectKit) | Form, quote display, wallet connection, approve and pay transactions, status polling, report rendering | Holds any secret, decides payment validity, computes risk |
| Smart contract | Fixed price, unique request IDs, escrow, state machine, refund guarantee, events | Reads reports, trusts any off-chain input, upgrades itself |
| Payment verifier (backend) | Independently confirms the payment from chain data and matches it to a request it created | Accepts a txHash as proof without reading the chain |
| Job runner (backend) | Atomic claim, processing lease, retries, deadlines, settle or refund decision | Runs the same request twice |
| Intelligence service (backend) | Collecting evidence from sources, with per-source status | Fills gaps with guesses |
| Report builder (backend) | Schema, evidence links, limitations, report hash | Claims anything its evidence cannot establish |
| Operator key (backend) | Calls `settle` and `refund` only | Can move funds anywhere except treasury (settle) or the original payer (refund) |

## 3. Smart contract design: `PayPerCall`

Simplest secure mechanism: **escrow with a pull-based refund**. Funds are held until the backend proves delivery by settling, or the payer takes them back after a deadline. This is the only design where "paid but not delivered" is solved onchain without trusting the backend. It is about 120 lines, has no loops, and is fully testable with Foundry.

Constructor (all immutable): `usdc` (0x3600000000000000000000000000000000000000, checked: code exists, `decimals()==6`), `price` (6-decimal base units), `refundWindow` (proposed 30 minutes), initial `owner`, `operator`, `treasury`.

State:

```solidity
enum Status { None, Paid, Settled, Refunded }
struct Payment {
  address payer;
  uint128 amount;
  uint64  paidAt;
  uint64  deadline;      // paidAt + refundWindow
  Status  status;
  bytes32 paramsHash;    // hash of token, chainId, tradeSize, product version
}
mapping(bytes32 => Payment) public payments;
```

Functions:

| Function | Caller | Rule |
| --- | --- | --- |
| `pay(bytes32 paramsHash, bytes32 nonce)` | Anyone (the payer) | Not paused. Computes `requestId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce, paramsHash))`. Reverts if that ID exists. Pulls exactly `price` USDC with `safeTransferFrom`. Emits `PaymentReceived(requestId, payer, amount, paramsHash, deadline)`. |
| `settle(bytes32 requestId, bytes32 reportHash)` | Operator | Status must be `Paid` and `block.timestamp <= deadline`. Sends escrowed USDC to `treasury`. Emits `Settled(requestId, reportHash)`. |
| `refund(bytes32 requestId)` | Operator | Status must be `Paid`. Sends USDC to the original payer only. Emits `Refunded`. |
| `claimRefund(bytes32 requestId)` | Anyone | Status `Paid` and `block.timestamp > deadline`. Sends USDC to the original payer only. |
| `pause()` / `unpause()` | Owner | Blocks `pay` only. Settle and refunds always work. |
| `setOperator`, `setTreasury` | Owner (Ownable2Step; multisig on mainnet) | Emit events. |

Why this is safe:

- **Unique request ID.** The ID commits to chain, contract, payer, a server-issued nonce, and the request parameters. A payment for one token and size cannot be replayed for another, and the same payer and nonce can never pay twice. Binding the payer in the ID stops a front-runner from paying your ID to steal refund rights.
- **No settle versus refund race.** `settle` is only valid before the deadline and `claimRefund` only after it. Past the deadline the payer always wins.
- **Operator is not a custodian.** A stolen operator key can only send escrow to the treasury or back to the payer. It cannot choose a destination. Worst case: it settles without delivering (a refund-rights loss until the key is rotated) or refunds early (a lost sale).
- **Report access is tied to `Settled`.** The backend generates the report, settles onchain, then releases it. If settle never lands, the deadline passes, the payer reclaims funds, and the report was never released.
- **Report hash onchain.** `Settled` carries `reportHash`, so a delivered report can be checked against the chain.
- **No upgrade path, no arbitrary withdraw, no loops.** Checks-effects-interactions, `SafeERC20`, `ReentrancyGuard`.

Known limits (accepted for the MVP): USDC can blacklist an address, in which case a refund to that payer reverts and the funds stay in escrow; tokens sent to the contract outside `pay` are not recoverable; the price changes only by redeploying.

Optional later: a native-value `payNative` (single transaction, no approval). Skipped because it mixes 18-decimal and 6-decimal views on a money path.

## 4. Request and payment lifecycle

Backend states (each transition is a compare-and-swap `UPDATE ... WHERE status = <expected>`; a zero-row result means someone else won):

```
CREATED --(pay seen)--> PAYMENT_DETECTED --(confirmed + checks pass)--> PAYMENT_VERIFIED
PAYMENT_VERIFIED --(claim, lease 120s)--> PROCESSING
PROCESSING --(report stored)--> REPORT_READY --(settle tx confirmed)--> COMPLETED
PROCESSING --(unrecoverable)--> REFUND_PENDING --(refund tx confirmed)--> REFUNDED
CREATED --(30 min, no payment)--> EXPIRED
any paid state --(deadline - 5 min margin reached)--> REFUND_PENDING
```

Payment verification (independent of the client):

1. A request row exists with `requestId`, expected payer, `paramsHash`, nonce, quoted price. Only IDs the server created are ever processed.
2. Source of truth is the chain, found two ways: the client posts a `txHash` (a hint only), and a log poller reads `PaymentReceived` from the contract.
3. Verify: receipt status success; log emitted by the configured contract address on the configured chain ID; `requestId` matches a `CREATED` row; payer matches; `amount == price` quoted; `paramsHash` matches; then `eth_call payments(requestId)` returns status `Paid` with the same fields.
4. Unique constraints: `requestId` primary key and `(txHash, logIndex)`. Plus the contract rejects duplicate IDs. Three layers against replay.
5. Anything else (wrong amount cannot happen because the contract fixes it, but wrong contract, wrong chain, unknown ID, wrong payer, reorged log) is recorded as ignored and never processed.

Duplicate processing: only one worker can move `PAYMENT_VERIFIED` to `PROCESSING`. A crashed worker's lease expires and the row is reclaimed, with a max of 2 attempts. `settle` is idempotent by contract state (a second call reverts), and the runner reads onchain status before sending.

Unauthorized access:

- `POST /requests` returns a 256-bit random `accessToken` once. Only its hash is stored. Status and report endpoints require `Authorization: Bearer <token>` and compare in constant time.
- Unknown ID and wrong token both return the same 404, so IDs cannot be enumerated.
- A report is returned only if DB status is `COMPLETED` and a fresh `payments(requestId)` read shows `Settled`. Otherwise it returns a status body, not the report.
- The access token is the only credential, so the UI keeps it in local storage and the API docs tell agents to store it with the request ID.

## 5. Intelligence data

Nothing here is promised beyond what is marked VERIFIED.

| Source | Status | Use |
| --- | --- | --- |
| Arc mainnet JSON-RPC `https://rpc.mainnet.arc.io` | VERIFIED: `eth_chainId` returns 0x13b2 (5042); head block was about 27.5 million | All onchain reads: code, storage, `eth_call`, logs, nonces. Backend uses the sandbox RPC proxy when present, `@/onchain-facts` URL otherwise. |
| USDC at 0x3600...0000 | VERIFIED on mainnet: `symbol()` is USDC, `decimals()` is 6. Bytecode looks like an upgradeable proxy (ASSUMPTION: confirm admin and implementation in Phase 2) | Payment asset |
| Arc Testnet explorer API (Blockscout v2) | VERIFIED: unauthenticated JSON works | Contract metadata and creation info for development |
| Arc mainnet explorer API | NOT USABLE: returned a Cloudflare challenge (403) from the sandbox | Treat contract verification status and holder lists as unavailable on mainnet unless a working API is found |
| Uniswap v2, v3, v4 on Arc mainnet | Addresses documented in Arc Studio's Uniswap reference (checked 2026-09-14). NEEDS WORK: re-verify code at build time, then implement. Not deployed on testnet | Pool discovery and quotes |
| GoPlus, DEXScreener, Etherscan V2, DefiLlama and similar | UNVERIFIED for Arc coverage, may need keys. Not used in the MVP | Possible later, only after a live check and a credential decision from you |

Report sections and what each can honestly establish:

| Section | Method (no credentials needed) | Cannot establish |
| --- | --- | --- |
| Token | `getCode`; ERC-20 `name/symbol/decimals/totalSupply`; EIP-1967 proxy slots; `owner()`, `paused()` reads; bytecode selector scan for mint, pause, blacklist, fee setters (reported as indicators, not proof of capability) | Whether source matches bytecode on mainnet, whether it is a honeypot, who is behind it |
| Wallet | For the owner, proxy admin, and an optional supplied wallet: balance, nonce, code or EOA, token balance and share of supply, recent Transfer logs in a bounded window | Real-world identity, links to other wallets, full history beyond the scanned window |
| Liquidity | Find v2 pairs and v3 pools against USDC; read reserves or liquidity; quote the requested trade size through the Uniswap quoter to get execution price and price impact; v4 later via PoolManager `Initialize` logs | LP lock status, off-Uniswap liquidity, future liquidity removal, MEV exposure |
| Holder concentration | Rebuilt from Transfer logs only when the token's creation block is resolvable and the range is bounded | Anything beyond the scanned range; otherwise reported `unavailable` |

Report schema (versioned):

```json
{
  "schemaVersion": "1",
  "requestId": "0x...",
  "subject": { "chainId": 5042, "token": "0x...", "tradeSizeUsd": "5000.00" },
  "generatedAt": "ISO-8601",
  "chainState": { "blockNumber": 0, "blockTimestamp": 0 },
  "sections": [{
    "id": "token|wallet|liquidity",
    "status": "ok|partial|unavailable",
    "findings": [{ "id": "...", "severity": "info|low|medium|high", "text": "...", "evidenceRefs": ["e1"] }],
    "evidence": [{ "id": "e1", "type": "eth_call|log|storage|quote", "source": "arc-rpc", "ref": "contract/block/tx", "observedAt": "ISO-8601", "value": "raw" }],
    "limitations": ["what this section could not check"]
  }],
  "notEstablished": ["honeypot behavior", "team identity", "..."],
  "reportHash": "keccak256 of canonical JSON without this field"
}
```

Rules: every finding must reference evidence; a failed source yields `unavailable` with the reason, never a default; there is no single "safety score" because a number would claim more than the evidence supports.

## 6. Failure handling

| Case | Behavior |
| --- | --- |
| Paid, report generation fails (bug, RPC down) | Retry once within the lease. Still failing: `REFUND_PENDING`, operator calls `refund`. If the operator is down, the payer calls `claimRefund` after the deadline. |
| Some data unavailable | If the token section succeeded, deliver a `partial` report listing exactly what is missing, then settle. If the token section itself failed, refund. Rule is fixed in code and shown on the quote screen. |
| Request times out | Worker must settle at least 5 minutes before the deadline, else it refunds. Payer can always `claimRefund` after the deadline. |
| Settle transaction fails | Retry with backoff until the margin, then refund. Report stays unreleased. |
| Never paid | `EXPIRED` after 30 minutes. Nothing onchain. |
| Payment for an unknown or mismatched request | Left in escrow; the payer can `claimRefund` after the deadline. Logged as ignored. |
| Reorg or log removed | Verification reads contract state at confirmation, not just logs; the row only advances when state is `Paid`. |

Refunds are recommended: they are pull-based, require no off-chain judgement for the deadline path, send only to the payer, and are covered by Foundry tests.

## 7. Components

Frontend (`src/components/`): `RequestForm`, `QuotePanel` (price, contract, chain, failure policy), `WalletGate` (connect and Arc chain check), `PayStepper` (approve, pay, verifying, generating, done), `ReportView` (sections, severity, evidence links via `buildTxExplorerUrl`, limitations), `RequestHistory`, `AgentApiPanel` (curl and fetch examples, OpenAPI link). Chain, USDC, and explorer facts come from `@/onchain-facts`; amounts use `@/onchain-money`.

Backend (`server/`): `routes/` (requests, payment hint, status, report, health, quote, openapi), `db/` (requests table with unique constraints), `chain/` (viem client, event poller starting at the deployment block, verifier), `intel/` (`token.ts`, `wallet.ts`, `liquidity.ts`, each returning a section with status), `report/` (schema, canonical JSON, hash), `runner/` (claim, lease, settle, refund), `auth/` (token hashing), `ratelimit`. Secrets (operator key) live only in server env, never in a `VITE_` variable.

Public API:

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/quote` | Price, USDC address, contract, chain ID, refund policy |
| `POST /api/v1/requests` | Create request; returns requestId, nonce, paramsHash, expiry, accessToken |
| `POST /api/v1/requests/:id/payment` | Optional `{txHash}` hint to speed up verification |
| `GET /api/v1/requests/:id` | Status (token required) |
| `GET /api/v1/requests/:id/report` | Report if settled, else 402 with status |
| `GET /api/v1/openapi.json` | Machine-readable spec for agents |

Controls: strict address and size validation, rate limits and a cap on pending requests per IP and payer, request bodies bounded, no raw RPC errors returned to clients.

Storage: SQLite for the MVP with the sandbox durability setup, or Postgres in a container. ASSUMPTION to settle in Phase 3.

## 8. Arc and USDC integration requirements

| Item | Requirement |
| --- | --- |
| Testnet | Chain ID 5042002, RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`, funded by the Get test USDC button |
| Mainnet | Chain ID 5042, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io` |
| USDC | ERC-20 at `0x3600000000000000000000000000000000000000`, 6 decimals (same address on both networks). Use only the ERC-20 view. The native view has 18 decimals and is for gas only. |
| Config source | Import from `@/onchain-facts`; never retype addresses or decimals |
| Deploy-time checks | `eth_chainId` equals the intended network; USDC `getCode` non-empty; `decimals()==6`; `symbol()=="USDC"`; address equals the registry value and Circle's published contract-address page; constructor reverts otherwise |
| Gas | Max fee per gas of at least 20 gwei or transactions are dropped silently. Operator wallet needs gas USDC. On mainnet that must be obtained separately (see risks). |
| Blocks | About 0.5 seconds, so use timestamps for deadlines and order events by block number |
| Start block | Poller starts at the contract's deployment block, never block 0; it reports current block, head, and blocks remaining |
| Unverified, test on a fork before relying on it | USDC permit or EIP-3009 support; blacklist behavior in `transferFrom` and refunds; finality semantics (the plan uses 1 confirmation plus a contract-state read until confirmed) |

## 9. Deployment and evidence

Sequence: testnet deploy through Arc Studio (Phase 2), full end-to-end on testnet (Phase 4), then a gated mainnet cutover (Phase 5).

Mainnet is done by you, outside Arc Studio: Arc Studio can generate the deploy script and checklist, but it does not deploy to, sign for, fund, or transact on mainnet. You deploy `PayPerCall` from your own wallet, set the operator and treasury (multisig preferred), run the backend with an operator key you control, and make the real payment from your own wallet. Mainnet work starts only after you confirm the disclaimer in the chat reply.

Evidence for a successful real transaction (all must be real, none fabricated):

1. Deploy transaction hash and contract address, with constructor arguments matching section 8.
2. Source verified on the explorer, or the Standard JSON input and compiler settings published if the explorer cannot verify.
3. `pay` transaction hash, plus the decoded `PaymentReceived` log with requestId, payer, amount equal to the price.
4. `settle` transaction hash and the `Settled` log whose `reportHash` equals the hash of the delivered report.
5. `eth_call payments(requestId)` output showing `Settled`.
6. Backend request record (status history with timestamps) and the report JSON.
7. USDC balance deltas for payer and treasury equal to the price.
8. A recorded run of an agent calling the API with `curl` only.

## 10. Acceptance tests

Contract (Foundry, unit, fuzz, invariant):

| ID | Test | Expected |
| --- | --- | --- |
| C1 | Valid `pay` | Escrow +price, status Paid, event data correct |
| C2 | Duplicate `pay` with same payer, nonce, params | Reverts, no extra transfer |
| C3 | Same nonce from a different payer | Different ID, both succeed |
| C4 | No allowance or insufficient balance | Reverts, no state change |
| C5 | `settle` by non-operator; `refund` by non-operator | Reverts |
| C6 | `settle` after deadline | Reverts; `claimRefund` works |
| C7 | `claimRefund` before deadline | Reverts |
| C8 | `settle` then `refund` or `claimRefund` | Reverts (no double spend) |
| C9 | Refund destination | Always the original payer |
| C10 | Paused contract | `pay` reverts; settle and refund still work |
| C11 | Constructor with wrong decimals or no code at USDC | Reverts |
| C12 | Invariant | Contract USDC balance equals sum of `Paid` amounts |
| C13 | Reentrancy attempt through a hostile token mock | Blocked |

Backend (mocked RPC plus a local fork):

| ID | Test | Expected |
| --- | --- | --- |
| B1 | Payment with valid tx and matching request | `PAYMENT_VERIFIED` |
| B2 | Client posts a txHash for a different contract, chain, or request | Rejected, never processed |
| B3 | Same txHash or log posted twice, and two parallel workers | One report, one settle |
| B4 | Payment by a different payer than the request's | Ignored |
| B5 | Underpayment by direct USDC transfer (no `pay`) | No request advances |
| B6 | Missing, wrong, or other-request token on status and report | 404, identical bodies |
| B7 | Report requested before `Settled` | No report body |
| B8 | Forced failure in the intelligence step | Refund executes, status `REFUNDED`, no report |
| B9 | One source unavailable, token section fine | `partial` report with the gap listed |
| B10 | Worker crash mid-processing | Lease expires, exactly one completion |
| B11 | Settle blocked until deadline | Payer `claimRefund` succeeds |
| B12 | Report contains an unsupported claim | Schema check fails: every finding needs evidence |

End to end:

| ID | Test | Expected |
| --- | --- | --- |
| E1 | Testnet: create request, approve, pay, receive report | Report hash matches the `Settled` event |
| E2 | Same flow driven only by `curl` and a script wallet | Works without the UI |
| E3 | Testnet with injected failure | Funds back to payer |
| E4 | Mainnet (your run): real payment | Evidence list in section 9 complete |

## 11. Implementation sequence

| Phase | Work | Exit gate |
| --- | --- | --- |
| 2 | Write `PayPerCall`, Foundry tests C1 to C13, USDC fork checks (permit, blacklist, transfer semantics), testnet deploy | All contract tests pass; testnet address recorded in `AGENTS.md` |
| 3 | Backend: DB, verifier, poller, runner, intelligence modules with live Arc reads, report schema, API and OpenAPI, tests B1 to B12 | Report generated for real Arc tokens with no fabricated field |
| 4 | Frontend flow, wiring to testnet contract, integration tests, E1 to E3, agent API panel | Full testnet run with traces captured |
| 5 | Security review of contract and backend; fix findings; mainnet readiness checklist; your confirmed mainnet deploy and real payment (E4); evidence pack; optional Circle Agent Marketplace submission (manual review, not instant) and optional x402 endpoint if current Circle docs confirm Arc support | Evidence list complete |

## 12. Major risks and open assumptions

| Risk or assumption | Impact | Plan |
| --- | --- | --- |
| Few tokens and pools on Arc mainnet | Thin demo data | Pick real demo tokens in Phase 3; say plainly when a pool does not exist |
| Mainnet explorer API blocked from the sandbox | No verification status or holder lists on mainnet | Report them as unavailable; revisit if a working endpoint is found |
| Mainnet gas for the operator wallet | Settle and refund cannot run | Obtain gas USDC through Circle's documented route before Phase 5 |
| Backend must run somewhere reachable by agents and hold the operator key | Mainnet settle cannot run inside the Arc Studio sandbox | You run it (or a Docker host) for the mainnet demo; confirm hosting |
| Operator key custody | Key theft limited to settle or refund of open payments | Testnet: env key. Mainnet: consider a Circle developer-controlled wallet (needs API key and entity secret; Arc mainnet support unconfirmed) |
| USDC proxy upgrade or blacklist | Refund could revert for one payer | Documented limit; fork-tested |
| Gateway or x402 support on Arc mainnet unconfirmed | Stretch goal may not be possible | Treat as optional, verify in Phase 5 |
| Heuristic bytecode scan | False positives and negatives | Labeled as indicators with limitations |
| Log scans on a 0.5 second chain | Slow, large ranges | Bounded windows, cached, and explicit "not scanned" statements |
| Price and refund window | Product choices | Proposed 0.10 USDC and 30 minutes; need your decision |
