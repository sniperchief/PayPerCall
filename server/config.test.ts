import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from './config'
import { runPreflight } from './context'
import { FakeChain, Clock, CONTRACT, SETTINGS, fill } from './testing'

const base = { VITE_PAY_PER_CALL_ADDRESS: CONTRACT, UPSTASH_REDIS_REST_URL: 'https://example-redis.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'token-value' }

test('an empty contract address fails closed', () => {
  const result = loadConfig({ ...base, VITE_PAY_PER_CALL_ADDRESS: '' })
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.errors.some((e) => e.includes('not been configured')))
})

test('malformed and zero contract addresses fail closed', () => {
  assert.equal(loadConfig({ ...base, VITE_PAY_PER_CALL_ADDRESS: '0x1234' }).ok, false)
  assert.equal(loadConfig({ ...base, VITE_PAY_PER_CALL_ADDRESS: `0x${'00'.repeat(20)}` }).ok, false)
})

test('production requires a durable store', () => {
  const { UPSTASH_REDIS_REST_URL: _u, UPSTASH_REDIS_REST_TOKEN: _t, ...noStore } = base
  assert.equal(loadConfig(noStore).ok, false)
  assert.equal(loadConfig({ ...base, UPSTASH_REDIS_REST_TOKEN: '' }).ok, false)
  assert.equal(loadConfig({ ...base, UPSTASH_REDIS_REST_URL: 'http://insecure.example' }).ok, false)
})

test('the in-memory store needs an explicit flag and is refused on Vercel', () => {
  const { UPSTASH_REDIS_REST_URL: _u, UPSTASH_REDIS_REST_TOKEN: _t, ...noStore } = base
  const local = loadConfig({ ...noStore, PPC_ALLOW_MEMORY_STORE: '1' })
  assert.ok(local.ok && local.config.store.kind === 'memory')
  assert.equal(loadConfig({ ...noStore, PPC_ALLOW_MEMORY_STORE: '1', VERCEL: '1' }).ok, false)
})

test('a valid configuration targets Arc mainnet with the official USDC and no testnet', () => {
  const result = loadConfig(base)
  assert.ok(result.ok)
  assert.equal(result.config.chainId, 5042)
  assert.equal(result.config.rpcUrl, 'https://rpc.mainnet.arc.io')
  assert.equal(result.config.usdc, '0x3600000000000000000000000000000000000000')
  assert.equal(result.config.store.kind, 'upstash')
  assert.equal(result.config.operatorKey, null)
})

test('operator key, cron secret and RPC override are validated', () => {
  assert.equal(loadConfig({ ...base, PPC_OPERATOR_PRIVATE_KEY: 'not-a-key' }).ok, false)
  assert.equal(loadConfig({ ...base, CRON_SECRET: 'short' }).ok, false)
  // The old name fails closed instead of silently leaving scheduled processing unauthenticated or off.
  assert.equal(loadConfig({ ...base, PPC_CRON_SECRET: 'a-long-enough-secret' }).ok, false)
  assert.equal(loadConfig({ ...base, ARC_MAINNET_RPC_URL: 'http://plain.example' }).ok, false)
  const good = loadConfig({ ...base, PPC_OPERATOR_PRIVATE_KEY: `0x${'ab'.repeat(32)}`, CRON_SECRET: 'a-long-enough-secret', ARC_MAINNET_RPC_URL: 'https://rpc.example' })
  assert.ok(good.ok)
})

function config() {
  const result = loadConfig(base)
  assert.ok(result.ok)
  return result.config
}

test('preflight passes only for the reviewed contract on chain 5042', async () => {
  const chain = new FakeChain(new Clock())
  const ok = await runPreflight(config(), chain)
  assert.deepEqual(ok.reasons, [])
  assert.ok(ok.settings)
})

test('preflight fails closed on a wrong chain, missing code, wrong USDC, wrong price or wrong refund delay', async () => {
  const wrongChain = new FakeChain(new Clock())
  wrongChain.chainId = 5042002
  assert.ok((await runPreflight(config(), wrongChain)).reasons[0].includes('expected 5042'))

  const noCode = new FakeChain(new Clock())
  noCode.codeSize = 0
  assert.ok((await runPreflight(config(), noCode)).reasons[0].includes('No contract code'))

  const wrongUsdc = new FakeChain(new Clock())
  wrongUsdc.settings = { ...SETTINGS, usdc: fill('aa') }
  assert.ok((await runPreflight(config(), wrongUsdc)).reasons.some((r) => r.includes('official Arc USDC')))

  const wrongPrice = new FakeChain(new Clock())
  wrongPrice.settings = { ...SETTINGS, price: 1n }
  assert.ok((await runPreflight(config(), wrongPrice)).reasons.some((r) => r.includes('PRICE')))

  const wrongDelay = new FakeChain(new Clock())
  wrongDelay.settings = { ...SETTINGS, refundDelay: 60 }
  assert.ok((await runPreflight(config(), wrongDelay)).reasons.some((r) => r.includes('REFUND_DELAY')))
})
