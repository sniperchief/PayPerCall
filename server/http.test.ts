import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CreateRequestResponse } from '../shared/protocol'
import type { ServerConfig } from './config'
import { createContextProvider, type AppContext, type ContextProvider } from './context'
import { createHandler } from './http'
import { ACTIVE_SET, CRON_LOCK, CRON_LOCK_MS } from './requests'
import { CONTRACT, PAYER, SETTINGS, TOKEN, USDC, makeHarness, type Harness } from './testing'

const BASE = 'https://app.example/api/v1'

function readyContext(h: Harness, cronSecret: string | null = null): AppContext {
  const config: ServerConfig = {
    chainId: 5042,
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorerBase: 'https://explorer.arc.io',
    contract: CONTRACT,
    usdc: USDC,
    store: { kind: 'memory' },
    operatorKey: null,
    cronSecret,
  }
  return { ready: true, config, deps: h.deps, settings: SETTINGS, settlementDisabledReason: null }
}

function client(context: AppContext | ContextProvider) {
  const handle = createHandler(typeof context === 'function' ? context : () => Promise.resolve(context))
  return (path: string, init: RequestInit & { token?: string; ip?: string } = {}) => {
    const headers = new Headers(init.headers)
    if (init.token) headers.set('authorization', `Bearer ${init.token}`)
    headers.set('x-forwarded-for', init.ip ?? '203.0.113.7')
    return handle(new Request(`${BASE}${path}`, { ...init, headers }))
  }
}

const createBody = JSON.stringify({ token: TOKEN, tradeSizeUsd: '2500', payer: PAYER })

test('a not-configured service refuses requests with 503 and explains why, but health still answers', async () => {
  const call = client({ ready: false, reasons: ['VITE_PAY_PER_CALL_ADDRESS is not set'] })
  const health = await call('/health')
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: false, ready: false, reasons: ['VITE_PAY_PER_CALL_ADDRESS is not set'] })
  const create = await call('/requests', { method: 'POST', body: createBody })
  assert.equal(create.status, 503)
  assert.equal(((await create.json()) as { error: string }).error, 'NOT_READY')
})

test('create validates input, returns the access token once, and never caches', async () => {
  const h = makeHarness()
  const call = client(readyContext(h))
  const bad = await call('/requests', { method: 'POST', body: JSON.stringify({ token: 'x', tradeSizeUsd: '1', payer: PAYER }) })
  assert.equal(bad.status, 400)
  const notJson = await call('/requests', { method: 'POST', body: 'nope' })
  assert.equal(notJson.status, 400)

  const ok = await call('/requests', { method: 'POST', body: createBody })
  assert.equal(ok.status, 201)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  const body = (await ok.json()) as CreateRequestResponse
  assert.match(body.accessToken, /^ppc_[0-9a-f]{64}$/)
  assert.equal(body.contract, CONTRACT)
})

test('creation is rate limited per client', async () => {
  const h = makeHarness()
  const call = client(readyContext(h))
  const statuses: number[] = []
  for (let i = 0; i < 22; i++) statuses.push((await call('/requests', { method: 'POST', body: createBody, ip: '198.51.100.9' })).status)
  assert.equal(statuses.filter((s) => s === 201).length, 10) // per-payer cap applies first
  assert.ok(statuses.includes(429))
})

test('status and report require the access token; wrong token and unknown id are indistinguishable', async () => {
  const h = makeHarness()
  const call = client(readyContext(h))
  const created = (await (await call('/requests', { method: 'POST', body: createBody })).json()) as CreateRequestResponse

  const missing = await call(`/requests/${created.requestId}`)
  const wrong = await call(`/requests/${created.requestId}`, { token: 'ppc_not_the_right_token' })
  const unknown = await call(`/requests/0x${'ee'.repeat(32)}`, { token: created.accessToken })
  const badId = await call('/requests/not-a-hash', { token: created.accessToken })
  const bodies = await Promise.all([missing, wrong, unknown, badId].map(async (r) => [r.status, await r.text()] as const))
  for (const [status, text] of bodies) {
    assert.equal(status, 404)
    assert.equal(text, bodies[0][1])
  }
  const reportWrong = await call(`/requests/${created.requestId}/report`, { token: 'ppc_not_the_right_token' })
  assert.equal(reportWrong.status, 404)
})

test('the report is refused until the request is paid, verified and settled, then released with its hash', async () => {
  const h = makeHarness()
  const call = client(readyContext(h))
  const created = (await (await call('/requests', { method: 'POST', body: createBody })).json()) as CreateRequestResponse

  const before = await call(`/requests/${created.requestId}/report`, { token: created.accessToken })
  assert.equal(before.status, 409)
  assert.equal(h.generatorCalls(), 0)
  const unpaid = (await (await call(`/requests/${created.requestId}`, { token: created.accessToken })).json()) as { status: string; reportAvailable: boolean }
  assert.equal(unpaid.status, 'CREATED')
  assert.equal(unpaid.reportAvailable, false)

  h.chain.pay(created.requestId, PAYER, created.paramsHash)
  const view = (await (await call(`/requests/${created.requestId}`, { token: created.accessToken })).json()) as { status: string; reportAvailable: boolean }
  assert.equal(view.status, 'COMPLETED')
  assert.equal(view.reportAvailable, true)

  const report = await call(`/requests/${created.requestId}/report`, { token: created.accessToken })
  assert.equal(report.status, 200)
  const payload = (await report.json()) as { reportHash: string; report: { subject: { token: string }; sections: { id: string; status: string }[] } }
  assert.match(payload.reportHash, /^0x[0-9a-f]{64}$/)
  assert.equal(payload.report.subject.token, TOKEN)
  assert.deepEqual(payload.report.sections.map((s) => `${s.id}:${s.status}`), ['token:ok', 'wallet:unavailable', 'liquidity:unavailable'])
  assert.equal(h.generatorCalls(), 1)
})

test('new requests are refused while the contract is paused', async () => {
  const h = makeHarness()
  const context = readyContext(h)
  if (!context.ready) throw new Error('unreachable')
  const call = client({ ...context, settings: { ...SETTINGS, paused: true } })
  assert.equal((await call('/requests', { method: 'POST', body: createBody })).status, 503)
})

test('the cron endpoint is hidden without a secret and rejects wrong secrets', async () => {
  const h = makeHarness()
  const hidden = client(readyContext(h))
  assert.equal((await hidden('/cron/process')).status, 404)
  assert.equal((await hidden('/cron/process', { method: 'POST' })).status, 404)

  const call = client(readyContext(h, 'a-long-enough-secret'))
  for (const method of ['GET', 'POST']) {
    assert.equal((await call('/cron/process', { method })).status, 401)
    assert.equal((await call('/cron/process', { method, token: 'wrong-secret-value' })).status, 401)
  }
})

// ---------------------------------------------------------------- settlement must be possible before payment

const SYNTHETIC_KEY = `0x${'11'.repeat(32)}` // test fixture only; its address is not the contract operator

function providerFor(h: Harness, extraEnv: Record<string, string> = {}): ContextProvider {
  const env = { VITE_PAY_PER_CALL_ADDRESS: CONTRACT, PPC_ALLOW_MEMORY_STORE: '1', ...extraEnv }
  return createContextProvider(env, { reader: h.chain, store: h.store, now: h.clock.now })
}

async function assertCreationRefused(h: Harness, call: ReturnType<typeof client>, expectedReason: string) {
  const health = (await (await call('/health')).json()) as { ready: boolean; settlementEnabled: boolean; settlementDisabledReason: string }
  assert.equal(health.ready, true)
  assert.equal(health.settlementEnabled, false)
  assert.equal(health.settlementDisabledReason, expectedReason)

  const create = await call('/requests', { method: 'POST', body: createBody })
  assert.equal(create.status, 503)
  const body = (await create.json()) as { error: string; reasons: string[]; accessToken?: string }
  assert.equal(body.error, 'SETTLEMENT_DISABLED')
  assert.deepEqual(body.reasons, [expectedReason])
  assert.equal(body.accessToken, undefined) // no nonce or token, so the client has nothing to pay for
  assert.deepEqual(await h.store.members(ACTIVE_SET), [])
}

test('a missing operator key refuses new requests before any payment', async () => {
  const h = makeHarness()
  await assertCreationRefused(h, client(providerFor(h)), 'PPC_OPERATOR_PRIVATE_KEY is not configured')
})

test('an operator key that is not the contract operator refuses new requests before any payment', async () => {
  const h = makeHarness()
  await assertCreationRefused(h, client(providerFor(h, { PPC_OPERATOR_PRIVATE_KEY: SYNTHETIC_KEY })), 'Configured operator key does not match the contract operator')
})

test('a malformed operator key keeps the whole service closed', async () => {
  const h = makeHarness()
  const call = client(providerFor(h, { PPC_OPERATOR_PRIVATE_KEY: '0x1234' }))
  const create = await call('/requests', { method: 'POST', body: createBody })
  assert.equal(create.status, 503)
  const body = (await create.json()) as { error: string; reasons: string[] }
  assert.equal(body.error, 'NOT_READY')
  assert.ok(body.reasons.includes('PPC_OPERATOR_PRIVATE_KEY is not a 32-byte hex private key'))
  assert.deepEqual(await h.store.members(ACTIVE_SET), [])
})

// ---------------------------------------------------------------- scheduled processing (Vercel Cron)

const CRON = 'a-long-enough-secret'

async function paidRequest(h: Harness, call: ReturnType<typeof client>): Promise<CreateRequestResponse> {
  const created = (await (await call('/requests', { method: 'POST', body: createBody })).json()) as CreateRequestResponse
  h.chain.pay(created.requestId, PAYER, created.paramsHash)
  return created
}

test('a Vercel Cron GET with the CRON_SECRET bearer settles a paid request nobody is polling', async () => {
  const h = makeHarness()
  const call = client(readyContext(h, CRON))
  const created = await paidRequest(h, call)

  const run = await call('/cron/process', { token: CRON })
  assert.equal(run.status, 200)
  assert.equal(run.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await run.json(), { skipped: false, processed: 1, failedIds: 0 })
  assert.equal(h.settler.prepares, 1)

  const view = (await (await call(`/requests/${created.requestId}`, { token: created.accessToken })).json()) as { status: string; reportAvailable: boolean }
  assert.equal(view.status, 'COMPLETED')
  assert.equal(view.reportAvailable, true)
})

test('a repeated cron delivery after completion settles nothing again', async () => {
  const h = makeHarness()
  const call = client(readyContext(h, CRON))
  await paidRequest(h, call)
  await call('/cron/process', { token: CRON })
  const again = await call('/cron/process', { token: CRON })
  assert.deepEqual(await again.json(), { skipped: false, processed: 0, failedIds: 0 })
  assert.equal(h.settler.prepares, 1)
  assert.equal(h.settler.broadcasts.length, 1)
})

test('an overlapping cron run is skipped while another holds the run lock, and the lock expires after a crash', async () => {
  const h = makeHarness()
  const call = client(readyContext(h, CRON))
  await paidRequest(h, call)
  assert.equal(await h.store.acquireLock(CRON_LOCK, 'crashed-run', CRON_LOCK_MS), true)

  const overlapping = await call('/cron/process', { token: CRON })
  assert.deepEqual(await overlapping.json(), { skipped: true, reason: 'ALREADY_RUNNING' })
  assert.equal(h.settler.prepares, 0)

  h.clock.advanceSeconds(CRON_LOCK_MS / 1000 + 1) // the stale lock expires; the request is still well inside its window
  const recovered = await call('/cron/process', { token: CRON })
  assert.deepEqual(await recovered.json(), { skipped: false, processed: 1, failedIds: 0 })
  assert.equal(h.settler.prepares, 1)
})

test('concurrent cron deliveries and a client poll settle the request exactly once', async () => {
  const h = makeHarness()
  const call = client(readyContext(h, CRON))
  const created = await paidRequest(h, call)

  const responses = await Promise.all([
    call('/cron/process', { token: CRON }),
    call('/cron/process', { token: CRON }),
    call(`/requests/${created.requestId}`, { token: created.accessToken }),
  ])
  assert.ok(responses.every((r) => r.status === 200))
  assert.equal(h.settler.prepares, 1)
  assert.equal(h.settler.broadcasts.length, 1)
  assert.equal(h.chain.settledLogs.size, 1)
  const view = (await (await call(`/requests/${created.requestId}`, { token: created.accessToken })).json()) as { status: string }
  assert.equal(view.status, 'COMPLETED')
})

test('chain outages return a retryable error without leaking details', async () => {
  const h = makeHarness()
  const call = client(readyContext(h))
  const created = (await (await call('/requests', { method: 'POST', body: createBody })).json()) as CreateRequestResponse
  h.chain.readFailure = new Error('secret rpc url https://user:pass@rpc.internal')
  const response = await call(`/requests/${created.requestId}`, { token: created.accessToken })
  assert.equal(response.status, 502)
  assert.ok(!(await response.text()).includes('rpc.internal'))
})
