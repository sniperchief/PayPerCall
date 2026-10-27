import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const ENTRY = 'api/[...path].ts'

/** Relative specifiers of a TypeScript file's static imports and re-exports. */
function relativeSpecifiers(file: string): string[] {
  const source = readFileSync(join(root, file), 'utf8')
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'(\.{1,2}\/[^']+)'/gm)].map((match) => match[1])
}

test('every relative import reachable from the Vercel function names its .js file', () => {
  // Vercel transpiles each file to ESM without bundling, so Node resolves specifiers literally at runtime:
  // an extensionless one fails with ERR_MODULE_NOT_FOUND before any request is handled.
  const seen = new Set<string>()
  const queue = [ENTRY]
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of relativeSpecifiers(file)) {
      assert.ok(specifier.endsWith('.js'), `${file} imports '${specifier}' without a .js extension`)
      const target = relative(root, join(root, dirname(file), specifier.replace(/\.js$/, '.ts'))).replace(/\\/g, '/')
      assert.ok(existsSync(join(root, target)), `${file} imports '${specifier}', but ${target} does not exist`)
      queue.push(target)
    }
  }
  assert.ok(seen.has('server/http.ts') && seen.has('shared/protocol.ts') && seen.has('src/onchain-facts.ts'))
})

test('vercel.json sends every /api path, at any depth, to the catch-all function', () => {
  // Without a rewrite, Vercel routes a catch-all file outside Next.js for one path segment only, so
  // /api/v1/health and the cron path /api/v1/cron/process would return 404.
  const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
    rewrites?: { source: string; destination: string }[]
    crons?: { path: string }[]
  }
  assert.ok(existsSync(join(root, ENTRY)))
  assert.ok(config.rewrites?.some((r) => r.source === '/api/:path*' && r.destination === '/api/[...path]'))
  assert.ok(config.crons?.every((cron) => cron.path.startsWith('/api/v1/')))
})

test('vercel.json crons run at most once a day, the limit of the Vercel Hobby plan', () => {
  // Hobby rejects a deployment whose cron runs more often than daily. Faster processing for requests nobody
  // polls comes from an external scheduler calling the same endpoint with the CRON_SECRET bearer.
  const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { crons?: { schedule: string }[] }
  assert.ok(config.crons && config.crons.length > 0)
  for (const { schedule } of config.crons) {
    const [minute, hour] = schedule.split(/\s+/)
    assert.ok(/^\d+$/.test(minute) && /^\d+$/.test(hour), `cron '${schedule}' runs more than once a day`)
  }
})
