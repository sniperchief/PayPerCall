import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, createReportGenerator, hashReport, type Report } from './report'
import { Clock, FakeChain, TOKEN, fill, tokenInspection } from './testing'

async function generate(overrides: Parameters<typeof tokenInspection>[0] = {}): Promise<Report> {
  const clock = new Clock()
  const chain = new FakeChain(clock)
  chain.inspection = tokenInspection(overrides)
  return createReportGenerator(chain, () => new Date(clock.ms)).generate({
    requestId: `0x${'aa'.repeat(32)}`,
    chainId: 5042,
    token: TOKEN,
    tradeSizeMicroUsd: 2_500_000_000n,
  })
}

test('every finding cites evidence that exists in its section', async () => {
  const report = await generate({ owner: fill('99'), eip1967Implementation: fill('98'), paused: false })
  for (const section of report.sections) {
    const ids = new Set(section.evidence.map((e) => e.id))
    for (const finding of section.findings) {
      assert.ok(finding.evidenceRefs.length > 0, `${finding.id} has no evidence`)
      for (const ref of finding.evidenceRefs) assert.ok(ids.has(ref), `${finding.id} cites missing ${ref}`)
    }
  }
})

test('sections without a data source are unavailable and say so, never invented', async () => {
  const report = await generate()
  const byId = Object.fromEntries(report.sections.map((s) => [s.id, s]))
  for (const id of ['wallet', 'liquidity']) {
    assert.equal(byId[id].status, 'unavailable')
    assert.equal(byId[id].findings.length, 0)
    assert.ok(byId[id].limitations[0].includes('not implemented'))
  }
  assert.ok(report.notEstablished.length > 0)
})

test('an address with no contract code is reported as such', async () => {
  const report = await generate({ codeSize: 0 })
  const token = report.sections[0]
  assert.equal(token.findings[0].id, 'no-contract-code')
  assert.equal(token.findings[0].severity, 'high')
})

test('unreadable fields make the section partial and are listed as limitations', async () => {
  const report = await generate({ name: null, symbol: null, unreadable: ['name', 'symbol'] })
  assert.equal(report.sections[0].status, 'partial')
  assert.ok(report.sections[0].limitations.some((l) => l.includes('name, symbol')))
})

test('proxy and privilege indicators are reported with evidence', async () => {
  const report = await generate({ eip1967Implementation: fill('98'), eip1967Admin: fill('97'), paused: true })
  const ids = report.sections[0].findings.map((f) => f.id)
  for (const id of ['upgradeable-proxy', 'proxy-admin', 'paused', 'privileged-selectors']) assert.ok(ids.includes(id), id)
})

test('canonical JSON is key-order independent so the report hash is stable', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(hashReport(canonicalJson({ a: 1 })), hashReport('{"a":1}'))
})
