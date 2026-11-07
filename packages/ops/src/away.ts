// `aico away`: leave with the hosts off. For each named host (the remote one first, this one
// last): mark a planned outage on every Aico that would page about it, set the countdown on the
// host's own plug socket so the plug cuts the power after a clean shutdown, then shut the host down.
// Start again later with the Kasa app (socket on); the BIOS powers a host on when power returns.
// Which hosts, their sockets and how each is shut down are data/ops.json (`away`, `plug`).

import ops from '../data/ops.json' with { type: 'json' }
import { Refusal } from './deploy'
import {
  clearCountdown,
  duration,
  findSocket,
  type PlugConfig,
  type PlugDeps,
  plugDeps,
  type Socket,
  setCountdown,
  socketOf,
} from './plug'
import { type Runner, run, tail } from './sh'

export interface AwayHost {
  /** Seconds the plug waits before it cuts the power; default is the shared value. */
  countdownSeconds?: number
  /** The host runs guests that report to Status; they are marked with it. */
  coversGuests?: boolean
  shutdown: {
    /** An ssh alias that reaches the host as root; absent when the command runs here. */
    ssh?: string
    /** Run with sudo (no password prompt); for the command that runs here. */
    sudo?: boolean
    command: string[]
  }
}

export interface AwayConfig {
  countdownSeconds: number
  /** How long after the mark a report from the host counts as the host being back. */
  settleSeconds: number
  /** This Aico's address (loopback). */
  statusUrl: string
  /** ssh aliases of the other Aico instances that would page about these hosts. */
  peers: string[]
  hosts: Record<string, AwayHost>
}

export interface AwayDeps {
  cfg: AwayConfig
  plug: PlugDeps
  run: Runner
  fetch: typeof fetch
  out: (line: string) => void
}

export function awayDeps(
  out: (line: string) => void,
  cfg: AwayConfig = ops.away as AwayConfig,
  plugCfg?: PlugConfig,
): AwayDeps {
  return { cfg, plug: plugDeps(out, plugCfg), run, fetch, out }
}

const short = (name: string) => (name.toLowerCase().split('.')[0] as string) || name

/** The names Status knows a machine by: its own and the hostnames the plug settings list. */
export function namesOf(plug: PlugConfig, machine: string): string[] {
  const names = new Set([machine])
  for (const p of plug.plugs)
    for (const s of p.sockets)
      if (s.machine === machine) for (const h of s.hostnames ?? []) names.add(h)
  return [...names]
}

interface Step {
  machine: string
  host: AwayHost
  local: boolean
  names: string[]
  seconds: number
  /** The plug and socket that power it, read just now. */
  socket: Socket
  plugName: string
}

const sshArgs = (alias: string) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias]

/** The command that shuts the host down, as program and arguments. */
export function shutdownCommand(host: AwayHost): [string, string[]] {
  const { ssh, sudo, command } = host.shutdown
  if (ssh) return ['ssh', [...sshArgs(ssh), ...command]]
  return sudo ? ['sudo', ['-n', ...command]] : [command[0] as string, command.slice(1)]
}

/** The harmless command that shows the shutdown command can run. */
function reachCommand(host: AwayHost): [string, string[]] {
  const { ssh, sudo } = host.shutdown
  if (ssh) return ['ssh', [...sshArgs(ssh), 'true']]
  return sudo ? ['sudo', ['-n', 'true']] : ['true', []]
}

const printable = ([program, args]: [string, string[]]) => [program, ...args].join(' ')

/** The hosts to take away, remote ones first and this computer last. */
function pickHosts(deps: AwayDeps, words: string[], all: boolean): string[] {
  const configured = Object.keys(deps.cfg.hosts)
  const wired = new Set(deps.plug.cfg.plugs.flatMap((p) => p.sockets.map((s) => s.machine)))
  const known = configured.filter((m) => wired.has(m))
  const chosen = all ? known : words
  if (!chosen.length) throw new Refusal('aico away needs a machine, or --all', 2)
  for (const name of chosen)
    if (!known.includes(name))
      throw new Refusal(
        `${name} cannot be taken away; the machines that can are ${known.join(', ')}`,
        2,
      )
  const unique = [...new Set(chosen)]
  const here = short(deps.plug.host)
  return [...unique.filter((m) => m !== here), ...unique.filter((m) => m === here)]
}

/** Everything the run needs, read before anything changes: plugs answer, sockets are on, this computer may run each shutdown. */
async function prepare(
  deps: AwayDeps,
  machines: string[],
  /** A dry run goes on when a plug does not answer, and says so. */
  notes: string[] | null,
): Promise<Step[]> {
  const here = short(deps.plug.host)
  const steps: Step[] = []
  for (const machine of machines) {
    const host = deps.cfg.hosts[machine] as AwayHost
    const local = !host.shutdown.ssh
    if (local && machine !== here)
      throw new Refusal(
        `${machine} is shut down from itself; run aico away on ${machine} (this computer is ${deps.plug.host})`,
        2,
      )
    const { plug, socket } = await socketOf(deps.plug, machine).catch((error) => {
      if (!notes) throw error
      const where = findSocket(deps.plug.cfg, machine)
      notes.push(`${machine}: ${(error as Error).message}; its socket was not checked`)
      const placeholder: Socket = {
        plug: where.plug.name,
        index: where.index,
        id: '',
        machine,
        on: true,
        onSeconds: null,
      }
      return { plug: where.plug, socket: placeholder }
    })
    if (!socket.on)
      throw new Refusal(
        `${machine}'s socket (${plug.name}:${socket.index}) is already off; there is nothing to shut down`,
      )
    steps.push({
      machine,
      host,
      local,
      names: namesOf(deps.plug.cfg, machine),
      seconds: host.countdownSeconds ?? deps.cfg.countdownSeconds,
      socket,
      plugName: plug.name,
    })
  }
  return steps
}

const label = (step: Step) => (step.local ? `${step.machine} (this computer)` : step.machine)

function planLines(deps: AwayDeps, steps: Step[]): string[] {
  const { settleSeconds, peers } = deps.cfg
  const lines = [`Away: ${steps.map(label).join(', then ')}.`]
  for (const step of steps) {
    const where = ['here', ...peers].join(' and on ')
    lines.push(
      label(step),
      `  1. Mark ${step.names.join(', ')}${step.host.coversGuests ? ' and its guests' : ''} as planned off ${where}; a report from it after ${duration(settleSeconds)} ends the mark`,
      `  2. Plug ${step.plugName}, socket ${step.socket.index}: switch off in ${duration(step.seconds)} (set on the plug itself)`,
      `  3. Shut down: ${printable(shutdownCommand(step.host))}`,
    )
  }
  return lines
}

/** Marks (or unmarks) the planned outage on this Aico, over its loopback address. */
async function markHere(
  deps: AwayDeps,
  names: string[],
  options: { guests: boolean; clear: boolean },
): Promise<void> {
  const response = await deps.fetch(`${deps.cfg.statusUrl}/api/machines/outage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      machines: names,
      guests: options.guests,
      clear: options.clear,
      settleSeconds: deps.cfg.settleSeconds,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Aico answered ${response.status}`)
}

/** The same on each other Aico, through that machine's own `aico away mark`. */
function markPeer(
  deps: AwayDeps,
  peer: string,
  names: string[],
  options: { guests: boolean; clear: boolean },
): void {
  const result = deps.run('ssh', [
    ...sshArgs(peer),
    'aico',
    'away',
    'mark',
    ...(options.clear ? ['--clear'] : []),
    ...(options.guests ? ['--guests'] : []),
    ...names,
  ])
  if (result.code !== 0) throw new Error(tail(result, 3) || `ssh ${peer} failed`)
}

/** Marks everywhere it can; where it cannot, says so and goes on (a stray page costs less than staying). */
async function mark(deps: AwayDeps, step: Step, clear: boolean): Promise<void> {
  const options = { guests: step.host.coversGuests === true, clear }
  const word = clear ? 'unmark' : 'mark'
  const tries: [string, () => void | Promise<void>][] = [
    ['here', () => markHere(deps, step.names, options)],
    ...deps.cfg.peers.map((peer): [string, () => void] => [
      peer,
      () => markPeer(deps, peer, step.names, options),
    ]),
  ]
  for (const [where, call] of tries) {
    try {
      await call()
    } catch (error) {
      deps.out(
        `Could not ${word} ${step.machine} on ${where} (${(error as Error).message}); that Aico may page about it`,
      )
    }
  }
}

/** `aico away mark [--clear] [--guests] NAME...`: the planned-outage mark on this Aico only (what `away` asks of each peer). */
async function markCommand(deps: AwayDeps, argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'))
  const bad = flags.find((f) => f !== '--clear' && f !== '--guests')
  if (bad) throw new Refusal(`unknown option ${bad}; aico away --help shows how`, 2)
  const names = argv.filter((a) => !a.startsWith('--'))
  if (!names.length) throw new Refusal('aico away mark needs machine names', 2)
  await markHere(deps, names, {
    guests: flags.includes('--guests'),
    clear: flags.includes('--clear'),
  })
  deps.out(`${flags.includes('--clear') ? 'unmarked' : 'marked'} ${names.join(', ')}`)
  return 0
}

export async function away(argv: string[], deps: AwayDeps): Promise<number> {
  if (argv[0] === 'mark') return await markCommand(deps, argv.slice(1))
  const flags = new Set(['--all', '--dry-run'])
  const bad = argv.find((a) => a.startsWith('--') && !flags.has(a))
  if (bad) throw new Refusal(`unknown option ${bad}; aico away --help shows how`, 2)
  const words = argv.filter((a) => !a.startsWith('--'))
  const dry = argv.includes('--dry-run')
  if (argv.includes('--all') && words.length)
    throw new Refusal('aico away takes machine names or --all, not both', 2)
  const machines = pickHosts(deps, words, argv.includes('--all'))
  const notes: string[] = []
  const steps = await prepare(deps, machines, dry ? notes : null)
  for (const line of planLines(deps, steps)) deps.out(line)
  if (dry) {
    for (const note of notes) deps.out(note)
    deps.out('Dry run: nothing was changed.')
    return 0
  }

  // Everything that runs the shutdown has to answer before the first plug is set: a countdown
  // set on a host that then does not shut down would cut its power.
  for (const step of steps) {
    const result = deps.run(...reachCommand(step.host))
    if (result.code !== 0)
      throw new Refusal(
        `Cannot run the shutdown for ${step.machine} (${tail(result, 3) || 'no answer'}). Nothing was changed.`,
      )
  }

  for (const step of steps) await mark(deps, step, false)
  let failed = 0
  for (const step of steps) {
    const plug = deps.plug.cfg.plugs.find((p) => p.name === step.plugName)
    if (!plug) continue
    try {
      await setCountdown(deps.plug, plug, step.socket, 'off', step.seconds)
    } catch (error) {
      deps.out(`${step.machine}: ${(error as Error).message}. Not shutting it down.`)
      await mark(deps, step, true)
      failed++
      continue
    }
    deps.out(`${step.machine}: the plug cuts power in ${duration(step.seconds)}`)
    const result = deps.run(...shutdownCommand(step.host))
    if (result.code !== 0) {
      deps.out(
        `${step.machine}: the shutdown did not start (${tail(result, 3)}). Cancelling its countdown.`,
      )
      await clearCountdown(deps.plug, plug, step.socket).catch((error) =>
        deps.out(
          `${step.machine}: could not cancel the countdown (${(error as Error).message}); check the plug`,
        ),
      )
      await mark(deps, step, true)
      failed++
      continue
    }
    deps.out(`${step.machine}: shutting down`)
  }
  if (failed) return 1
  deps.out(
    'To start them again, switch their sockets on in the Kasa app (the BIOS powers each host on when power returns).',
  )
  return 0
}
