// `aico plug`: the Kasa smart plug that feeds the machines (a TP-Link EP40, two sockets), over its
// local protocol: TCP, JSON, XOR "autokey" cipher (start key 171), a 4-byte big-endian length in
// front. No cloud and no login. The address and which socket powers which machine are data/ops.json
// (`plug`); sockets are counted from 0. Both hosts can reach the plug, so either can switch the
// other's power during a power-off test, but a host never switches off its own socket by accident.

import { connect } from 'node:net'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'

export interface PlugConfig {
  address: string
  port: number
  timeoutSeconds: number
  cycleSeconds: number
  sockets: { machine: string; hostnames: string[] }[]
}

const KEY = 171

export function encode(value: unknown): Buffer {
  const text = Buffer.from(JSON.stringify(value))
  const out = Buffer.alloc(4 + text.length)
  out.writeUInt32BE(text.length)
  let key = KEY
  text.forEach((byte, i) => {
    key ^= byte
    out[4 + i] = key
  })
  return out
}

/** The JSON inside one cipher body (the bytes after the length prefix). */
export function decode(body: Buffer): unknown {
  let key = KEY
  const plain = Buffer.alloc(body.length)
  body.forEach((byte, i) => {
    plain[i] = key ^ byte
    key = byte
  })
  return JSON.parse(plain.toString())
}

/** One request, one reply. Anything that goes wrong on the wire reads as "didn't answer". */
export type PlugSend = (request: unknown) => Promise<unknown>

export class PlugSilent extends Refusal {
  constructor(address: string) {
    super(`The power plug at ${address} didn't answer`)
  }
}

export function socketSend(cfg: PlugConfig): PlugSend {
  return (request) =>
    new Promise((accept, reject) => {
      const silent = () => reject(new PlugSilent(cfg.address))
      const socket = connect({ host: cfg.address, port: cfg.port })
      socket.setTimeout(cfg.timeoutSeconds * 1000)
      const chunks: Buffer[] = []
      let have = 0
      socket.on('connect', () => socket.write(encode(request)))
      socket.on('data', (chunk) => {
        chunks.push(chunk)
        have += chunk.length
        const all = Buffer.concat(chunks)
        if (have < 4 || have < 4 + all.readUInt32BE(0)) return
        socket.destroy()
        try {
          accept(decode(all.subarray(4, 4 + all.readUInt32BE(0))))
        } catch {
          reject(new Refusal(`The power plug at ${cfg.address} sent a reply Aico cannot read`))
        }
      })
      socket.on('timeout', () => {
        socket.destroy()
        silent()
      })
      socket.on('error', () => {
        socket.destroy()
        silent()
      })
      socket.on('close', silent)
    })
}

export interface Socket {
  index: number
  /** The plug's own id for the socket. */
  id: string
  machine: string
  on: boolean
  /** Seconds it has been on; null when it is off or the plug did not say. */
  onSeconds: number | null
}

/** The plug's sockets from a get_sysinfo reply, named by the configured machines. */
export function parseStatus(reply: unknown, cfg: PlugConfig): { model: string; sockets: Socket[] } {
  const info = (reply as { system?: { get_sysinfo?: Record<string, unknown> } })?.system
    ?.get_sysinfo
  const children = info?.children
  if (!info || !Array.isArray(children))
    throw new Refusal(`The power plug at ${cfg.address} sent a reply Aico cannot read`)
  return {
    model: String(info.model ?? 'plug'),
    sockets: children.map((child: Record<string, unknown>, index) => ({
      index,
      id: String(child.id ?? ''),
      machine: cfg.sockets[index]?.machine ?? `socket ${index}`,
      on: child.state === 1,
      onSeconds: child.state === 1 && typeof child.on_time === 'number' ? child.on_time : null,
    })),
  }
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** The configured socket index this computer's hostname is wired to, or null. */
export function ownSocket(cfg: PlugConfig, host: string): number | null {
  const name = host.toLowerCase().split('.')[0]
  const index = cfg.sockets.findIndex((s) => s.hostnames.some((h) => h.toLowerCase() === name))
  return index < 0 ? null : index
}

export interface PlugDeps {
  cfg: PlugConfig
  send: PlugSend
  /** This computer's hostname. */
  host: string
  sleep: (seconds: number) => Promise<void>
  out: (line: string) => void
}

export function plugDeps(out: (line: string) => void, cfg: PlugConfig = ops.plug): PlugDeps {
  return {
    cfg,
    send: socketSend(cfg),
    host: hostname(),
    sleep: (seconds) => delay(seconds * 1000),
    out,
  }
}

const read = async (deps: PlugDeps) =>
  parseStatus(await deps.send({ system: { get_sysinfo: {} } }), deps.cfg)

function pick(sockets: Socket[], what: string | undefined): Socket {
  if (!what) throw new Refusal('aico plug needs a machine or a socket number', 2)
  const found = /^\d+$/.test(what)
    ? sockets[Number(what)]
    : sockets.find((s) => s.machine.toLowerCase() === what.toLowerCase())
  if (!found) {
    const names = sockets.map((s) => `${s.index} (${s.machine})`).join(', ')
    throw new Refusal(`The plug has no socket for "${what}"; it has ${names}`, 2)
  }
  return found
}

async function set(deps: PlugDeps, socket: Socket, on: boolean) {
  if (!socket.id)
    throw new Refusal(`The power plug at ${deps.cfg.address} has no socket ${socket.index}`)
  const reply = (await deps.send({
    context: { child_ids: [socket.id] },
    system: { set_relay_state: { state: on ? 1 : 0 } },
  })) as { system?: { set_relay_state?: { err_code?: number } } }
  const code = reply.system?.set_relay_state?.err_code
  if (code !== 0)
    throw new Refusal(
      `The power plug at ${deps.cfg.address} refused to switch ${socket.machine} ${on ? 'on' : 'off'} (error ${code ?? 'none'})`,
    )
}

const line = (s: Socket, own: number | null, widest: number) =>
  `  ${s.index}  ${s.machine.padEnd(widest)}  ${s.on ? 'on ' : 'off'}  ${
    s.on ? (s.onSeconds === null ? 'for ?' : `for ${duration(s.onSeconds)}`) : ''
  }${s.index === own ? '  (this computer)' : ''}`.trimEnd()

async function show(deps: PlugDeps, json: boolean) {
  const { model, sockets } = await read(deps)
  const own = ownSocket(deps.cfg, deps.host)
  if (json) {
    deps.out(JSON.stringify({ address: deps.cfg.address, model, own, sockets }))
    return
  }
  const widest = Math.max(...sockets.map((s) => s.machine.length))
  deps.out(`Power plug at ${deps.cfg.address} (${model})`)
  for (const s of sockets) deps.out(line(s, own, widest))
  if (own === null)
    deps.out(`  This computer (${deps.host}) is not wired to a socket in the plug settings.`)
}

export async function plug(argv: string[], deps: PlugDeps): Promise<number> {
  const flags = new Set(['--force', '--json'])
  let wait = deps.cfg.cycleSeconds
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--wait') {
      wait = Number(argv[++i])
      if (!(wait >= 0)) throw new Refusal('--wait needs a number of seconds', 2)
    } else if (arg.startsWith('--') && !flags.has(arg)) {
      throw new Refusal(`unknown option ${arg}; aico plug --help shows how`, 2)
    } else words.push(arg)
  }
  const force = argv.includes('--force')
  const json = argv.includes('--json')
  const plain = words.filter((w) => !flags.has(w))
  const [verb, target, ...extra] = plain
  if (!verb || verb === 'status') {
    if (target || extra.length) throw new Refusal('aico plug status takes no arguments', 2)
    await show(deps, json)
    return 0
  }
  if (verb !== 'on' && verb !== 'off' && verb !== 'cycle')
    throw new Refusal(`unknown command ${verb}; aico plug --help shows how`, 2)
  if (extra.length) throw new Refusal(`unexpected ${extra[0]}`, 2)
  const { sockets } = await read(deps)
  const socket = pick(sockets, target)
  if (verb !== 'on' && !force && ownSocket(deps.cfg, deps.host) === socket.index)
    throw new Refusal(
      `${socket.machine} is this computer, and socket ${socket.index} is what powers it. ` +
        `Switching it off would cut this computer's own power. Run it from the other machine, or add --force.`,
    )
  if (verb !== 'cycle') {
    await set(deps, socket, verb === 'on')
    deps.out(`${socket.machine} (socket ${socket.index}) is ${verb}`)
    return 0
  }
  await set(deps, socket, false)
  deps.out(`${socket.machine} (socket ${socket.index}) is off; back on in ${wait} s`)
  await deps.sleep(wait)
  await set(deps, socket, true)
  deps.out(`${socket.machine} (socket ${socket.index}) is on`)
  return 0
}
