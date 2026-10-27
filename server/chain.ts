/**
 * Chain access. The domain logic depends only on the ChainReader and Settler interfaces so it can be
 * tested without a network; the viem implementations below talk to Arc mainnet over JSON-RPC.
 */
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arc } from 'viem/chains'
import { payPerCallAbi, type OnchainStatus } from '../shared/abi'

export interface OnchainRequest {
  payer: Address
  createdAt: number
  refundableAt: number
  status: OnchainStatus
  paramsHash: Hex
}

export interface ContractSettings {
  usdc: Address
  price: bigint
  refundDelay: number
  treasury: Address
  operator: Address
  paused: boolean
}

export interface SettledLog {
  requestId: Hex
  payer: Address
  reportHash: Hex
  settledAt: number
  txHash: Hex
}

export interface TokenInspection {
  blockNumber: bigint
  blockTimestamp: bigint
  codeSize: number
  /** Selector presence in the runtime bytecode, keyed by signature. A heuristic indicator only. */
  selectors: Record<string, boolean>
  name: string | null
  symbol: string | null
  decimals: number | null
  totalSupply: bigint | null
  owner: Address | null
  paused: boolean | null
  eip1967Implementation: Address | null
  eip1967Admin: Address | null
  /** Names of fields that could not be read, with no raw RPC error text. */
  unreadable: string[]
}

export interface ChainReader {
  getChainId(): Promise<number>
  getCodeSize(address: Address): Promise<number>
  readSettings(contract: Address): Promise<ContractSettings>
  getRequest(contract: Address, requestId: Hex): Promise<OnchainRequest>
  /** Latest block timestamp in seconds. */
  getChainTime(): Promise<number>
  /** Returns the RequestSettled log of a specific successful transaction, or null. */
  getSettledLog(contract: Address, requestId: Hex, txHash: Hex): Promise<SettledLog | null>
  inspectToken(token: Address): Promise<TokenInspection>
}

export type TxState = 'success' | 'reverted' | 'pending'

export interface PreparedSettlement {
  txHash: Hex
  raw: Hex
}

export interface Settler {
  readonly address: Address
  prepareSettle(contract: Address, requestId: Hex, reportHash: Hex): Promise<PreparedSettlement>
  broadcast(raw: Hex): Promise<Hex>
  getTxState(txHash: Hex): Promise<TxState>
}

/** Arc enforces a 20 gwei maxFeePerGas floor; transactions below it are silently dropped. */
export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n

const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const EIP1967_ADMIN_SLOT: Hex = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103'

const erc20ReadAbi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const

/** Selectors looked for in bytecode. Presence means "a function with this selector may exist", nothing more. */
export const INDICATOR_SELECTORS: Record<string, string> = {
  'mint(address,uint256)': '40c10f19',
  'pause()': '8456cb59',
  'blacklist(address)': 'f9f92be4',
  'isBlacklisted(address)': 'fe575a87',
  'upgradeTo(address)': '3659cfe6',
}

function slotToAddress(slot: Hex | undefined): Address | null {
  if (!slot) return null
  const hex = slot.slice(2).padStart(64, '0')
  const addr = `0x${hex.slice(24)}`
  return /^0x0{40}$/.test(addr) ? null : getAddress(addr)
}

export function createViemChainReader(rpcUrl: string): ChainReader {
  const client: PublicClient = createPublicClient({ chain: arc, transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }) })

  return {
    getChainId: () => client.getChainId(),

    async getCodeSize(address) {
      const code = await client.getCode({ address })
      return code && code !== '0x' ? (code.length - 2) / 2 : 0
    },

    async readSettings(contract) {
      const read = <T>(functionName: 'USDC' | 'PRICE' | 'REFUND_DELAY' | 'TREASURY' | 'operator' | 'paused') =>
        client.readContract({ address: contract, abi: payPerCallAbi, functionName }) as Promise<T>
      const [usdc, price, refundDelay, treasury, operator, paused] = await Promise.all([
        read<Address>('USDC'),
        read<bigint>('PRICE'),
        read<bigint>('REFUND_DELAY'),
        read<Address>('TREASURY'),
        read<Address>('operator'),
        read<boolean>('paused'),
      ])
      return {
        usdc: getAddress(usdc),
        price,
        refundDelay: Number(refundDelay),
        treasury: getAddress(treasury),
        operator: getAddress(operator),
        paused,
      }
    },

    async getRequest(contract, requestId) {
      const [payer, createdAt, refundableAt, status, paramsHash] = await client.readContract({
        address: contract,
        abi: payPerCallAbi,
        functionName: 'requests',
        args: [requestId],
      })
      return {
        payer: getAddress(payer),
        createdAt: Number(createdAt),
        refundableAt: Number(refundableAt),
        status: status as OnchainStatus,
        paramsHash,
      }
    },

    async getChainTime() {
      const block = await client.getBlock({ blockTag: 'latest' })
      return Number(block.timestamp)
    },

    async getSettledLog(contract, requestId, txHash) {
      let receipt
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash })
      } catch {
        return null
      }
      if (receipt.status !== 'success') return null
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== contract.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({ abi: payPerCallAbi, data: log.data, topics: log.topics })
          if (decoded.eventName !== 'RequestSettled') continue
          if (decoded.args.requestId.toLowerCase() !== requestId.toLowerCase()) continue
          return {
            requestId: decoded.args.requestId,
            payer: getAddress(decoded.args.payer),
            reportHash: decoded.args.reportHash,
            settledAt: Number(decoded.args.settledAt),
            txHash,
          }
        } catch {
          continue
        }
      }
      return null
    },

    async inspectToken(token) {
      const block = await client.getBlock({ blockTag: 'latest' })
      const blockNumber = block.number
      const unreadable: string[] = []
      const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn()
        } catch {
          unreadable.push(label)
          return null
        }
      }
      const code = await client.getCode({ address: token, blockNumber })
      const bytecode = code && code !== '0x' ? code.toLowerCase() : ''
      const selectors: Record<string, boolean> = {}
      for (const [signature, selector] of Object.entries(INDICATOR_SELECTORS)) {
        selectors[signature] = bytecode.includes(selector)
      }
      const readErc20 = <T>(functionName: (typeof erc20ReadAbi)[number]['name']) =>
        client.readContract({ address: token, abi: erc20ReadAbi, functionName, blockNumber }) as Promise<T>
      const [name, symbol, decimals, totalSupply, owner, paused, impl, admin] = await Promise.all([
        attempt('name', () => readErc20<string>('name')),
        attempt('symbol', () => readErc20<string>('symbol')),
        attempt('decimals', () => readErc20<number>('decimals')),
        attempt('totalSupply', () => readErc20<bigint>('totalSupply')),
        attempt('owner', () => readErc20<Address>('owner')),
        attempt('paused', () => readErc20<boolean>('paused')),
        attempt('eip1967Implementation', () =>
          client.getStorageAt({ address: token, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber }),
        ),
        attempt('eip1967Admin', () => client.getStorageAt({ address: token, slot: EIP1967_ADMIN_SLOT, blockNumber })),
      ])
      return {
        blockNumber,
        blockTimestamp: block.timestamp,
        codeSize: bytecode ? (bytecode.length - 2) / 2 : 0,
        selectors,
        name,
        symbol,
        decimals: decimals === null ? null : Number(decimals),
        totalSupply,
        owner: owner ? getAddress(owner) : null,
        paused,
        eip1967Implementation: slotToAddress(impl ?? undefined),
        eip1967Admin: slotToAddress(admin ?? undefined),
        unreadable,
      }
    },
  }
}

/**
 * Operator-side settlement. The signed transaction hash is computed before broadcast so it can be
 * persisted first; a crash or retry then re-broadcasts the identical transaction, never a second one.
 * Not exercised against a live network in Phase 3: the test suite uses a fake Settler.
 */
export function createViemSettler(rpcUrl: string, privateKey: Hex): Settler {
  const account = privateKeyToAccount(privateKey)
  const transport = http(rpcUrl, { timeout: 15_000, retryCount: 2 })
  const publicClient: PublicClient = createPublicClient({ chain: arc, transport })
  const wallet = createWalletClient({ account, chain: arc, transport })

  return {
    address: account.address,

    async prepareSettle(contract, requestId, reportHash) {
      const data = encodeFunctionData({ abi: payPerCallAbi, functionName: 'settle', args: [requestId, reportHash] })
      const [nonce, fees, gasEstimate] = await Promise.all([
        publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        publicClient.estimateFeesPerGas(),
        publicClient.estimateGas({ account: account.address, to: contract, data }),
      ])
      const maxFeePerGas = fees.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? fees.maxFeePerGas : MIN_MAX_FEE_PER_GAS
      const priority = fees.maxPriorityFeePerGas ?? 0n
      const raw = await wallet.signTransaction({
        account,
        chain: arc,
        to: contract,
        data,
        nonce,
        gas: (gasEstimate * 12n) / 10n,
        maxFeePerGas,
        maxPriorityFeePerGas: priority > maxFeePerGas ? maxFeePerGas : priority,
        type: 'eip1559',
      })
      return { txHash: keccak256(raw), raw }
    },

    broadcast: (raw) => publicClient.sendRawTransaction({ serializedTransaction: raw }),

    async getTxState(txHash) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
        return receipt.status === 'success' ? 'success' : 'reverted'
      } catch {
        return 'pending'
      }
    },
  }
}
