import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryStore, UpstashStore } from './store'

test('compare-and-set succeeds once for competing writers', async () => {
  const store = new MemoryStore()
  assert.equal(await store.setIfAbsent('k', 'a', 60), true)
  assert.equal(await store.setIfAbsent('k', 'b', 60), false)
  const results = await Promise.all([store.compareAndSet('k', 'a', 'x', 60), store.compareAndSet('k', 'a', 'y', 60)])
  assert.deepEqual(results.filter(Boolean).length, 1)
})

test('locks are exclusive, owner-released, and expire', async () => {
  let now = 0
  const store = new MemoryStore(() => now)
  assert.equal(await store.acquireLock('l', 'one', 1000), true)
  assert.equal(await store.acquireLock('l', 'two', 1000), false)
  await store.releaseLock('l', 'two')
  assert.equal(await store.acquireLock('l', 'two', 1000), false)
  await store.releaseLock('l', 'one')
  assert.equal(await store.acquireLock('l', 'two', 1000), true)
  now += 1001
  assert.equal(await store.acquireLock('l', 'three', 1000), true)
})

test('counters expire with their window', async () => {
  let now = 0
  const store = new MemoryStore(() => now)
  assert.equal(await store.incr('c', 10), 1)
  assert.equal(await store.incr('c', 10), 2)
  now += 11_000
  assert.equal(await store.incr('c', 10), 1)
})

test('the Upstash client sends one JSON command per request with a bearer token', async () => {
  const calls: { url: string; auth: string | null; body: unknown[] }[] = []
  const fake = ((url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(init.body as string) as unknown[] })
    const command = calls[calls.length - 1].body[0]
    const result = command === 'GET' ? 'stored' : command === 'EVAL' ? 1 : command === 'SMEMBERS' ? ['a', 'b'] : 'OK'
    return Promise.resolve(new Response(JSON.stringify({ result }), { status: 200 }))
  }) as unknown as typeof fetch
  const store = new UpstashStore('https://redis.example', 'secret', fake)

  assert.equal(await store.get('k'), 'stored')
  assert.equal(await store.setIfAbsent('k', 'v', 30), true)
  assert.equal(await store.compareAndSet('k', 'old', 'new', 30), true)
  assert.equal(await store.acquireLock('lock', 'me', 5000), true)
  assert.deepEqual(await store.members('s'), ['a', 'b'])

  assert.deepEqual(calls[1].body, ['SET', 'k', 'v', 'NX', 'EX', 30])
  assert.equal(calls[2].body[0], 'EVAL')
  assert.deepEqual(calls[2].body.slice(2, 7), [1, 'k', 'old', 'new', 30])
  assert.deepEqual(calls[3].body, ['SET', 'lock', 'me', 'NX', 'PX', 5000])
  assert.ok(calls.every((c) => c.url === 'https://redis.example' && c.auth === 'Bearer secret'))
})

test('Upstash errors surface as failures instead of silent success', async () => {
  const fake = (() => Promise.resolve(new Response(JSON.stringify({ error: 'ERR' }), { status: 400 }))) as unknown as typeof fetch
  const store = new UpstashStore('https://redis.example', 'secret', fake)
  await assert.rejects(store.get('k'))
})
