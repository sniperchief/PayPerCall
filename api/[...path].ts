/**
 * Vercel Function entry. All /api/* requests are handled by the shared router in server/http.ts.
 * Configuration comes from environment variables; see .env.example.
 */
import { getDefaultContextProvider } from '../server/context'
import { createHandler } from '../server/http'

const handle = createHandler(getDefaultContextProvider())

export const GET = (request: Request) => handle(request)
export const POST = (request: Request) => handle(request)
