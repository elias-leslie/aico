// A local CLI carries stdin/stdout/stderr and exit status through an exec channel.
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

export function execArgv(socket: string, argv: string[], env = process.env): string[] {
  return [
    env.TETHER_BIN || join(env.HOME || homedir(), '.local/lib/tether/bin/tether'),
    'fleet',
    'exec',
    socket,
    '--',
    ...argv,
  ]
}

function packet(fd: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header[0] = fd
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}

/** Commands run as this machine's Aico user, with the same authority as its pinned peers. */
export function serveExec(channel: Duplex, argv: string[]): void {
  const [command, ...args] = argv
  if (!command) {
    channel.destroy(new Error('Empty command'))
    return
  }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  channel.pipe(child.stdin)
  child.stdin.on('error', () => {})
  const send = (fd: number, data: Buffer) => {
    if (!channel.write(packet(fd, data))) {
      child.stdout.pause()
      child.stderr.pause()
      channel.once('drain', () => {
        child.stdout.resume()
        child.stderr.resume()
      })
    }
  }
  child.stdout.on('data', (data: Buffer) => send(1, data))
  child.stderr.on('data', (data: Buffer) => send(2, data))
  child.once('error', (error) => send(2, Buffer.from(error.message)))
  child.once('close', (code) => channel.end(packet(3, Buffer.from(String(code ?? 1)))))
  // A broken view does not kill work. stdin closes; the command owns its lifetime.
  channel.once('close', () => child.stdin.end())
}

export async function runExec(socketPath: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let buffer: Buffer = Buffer.alloc(0)
    let code = 255
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(argv)}\n`)
      process.stdin.pipe(socket)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5) {
        const size = buffer.readUInt32BE(1)
        if (size > 1024 * 1024) {
          socket.destroy(new Error('Invalid fleet exec packet'))
          return
        }
        if (buffer.length < size + 5) break
        const fd = buffer[0]
        const data = buffer.subarray(5, size + 5)
        if (fd === 1) process.stdout.write(data)
        else if (fd === 2) process.stderr.write(data)
        else if (fd === 3) code = Number(data.toString())
        buffer = buffer.subarray(size + 5)
      }
    })
    socket.on('error', (error) => console.error(`Fleet command: ${error.message}`))
    socket.once('close', () => {
      process.stdin.unpipe(socket)
      process.stdin.pause()
      resolve(code)
    })
  })
}
