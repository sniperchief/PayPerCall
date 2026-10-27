import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Hex } from 'viem'
import { ONCHAIN_STATUS } from '../shared/abi'
import { computeRequestId } from '../shared/protocol'
import {
  SWEEP_BUDGET_MS,
  advance,
  authorize,
  buildView,
  createRequest,
  getReport,
  hashAccessToken,
  processScheduled,
  recordKey,
  reportKey,
  type RequestRecord,
} from './requests'
import { CONTRACT, PAYER, TOKEN, fill, makeHarness, type Harness } from './testing'

async function newRequest(h: Harness) {
  const result = await createRequest(h.deps, { token: TOKEN, tradeSizeUsd: '5000', payer: PAYER })
  assert.ok(result.ok)
  return result.response
}

async function paidRequest(h: Harness) {
  const created = await newRequest(h)
  h.chain.pay(created.requestId, PAYER, created.paramsHash)
  return created
}

async function record(h: Harness, id: Hex): Promise<RequestRecord> {
  return JSON.parse((await h.store.get(recordKey(id)))!) as RequestRecord
}

test('creating a request stores only a hash of the access token and binds the payer into the ID', async () => {
  const h = makeHarness()
  const created = await newRequest(h)
  assert.equal(created.requestId, computeRequestId(CONTRACT, PAYER, created.nonce, created.paramsHash))
  assert.equal(created.priceRaw, '100000')
  const raw = (await h.store.get(recordKey(created.requestId)))!
  assert.ok(!raw.includes(created.accessToken), 'plain access token must never be stored')
  assert.ok(raw.includes(hashAccessToken(created.accessToken)))
  assert.equal(h.generatorCalls(), 0)
})

test('invalid inputs are rejected before anything is stored', async () => {
  const h = makeHarness()
  assert.deepEqual(await createRequest(h.deps, { token: 'nope', tradeSizeUsd: '5000', payer: PAYER }), { ok: false, error: 'INVALID_TOKEN' })
  assert.deepEqual(await createRequest(h.deps, { token: TOKEN, tradeSizeUsd: '5000', payer: '0x1' }), { ok: false, error: 'INVALID_PAYER' })
  assert.deepEqual(await createRequest(h.deps, { token: TOKEN, tradeSizeUsd: '0', payer: PAYER }), { ok: false, error: 'INVALID_TRADE_SIZE' })
  assert.deepEqual(await h.store.members('ppc:active'), [])
})

test('an unpaid request does nothing, generates no report, and expires after 30 minutes', async () => {
  const h = makeHarness()
  const created = await newRequest(h)
  assert.equal((await advance(h.deps, created.requestId))?.status, 'CREATED')
  assert.equal(h.generatorCalls(), 0)
  h.clock.advanceSeconds(31 * 60)
  assert.equal((await advance(h.deps, created.requestId))?.status, 'EXPIRED')
  assert.deepEqual(await h.store.members('ppc:active'), [])
})

test('verified payment runs the whole lifecycle once and the report is revealed only after settlement', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)

  const midway = await advance(h.deps, created.requestId)
  assert.equal(midway?.status, 'SETTLING')
  assert.equal(h.generatorCalls(), 1)
  assert.deepEqual(await getReport(h.deps, midway), { ok: false, reason: 'NOT_READY' })
  assert.equal((await buildView(h.deps, midway)).reportAvailable, false)

  // The transaction lands onchain.
  const settle = midway.settle!
  h.chain.settle(created.requestId, midway.report!.hash, settle.txHash)
  h.settler.txStates.set(settle.txHash, 'success')

  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(done?.settledTxHash, settle.txHash)
  const released = await getReport(h.deps, done)
  assert.ok(released.ok)
  assert.equal(released.reportHash, done.report!.hash)
  assert.equal(h.generatorCalls(), 1)
  assert.equal(h.settler.prepares, 1)
})

test('concurrent invocations cannot generate or settle twice', async () => {
  const h = makeHarness()
  const created = await paidRequest(h)
  await Promise.all(Array.from({ length: 8 }, () => advance(h.deps, created.requestId)))
  await advance(h.deps, created.requestId)
  assert.equal((await record(h, created.requestId)).status, 'COMPLETED')
  assert.equal(h.generatorCalls(), 1)
  assert.equal(h.settler.prepares, 1)
  assert.equal(h.settler.broadcasts.length, 1)
})

test('a failed broadcast is retried with the identical signed transaction, never a second settlement', async () => {
  const h = makeHarness()
  h.settler.broadcastError = new Error('rpc timeout')
  const created = await paidRequest(h)
  const first = await advance(h.deps, created.requestId)
  assert.equal(first?.status, 'SETTLING')
  const raw = first.settle!.raw
  h.clock.advanceSeconds(10)
  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(h.settler.prepares, 1)
  assert.deepEqual([...new Set(h.settler.broadcasts)], [raw])
})

/** Makes the next rebroadcast find that the original settlement already landed (it mines, then the node says "nonce too low"). */
function landOnRebroadcast(h: Harness, requestId: Hex, txHash: Hex, reportHash: Hex) {
  const original = h.settler.broadcast.bind(h.settler)
  let raced = false
  h.settler.broadcast = (raw: Hex) => {
    if (raced) return original(raw)
    raced = true
    h.chain.settle(requestId, reportHash, txHash)
    h.settler.txStates.set(txHash, 'success')
    return Promise.reject(new Error('nonce too low'))
  }
}

test('a settlement that lands just before its rebroadcast is completed, never signed a second time', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const first = await advance(h.deps, created.requestId)
  assert.equal(first?.status, 'SETTLING')
  const t1 = first.settle!.txHash
  landOnRebroadcast(h, created.requestId, t1, first.report!.hash)

  h.clock.advanceSeconds(6)
  await advance(h.deps, created.requestId)
  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(done.settledTxHash, t1)
  assert.equal(h.settler.prepares, 1)
  assert.equal((await getReport(h.deps, done)).ok, true)
})

test('behind a lagging RPC node, a needless second settlement that reverts still completes from the first one', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const first = await advance(h.deps, created.requestId)
  const t1 = first!.settle!.txHash
  landOnRebroadcast(h, created.requestId, t1, first!.report!.hash)

  // The node keeps answering with the pre-settlement view: no receipt for t1 and the request still Paid.
  let lagging = true
  const paidView = await h.chain.getRequest(CONTRACT, created.requestId)
  const realGetRequest = h.chain.getRequest.bind(h.chain)
  h.chain.getRequest = (contract, id) => (lagging ? Promise.resolve(paidView) : realGetRequest(contract, id))
  const realTxState = h.settler.getTxState
  h.settler.getTxState = (hash) => (lagging && hash === t1 ? Promise.resolve('pending') : realTxState(hash))

  h.clock.advanceSeconds(6)
  const second = await advance(h.deps, created.requestId)
  assert.equal(second?.status, 'SETTLING')
  const t2 = second.settle!.txHash
  assert.notEqual(t2, t1)

  // The node catches up; the contract rejected t2 because the request was already Settled by t1.
  lagging = false
  h.settler.txStates.set(t2, 'reverted')
  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(done.settledTxHash, t1)
  assert.equal((await getReport(h.deps, done)).ok, true)
})

test('a payment that does not match the request is rejected and never processed', async () => {
  const h = makeHarness()
  const created = await newRequest(h)
  h.chain.pay(created.requestId, fill('99'), created.paramsHash)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'PAYMENT_MISMATCH')
  assert.equal(h.generatorCalls(), 0)
  assert.equal(h.settler.prepares, 0)
})

test('with too little time before the refund deadline nothing is generated or settled', async () => {
  const h = makeHarness()
  const created = await paidRequest(h)
  h.clock.advanceSeconds(1800 - 120)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'DEADLINE_MARGIN')
  assert.equal(h.generatorCalls(), 0)
  assert.equal(h.settler.prepares, 0)
})

test('report generation is retried once and then fails closed without settling', async () => {
  let attempts = 0
  const h = makeHarness({
    generator: {
      generate: () => {
        attempts++
        return Promise.reject(new Error('rpc down'))
      },
    },
  })
  const created = await paidRequest(h)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'REPORT_GENERATION_FAILED')
  assert.equal(attempts, 2)
  assert.equal(h.settler.prepares, 0)
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('without a settlement key the report stays locked at REPORT_READY', async () => {
  const h = makeHarness({ withSettler: false })
  const created = await paidRequest(h)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'REPORT_READY')
  assert.equal((await buildView(h.deps, result)).settlementEnabled, false)
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('a settlement whose logged report hash differs from the stored report is rejected', async () => {
  const h = makeHarness()
  h.settler.logHashOverride = `0x${'ab'.repeat(32)}`
  const created = await paidRequest(h)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'SETTLEMENT_MISMATCH')
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('the report is withheld if the contract no longer reports Settled or the stored report was altered', async () => {
  const h = makeHarness()
  const created = await paidRequest(h)
  const done = (await advance(h.deps, created.requestId))!
  assert.equal(done.status, 'COMPLETED')
  assert.ok((await getReport(h.deps, done)).ok)

  await h.store.compareAndSet(reportKey(created.requestId), (await h.store.get(reportKey(created.requestId)))!, '{"tampered":true}', 60)
  assert.deepEqual(await getReport(h.deps, done), { ok: false, reason: 'REPORT_HASH_MISMATCH' })

  h.chain.setStatus(created.requestId, ONCHAIN_STATUS.Paid)
  assert.deepEqual(await getReport(h.deps, done), { ok: false, reason: 'NOT_SETTLED' })
})

test('a refund onchain moves the request to REFUNDED and no report is released', async () => {
  const h = makeHarness({ withSettler: false })
  const created = await paidRequest(h)
  await advance(h.deps, created.requestId)
  h.chain.setStatus(created.requestId, ONCHAIN_STATUS.Refunded)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'REFUNDED')
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('a crashed worker is recovered only after its lease expires', async () => {
  const h = makeHarness()
  const created = await paidRequest(h)
  const current = await record(h, created.requestId)
  const stuck: RequestRecord = {
    ...current,
    status: 'PROCESSING',
    attempts: 1,
    chainCreatedAt: Math.floor(h.clock.ms / 1000),
    refundableAt: Math.floor(h.clock.ms / 1000) + 1800,
    lease: { owner: 'dead-worker', untilMs: h.clock.ms + 60_000 },
  }
  await h.store.compareAndSet(recordKey(created.requestId), (await h.store.get(recordKey(created.requestId)))!, JSON.stringify(stuck), 3600)

  assert.equal((await advance(h.deps, created.requestId))?.status, 'PROCESSING')
  assert.equal(h.generatorCalls(), 0)

  h.clock.advanceSeconds(61)
  assert.equal((await advance(h.deps, created.requestId))?.status, 'COMPLETED')
  assert.equal(h.generatorCalls(), 1)
})

test('authorization is by access token and unknown ids look the same as wrong tokens', async () => {
  const h = makeHarness()
  const created = await newRequest(h)
  assert.equal((await authorize(h.deps, created.requestId, created.accessToken))?.id, created.requestId)
  assert.equal(await authorize(h.deps, created.requestId, 'ppc_wrong_token_value'), null)
  assert.equal(await authorize(h.deps, created.requestId, null), null)
  assert.equal(await authorize(h.deps, `0x${'ee'.repeat(32)}`, created.accessToken), null)
  assert.equal(await authorize(h.deps, 'not-a-hash', created.accessToken), null)
})

test('a chain read failure leaves the stored state untouched', async () => {
  const h = makeHarness()
  const created = await paidRequest(h)
  h.chain.readFailure = new Error('rpc down')
  await assert.rejects(advance(h.deps, created.requestId))
  h.chain.readFailure = null
  assert.equal((await record(h, created.requestId)).status, 'CREATED')
})

/** Makes the settlement land at the moment its receipt is first looked up, after the contract state was read. */
function landOnReceiptLookup(h: Harness, requestId: Hex, txHash: Hex, reportHash: Hex) {
  const realTxState = h.settler.getTxState
  h.settler.getTxState = (hash) => {
    if (hash === txHash && h.settler.txStates.get(hash) !== 'success') {
      h.chain.settle(requestId, reportHash, txHash)
      h.settler.txStates.set(hash, 'success')
    }
    return realTxState(hash)
  }
}

test('a settlement mined between the contract read and the receipt read completes instead of failing', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const first = (await advance(h.deps, created.requestId))!
  assert.equal(first.status, 'SETTLING')
  landOnReceiptLookup(h, created.requestId, first.settle!.txHash, first.report!.hash)

  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(done.failure, null)
  assert.equal(done.settledTxHash, first.settle!.txHash)
  assert.equal(h.settler.prepares, 1)
  assert.equal((await getReport(h.deps, done)).ok, true)
})

test('a successful receipt from a node whose contract view still lags waits and never fails the request', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const first = (await advance(h.deps, created.requestId))!
  const txHash = first.settle!.txHash
  const paidView = await h.chain.getRequest(CONTRACT, created.requestId)
  h.chain.settle(created.requestId, first.report!.hash, txHash)
  h.settler.txStates.set(txHash, 'success')

  // Receipt visible, contract state not yet: no report, no failure.
  let lagging = true
  const realGetRequest = h.chain.getRequest.bind(h.chain)
  h.chain.getRequest = (contract, id) => (lagging ? Promise.resolve(paidView) : realGetRequest(contract, id))
  const waiting = await advance(h.deps, created.requestId)
  assert.equal(waiting?.status, 'SETTLING')
  assert.equal(waiting.failure, null)
  assert.deepEqual(await getReport(h.deps, waiting), { ok: false, reason: 'NOT_READY' })

  lagging = false
  const done = await advance(h.deps, created.requestId)
  assert.equal(done?.status, 'COMPLETED')
  assert.equal(h.settler.prepares, 1)
})

test('a backlog of unpaid requests cannot starve a paid request out of the scheduled sweep', async () => {
  const h = makeHarness()
  for (let i = 0; i < 25; i++) await newRequest(h)
  const paid = await paidRequest(h)
  const result = await processScheduled(h.deps)
  assert.deepEqual(result, { skipped: false, processed: 26, failedIds: 0 })
  assert.equal((await record(h, paid.requestId)).status, 'COMPLETED')
})

test('the scheduled sweep stops starting requests once its time budget is spent', async () => {
  const h = makeHarness()
  for (let i = 0; i < 5; i++) await newRequest(h)
  const realGetRequest = h.chain.getRequest.bind(h.chain)
  h.chain.getRequest = (contract, id) => {
    h.clock.advanceSeconds(SWEEP_BUDGET_MS / 1000 / 2)
    return realGetRequest(contract, id)
  }
  assert.deepEqual(await processScheduled(h.deps), { skipped: false, processed: 2, failedIds: 0 })
})

test('a settlement that reverts while the request is still Paid fails to the refund path and releases nothing', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const first = (await advance(h.deps, created.requestId))!
  h.settler.txStates.set(first.settle!.txHash, 'reverted')
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'SETTLE_REVERTED')
  assert.equal(h.settler.prepares, 1)
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('a settlement still pending at the refund deadline fails the request and is never re-signed', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  await advance(h.deps, created.requestId)
  h.clock.advanceSeconds(1800)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'FAILED')
  assert.equal(result?.failure, 'SETTLEMENT_WINDOW_CLOSED')
  assert.equal(h.settler.prepares, 1)
  assert.equal((await getReport(h.deps, result)).ok, false)
})

test('an operator nonce taken by other transactions is re-signed at most three times, then fails closed', async () => {
  const h = makeHarness()
  h.settler.autoMine = false
  const created = await paidRequest(h)
  const realBroadcast = h.settler.broadcast.bind(h.settler)
  h.settler.broadcast = async (raw) => {
    await realBroadcast(raw)
    throw new Error('nonce too low')
  }
  for (let i = 0; i < 12; i++) {
    h.clock.advanceSeconds(6)
    await advance(h.deps, created.requestId)
  }
  const result = await record(h, created.requestId)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.failure, 'SETTLE_BROADCAST_FAILED')
  assert.equal(h.settler.prepares, 3)
  assert.equal(result.priorSettleTxHashes?.length, 3)
})

test('a payment that lands after the request expired is never processed', async () => {
  const h = makeHarness()
  const created = await newRequest(h)
  h.clock.advanceSeconds(31 * 60)
  assert.equal((await advance(h.deps, created.requestId))?.status, 'EXPIRED')
  h.chain.pay(created.requestId, PAYER, created.paramsHash)
  const result = await advance(h.deps, created.requestId)
  assert.equal(result?.status, 'EXPIRED')
  assert.equal((await buildView(h.deps, result)).payment.state, 'paid')
  assert.equal(h.generatorCalls(), 0)
  assert.equal(h.settler.prepares, 0)
})
