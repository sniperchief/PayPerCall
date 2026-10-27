/**
 * HTTP router (Web Request in, Web Response out). Used by the Vercel catch-all function and the local dev server.
 * Routes live under /api/v1. Responses are never cached; unknown ids and wrong tokens are indistinguishable.
 */
import { timingSafeEqual } from 'node:crypto'
import { isHash32, type ApiErrorBody } from '../shared/protocol'
import type { ContextProvider, ReadyContext } from './context'
import { advance, authorize, buildView, createRequest, getReport, processScheduled } from './requests'

const PREFIX = '/api/v1'
const MAX_BODY_BYTES = 2048

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)), {
    status,
    headers: HEADERS,
  })
}

function fail(status: number, error: string, message: string, reasons?: string[]): Response {
  const body: ApiErrorBody = { error, message, ...(reasons ? { reasons } : {}) }
  return json(status, body)
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  const match = header ? /^Bearer\s+(\S{8,200})$/.exec(header) : null
  return match ? match[1] : null
}

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown'
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function allow(ctx: ReadyContext, key: string, max: number, windowSec: number): Promise<boolean> {
  return (await ctx.deps.store.incr(`ppc:rl:${key}`, windowSec)) <= max
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text()
  if (text.length === 0 || new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function createHandler(getContext: ContextProvider): (request: Request) => Promise<Response> {
  return async function handle(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(PREFIX)) return fail(404, 'NOT_FOUND', 'Unknown route')
    const path = url.pathname.slice(PREFIX.length).replace(/\/+$/, '') || '/'
    const segments = path.split('/').filter(Boolean)
    const method = request.method.toUpperCase()

    try {
      const ctx = await getContext()

      if (method === 'GET' && path === '/health') {
        return json(200, ctx.ready
          ? {
              ok: true,
              ready: true,
              chainId: ctx.config.chainId,
              contract: ctx.config.contract,
              store: ctx.config.store.kind,
              paused: ctx.settings.paused,
              settlementEnabled: ctx.deps.settler !== null,
              settlementDisabledReason: ctx.settlementDisabledReason,
            }
          : { ok: false, ready: false, reasons: ctx.reasons })
      }

      if (!ctx.ready) return fail(503, 'NOT_READY', 'The service is not configured for Arc mainnet.', ctx.reasons)

      if (method === 'GET' && path === '/quote') {
        return json(200, {
          chainId: ctx.config.chainId,
          contract: ctx.config.contract,
          usdc: ctx.config.usdc,
          priceRaw: ctx.settings.price.toString(),
          refundDelaySeconds: ctx.settings.refundDelay,
          paused: ctx.settings.paused,
          settlementEnabled: ctx.deps.settler !== null,
        })
      }

      if (method === 'POST' && path === '/requests') {
        const ip = clientIp(request)
        if (!(await allow(ctx, `create:ip:${ip}`, 20, 3600))) return fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.')
        if (ctx.settings.paused) return fail(503, 'PAUSED', 'New requests are paused.')
        // A request this server cannot settle would leave the payer waiting for a refund, so refuse it before any payment.
        if (!ctx.deps.settler) {
          return fail(503, 'SETTLEMENT_DISABLED', 'New requests are refused because settlement is not configured.', [
            ctx.settlementDisabledReason ?? 'No settlement key is available',
          ])
        }
        const body = await readJson(request)
        if (!body) return fail(400, 'INVALID_BODY', 'Expected a small JSON object.')
        if (typeof body.payer === 'string' && !(await allow(ctx, `create:payer:${body.payer.toLowerCase()}`, 10, 3600))) {
          return fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.')
        }
        const result = await createRequest(ctx.deps, body)
        if (!result.ok) return fail(400, result.error, 'Invalid request parameters.')
        return json(201, result.response)
      }

      // Vercel Cron invokes this path with GET and `Authorization: Bearer $CRON_SECRET`; POST is kept for manual runs.
      if ((method === 'GET' || method === 'POST') && path === '/cron/process') {
        const provided = bearer(request)
        const secret = ctx.config.cronSecret
        if (!secret) return fail(404, 'NOT_FOUND', 'Unknown route')
        if (!provided || !safeEqual(provided, secret)) return fail(401, 'UNAUTHORIZED', 'Invalid credentials.')
        return json(200, await processScheduled(ctx.deps))
      }

      if (method === 'GET' && segments[0] === 'requests' && segments.length >= 2 && segments.length <= 3) {
        const id = segments[1]
        if (!(await allow(ctx, `read:ip:${clientIp(request)}`, 240, 60))) return fail(429, 'RATE_LIMITED', 'Too many requests. Try again later.')
        const notFound = () => fail(404, 'NOT_FOUND', 'Request not found.')
        if (!isHash32(id)) return notFound()
        const authorized = await authorize(ctx.deps, id, bearer(request))
        if (!authorized) return notFound()
        const record = (await advance(ctx.deps, id)) ?? authorized

        if (segments.length === 2) return json(200, await buildView(ctx.deps, record))
        if (segments[2] === 'report') {
          const result = await getReport(ctx.deps, record)
          if (!result.ok) {
            return json(409, { error: 'REPORT_NOT_AVAILABLE', reason: result.reason, status: record.status })
          }
          return json(200, { requestId: record.id, reportHash: result.reportHash, settleTxHash: result.settleTxHash, report: result.report })
        }
      }

      return fail(404, 'NOT_FOUND', 'Unknown route')
    } catch {
      return fail(502, 'UPSTREAM_ERROR', 'A chain or storage dependency is unavailable. Retry shortly.')
    }
  }
}
