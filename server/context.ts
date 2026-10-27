/**
 * Builds the dependency context once per function instance and runs the fail-closed preflight:
 * the RPC must report chain 5042, the configured address must hold the PayPerCall contract, and the
 * contract's immutable settings must match the values Phase 2 was reviewed with.
 */
import { PRICE_RAW, REFUND_DELAY_SECONDS } from '../shared/protocol'
import { createViemChainReader, createViemSettler, type ChainReader, type ContractSettings, type Settler } from './chain'
import { loadConfig, type Env, type ServerConfig } from './config'
import { defaultNewId, type Deps } from './requests'
import { createReportGenerator } from './report'
import { createStore, type Store } from './store'

export interface ReadyContext {
  ready: true
  config: ServerConfig
  deps: Deps
  settings: ContractSettings
  settlementDisabledReason: string | null
}
export interface NotReadyContext {
  ready: false
  reasons: string[]
}
export type AppContext = ReadyContext | NotReadyContext
export type ContextProvider = () => Promise<AppContext>

export async function runPreflight(config: ServerConfig, reader: ChainReader): Promise<{ reasons: string[]; settings: ContractSettings | null }> {
  const reasons: string[] = []
  try {
    const chainId = await reader.getChainId()
    if (chainId !== config.chainId) reasons.push(`RPC reports chain ${chainId.toString()}, expected ${config.chainId.toString()}`)
  } catch {
    reasons.push('RPC endpoint is unreachable')
    return { reasons, settings: null }
  }
  if (reasons.length > 0) return { reasons, settings: null }
  try {
    if ((await reader.getCodeSize(config.contract)) === 0) {
      return { reasons: ['No contract code at the configured PayPerCall address on Arc mainnet'], settings: null }
    }
    const settings = await reader.readSettings(config.contract)
    if (settings.usdc.toLowerCase() !== config.usdc.toLowerCase()) reasons.push('Contract USDC does not match the official Arc USDC address')
    if (settings.price !== PRICE_RAW) reasons.push('Contract PRICE is not 0.10 USDC')
    if (settings.refundDelay !== REFUND_DELAY_SECONDS) reasons.push('Contract REFUND_DELAY is not 30 minutes')
    return { reasons, settings: reasons.length === 0 ? settings : null }
  } catch {
    return { reasons: ['The configured address does not look like a PayPerCall contract'], settings: null }
  }
}

export interface ProviderOverrides {
  reader?: ChainReader
  store?: Store
  settler?: Settler | null
  now?: () => number
  cacheMs?: number
}

export function createContextProvider(env: Env, overrides: ProviderOverrides = {}): ContextProvider {
  let cached: { at: number; value: AppContext } | null = null
  const now = overrides.now ?? Date.now
  let store: Store | null = overrides.store ?? null
  let reader: ChainReader | null = overrides.reader ?? null
  let settler: Settler | null | undefined = overrides.settler

  return async () => {
    const ttl = cached?.value.ready ? (overrides.cacheMs ?? 60_000) : 10_000
    if (cached && now() - cached.at < ttl) return cached.value

    const loaded = loadConfig(env)
    if (!loaded.ok) {
      cached = { at: now(), value: { ready: false, reasons: loaded.errors } }
      return cached.value
    }
    const config = loaded.config
    store ??= createStore(config.store)
    reader ??= createViemChainReader(config.rpcUrl)
    const { reasons, settings } = await runPreflight(config, reader)
    if (reasons.length > 0 || !settings) {
      cached = { at: now(), value: { ready: false, reasons } }
      return cached.value
    }

    let activeSettler: Settler | null = null
    let settlementDisabledReason: string | null = null
    if (settler !== undefined) activeSettler = settler
    else if (config.operatorKey) activeSettler = createViemSettler(config.rpcUrl, config.operatorKey)
    else settlementDisabledReason = 'PPC_OPERATOR_PRIVATE_KEY is not configured'
    if (activeSettler && activeSettler.address.toLowerCase() !== settings.operator.toLowerCase()) {
      activeSettler = null
      settlementDisabledReason = 'Configured operator key does not match the contract operator'
    }

    const deps: Deps = {
      chainId: config.chainId,
      contract: config.contract,
      usdc: config.usdc,
      store,
      reader,
      settler: activeSettler,
      generator: createReportGenerator(reader),
      now,
      newId: defaultNewId,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }
    cached = { at: now(), value: { ready: true, config, deps, settings, settlementDisabledReason } }
    return cached.value
  }
}

let defaultProvider: ContextProvider | null = null

/** Per-instance singleton used by the Vercel entry and the local dev server. */
export function getDefaultContextProvider(): ContextProvider {
  defaultProvider ??= createContextProvider(process.env)
  return defaultProvider
}
