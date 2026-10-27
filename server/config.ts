/**
 * Server configuration. Fails closed: any missing or invalid production setting yields errors and
 * the API refuses to serve requests instead of guessing a value.
 */
import { type Address, type Hex } from 'viem'
import { isZeroAddress, parseAddress, productionFacts } from '../shared/protocol.js'

export const CONTRACT_ENV = 'VITE_PAY_PER_CALL_ADDRESS'

export type StoreConfig =
  | { kind: 'upstash'; url: string; token: string }
  | { kind: 'memory' }

export interface ServerConfig {
  chainId: number
  rpcUrl: string
  explorerBase: string
  contract: Address
  usdc: Address
  store: StoreConfig
  /** Present only when a settlement key is configured. Never logged. */
  operatorKey: Hex | null
  cronSecret: string | null
}

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; errors: string[] }

export type Env = Record<string, string | undefined>

function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

export function loadConfig(env: Env): ConfigResult {
  const errors: string[] = []
  const facts = productionFacts()

  // 1. Contract address: explicit placeholder until deployment.
  const rawContract = clean(env[CONTRACT_ENV])
  let contract: Address | null = null
  if (rawContract === '') {
    errors.push(`${CONTRACT_ENV} is not set: the PayPerCall contract has not been configured (not deployed yet)`)
  } else {
    contract = parseAddress(rawContract)
    if (!contract) errors.push(`${CONTRACT_ENV} is not a valid address`)
    else if (isZeroAddress(contract)) {
      errors.push(`${CONTRACT_ENV} is the zero address`)
      contract = null
    }
  }

  // 2. RPC: the registry's Arc mainnet endpoint unless an https override is supplied. The chain ID is
  // also checked against the live endpoint during preflight.
  let rpcUrl = facts.rpcUrl
  const rpcOverride = clean(env.ARC_MAINNET_RPC_URL)
  if (rpcOverride !== '') {
    if (/^https:\/\/[^\s]+$/.test(rpcOverride)) rpcUrl = rpcOverride
    else errors.push('ARC_MAINNET_RPC_URL must be an https URL')
  }

  // 3. Durable store. In-memory is allowed only when explicitly requested and never on Vercel.
  const upstashUrl = clean(env.UPSTASH_REDIS_REST_URL)
  const upstashToken = clean(env.UPSTASH_REDIS_REST_TOKEN)
  let store: StoreConfig | null = null
  if (upstashUrl !== '' || upstashToken !== '') {
    if (/^https:\/\/[^\s]+$/.test(upstashUrl) && upstashToken !== '') {
      store = { kind: 'upstash', url: upstashUrl.replace(/\/+$/, ''), token: upstashToken }
    } else {
      errors.push('UPSTASH_REDIS_REST_URL (https) and UPSTASH_REDIS_REST_TOKEN must both be set')
    }
  } else if (clean(env.PPC_ALLOW_MEMORY_STORE) === '1') {
    if (clean(env.VERCEL) !== '') errors.push('PPC_ALLOW_MEMORY_STORE is not allowed on Vercel; configure Upstash Redis')
    else store = { kind: 'memory' }
  } else {
    errors.push('No durable store configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN')
  }

  // 4. Optional settlement key and cron secret.
  let operatorKey: Hex | null = null
  const rawKey = clean(env.PPC_OPERATOR_PRIVATE_KEY)
  if (rawKey !== '') {
    if (/^0x[0-9a-fA-F]{64}$/.test(rawKey)) operatorKey = rawKey as Hex
    else errors.push('PPC_OPERATOR_PRIVATE_KEY is not a 32-byte hex private key')
  }
  // CRON_SECRET is the name Vercel Cron reads to send `Authorization: Bearer <secret>`.
  const rawCron = clean(env.CRON_SECRET)
  let cronSecret: string | null = null
  if (rawCron !== '') {
    if (rawCron.length >= 16) cronSecret = rawCron
    else errors.push('CRON_SECRET must be at least 16 characters')
  }
  if (clean(env.PPC_CRON_SECRET) !== '') errors.push('PPC_CRON_SECRET was renamed to CRON_SECRET (the variable Vercel Cron uses)')

  if (errors.length > 0 || !contract || !store) {
    return { ok: false, errors: errors.length > 0 ? errors : ['Configuration is incomplete'] }
  }
  return {
    ok: true,
    config: {
      chainId: facts.chainId,
      rpcUrl,
      explorerBase: facts.explorerBase,
      contract,
      usdc: facts.usdc,
      store,
      operatorKey,
      cronSecret,
    },
  }
}
