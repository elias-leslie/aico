// `aico plug`: the Kasa smart plugs that feed the machines (TP-Link EP40s, two sockets each), over
// their local protocol: TCP, JSON, XOR "autokey" cipher (start key 171), a 4-byte big-endian length
// in front. No cloud and no login. Each plug's address and which socket powers which machine are
// data/ops.json (`plug`); sockets are counted from 0. Either host can switch the other's power
// during a power-off test, but a host never switches off its own socket by accident.

import { connect } from 'node:net'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'

export interface PlugDef {
  name: string
  address: string
  port: number
  /** Index = socket number; machine null is an empty socket. */
  sockets: { machine: string | null; hostnames?: string[] }[]
}

export interface PlugConfig {
  timeoutSeconds: number
  cycleSeconds: number
  plugs: PlugDef[]
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

export function socketSend(plug: PlugDef, timeoutSeconds: number): PlugSend {
  return (request) =>
    new Promise((accept, reject) => {
      const silent = () => reject(new PlugSilent(plug.address))
      const socket = connect({ host: plug.address, port: plug.port })
      socket.setTimeout(timeoutSeconds * 1000)
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
          reject(new Refusal(`The power plug at ${plug.address} sent a reply Aico cannot read`))
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
  plug: string
  index: number
  /** The plug's own id for the socket. */
  id: string
  /** The machine it powers; null for an empty socket. */
  machine: string | null
  on: boolean
  /** Seconds it has been on; null when it is off or the plug did not say. */
  onSeconds: number | null
}

/** One plug's sockets from a get_sysinfo reply, named by the configured machines. */
export function parseStatus(reply: unknown, plug: PlugDef): { model: string; sockets: Socket[] } {
  const info = (reply as { system?: { get_sysinfo?: Record<string, unknown> } })?.system
    ?.get_sysinfo
  const children = info?.children
  if (!info || !Array.isArray(children))
    throw new Refusal(`The power plug at ${plug.address} sent a reply Aico cannot read`)
  return {
    model: String(info.model ?? 'plug'),
    sockets: children.map((child: Record<string, unknown>, index) => ({
      plug: plug.name,
      index,
      id: String(child.id ?? ''),
      machine: plug.sockets[index]?.machine ?? null,
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

export interface Where {
  plug: string
  index: number
}

/** The plug and socket this computer's hostname is wired to, or null. */
export function ownSocket(cfg: PlugConfig, host: string): Where | null {
  const name = host.toLowerCase().split('.')[0]
  for (const plug of cfg.plugs) {
    const index = plug.sockets.findIndex((s) => s.hostnames?.some((h) => h.toLowerCase() === name))
    if (index >= 0) return { plug: plug.name, index }
  }
  return null
}

export interface PlugDeps {
  cfg: PlugConfig
  send: (plug: PlugDef, request: unknown) => Promise<unknown>
  /** This computer's hostname. */
  host: string
  sleep: (seconds: number) => Promise<void>
  out: (line: string) => void
}

export function plugDeps(out: (line: string) => void, cfg: PlugConfig = ops.plug): PlugDeps {
  return {
    cfg,
    send: (plug, request) => socketSend(plug, cfg.timeoutSeconds)(request),
    host: hostname(),
    sleep: (seconds) => delay(seconds * 1000),
    out,
  }
}

const read = async (deps: PlugDeps, plug: PlugDef) =>
  parseStatus(await deps.send(plug, { system: { get_sysinfo: {} } }), plug)

const label = (plug: PlugDef) => `${plug.name[0]?.toUpperCase()}${plug.name.slice(1)} plug`

/** The configured socket a command word names: a machine, or PLUG:SOCKET for any (also an empty one). */
function find(cfg: PlugConfig, what: string | undefined): { plug: PlugDef; index: number } {
  if (!what) throw new Refusal('aico plug needs a machine, or PLUG:SOCKET', 2)
  const lower = what.toLowerCase()
  for (const plug of cfg.plugs) {
    const index = plug.sockets.findIndex((s) => s.machine?.toLowerCase() === lower)
    if (index >= 0) return { plug, index }
  }
  const [, plugName, number] = /^([^:]+):(\d+)$/.exec(lower) ?? []
  const plug = cfg.plugs.find((p) => p.name.toLowerCase() === plugName)
  if (plug && Number(number) < plug.sockets.length) return { plug, index: Number(number) }
  const known = cfg.plugs.flatMap((p) =>
    p.sockets.map((s, i) => (s.machine ? `${s.machine} (${p.name}:${i})` : `${p.name}:${i}`)),
  )
  throw new Refusal(`No socket for "${what}"; the sockets are ${known.join(', ')}`, 2)
}

async function set(deps: PlugDeps, socket: Socket, plug: PlugDef, on: boolean) {
  const name = socket.machine ?? `${plug.name}:${socket.index}`
  if (!socket.id)
    throw new Refusal(`The power plug at ${plug.address} has no socket ${socket.index}`)
  const reply = (await deps.send(plug, {
    context: { child_ids: [socket.id] },
    system: { set_relay_state: { state: on ? 1 : 0 } },
  })) as { system?: { set_relay_state?: { err_code?: number } } }
  const code = reply.system?.set_relay_state?.err_code
  if (code !== 0)
    throw new Refusal(
      `The power plug at ${plug.address} refused to switch ${name} ${on ? 'on' : 'off'} (error ${code ?? 'none'})`,
    )
}

const line = (s: Socket, own: Where | null, widest: number) =>
  `  ${s.index}  ${(s.machine ?? '(empty)').padEnd(widest)}  ${s.on ? 'on ' : 'off'}  ${
    s.on ? (s.onSeconds === null ? 'for ?' : `for ${duration(s.onSeconds)}`) : ''
  }${own && own.plug === s.plug && own.index === s.index ? '  (this computer)' : ''}`.trimEnd()

/** Every plug once; one that does not answer shows that and the others still show. */
async function show(deps: PlugDeps, json: boolean): Promise<number> {
  const own = ownSocket(deps.cfg, deps.host)
  const reads = await Promise.allSettled(deps.cfg.plugs.map((plug) => read(deps, plug)))
  const widest = Math.max(
    '(empty)'.length,
    ...deps.cfg.plugs.flatMap((p) => p.sockets.map((s) => s.machine?.length ?? 0)),
  )
  const failed = (reason: unknown) => (reason as Error).message
  if (json) {
    deps.out(
      JSON.stringify({
        own,
        plugs: deps.cfg.plugs.map((plug, i) => {
          const result = reads[i] as PromiseSettledResult<Awaited<ReturnType<typeof read>>>
          return result.status === 'fulfilled'
            ? { name: plug.name, address: plug.address, ...result.value }
            : { name: plug.name, address: plug.address, error: failed(result.reason) }
        }),
      }),
    )
  } else {
    for (const [i, plug] of deps.cfg.plugs.entries()) {
      const result = reads[i] as PromiseSettledResult<Awaited<ReturnType<typeof read>>>
      if (result.status === 'rejected') {
        deps.out(`${label(plug)} (${plug.address}): ${failed(result.reason)}`)
        continue
      }
      deps.out(`${label(plug)} (${plug.address}, ${result.value.model})`)
      for (const s of result.value.sockets) deps.out(line(s, own, widest))
    }
    if (own === null)
      deps.out(`This computer (${deps.host}) is not wired to a socket in the plug settings.`)
  }
  return reads.some((r) => r.status === 'fulfilled') ? 0 : 1
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
    return await show(deps, json)
  }
  if (verb !== 'on' && verb !== 'off' && verb !== 'cycle')
    throw new Refusal(`unknown command ${verb}; aico plug --help shows how`, 2)
  if (extra.length) throw new Refusal(`unexpected ${extra[0]}`, 2)
  const { plug: def, index } = find(deps.cfg, target)
  const own = ownSocket(deps.cfg, deps.host)
  if (verb !== 'on' && !force && own?.plug === def.name && own.index === index) {
    const machine = def.sockets[index]?.machine
    throw new Refusal(
      `${machine} is this computer, and ${def.name}:${index} is what powers it. ` +
        `Switching it off would cut this computer's own power. Run it from the other machine, or add --force.`,
    )
  }
  const socket = (await read(deps, def)).sockets[index]
  if (!socket) throw new Refusal(`The power plug at ${def.address} has no socket ${index}`)
  const name = `${socket.machine ?? 'empty socket'} (${def.name}:${index})`
  if (verb !== 'cycle') {
    await set(deps, socket, def, verb === 'on')
    deps.out(`${name} is ${verb}`)
    return 0
  }
  await set(deps, socket, def, false)
  deps.out(`${name} is off; back on in ${wait} s`)
  await deps.sleep(wait)
  await set(deps, socket, def, true)
  deps.out(`${name} is on`)
  return 0
}
