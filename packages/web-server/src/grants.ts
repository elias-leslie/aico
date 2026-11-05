// One JSON line to root. The web API reads metadata and revokes access; approval stays in the FIDO tray.
import { createConnection } from 'node:net'
import { objectBody, type Router, requiredString } from './http'
import { HttpError } from './tether'

export interface GrantRequest {
  id: string
  grant: string
  title: string
  reason: string
  agent: string
  state: string
  created: number
  expires: number
}
interface GrantView {
  public_url: string
  requests: GrantRequest[]
  grants: { id: string; kind: string; expires: number }[]
  uses: { at: number; event: string; id: string; kind: string; uid: number }[]
  labels: Record<string, string>
}
export type GrantCall = (msg: Record<string, unknown>) => Promise<unknown>
const grantCall: GrantCall = (msg) =>
  new Promise((resolve, reject) => {
    const socket = createConnection(
      process.env.AICO_GRANTS_SOCKET || '/run/host-steward/grants.sock',
    )
    let buffer = ''
    const failed = () =>
      reject(new HttpError(503, 'Grants are unavailable on this machine. Try again.'))
    socket.setTimeout(10_000, () => socket.destroy(new Error('timeout')))
    socket.on('error', failed)
    socket.on('connect', () => socket.write(`${JSON.stringify(msg)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.length > 1 << 20) socket.destroy(new Error('too large'))
      if (!buffer.includes('\n')) return
      socket.end()
      try {
        const result = JSON.parse(buffer.split('\n')[0] ?? '')
        if (result.error) reject(new HttpError(409, String(result.error)))
        else resolve(result)
      } catch {
        failed()
      }
    })
    socket.on('end', () => {
      if (!buffer.includes('\n')) failed()
    })
  })

export async function pendingGrants(
  run: GrantCall = grantCall,
): Promise<{ id: string; title: string; url: string; expiresInS: number }[] | null> {
  try {
    const result = (await run({ op: 'list' })) as GrantView
    return result.requests
      .filter((r) => r.state === 'pending')
      .map((r) => ({
        id: r.id,
        title: r.title,
        url: `${result.public_url}?request=${r.id}`,
        expiresInS: Math.max(0, Math.ceil(r.expires - Date.now() / 1000)),
      }))
  } catch {
    return null
  }
}

export function registerGrantRoutes(router: Router, run: GrantCall = grantCall): void {
  router.on('GET', '/api/grants', () => run({ op: 'list' }))
  router.on('POST', '/api/grants/revoke', async (ctx) => {
    const body = objectBody(await ctx.body())
    const id = requiredString(body, 'id', { pattern: /^[a-f0-9]{32}$/ })
    return run({ op: 'revoke', id })
  })
}
