/** In-memory fakes for the chain and the operator, used only by tests. */
import { keccak256, toHex, type Address, type Hex } from 'viem'
import { ONCHAIN_STATUS, type OnchainStatus } from '../shared/abi'
import { REFUND_DELAY_SECONDS, productionFacts } from '../shared/protocol'
import type { ChainReader, ContractSettings, OnchainRequest, PreparedSettlement, SettledLog, Settler, TokenInspection, TxState } from './chain'
import { type Deps } from './requests'
import { createReportGenerator, type ReportGenerator } from './report'
import { MemoryStore } from './store'

/** Obviously synthetic fixture addresses (one repeated byte). */
export const fill = (byte: string): Address => `0x${byte.repeat(20)}`
export const CONTRACT = fill('11')
export const USDC = productionFacts().usdc
export const PAYER = fill('22')
export const OPERATOR = fill('55')
export const TOKEN = fill('66')
const TREASURY = fill('77')
const TOKEN_OWNER = fill('88')

export class Clock {
  constructor(public ms = 1_800_000_000_000) {}
  now = () => this.ms
  advanceSeconds(seconds: number) {
    this.ms += seconds * 1000
  }
}

export const SETTINGS: ContractSettings = {
  usdc: USDC,
  price: 100_000n,
  refundDelay: REFUND_DELAY_SECONDS,
  treasury: TREASURY,
  operator: OPERATOR,
  paused: false,
}

export function tokenInspection(overrides: Partial<TokenInspection> = {}): TokenInspection {
  return {
    blockNumber: 27_000_000n,
    blockTimestamp: 1_800_000_000n,
    codeSize: 1200,
    selectors: { 'mint(address,uint256)': true, 'pause()': false },
    name: 'Test Token',
    symbol: 'TST',
    decimals: 18,
    totalSupply: 1_000_000n * 10n ** 18n,
    owner: TOKEN_OWNER,
    paused: false,
    eip1967Implementation: null,
    eip1967Admin: null,
    unreadable: [],
    ...overrides,
  }
}

export class FakeChain implements ChainReader {
  chainId = 5042
  codeSize = 100
  settings: ContractSettings = SETTINGS
  requests = new Map<string, OnchainRequest>()
  settledLogs = new Map<string, SettledLog>()
  inspection: TokenInspection = tokenInspection()
  inspectCalls = 0
  readFailure: Error | null = null

  constructor(private readonly clock: Clock) {}

  getChainId = () => Promise.resolve(this.chainId)
  getCodeSize = () => Promise.resolve(this.codeSize)
  readSettings = () => Promise.resolve(this.settings)
  getChainTime = () => Promise.resolve(Math.floor(this.clock.ms / 1000))

  getRequest(_contract: Address, requestId: Hex): Promise<OnchainRequest> {
    if (this.readFailure) return Promise.reject(this.readFailure)
    return Promise.resolve(
      this.requests.get(requestId.toLowerCase()) ?? {
        payer: fill('00'),
        createdAt: 0,
        refundableAt: 0,
        status: ONCHAIN_STATUS.None,
        paramsHash: `0x${'00'.repeat(32)}`,
      },
    )
  }

  getSettledLog(_contract: Address, _requestId: Hex, txHash: Hex): Promise<SettledLog | null> {
    return Promise.resolve(this.settledLogs.get(txHash) ?? null)
  }

  inspectToken(): Promise<TokenInspection> {
    this.inspectCalls++
    return Promise.resolve(this.inspection)
  }

  /** Simulates the payer's successful createRequest transaction. */
  pay(requestId: Hex, payer: Address, paramsHash: Hex): void {
    const createdAt = Math.floor(this.clock.ms / 1000)
    this.requests.set(requestId.toLowerCase(), {
      payer,
      createdAt,
      refundableAt: createdAt + REFUND_DELAY_SECONDS,
      status: ONCHAIN_STATUS.Paid,
      paramsHash,
    })
  }

  setStatus(requestId: Hex, status: OnchainStatus): void {
    const current = this.requests.get(requestId.toLowerCase())
    if (current) this.requests.set(requestId.toLowerCase(), { ...current, status })
  }

  settle(requestId: Hex, reportHash: Hex, txHash: Hex): void {
    const current = this.requests.get(requestId.toLowerCase())
    if (!current) return
    this.requests.set(requestId.toLowerCase(), { ...current, status: ONCHAIN_STATUS.Settled })
    this.settledLogs.set(txHash, { requestId, payer: current.payer, reportHash, settledAt: Math.floor(this.clock.ms / 1000), txHash })
  }
}

interface RawSettlement {
  requestId: Hex
  reportHash: Hex
  n: number
}

export class FakeSettler implements Settler {
  readonly address = OPERATOR
  prepares = 0
  broadcasts: Hex[] = []
  txStates = new Map<Hex, TxState>()
  broadcastError: Error | null = null
  autoMine = true
  /** Value written to the settle log instead of the real report hash (to test mismatches). */
  logHashOverride: Hex | null = null

  constructor(private readonly chain: FakeChain) {}

  prepareSettle(_contract: Address, requestId: Hex, reportHash: Hex): Promise<PreparedSettlement> {
    this.prepares++
    const raw = toHex(JSON.stringify({ requestId, reportHash, n: this.prepares } satisfies RawSettlement))
    return Promise.resolve({ raw, txHash: keccak256(raw) })
  }

  broadcast(raw: Hex): Promise<Hex> {
    this.broadcasts.push(raw)
    if (this.broadcastError) {
      const error = this.broadcastError
      this.broadcastError = null
      return Promise.reject(error)
    }
    const txHash = keccak256(raw)
    if (this.autoMine) {
      const parsed = JSON.parse(Buffer.from(raw.slice(2), 'hex').toString('utf8')) as RawSettlement
      this.chain.settle(parsed.requestId, this.logHashOverride ?? parsed.reportHash, txHash)
      this.txStates.set(txHash, 'success')
    }
    return Promise.resolve(txHash)
  }

  getTxState = (txHash: Hex): Promise<TxState> => Promise.resolve(this.txStates.get(txHash) ?? 'pending')
}

export interface Harness {
  clock: Clock
  chain: FakeChain
  settler: FakeSettler
  store: MemoryStore
  deps: Deps
  generatorCalls: () => number
}

export function makeHarness(options: { withSettler?: boolean; generator?: ReportGenerator } = {}): Harness {
  const clock = new Clock()
  const chain = new FakeChain(clock)
  const settler = new FakeSettler(chain)
  const store = new MemoryStore(clock.now)
  const base = options.generator ?? createReportGenerator(chain, () => new Date(clock.ms))
  let calls = 0
  const generator: ReportGenerator = {
    generate: (input) => {
      calls++
      return base.generate(input)
    },
  }
  let counter = 0
  const deps: Deps = {
    chainId: 5042,
    contract: CONTRACT,
    usdc: USDC,
    store,
    reader: chain,
    settler: options.withSettler === false ? null : settler,
    generator,
    now: clock.now,
    newId: () => `id${(++counter).toString()}`,
    sleep: () => Promise.resolve(),
  }
  return { clock, chain, settler, store, deps, generatorCalls: () => calls }
}
