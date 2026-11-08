import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { requestExec } from './exec'

const frame = (fd: number, text: string) => {
  const data = Buffer.from(text)
  const head = Buffer.alloc(5)
  head[0] = fd
  head.writeUInt32BE(data.length, 1)
  return Buffer.concat([head, data])
}

it('keeps a whole JSON list a command prints, not only its last 4096 characters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-stdout-'))
  const socketPath = join(dir, 'exec.sock')
  // Ten phones at about 961 bytes each, sent in several frames like a real channel.
  const phones = Array.from({ length: 10 }, (_, i) => ({ id: `phone-${i}`, pad: 'x'.repeat(940) }))
  const json = `${JSON.stringify(phones)}\n`
  const server = createServer((socket) => {
    socket.on('data', () => {})
    socket.once('end', () => {
      for (let at = 0; at < json.length; at += 3000)
        socket.write(frame(1, json.slice(at, at + 3000)))
      socket.write(frame(3, '0'))
      socket.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    const result = await requestExec(socketPath, ['x'], Buffer.alloc(0))
    expect(json.length).toBeGreaterThan(9000)
    expect(result).toMatchObject({ code: 0, ended: true })
    expect(JSON.parse(result.stdout.trim())).toEqual(phones)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
