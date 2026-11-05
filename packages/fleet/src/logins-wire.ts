// A bounded JSON exchange on the dedicated Logins channel; no command execution or argv.
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { LoginError, loginPolicy } from './logins'

export function requestLoginWire(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true })
    const chunks: Buffer[] = []
    let size = 0,
      ended = false
    socket.once('connect', () => socket.end(payload))
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > loginPolicy.maxRpcBytes) {
        reject(new LoginError('Login response is too large'))
        socket.destroy()
        return
      }
      chunks.push(chunk)
    })
    socket.once('end', () => {
      ended = true
      if (size) resolve(Buffer.concat(chunks).toString())
      else reject(new LoginError('The Logins link closed without an answer'))
      socket.destroy()
    })
    socket.once('error', () => reject(new LoginError('The Logins link is unavailable')))
    socket.once('close', () => {
      if (!ended) reject(new LoginError('The Logins link closed before its answer'))
    })
  })
}
export function serveLoginWire(channel: Duplex, handle: (input: string) => Promise<string>): void {
  const chunks: Buffer[] = []
  let size = 0
  channel.on('error', () => {})
  channel.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > loginPolicy.maxRpcBytes) {
      channel.destroy()
      return
    }
    chunks.push(chunk)
  })
  channel.once('end', () => {
    void handle(Buffer.concat(chunks).toString())
      .then((answer) => {
        if (Buffer.byteLength(answer) > loginPolicy.maxRpcBytes)
          channel.end(JSON.stringify({ ok: false, error: 'Login response is too large' }))
        else channel.end(answer)
      })
      .catch(() =>
        channel.end(
          JSON.stringify({ ok: false, error: 'Logins could not complete the operation' }),
        ),
      )
  })
}
