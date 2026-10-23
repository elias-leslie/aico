import { request } from 'node:http'

export interface ClientResponse {
  status: number
  body: unknown
}

/** One JSON request to a Tether control socket. */
export function callSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 5_000,
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath,
        method,
        path,
        timeout: timeoutMs,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => parts.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            // Non-JSON bodies are returned as text.
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}
