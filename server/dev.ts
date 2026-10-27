/**
 * Local API server for development. Serves the same router as the Vercel function on port 3001; Vite proxies /api to it.
 * Run with: bun run dev:api   (set PPC_ALLOW_MEMORY_STORE=1 in .env to use the in-memory store locally)
 */
import { createServer } from 'node:http'
import { getDefaultContextProvider } from './context'
import { createHandler } from './http'

const handle = createHandler(getDefaultContextProvider())
const port = Number(process.env.PPC_API_PORT ?? 3001)

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (chunk: Buffer) => chunks.push(chunk))
  req.on('end', () => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(key, value)
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(`http://localhost:${port.toString()}${req.url ?? '/'}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    })
    void handle(request).then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
  })
})

server.listen(port, () => {
  console.log(`PayPerCall API listening on http://localhost:${port.toString()}/api/v1`)
})
