/**
 * Report generation. Deterministic and rule based: every finding cites evidence read from Arc RPC.
 * Sections whose data sources are not built yet are reported as "unavailable" with the reason, never filled in.
 */
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { formatTradeSizeUsd } from '../shared/protocol'
import type { ChainReader, TokenInspection } from './chain'

export type Severity = 'info' | 'low' | 'medium' | 'high'
export type SectionStatus = 'ok' | 'partial' | 'unavailable'

export interface Evidence {
  id: string
  type: 'eth_getCode' | 'eth_call' | 'eth_getStorageAt'
  source: 'arc-rpc'
  ref: string
  observedAt: string
  value: string
}

export interface Finding {
  id: string
  severity: Severity
  text: string
  evidenceRefs: string[]
}

export interface ReportSection {
  id: 'token' | 'wallet' | 'liquidity'
  status: SectionStatus
  findings: Finding[]
  evidence: Evidence[]
  limitations: string[]
}

export interface Report {
  schemaVersion: '1'
  requestId: Hex
  subject: { chainId: number; token: Address; tradeSizeUsd: string }
  generatedAt: string
  chainState: { blockNumber: string; blockTimestamp: string }
  sections: ReportSection[]
  notEstablished: string[]
}

export interface ReportInput {
  requestId: Hex
  chainId: number
  token: Address
  tradeSizeMicroUsd: bigint
}

export interface ReportGenerator {
  generate(input: ReportInput): Promise<Report>
}

/** Stable JSON: object keys sorted, so the same report always serializes (and hashes) identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]))
  }
  return value
}

export function hashReport(canonical: string): Hex {
  return keccak256(toHex(canonical))
}

const NOT_ESTABLISHED = [
  'Whether the token can be sold after buying (honeypot behavior is not simulated).',
  'Who controls the token or its privileged addresses in the real world.',
  'Whether source code matches deployed bytecode (no verified-source data source is connected).',
  'Holder concentration and wallet activity (not implemented in this release).',
  'Liquidity depth, price impact and liquidity locks (not implemented in this release).',
]

export function createReportGenerator(reader: ChainReader, now: () => Date = () => new Date()): ReportGenerator {
  return {
    async generate(input) {
      const inspection = await reader.inspectToken(input.token)
      const observedAt = now().toISOString()
      return {
        schemaVersion: '1',
        requestId: input.requestId,
        subject: {
          chainId: input.chainId,
          token: input.token,
          tradeSizeUsd: formatTradeSizeUsd(input.tradeSizeMicroUsd),
        },
        generatedAt: observedAt,
        chainState: { blockNumber: inspection.blockNumber.toString(), blockTimestamp: inspection.blockTimestamp.toString() },
        sections: [
          buildTokenSection(input.token, inspection, observedAt),
          unavailableSection('wallet', 'Wallet activity analysis is not implemented in this release.'),
          unavailableSection('liquidity', 'Liquidity analysis (pool discovery and trade-size quotes) is not implemented in this release.'),
        ],
        notEstablished: NOT_ESTABLISHED,
      }
    },
  }
}

function unavailableSection(id: 'wallet' | 'liquidity', reason: string): ReportSection {
  return { id, status: 'unavailable', findings: [], evidence: [], limitations: [reason] }
}

function buildTokenSection(token: Address, t: TokenInspection, observedAt: string): ReportSection {
  const at = `${token}@block ${t.blockNumber.toString()}`
  const evidence: Evidence[] = []
  const findings: Finding[] = []
  const limitations: string[] = [
    'Selector checks only show that a function selector appears in the bytecode. They do not prove the function is reachable or who can call it.',
    'All values are single reads at one block; nothing here reflects history.',
  ]
  const addEvidence = (type: Evidence['type'], label: string, value: string): string => {
    const id = `e${(evidence.length + 1).toString()}`
    evidence.push({ id, type, source: 'arc-rpc', ref: `${label} ${at}`, observedAt, value })
    return id
  }

  const codeEvidence = addEvidence('eth_getCode', 'code size (bytes)', t.codeSize.toString())
  if (t.codeSize === 0) {
    findings.push({
      id: 'no-contract-code',
      severity: 'high',
      text: 'No contract code exists at this address on Arc mainnet, so it is not a token contract.',
      evidenceRefs: [codeEvidence],
    })
    return { id: 'token', status: 'ok', findings, evidence, limitations }
  }

  if (t.name !== null || t.symbol !== null || t.decimals !== null || t.totalSupply !== null) {
    const ref = addEvidence(
      'eth_call',
      'name/symbol/decimals/totalSupply',
      JSON.stringify({ name: t.name, symbol: t.symbol, decimals: t.decimals, totalSupply: t.totalSupply?.toString() ?? null }),
    )
    findings.push({
      id: 'erc20-metadata',
      severity: 'info',
      text: `Reads as an ERC-20 style token: name ${t.name ?? 'unreadable'}, symbol ${t.symbol ?? 'unreadable'}, decimals ${t.decimals?.toString() ?? 'unreadable'}.`,
      evidenceRefs: [ref],
    })
  } else {
    findings.push({
      id: 'not-erc20',
      severity: 'medium',
      text: 'Contract code exists but none of the standard ERC-20 metadata calls returned a value.',
      evidenceRefs: [codeEvidence],
    })
  }

  if (t.eip1967Implementation) {
    const ref = addEvidence('eth_getStorageAt', 'EIP-1967 implementation slot', t.eip1967Implementation)
    findings.push({
      id: 'upgradeable-proxy',
      severity: 'medium',
      text: `The EIP-1967 implementation slot is set (${t.eip1967Implementation}). Whoever controls the proxy admin can change the token's code.`,
      evidenceRefs: [ref],
    })
  }
  if (t.eip1967Admin) {
    const ref = addEvidence('eth_getStorageAt', 'EIP-1967 admin slot', t.eip1967Admin)
    findings.push({
      id: 'proxy-admin',
      severity: 'low',
      text: `A proxy admin address is recorded: ${t.eip1967Admin}.`,
      evidenceRefs: [ref],
    })
  }
  if (t.owner) {
    const ref = addEvidence('eth_call', 'owner()', t.owner)
    findings.push({
      id: 'owner-present',
      severity: 'low',
      text: `owner() returns ${t.owner}. A privileged owner exists; what it can do depends on code this report does not analyze.`,
      evidenceRefs: [ref],
    })
  }
  if (t.paused !== null) {
    const ref = addEvidence('eth_call', 'paused()', String(t.paused))
    findings.push({
      id: t.paused ? 'paused' : 'pausable',
      severity: t.paused ? 'high' : 'low',
      text: t.paused ? 'paused() returns true: transfers may currently be blocked.' : 'paused() exists and currently returns false.',
      evidenceRefs: [ref],
    })
  }
  const flagged = Object.entries(t.selectors).filter(([, present]) => present).map(([signature]) => signature)
  if (flagged.length > 0) {
    findings.push({
      id: 'privileged-selectors',
      severity: 'low',
      text: `The bytecode contains selectors for: ${flagged.join(', ')}.`,
      evidenceRefs: [codeEvidence],
    })
  }
  if (t.unreadable.length > 0) {
    limitations.push(`These reads failed or are not supported by the contract: ${t.unreadable.join(', ')}.`)
  }
  return { id: 'token', status: t.unreadable.length > 0 ? 'partial' : 'ok', findings, evidence, limitations }
}
