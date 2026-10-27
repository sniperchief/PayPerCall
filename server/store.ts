/**
 * Durable key-value store used for request records, report references, locks and rate limits.
 * Production uses Upstash Redis over its REST API. The in-memory store is for local development and tests only.
 */
import { randomBytes } from 'node:crypto'
import type { StoreConfig } from './config'

export interface Store {
  readonly kind: 'memory' | 'upstash'
  get(key: string): Promise<string | null>
  /** Atomic SET NX. Returns true when the key was created. */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>
  /** Atomic compare-and-set on the exact stored string. Returns true when the swap happened. */
  compareAndSet(key: string, expected: string, next: string, ttlSec: number): Promise<boolean>
  /** Increments a counter that expires windowSec after its first increment. */
  incr(key: string, windowSec: number): Promise<number>
  addToSet(key: string, member: string): Promise<void>
  removeFromSet(key: string, member: string): Promise<void>
  members(key: string): Promise<string[]>
  acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean>
  releaseLock(key: string, owner: string): Promise<void>
}

interface Entry {
  value: string
  expiresAt: number | null
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const
  private readonly data = new Map<string, Entry>()
  private readonly sets = new Map<string, Set<string>>()
  constructor(private readonly now: () => number = Date.now) {}

  private read(key: string): string | null {
    const entry = this.data.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.data.delete(key)
      return null
    }
    return entry.value
  }

  private write(key: string, value: string, ttlMs: number | null): void {
    this.data.set(key, { value, expiresAt: ttlMs === null ? null : this.now() + ttlMs })
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.read(key))
  }

  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    if (this.read(key) !== null) return Promise.resolve(false)
    this.write(key, value, ttlSec * 1000)
    return Promise.resolve(true)
  }

  compareAndSet(key: string, expected: string, next: string, ttlSec: number): Promise<boolean> {
    if (this.read(key) !== expected) return Promise.resolve(false)
    this.write(key, next, ttlSec * 1000)
    return Promise.resolve(true)
  }

  incr(key: string, windowSec: number): Promise<number> {
    const current = this.read(key)
    if (current === null) {
      this.write(key, '1', windowSec * 1000)
      return Promise.resolve(1)
    }
    const entry = this.data.get(key)
    const next = Number(current) + 1
    this.data.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null })
    return Promise.resolve(next)
  }

  addToSet(key: string, member: string): Promise<void> {
    const set = this.sets.get(key) ?? new Set<string>()
    set.add(member)
    this.sets.set(key, set)
    return Promise.resolve()
  }

  removeFromSet(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member)
    return Promise.resolve()
  }

  members(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sets.get(key) ?? [])])
  }

  acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    if (this.read(key) !== null) return Promise.resolve(false)
    this.write(key, owner, ttlMs)
    return Promise.resolve(true)
  }

  releaseLock(key: string, owner: string): Promise<void> {
    if (this.read(key) === owner) this.data.delete(key)
    return Promise.resolve()
  }
}

const CAS_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end"
const INCR_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c"
const UNLOCK_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"

type RedisArg = string | number
interface UpstashReply {
  result?: unknown
  error?: string
}

/** Minimal Upstash Redis REST client: every command is one POST with a JSON array body. */
export class UpstashStore implements Store {
  readonly kind = 'upstash' as const
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async command(...args: RedisArg[]): Promise<unknown> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = (await response.json().catch(() => ({}))) as UpstashReply
    if (!response.ok || body.error) throw new Error(`Upstash command failed (${response.status})`)
    return body.result ?? null
  }

  async get(key: string): Promise<string | null> {
    const result = await this.command('GET', key)
    return typeof result === 'string' ? result : null
  }

  async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
    return (await this.command('SET', key, value, 'NX', 'EX', ttlSec)) === 'OK'
  }

  async compareAndSet(key: string, expected: string, next: string, ttlSec: number): Promise<boolean> {
    return Number(await this.command('EVAL', CAS_SCRIPT, 1, key, expected, next, ttlSec)) === 1
  }

  async incr(key: string, windowSec: number): Promise<number> {
    return Number(await this.command('EVAL', INCR_SCRIPT, 1, key, windowSec))
  }

  async addToSet(key: string, member: string): Promise<void> {
    await this.command('SADD', key, member)
  }

  async removeFromSet(key: string, member: string): Promise<void> {
    await this.command('SREM', key, member)
  }

  async members(key: string): Promise<string[]> {
    const result = await this.command('SMEMBERS', key)
    return Array.isArray(result) ? result.filter((item): item is string => typeof item === 'string') : []
  }

  async acquireLock(key: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.command('SET', key, owner, 'NX', 'PX', ttlMs)) === 'OK'
  }

  async releaseLock(key: string, owner: string): Promise<void> {
    await this.command('EVAL', UNLOCK_SCRIPT, 1, key, owner)
  }
}

export function createStore(config: StoreConfig): Store {
  return config.kind === 'upstash' ? new UpstashStore(config.url, config.token) : new MemoryStore()
}

export function randomId(): string {
  return randomBytes(16).toString('hex')
}
