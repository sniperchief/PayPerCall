import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { payPerCallAbi } from './abi'
import {
  PRICE_RAW,
  PRODUCTION_CHAIN_ID,
  computeParamsHash,
  computeRequestId,
  formatTradeSizeUsd,
  parseAddress,
  parseTradeSizeUsd,
  productionFacts,
} from './protocol'

interface JsonAbiParam {
  type: string
  indexed?: boolean
}
interface JsonAbiItem {
  type: string
  name?: string
  inputs?: JsonAbiParam[]
  outputs?: JsonAbiParam[]
}

test('production facts match the verified Arc mainnet values', () => {
  // Verified against docs.arc.io (connect-to-arc, contract-addresses) and the live RPC (eth_chainId 0x13b2, USDC decimals 6).
  const facts = productionFacts()
  assert.equal(PRODUCTION_CHAIN_ID, 5042)
  assert.equal(facts.chainId, 5042)
  assert.equal(facts.rpcUrl, 'https://rpc.mainnet.arc.io')
  assert.equal(facts.explorerBase, 'https://explorer.arc.io')
  assert.equal(facts.usdc, '0x3600000000000000000000000000000000000000')
  assert.equal(facts.usdcDecimals, 6)
  assert.equal(PRICE_RAW, 100_000n)
})

test('request ID and params hash match independent cast keccak/abi-encode vectors', () => {
  const token = '0x3600000000000000000000000000000000000000'
  const contract = '0x1111111111111111111111111111111111111111'
  const payer = '0x2222222222222222222222222222222222222222'
  const nonce = '0x0101010101010101010101010101010101010101010101010101010101010101'
  const paramsHash = computeParamsHash(token, 5_000_000_000n)
  assert.equal(paramsHash, '0xf5d22d72a68d1e87c265f475737d3320f7b86a5a303521301afbc1b3d4d2c3b8')
  assert.equal(computeRequestId(contract, payer, nonce, paramsHash), '0x55f285cd80fbea6b7ebc26365283412d326b4c76c4be7e03d1ae55b00736d930')
})

test('request ID binds the payer, contract and chain', () => {
  const nonce = `0x${'07'.repeat(32)}` as const
  const ph = `0x${'09'.repeat(32)}` as const
  const a = computeRequestId('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', nonce, ph)
  assert.notEqual(a, computeRequestId('0x1111111111111111111111111111111111111111', '0x3333333333333333333333333333333333333333', nonce, ph))
  assert.notEqual(a, computeRequestId('0x4444444444444444444444444444444444444444', '0x2222222222222222222222222222222222222222', nonce, ph))
  assert.notEqual(a, computeRequestId('0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', nonce, ph, 5042002))
})

test('trade size parsing accepts only bounded USD amounts with at most two decimals', () => {
  assert.equal(parseTradeSizeUsd('5000'), 5_000_000_000n)
  assert.equal(parseTradeSizeUsd('1.5'), 1_500_000n)
  assert.equal(parseTradeSizeUsd('1234.56'), 1_234_560_000n)
  assert.equal(formatTradeSizeUsd(1_234_560_000n), '1234.56')
  for (const bad of ['', '0', '0.99', '10000000.01', '1.234', '-5', '1e3', '0x10', ' ', 'abc', 5, null, undefined]) {
    assert.equal(parseTradeSizeUsd(bad), null, `should reject ${String(bad)}`)
  }
  assert.equal(parseTradeSizeUsd('10000000'), 10_000_000_000_000n)
})

test('address parsing checksums valid addresses and rejects everything else', () => {
  assert.equal(parseAddress('0x3600000000000000000000000000000000000000'), '0x3600000000000000000000000000000000000000')
  assert.equal(parseAddress('0x123'), null)
  assert.equal(parseAddress(undefined), null)
})

test('typed ABI fragments exist unchanged in the reviewed docs/PayPerCall.abi.json', () => {
  const json = JSON.parse(readFileSync(new URL('../docs/PayPerCall.abi.json', import.meta.url), 'utf8')) as JsonAbiItem[]
  const types = (params: JsonAbiParam[] | undefined, withIndexed: boolean) =>
    (params ?? []).map((p) => (withIndexed ? `${p.type}${p.indexed ? ' indexed' : ''}` : p.type))
  for (const item of payPerCallAbi as unknown as readonly JsonAbiItem[]) {
    const match = json.find((candidate) => candidate.type === item.type && candidate.name === item.name)
    assert.ok(match, `${item.type} ${item.name ?? ''} is missing from docs/PayPerCall.abi.json`)
    const isEvent = item.type === 'event'
    assert.deepEqual(types(item.inputs, isEvent), types(match.inputs, isEvent), `inputs differ for ${item.name ?? ''}`)
    if (item.type === 'function') assert.deepEqual(types(item.outputs, false), types(match.outputs, false), `outputs differ for ${item.name ?? ''}`)
  }
})
