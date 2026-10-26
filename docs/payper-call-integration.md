# PayPerCall: contract integration interface (Phase 2)

For the Vercel Functions backend (Phase 3) and the frontend (Phase 4). Network for this phase: Arc Testnet only. Nothing is deployed yet, so no contract address exists.

ABI: `docs/PayPerCall.abi.json` (generated from `contracts/PayPerCall.sol` with `forge inspect PayPerCall abi --json`).

## Configuration sources

| Item | Value | Source |
| --- | --- | --- |
| Chain | Arc Testnet, chain ID 5042002 (0x4CEF52) | `eth_chainId` on `https://rpc.testnet.arc.io` returned `0x4cef52`; `src/onchain-facts.ts` |
| RPC | `https://rpc.testnet.arc.io` | `src/onchain-facts.ts`; Arc docs |
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000`, 6 decimals | Arc docs contract-addresses page; live `decimals()` returned 6 and `symbol()` returned USDC on testnet |
| Native view | 18 decimals, gas only. Never use for amounts. | Arc docs EVM differences |
| Min fee | `maxFeePerGas` of at least 20 gwei or transactions are silently dropped | Arc docs EVM differences |
| Finality | Deterministic on inclusion, so one confirmation is enough | Arc docs EVM differences. (Phase 1 assumed extra confirmation might be needed; it is not.) |

Mainnet is not configured anywhere in this phase.

## Contract surface

| Function | Caller | Effect |
| --- | --- | --- |
| `createRequest(bytes32 nonce, bytes32 paramsHash) returns (bytes32 requestId)` | Payer | Pulls exactly 100000 USDC base units (0.10 USDC) with `transferFrom`. Needs a prior `approve(contract, 100000)`. |
| `settle(bytes32 requestId, bytes32 reportHash)` | Operator | Only while `now < refundableAt`. Sends the escrow to the immutable treasury. |
| `refund(bytes32 requestId, address recipient)` | Original payer | Only when `now >= refundableAt` and still unsettled. Sends the escrow to `recipient`, which cannot be the zero address, the contract itself, or the USDC token contract. Default the recipient to the payer in the UI. |
| `computeRequestId(address payer, bytes32 nonce, bytes32 paramsHash)` | Anyone (view) | `keccak256(abi.encode(chainId, contract, payer, nonce, paramsHash))` |
| `requests(bytes32) returns (payer, createdAt, refundableAt, status, paramsHash)` | Anyone (view) | Source of truth for a request. Status: 0 None, 1 Paid, 2 Settled, 3 Refunded. |
| `setOperator`, `pause`, `unpause`, `transferOwnership`, `acceptOwnership` | Owner | Admin only. No function moves escrow. |
| `PRICE()`, `REFUND_DELAY()`, `USDC()`, `TREASURY()`, `operator()`, `owner()`, `paused()` | Anyone (view) | Configuration reads |

Events: `RequestCreated(requestId, payer, paramsHash, nonce, amount, createdAt, refundableAt)`, `RequestSettled(requestId, payer, reportHash, amount, settledAt)`, `RequestRefunded(requestId, payer, recipient, amount)`, `OperatorUpdated(old, new)`, plus OpenZeppelin `Paused`, `Unpaused`, `OwnershipTransferStarted`, `OwnershipTransferred`.

Errors: `ZeroAddress`, `WrongToken`, `InvalidTreasury`, `InvalidRecipient`, `EmptyParamsHash`, `EmptyReportHash`, `RequestAlreadyExists`, `UnexpectedReceivedAmount`, `NotPaid(status)`, `SettlementWindowClosed`, `NotPayer`, `RefundNotYetAvailable(refundableAt)`, `NotOperator`, `SameOperator`, `RenounceDisabled`.

State machine: `None -> Paid` (payer, `createRequest`), `Paid -> Settled` (operator, `settle`, before the deadline), `Paid -> Refunded` (payer, `refund`, at or after the deadline). Settled and Refunded are terminal, and request IDs are never reusable. Settle is valid while `now < refundableAt` and refund while `now >= refundableAt`, so both can never be valid at the same second.

## Backend flow (Vercel Functions)

1. Submit or identify a request. The client sends `{token, tradeSize, payer}`. The function validates input, generates a random 32-byte `nonce`, and defines the canonical `paramsHash` (suggested: `keccak256(abi.encode(uint8 version, uint256 chainId, address token, uint256 tradeSizeMicroUsd))`). It computes `requestId` with the same formula as the contract (or calls `computeRequestId`) and stores a row `{requestId, payer, nonce, paramsHash, status: CREATED, accessTokenHash}`. It returns the nonce, `paramsHash`, contract address, price, and chain ID. Only request IDs the server created are ever processed.
2. The payer's wallet sends `USDC.approve(contract, 100000)` then `createRequest(nonce, paramsHash)`.
3. Read status from the chain. Call `requests(requestId)` over RPC. Treat the payment as confirmed only when all hold: `status == 1 (Paid)`, `payer` equals the stored payer, `paramsHash` equals the stored hash, and `refundableAt - createdAt == 1800`. A client-supplied transaction hash may be used as a hint to look sooner, never as proof. Do not use USDC `Transfer` logs: on Arc they come from two emitters (the USDC contract and `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`) at two decimal scales. This contract's own events and `requests()` are the evidence.
4. Verify events if you index them. A `RequestCreated` or `RequestSettled` log counts only when `log.address` equals the configured contract on chain 5042002 and the `requestId` matches a stored row. Bound the log scan: start at the deployment block, never block 0.
5. Generate the report, store it, compute `reportHash = keccak256(canonical report bytes)`, then submit `settle(requestId, reportHash)` from the operator key. Do this with a safety margin: stop and leave the request for refund when less than 5 minutes remain before `refundableAt`.
6. Publish the report only when a fresh read shows `requests(requestId).status == 2 (Settled)` and the `RequestSettled` log for that ID carries a `reportHash` equal to the stored report's hash. Re-check at access time, not just at settle time.
7. Failure path. If report generation fails, do not settle. The payer calls `refund(requestId, recipient)` once `refundableAt` has passed (up to 30 minutes of waiting; there is deliberately no operator early-refund path). The backend marks the request refundable and detects `RequestRefunded`.

Vercel-specific notes (open items for Phase 3):

- Functions are stateless, so polling and settlement need a durable store and a scheduler (Vercel Cron or a queue). Durable storage choice is not made yet.
- The operator private key lives only in encrypted server environment variables, never in a `VITE_` variable or frontend bundle. Custody options (plain key versus a Circle developer-controlled wallet) are unresolved.
- Settlement must carry `maxFeePerGas` of at least 20 gwei.
- Function duration limits apply to settle retries; make settle idempotent by reading status first (a repeat settle reverts with `NotPaid(Settled)`).

## Minimal viem reads

```ts
const request = await publicClient.readContract({
  address: PAY_PER_CALL, abi, functionName: 'requests', args: [requestId],
}); // [payer, createdAt, refundableAt, status, paramsHash]
```

Read the contract address and ABI from the deployment record once Phase 3 has one; do not hardcode it in source.
