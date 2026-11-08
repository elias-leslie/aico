// `aico power`: the workstation's power from whichever Aico answers, and the services of each full
// Aico. On: its plug socket if the plug answers, and always the Wake-on-LAN packet. Off: a clean
// shutdown, run on the workstation itself: running sessions are prepared so they come back at boot,
// the planned outage is marked on every Aico, then the host powers off. It needs no plug and no
// `away.enabled`: nothing cuts the power. Who, how and which services are data/ops.json (`power`).

import { createSocket } from 'node:dgram'
import { connect } from 'node:net'
import { requestExec } from '@aico/fleet/exec'
import { fullPeers } from '@aico/fleet/peers'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { machineId } from '@aico/status'
import syncConfig from '../data/context-sync.json' with { type: 'json' }
import ops from '../data/ops.json' with { type: 'json' }
import { type AwayDeps, awayDeps, markEverywhere, namesOf, sshArgs } from './away'
import { Refusal } from './deploy'
import { type PlugDeps, plug } from './plug'
import { type Runner, run, tail } from './sh'

export interface PowerHost {
  /** Answers on `port` while it is on. */
  address: string
  port: number
  /** The ssh alias that reaches it from the other Aico. */
  ssh: string
  wake: { mac: string; broadcast: string; port: number }
  /** Run there with sudo. */
  shutdown: string[]
  /** How long running agents get to save their place before the shutdown. */
  prepareSeconds: number
}

export interface UnitDef {
  unit: string
  /** What the page calls it. */
  label: string
  scope: 'user' | 'system'
  /** Only on these machines; every full Aico without it. */
  machines?: string[]
  /** Restarting it interrupts the Aico page on that machine. */
  reloadsPage?: boolean
}

export interface PowerConfig {
  answerSeconds: number
  peerSeconds: number
  hosts: Record<string, PowerHost>
  units: UnitDef[]
}

interface UnitState {
  unit: string
  label: string
  state: string
  reloadsPage: boolean
}

interface MachineUnits {
  machine: string
  /** Null when that machine didn't answer. */
  units: UnitState[] | null
  error?: string
}

type PeerExec = (
  peer: { name: string; exec: string },
  args: string,
) => Promise<{ code: number; stdout: string; output: string }>

export interface PowerDeps {
  cfg: PowerConfig
  away: AwayDeps
  plug: PlugDeps
  run: Runner
  out: (line: string) => void
  /** This machine's name. */
  machine: string
  answers: (address: string, port: number, seconds: number) => Promise<boolean>
  sendWake: (packet: Buffer, broadcast: string, port: number) => Promise<void>
  peers: () => { name: string; exec: string }[]
  peerExec: PeerExec
}

/** The Wake-on-LAN packet: six 0xFF bytes, then the MAC sixteen times. */
export function magicPacket(mac: string): Buffer {
  const bytes = mac.split(/[:-]/).map((part) => Number.parseInt(part, 16))
  if (bytes.length !== 6 || bytes.some((byte) => !(byte >= 0 && byte <= 255)))
    throw new Refusal(`${mac} is not a MAC address`, 2)
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(bytes))])
}

const SENDS = 3

const sendWake: PowerDeps['sendWake'] = (packet, broadcast, port) =>
  new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    socket.once('error', (error) => {
      socket.close()
      reject(error)
    })
    socket.bind(() => {
      socket.setBroadcast(true)
      let left = SENDS
      const next = () => {
        socket.send(packet, port, broadcast, (error) => {
          if (error || --left === 0) {
            socket.close()
            if (error) reject(error)
            else resolve()
          } else next()
        })
      }
      next()
    })
  })

const answers: PowerDeps['answers'] = (address, port, seconds) =>
  new Promise((resolve) => {
    const socket = connect({ host: address, port })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }
    socket.setTimeout(seconds * 1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

export function powerDeps(out: (line: string) => void, env = process.env): PowerDeps {
  const away = awayDeps(out)
  return {
    cfg: ops.power as PowerConfig,
    away,
    plug: away.plug,
    run,
    out,
    machine: machineId(),
    answers,
    sendWake,
    peers: () => {
      const settings = readSettings(env, '')
      return settings ? fullPeers(settings, readPins(settings.allowlist)).peers : []
    },
    peerExec: (peer, args) =>
      requestExec(
        peer.exec,
        ['sh', '-c', `cd "$HOME" && ${syncConfig.peerAico} power ${args}`],
        Buffer.alloc(0),
      ),
  }
}

function hostOf(deps: PowerDeps, machine: string | undefined): PowerHost {
  const host = machine ? deps.cfg.hosts[machine] : undefined
  if (!host)
    throw new Refusal(
      `aico power needs a machine it can power: ${Object.keys(deps.cfg.hosts).join(', ')}`,
      2,
    )
  return host
}

const isOn = (deps: PowerDeps, machine: string, host: PowerHost) =>
  machine === deps.machine
    ? Promise.resolve(true)
    : deps.answers(host.address, host.port, deps.cfg.answerSeconds)

async function start(deps: PowerDeps, machine: string, host: PowerHost): Promise<number> {
  if (machine === deps.machine) throw new Refusal(`${machine} is this computer; it is on.`)
  try {
    await plug(['on', machine], deps.plug)
  } catch (error) {
    deps.out(`${(error as Error).message}; sending the wake signal only.`)
  }
  const packet = magicPacket(host.wake.mac)
  await deps.sendWake(packet, host.wake.broadcast, host.wake.port)
  deps.out(`Wake signal sent to ${machine}.`)
  return 0
}

/** Runs where the machine is. Anything that can't run is said before anything has changed. */
async function shutDownHere(
  deps: PowerDeps,
  machine: string,
  host: PowerHost,
  dry: boolean,
): Promise<number> {
  const can = deps.run('sudo', ['-n', 'true'])
  if (can.code !== 0)
    throw new Refusal(`${machine} can't run its shutdown (${tail(can, 2) || 'sudo said no'})`)
  const names = namesOf(deps.plug.cfg, machine)
  if (dry) {
    deps.out(
      `${machine}: ready. Would prepare sessions (${host.prepareSeconds} s), mark ${names.join(', ')} as off on every Aico, then run ${host.shutdown.join(' ')}.`,
    )
    return 0
  }
  // A session that didn't get to save in time is restored from its last state: not a refusal.
  const prepared = deps.run('tether', [
    'reboot',
    'prepare',
    '--timeout',
    String(host.prepareSeconds),
  ])
  if (prepared.code !== 0)
    deps.out(`Not every session finished saving (${tail(prepared, 2) || `exit ${prepared.code}`}).`)
  await markEverywhere(deps.away, machine, names, false)
  const off = deps.run('sudo', ['-n', ...host.shutdown])
  if (off.code !== 0) {
    await markEverywhere(deps.away, machine, names, true)
    throw new Refusal(`${machine}: the shutdown did not start (${tail(off, 3)})`)
  }
  deps.out(`${machine}: shutting down`)
  return 0
}

async function shutDown(
  deps: PowerDeps,
  machine: string,
  host: PowerHost,
  dry: boolean,
): Promise<number> {
  if (machine === deps.machine) return await shutDownHere(deps, machine, host, dry)
  if (!(await isOn(deps, machine, host))) throw new Refusal(`${machine} is already off.`)
  const remote = deps.run('ssh', [
    ...sshArgs(host.ssh),
    syncConfig.peerAico,
    'power',
    'off',
    machine,
    ...(dry ? ['--dry-run'] : []),
  ])
  for (const line of remote.out.trim().split('\n').filter(Boolean)) deps.out(line)
  // The link drops as it powers off: having said so, that is the shutdown working.
  if (remote.code !== 0 && !remote.out.includes('shutting down'))
    throw new Refusal(tail(remote, 2).replace(/^aico power:\s*/, '') || `ssh ${host.ssh} failed`)
  return 0
}

const unitsHere = (deps: PowerDeps): UnitState[] =>
  deps.cfg.units
    .filter((def) => !def.machines || def.machines.includes(deps.machine))
    .map((def) => ({ def, read: unitRead(deps, def) }))
    .filter(({ read }) => read.load !== 'not-found')
    .map(({ def, read }) => ({
      unit: def.unit,
      label: def.label,
      state: read.state,
      reloadsPage: def.reloadsPage === true,
    }))

function unitRead(deps: PowerDeps, def: UnitDef): { state: string; load: string } {
  const result = deps.run('systemctl', [
    ...(def.scope === 'user' ? ['--user'] : []),
    'show',
    def.unit,
    '--property=ActiveState,LoadState',
  ])
  const value = (name: string) =>
    new RegExp(`^${name}=(.*)$`, 'm').exec(result.out)?.[1]?.trim() ?? 'unknown'
  return { state: value('ActiveState'), load: value('LoadState') }
}

/** A peer's answer, or why there is none; a machine that is off is not waited for. */
async function askPeer(
  deps: PowerDeps,
  peer: { name: string; exec: string },
  args: string,
): Promise<{ code: number; stdout: string; output: string }> {
  const silent = { code: 255, stdout: '', output: `${peer.name} didn't answer` }
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<typeof silent>((resolve) => {
    timer = setTimeout(() => resolve(silent), deps.cfg.peerSeconds * 1000)
    timer.unref()
  })
  try {
    return await Promise.race([deps.peerExec(peer, args), late])
  } finally {
    clearTimeout(timer)
  }
}

async function allUnits(deps: PowerDeps): Promise<MachineUnits[]> {
  const others = await Promise.all(
    deps.peers().map(async (peer): Promise<MachineUnits> => {
      const answer = await askPeer(deps, peer, 'units --here --json')
      try {
        if (answer.code === 0) {
          const list = JSON.parse(answer.stdout.trim().split('\n').pop() ?? '') as MachineUnits[]
          const units = list[0]?.units
          if (Array.isArray(units)) return { machine: peer.name, units }
        }
      } catch {
        /* Said below as not answering. */
      }
      return { machine: peer.name, units: null, error: `${peer.name} didn't answer` }
    }),
  )
  return [{ machine: deps.machine, units: unitsHere(deps) }, ...others]
}

async function restartUnit(deps: PowerDeps, unit: string, on: string): Promise<number> {
  const def = deps.cfg.units.find((candidate) => candidate.unit === unit)
  if (!def) throw new Refusal(`${unit} is not a service Aico restarts`, 2)
  if (on !== deps.machine) {
    const peer = deps.peers().find((candidate) => candidate.name === on)
    if (!peer) throw new Refusal(`${on} is not a machine that runs Aico`, 2)
    const answer = await askPeer(deps, peer, `restart ${unit}`)
    if (answer.code !== 0)
      throw new Refusal(
        answer.output.trim().replace(/^aico power:\s*/, '') || `${on} didn't answer`,
      )
    deps.out(answer.stdout.trim())
    return 0
  }
  // --no-block: restarting the Aico that asked ends the process asking.
  const argv = ['restart', '--no-block', unit]
  const result =
    def.scope === 'user'
      ? deps.run('systemctl', ['--user', ...argv])
      : deps.run('sudo', ['-n', 'systemctl', ...argv])
  if (result.code !== 0)
    throw new Refusal(`${def.label} didn't restart on ${on} (${tail(result, 2)})`)
  deps.out(`${def.label} is restarting on ${on}`)
  return 0
}

export async function power(argv: string[], deps: PowerDeps): Promise<number> {
  const [verb, target, ...rest] = argv
  const dry = rest.includes('--dry-run')
  if (verb === 'state') {
    const host = hostOf(deps, target)
    deps.out((await isOn(deps, target as string, host)) ? 'on' : 'off')
    return 0
  }
  if (verb === 'on') return await start(deps, target as string, hostOf(deps, target))
  if (verb === 'off') return await shutDown(deps, target as string, hostOf(deps, target), dry)
  if (verb === 'units') {
    const list = argv.includes('--here')
      ? [{ machine: deps.machine, units: unitsHere(deps) }]
      : await allUnits(deps)
    if (argv.includes('--json')) deps.out(JSON.stringify(list))
    else
      for (const { machine, units, error } of list) {
        deps.out(`${machine}${error ? `: ${error}` : ''}`)
        for (const unit of units ?? []) deps.out(`  ${unit.unit}  ${unit.state}`)
      }
    return 0
  }
  if (verb === 'restart' && target) {
    const at = rest.indexOf('--on')
    return await restartUnit(deps, target, at >= 0 ? (rest[at + 1] ?? '') : deps.machine)
  }
  throw new Refusal('aico power --help shows how', 2)
}
