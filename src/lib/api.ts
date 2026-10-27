import type { Hex } from 'viem'
import type { CreateRequestBody, CreateRequestResponse, RequestView } from '../../shared/protocol'
import type { Report } from '../../server/report'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ReportResponse {
  requestId: Hex
  reportHash: Hex
  settleTxHash: Hex
  report: Report
}

export interface HealthResponse {
  ok: boolean
  ready: boolean
  reasons?: string[]
  settlementEnabled?: boolean
  paused?: boolean
}

interface ErrorShape {
  error?: string
  message?: string
  reasons?: string[]
  reason?: string
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, { ...init, headers })
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the PayPerCall API.')
  }
  const body = (await response.json().catch(() => ({}))) as ErrorShape & T
  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? 'ERROR', body.message ?? body.reason ?? 'Request failed.', body.reasons ?? [])
  }
  return body
}

export const api = {
  health: () => call<HealthResponse>('/health'),
  create: (body: CreateRequestBody) => call<CreateRequestResponse>('/requests', { method: 'POST', body: JSON.stringify(body) }),
  view: (id: Hex, token: string) => call<RequestView>(`/requests/${id}`, {}, token),
  report: (id: Hex, token: string) => call<ReportResponse>(`/requests/${id}/report`, {}, token),
}
