/**
 * Request lifecycle. Every state change is a compare-and-set on the stored record, so concurrent
 * invocations (client polls, cron, retries) cannot process or settle the same request twice.
 *
 * CREATED -> PAYMENT_VERIFIED -> PROCESSING -> REPORT_READY -> SETTLING -> COMPLETED
 * Any pre-settlement state can end in FAILED (refund path), REFUNDED or EXPIRED.
 * A report is released only from COMPLETED and only while the contract still reports Settled.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { toHex, type Address, type Hex } from 'viem'
import { ONCHAIN_STATUS } from '../shared/abi'
import {
  PRICE_RAW,
  REFUND_DELAY_SECONDS,
  SETTLE_SAFETY_MARGIN_SECONDS,
  computeParamsHash,
  computeRequestId,
  formatTradeSizeUsd,
  isHash32,
  parseAddress,
  parseTradeSizeUsd,
  type CreateRequestResponse,
  type PaymentState,
  type RequestStatus,
  type RequestView,
} from '../shared/protocol'
import type { ChainReader, OnchainRequest, Settler } from './chain'
import { canonicalJson, hashReport, type ReportGenerator } from './report'
import { randomId, type Store } from './store'

export const RECORD_TTL_SEC = 30 * 24 * 3600
export const UNPAID_TTL_MS = 30 * 60 * 1000
export const LEASE_MS = 120_000
export const MAX_PROCESSING_ATTEMPTS = 2
export const MAX_SETTLE_PREPARES = 3
export const ACTIVE_SET = 'ppc:active'
const OPERATOR_LOCK = 'ppc:lock:operator'
export const CRON_LOCK = 'ppc:lock:cron'
/** Longer than the 60 second function limit, so a run killed at its deadline cannot overlap the next one. */
export const CRON_LOCK_MS = 90_000

export interface Deps {
  chainId: number
  contract: Address
  usdc: Address
  store: Store
  reader: ChainReader
  settler: Settler | null
  generator: ReportGenerator
  now: () => number
  newId: () => string
  sleep: (ms: number) => Promise<void>
}

export interface RequestRecord {
  v: 1
  id: Hex
  payer: Address
  token: Address
  tradeSizeMicroUsd: string
  nonce: Hex
  paramsHash: Hex
  accessTokenHash: string
  status: RequestStatus
  createdAtMs: number
  expiresAtMs: number
  updatedAtMs: number
  rev: number
  chainCreatedAt: number | null
  refundableAt: number | null
  lease: { owner: string; untilMs: number } | null
  attempts: number
  report: { hash: Hex } | null
  settle: { txHash: Hex; raw: Hex; prepares: number; lastBroadcastMs: number } | null
  /** Settlement transactions given up on after "nonce too low"; kept because one may still have landed. */
  priorSettleTxHashes?: Hex[]
  settlePrepares: number
  settledTxHash: Hex | null
  failure: string | null
}

export const recordKey = (id: string) => `ppc:req:${id.toLowerCase()}`
export const reportKey = (id: string) => `ppc:report:${id.toLowerCase()}`

const TERMINAL: readonly RequestStatus[] = ['COMPLETED', 'REFUNDED', 'EXPIRED']

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function tokensMatch(expectedHashHex: string, provided: string): boolean {
  const a = Buffer.from(expectedHashHex, 'hex')
  const b = Buffer.from(hashAccessToken(provided), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface Loaded {
  raw: string
  record: RequestRecord
}

async function load(store: Store, id: string): Promise<Loaded | null> {
  const raw = await store.get(recordKey(id))
  if (raw === null) return null
  return { raw, record: JSON.parse(raw) as RequestRecord }
}

/** Optimistic update. `fn` returns the changed record or null for "nothing to do". Returns the applied record or null. */
async function mutate(
  deps: Deps,
  id: string,
  fn: (current: RequestRecord) => RequestRecord | null,
): Promise<RequestRecord | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const loaded = await load(deps.store, id)
    if (!loaded) return null
    const changed = fn(loaded.record)
    if (changed === null) return null
    const next: RequestRecord = { ...changed, rev: loaded.record.rev + 1, updatedAtMs: deps.now() }
    if (await deps.store.compareAndSet(recordKey(id), loaded.raw, JSON.stringify(next), RECORD_TTL_SEC)) return next
  }
  return null
}

export type CreateResult =
  | { ok: true; response: CreateRequestResponse }
  | { ok: false; error: 'INVALID_TOKEN' | 'INVALID_PAYER' | 'INVALID_TRADE_SIZE' }

export async function createRequest(deps: Deps, body: { token?: unknown; tradeSizeUsd?: unknown; payer?: unknown }): Promise<CreateResult> {
  const token = parseAddress(body.token)
  if (!token) return { ok: false, error: 'INVALID_TOKEN' }
  const payer = parseAddress(body.payer)
  if (!payer) return { ok: false, error: 'INVALID_PAYER' }
  const micro = parseTradeSizeUsd(body.tradeSizeUsd)
  if (micro === null) return { ok: false, error: 'INVALID_TRADE_SIZE' }

  const nonce = toHex(randomBytes(32))
  const paramsHash = computeParamsHash(token, micro, deps.chainId)
  const requestId = computeRequestId(deps.contract, payer, nonce, paramsHash, deps.chainId)
  const accessToken = `ppc_${randomBytes(32).toString('hex')}`
  const nowMs = deps.now()
  const record: RequestRecord = {
    v: 1,
    id: requestId,
    payer,
    token,
    tradeSizeMicroUsd: micro.toString(),
    nonce,
    paramsHash,
    accessTokenHash: hashAccessToken(accessToken),
    status: 'CREATED',
    createdAtMs: nowMs,
    expiresAtMs: nowMs + UNPAID_TTL_MS,
    updatedAtMs: nowMs,
    rev: 0,
    chainCreatedAt: null,
    refundableAt: null,
    lease: null,
    attempts: 0,
    report: null,
    settle: null,
    settlePrepares: 0,
    settledTxHash: null,
    failure: null,
  }
  const created = await deps.store.setIfAbsent(recordKey(requestId), JSON.stringify(record), RECORD_TTL_SEC)
  if (!created) throw new Error('request id collision')
  await deps.store.addToSet(ACTIVE_SET, requestId)
  return {
    ok: true,
    response: {
      requestId,
      nonce,
      paramsHash,
      chainId: deps.chainId,
      contract: deps.contract,
      usdc: deps.usdc,
      priceRaw: PRICE_RAW.toString(),
      refundDelaySeconds: REFUND_DELAY_SECONDS,
      expiresAt: Math.floor(record.expiresAtMs / 1000),
      accessToken,
    },
  }
}

/** Returns the record only when the bearer token matches. Unknown id and wrong token are indistinguishable. */
export async function authorize(deps: Deps, id: string, bearer: string | null): Promise<RequestRecord | null> {
  const dummy = '0'.repeat(64)
  const loaded = isHash32(id) ? await load(deps.store, id) : null
  const expected = loaded?.record.accessTokenHash ?? dummy
  const matches = bearer !== null && tokensMatch(expected, bearer)
  return loaded && matches ? loaded.record : null
}

const FAILED_LINGER_MS = 2 * 3600 * 1000

async function finish(deps: Deps, record: RequestRecord): Promise<void> {
  const done = TERMINAL.includes(record.status) || (record.status === 'FAILED' && deps.now() - record.updatedAtMs > FAILED_LINGER_MS)
  if (done) await deps.store.removeFromSet(ACTIVE_SET, record.id)
}

function setFailed(reason: string) {
  return (current: RequestRecord): RequestRecord | null =>
    current.status === 'COMPLETED' || current.status === 'REFUNDED' || current.status === 'EXPIRED' || current.status === 'FAILED'
      ? null
      : { ...current, status: 'FAILED', failure: reason, lease: null }
}

interface StepResult {
  record: RequestRecord
  progressed: boolean
}

function marginOk(chainReq: OnchainRequest, chainNowSec: number): boolean {
  return chainReq.refundableAt - chainNowSec >= SETTLE_SAFETY_MARGIN_SECONDS
}

async function stepOnce(deps: Deps, rec: RequestRecord, ownerId: string): Promise<StepResult> {
  const same = (): StepResult => ({ record: rec, progressed: false })
  const moved = (next: RequestRecord | null): StepResult => (next ? { record: next, progressed: true } : { record: rec, progressed: false })

  if (rec.status === 'COMPLETED' || rec.status === 'REFUNDED' || rec.status === 'EXPIRED') return same()

  const chainReq = await deps.reader.getRequest(deps.contract, rec.id)

  if (chainReq.status === ONCHAIN_STATUS.Refunded) {
    return moved(await mutate(deps, rec.id, (c) => (c.status === 'REFUNDED' ? null : { ...c, status: 'REFUNDED', lease: null })))
  }
  if (rec.status === 'FAILED') return same()

  switch (rec.status) {
    case 'CREATED': {
      if (chainReq.status === ONCHAIN_STATUS.None) {
        if (deps.now() > rec.expiresAtMs) {
          return moved(await mutate(deps, rec.id, (c) => (c.status === 'CREATED' ? { ...c, status: 'EXPIRED' } : null)))
        }
        return same()
      }
      const valid =
        chainReq.status === ONCHAIN_STATUS.Paid &&
        chainReq.payer.toLowerCase() === rec.payer.toLowerCase() &&
        chainReq.paramsHash.toLowerCase() === rec.paramsHash.toLowerCase() &&
        chainReq.refundableAt - chainReq.createdAt === REFUND_DELAY_SECONDS
      if (!valid) return moved(await mutate(deps, rec.id, setFailed('PAYMENT_MISMATCH')))
      return moved(
        await mutate(deps, rec.id, (c) =>
          c.status === 'CREATED'
            ? { ...c, status: 'PAYMENT_VERIFIED', chainCreatedAt: chainReq.createdAt, refundableAt: chainReq.refundableAt }
            : null,
        ),
      )
    }

    case 'PAYMENT_VERIFIED': {
      if (chainReq.status !== ONCHAIN_STATUS.Paid) return moved(await mutate(deps, rec.id, setFailed('UNEXPECTED_ONCHAIN_STATE')))
      if (!marginOk(chainReq, await deps.reader.getChainTime())) {
        return moved(await mutate(deps, rec.id, setFailed('DEADLINE_MARGIN')))
      }
      const claimed = await mutate(deps, rec.id, (c) =>
        c.status === 'PAYMENT_VERIFIED'
          ? { ...c, status: 'PROCESSING', lease: { owner: ownerId, untilMs: deps.now() + LEASE_MS }, attempts: c.attempts + 1 }
          : null,
      )
      return moved(claimed)
    }

    case 'PROCESSING': {
      if (rec.lease && rec.lease.owner !== ownerId) {
        if (rec.lease.untilMs > deps.now()) return same()
        const stale = rec.lease
        return moved(
          await mutate(deps, rec.id, (c) =>
            c.status === 'PROCESSING' && c.lease?.owner === stale.owner
              ? c.attempts >= MAX_PROCESSING_ATTEMPTS
                ? { ...c, status: 'FAILED', failure: 'PROCESSING_TIMEOUT', lease: null }
                : { ...c, status: 'PAYMENT_VERIFIED', lease: null }
              : null,
          ),
        )
      }
      return moved(await runGeneration(deps, rec, ownerId))
    }

    case 'REPORT_READY': {
      // Already settled onchain means an earlier settlement of ours landed: complete from it, never sign again.
      if (chainReq.status === ONCHAIN_STATUS.Settled) return await completeFromPrior(deps, rec)
      if (chainReq.status !== ONCHAIN_STATUS.Paid) return same()
      if (!deps.settler || !rec.report) return same()
      if (!marginOk(chainReq, await deps.reader.getChainTime())) {
        return moved(await mutate(deps, rec.id, setFailed('DEADLINE_MARGIN')))
      }
      return moved(await prepareAndBroadcast(deps, rec, deps.settler))
    }

    case 'SETTLING':
      return await checkSettlement(deps, rec, chainReq)

    default:
      return same()
  }
}

async function runGeneration(deps: Deps, rec: RequestRecord, ownerId: string): Promise<RequestRecord | null> {
  let reportJson = await deps.store.get(reportKey(rec.id))
  if (reportJson === null) {
    try {
      const report = await deps.generator.generate({
        requestId: rec.id,
        chainId: deps.chainId,
        token: rec.token,
        tradeSizeMicroUsd: BigInt(rec.tradeSizeMicroUsd),
      })
      const json = canonicalJson(report)
      await deps.store.setIfAbsent(reportKey(rec.id), json, RECORD_TTL_SEC)
      reportJson = (await deps.store.get(reportKey(rec.id))) ?? json
    } catch {
      return await mutate(deps, rec.id, (c) =>
        c.status === 'PROCESSING' && c.lease?.owner === ownerId
          ? c.attempts >= MAX_PROCESSING_ATTEMPTS
            ? { ...c, status: 'FAILED', failure: 'REPORT_GENERATION_FAILED', lease: null }
            : { ...c, status: 'PAYMENT_VERIFIED', lease: null }
          : null,
      )
    }
  }
  const hash = hashReport(reportJson)
  return await mutate(deps, rec.id, (c) =>
    c.status === 'PROCESSING' && c.lease?.owner === ownerId ? { ...c, status: 'REPORT_READY', report: { hash }, lease: null } : null,
  )
}

async function prepareAndBroadcast(deps: Deps, rec: RequestRecord, settler: Settler): Promise<RequestRecord | null> {
  const lockOwner = deps.newId()
  let locked = false
  for (let i = 0; i < 10 && !locked; i++) {
    locked = await deps.store.acquireLock(OPERATOR_LOCK, lockOwner, 30_000)
    if (!locked) await deps.sleep(300)
  }
  if (!locked) return null
  try {
    const fresh = await load(deps.store, rec.id)
    if (!fresh || fresh.record.status !== 'REPORT_READY' || !fresh.record.report) return null
    if (fresh.record.settlePrepares >= MAX_SETTLE_PREPARES) {
      return await mutate(deps, rec.id, setFailed('SETTLE_BROADCAST_FAILED'))
    }
    const prepared = await settler.prepareSettle(deps.contract, rec.id, fresh.record.report.hash)
    const next = await mutate(deps, rec.id, (c) =>
      c.status === 'REPORT_READY'
        ? {
            ...c,
            status: 'SETTLING',
            settlePrepares: c.settlePrepares + 1,
            settle: { txHash: prepared.txHash, raw: prepared.raw, prepares: c.settlePrepares + 1, lastBroadcastMs: deps.now() },
          }
        : null,
    )
    // Broadcast only after the signed hash is persisted. Errors here are retried by the SETTLING step.
    if (next) await settler.broadcast(prepared.raw).catch(() => undefined)
    return next
  } finally {
    await deps.store.releaseLock(OPERATOR_LOCK, lockOwner)
  }
}

async function checkSettlement(deps: Deps, rec: RequestRecord, chainReq: OnchainRequest): Promise<StepResult> {
  const stay: StepResult = { record: rec, progressed: false }
  if (!deps.settler || !rec.settle || !rec.report) return stay
  const settle = rec.settle
  const state = await deps.settler.getTxState(settle.txHash)

  if (state === 'success') {
    const log = chainReq.status === ONCHAIN_STATUS.Settled ? await deps.reader.getSettledLog(deps.contract, rec.id, settle.txHash) : null
    const ok =
      log !== null &&
      log.reportHash.toLowerCase() === rec.report.hash.toLowerCase() &&
      log.payer.toLowerCase() === rec.payer.toLowerCase()
    const next = await mutate(deps, rec.id, (c) =>
      c.status !== 'SETTLING'
        ? null
        : ok
          ? { ...c, status: 'COMPLETED', settledTxHash: settle.txHash }
          : { ...c, status: 'FAILED', failure: 'SETTLEMENT_MISMATCH' },
    )
    return next ? { record: next, progressed: true } : stay
  }
  if (state === 'reverted') {
    // A retry reverts when an earlier settlement of ours already settled the request; check before failing.
    if ((await deps.reader.getRequest(deps.contract, rec.id)).status === ONCHAIN_STATUS.Settled) {
      const reconciled = await completeFromPrior(deps, rec)
      if (reconciled.progressed) return reconciled
    }
    const next = await mutate(deps, rec.id, setFailed('SETTLE_REVERTED'))
    return next ? { record: next, progressed: true } : stay
  }
  if (chainReq.status === ONCHAIN_STATUS.Settled) return stay // included but receipt not visible yet

  if ((await deps.reader.getChainTime()) >= chainReq.refundableAt) {
    const next = await mutate(deps, rec.id, setFailed('SETTLEMENT_WINDOW_CLOSED'))
    return next ? { record: next, progressed: true } : stay
  }
  if (deps.now() - settle.lastBroadcastMs < 5000) return stay
  try {
    await deps.settler.broadcast(settle.raw)
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('nonce too low') || message.includes('replacement')) {
      // The nonce is used, possibly by this very transaction landing since the reads above. Re-sign only if a
      // fresh read still shows it pending and the request still Paid; otherwise the next tick sees the result.
      const [again, fresh] = await Promise.all([deps.settler.getTxState(settle.txHash), deps.reader.getRequest(deps.contract, rec.id)])
      if (again !== 'pending' || fresh.status !== ONCHAIN_STATUS.Paid) return stay
      const next = await mutate(deps, rec.id, (c) =>
        c.status === 'SETTLING'
          ? { ...c, status: 'REPORT_READY', settle: null, priorSettleTxHashes: [...(c.priorSettleTxHashes ?? []), settle.txHash] }
          : null,
      )
      return next ? { record: next, progressed: true } : stay
    }
  }
  const touched = await mutate(deps, rec.id, (c) =>
    c.status === 'SETTLING' && c.settle ? { ...c, settle: { ...c.settle, lastBroadcastMs: deps.now() } } : null,
  )
  return touched ? { record: touched, progressed: true } : stay
}

/** Completes a request settled by one of its earlier settlement transactions, when that transaction's log matches. */
async function completeFromPrior(deps: Deps, rec: RequestRecord): Promise<StepResult> {
  const stay: StepResult = { record: rec, progressed: false }
  if (!rec.report) return stay
  for (const txHash of rec.priorSettleTxHashes ?? []) {
    const log = await deps.reader.getSettledLog(deps.contract, rec.id, txHash)
    if (!log || log.reportHash.toLowerCase() !== rec.report.hash.toLowerCase() || log.payer.toLowerCase() !== rec.payer.toLowerCase()) continue
    const next = await mutate(deps, rec.id, (c) =>
      c.status === 'REPORT_READY' || c.status === 'SETTLING' ? { ...c, status: 'COMPLETED', settle: null, settledTxHash: txHash } : null,
    )
    return next ? { record: next, progressed: true } : stay
  }
  return stay
}

/** Advances a request as far as the current onchain state allows. Safe to call concurrently and repeatedly. */
export async function advance(deps: Deps, id: string): Promise<RequestRecord | null> {
  const ownerId = deps.newId()
  let loaded = await load(deps.store, id)
  if (!loaded) return null
  let record = loaded.record
  for (let i = 0; i < 12; i++) {
    const result = await stepOnce(deps, record, ownerId)
    record = result.record
    if (!result.progressed) break
    loaded = await load(deps.store, id)
    if (!loaded) break
    record = loaded.record
  }
  await finish(deps, record)
  return record
}

export function toPaymentState(status: number): PaymentState {
  return status === ONCHAIN_STATUS.Paid ? 'paid' : status === ONCHAIN_STATUS.Settled ? 'settled' : status === ONCHAIN_STATUS.Refunded ? 'refunded' : 'none'
}

export async function buildView(deps: Deps, rec: RequestRecord): Promise<RequestView> {
  const chainReq = await deps.reader.getRequest(deps.contract, rec.id)
  return {
    requestId: rec.id,
    status: rec.status,
    token: rec.token,
    tradeSizeUsd: formatTradeSizeUsd(BigInt(rec.tradeSizeMicroUsd)),
    payer: rec.payer,
    payment: {
      state: toPaymentState(chainReq.status),
      createdAt: chainReq.status === ONCHAIN_STATUS.None ? null : chainReq.createdAt,
      refundableAt: chainReq.status === ONCHAIN_STATUS.None ? null : chainReq.refundableAt,
    },
    settleTxHash: rec.settledTxHash,
    reportAvailable: rec.status === 'COMPLETED' && chainReq.status === ONCHAIN_STATUS.Settled,
    failure: rec.failure,
    settlementEnabled: deps.settler !== null,
  }
}

export type ReportResult =
  | { ok: true; report: unknown; reportHash: Hex; settleTxHash: Hex }
  | { ok: false; reason: 'NOT_READY' | 'NOT_SETTLED' | 'REPORT_MISSING' | 'REPORT_HASH_MISMATCH' }

/** Releases the report only when the record is COMPLETED, the contract still says Settled, and the stored report matches the settled hash. */
export async function getReport(deps: Deps, rec: RequestRecord): Promise<ReportResult> {
  if (rec.status !== 'COMPLETED' || !rec.report || !rec.settledTxHash) return { ok: false, reason: 'NOT_READY' }
  const chainReq = await deps.reader.getRequest(deps.contract, rec.id)
  if (chainReq.status !== ONCHAIN_STATUS.Settled) return { ok: false, reason: 'NOT_SETTLED' }
  const json = await deps.store.get(reportKey(rec.id))
  if (json === null) return { ok: false, reason: 'REPORT_MISSING' }
  if (hashReport(json).toLowerCase() !== rec.report.hash.toLowerCase()) return { ok: false, reason: 'REPORT_HASH_MISMATCH' }
  return { ok: true, report: JSON.parse(json) as unknown, reportHash: rec.report.hash, settleTxHash: rec.settledTxHash }
}

/** Processes outstanding requests; used by the cron endpoint. */
export async function processActive(deps: Deps, limit = 20): Promise<{ processed: number; failedIds: number }> {
  const ids = (await deps.store.members(ACTIVE_SET)).slice(0, limit)
  let failedIds = 0
  for (const id of ids) {
    try {
      await advance(deps, id)
    } catch {
      failedIds++
    }
  }
  return { processed: ids.length, failedIds }
}

export type ScheduledResult = { skipped: false; processed: number; failedIds: number } | { skipped: true; reason: 'ALREADY_RUNNING' }

/**
 * Scheduled entry point. Cron delivery may overlap or repeat a run, so a run lock keeps one sweep at a time,
 * and every step inside is a compare-and-set, so a repeated sweep finds nothing new to do.
 */
export async function processScheduled(deps: Deps): Promise<ScheduledResult> {
  const owner = deps.newId()
  if (!(await deps.store.acquireLock(CRON_LOCK, owner, CRON_LOCK_MS))) return { skipped: true, reason: 'ALREADY_RUNNING' }
  try {
    return { skipped: false, ...(await processActive(deps)) }
  } finally {
    await deps.store.releaseLock(CRON_LOCK, owner)
  }
}

export function defaultNewId(): string {
  return randomId()
}
