import type { Address } from 'viem'
import { isHash32, parseAddress, type CreateRequestResponse } from '../../shared/protocol'

/** Local record of a request: the access token is the only credential for its status and report. */
export interface HistoryEntry {
  created: CreateRequestResponse
  token: Address
  tradeSizeUsd: string
  payer: Address
  savedAt: number
}

const KEY = 'payper-call:requests:v1'
const MAX_ENTRIES = 25

function isEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<HistoryEntry>
  const created = entry.created as Partial<CreateRequestResponse> | undefined
  return (
    !!created &&
    isHash32(created.requestId) &&
    isHash32(created.nonce) &&
    isHash32(created.paramsHash) &&
    typeof created.accessToken === 'string' &&
    parseAddress(created.contract) !== null &&
    parseAddress(entry.token) !== null &&
    parseAddress(entry.payer) !== null &&
    typeof entry.tradeSizeUsd === 'string'
  )
}

export function loadHistory(storage: Pick<Storage, 'getItem'> = localStorage): HistoryEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

export function saveEntry(entry: HistoryEntry, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): HistoryEntry[] {
  const next = [entry, ...loadHistory(storage).filter((e) => e.created.requestId !== entry.created.requestId)].slice(0, MAX_ENTRIES)
  storage.setItem(KEY, JSON.stringify(next))
  return next
}

export function removeEntry(requestId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): HistoryEntry[] {
  const next = loadHistory(storage).filter((e) => e.created.requestId !== requestId)
  storage.setItem(KEY, JSON.stringify(next))
  return next
}
