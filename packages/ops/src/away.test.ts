import { expect, it } from 'vitest'
import {
  type AwayConfig,
  type AwayDeps,
  type AwayHost,
  away,
  namesOf,
  shutdownCommand,
} from './away'
import { Refusal } from './deploy'
import type { PlugConfig, PlugDef } from './plug'
import type { RunResult } from './sh'

const shed: PlugDef = {
  name: 'shed',
  address: '192.168.87.217',
  port: 9999,
  sockets: [
    { machine: 'davion-sidarli', hostnames: ['davion-sidarli'] },
    { machine: 'davion-gem', hostnames: ['davion-gem', 'aico'] },
  ],
}
const network: PlugDef = {
  name: 'shed-network',
  address: '192.168.87.193',
  port: 9999,
  sockets: [{ machine: null, label: 'shed network' }, { machine: null }],
}
const plugCfg: PlugConfig = { timeoutSeconds: 5, cycleSeconds: 10, plugs: [shed, network] }
const awayCfg: AwayConfig = {
  enabled: true,
  countdownSeconds: 120,
  settleSeconds: 120,
  statusUrl: 'http://127.0.0.1:3002',
  peers: ['aico-gem'],
  hosts: {
    'davion-gem': {
      countdownSeconds: 300,
      coversGuests: true,
      shutdown: { ssh: 'davion-gem', command: ['systemctl', 'poweroff', '--no-ask-password'] },
    },
    'davion-sidarli': {
      shutdown: { sudo: true, command: ['systemctl', 'poweroff', '--no-ask-password'] },
    },
  },
}

interface Options {
  disabled?: boolean
  host?: string
  /** Sockets of the shed plug that are on. */
  on?: [number, number]
  silent?: boolean
  refuseCountdownFor?: string
  /** Commands (joined) that fail. */
  failing?: string[]
  /** Mark requests that fail. */
  markFails?: boolean
}

/** Nothing here touches a plug, a host or a network: every call lands in `events`. */
function harness(options: Options = {}) {
  const events: string[] = []
  const lines: string[] = []
  const marks: unknown[] = []
  const on = options.on ?? [1, 1]
  const deps: AwayDeps = {
    cfg: options.disabled ? { ...awayCfg, enabled: false } : awayCfg,
    plug: {
      cfg: plugCfg,
      host: options.host ?? 'davion-sidarli',
      sleep: async () => {},
      out: (line) => void lines.push(line),
      send: async (plug, request) => {
        if (options.silent) throw new Refusal(`The power plug at ${plug.address} didn't answer`)
        const r = request as {
          context?: { child_ids: string[] }
          system?: { get_sysinfo?: object }
          count_down?: Record<string, unknown>
        }
        if (r.system?.get_sysinfo)
          return {
            system: {
              get_sysinfo: {
                model: 'EP40(US)',
                children: [0, 1].map((i) => ({
                  id: `ID0${i}`,
                  state: plug.name === 'shed' ? on[i as 0 | 1] : 1,
                  on_time: 500,
                })),
              },
            },
          }
        const id = r.context?.child_ids[0]
        const command = Object.keys(r.count_down ?? {})[0] as string
        events.push(`${plug.name}/${id} ${command} ${JSON.stringify(r.count_down?.[command])}`)
        const refuse = command === 'add_rule' && options.refuseCountdownFor === id
        return { count_down: { [command]: { err_code: refuse ? -1 : 0 } } }
      },
    },
    run: (cmd, args): RunResult => {
      const text = [cmd, ...args].join(' ')
      events.push(text)
      if (cmd === 'ssh' && args.includes('aico-gem') && options.markFails)
        return { code: 255, out: '', err: 'no route to host' }
      return options.failing?.some((f) => text.includes(f))
        ? { code: 1, out: '', err: 'refused' }
        : { code: 0, out: '', err: '' }
    },
    fetch: (async (url: string, init: { body: string }) => {
      events.push(`POST ${url}`)
      marks.push(JSON.parse(init.body))
      return { ok: !options.markFails, status: options.markFails ? 500 : 200 }
    }) as unknown as typeof fetch,
    out: (line) => void lines.push(line),
  }
  return { deps, events, lines, marks }
}

const code = async (promise: Promise<unknown>) => ((await promise.catch((e) => e)) as Refusal).code

it('dry run prints the steps, the remote host first and this computer last, and changes nothing', async () => {
  const h = harness()
  expect(await away(['--all', '--dry-run'], h.deps)).toBe(0)
  expect(h.lines).toEqual([
    'Away: davion-gem, then davion-sidarli (this computer).',
    'davion-gem',
    '  1. Mark davion-gem, aico and its guests as planned off here and on aico-gem; a report from it after 2 min ends the mark',
    '  2. Plug shed, socket 1: switch off in 5 min (set on the plug itself)',
    '  3. Shut down: ssh -o BatchMode=yes -o ConnectTimeout=8 davion-gem systemctl poweroff --no-ask-password',
    'davion-sidarli (this computer)',
    '  1. Mark davion-sidarli as planned off here and on aico-gem; a report from it after 2 min ends the mark',
    '  2. Plug shed, socket 0: switch off in 2 min (set on the plug itself)',
    '  3. Shut down: sudo -n systemctl poweroff --no-ask-password',
    'Dry run: nothing was changed.',
  ])
  expect(h.events).toEqual([])
})

it('marks everything first, then per host: countdown, then shutdown; this computer last', async () => {
  const h = harness()
  expect(await away(['--all'], h.deps)).toBe(0)
  const ssh = 'ssh -o BatchMode=yes -o ConnectTimeout=8'
  expect(h.events).toEqual([
    // the shutdowns can run
    `${ssh} davion-gem true`,
    'sudo -n true',
    // marks: here and the other Aico, gem then this computer
    'POST http://127.0.0.1:3002/api/machines/outage',
    `${ssh} aico-gem aico away mark --guests davion-gem aico`,
    'POST http://127.0.0.1:3002/api/machines/outage',
    `${ssh} aico-gem aico away mark davion-sidarli`,
    // gem: plug countdown, then the clean shutdown
    'shed/ID01 delete_all_rules {}',
    'shed/ID01 add_rule {"enable":1,"delay":300,"act":0,"name":"aico"}',
    `${ssh} davion-gem systemctl poweroff --no-ask-password`,
    // this computer last
    'shed/ID00 delete_all_rules {}',
    'shed/ID00 add_rule {"enable":1,"delay":120,"act":0,"name":"aico"}',
    'sudo -n systemctl poweroff --no-ask-password',
  ])
  expect(h.marks).toEqual([
    { machines: ['davion-gem', 'aico'], guests: true, clear: false, settleSeconds: 120 },
    { machines: ['davion-sidarli'], guests: false, clear: false, settleSeconds: 120 },
  ])
  expect(h.lines.at(-1)).toContain('Kasa app')
})

it('takes only the machines named, and never touches the shed network plug', async () => {
  const h = harness()
  expect(await away(['davion-gem'], h.deps)).toBe(0)
  expect(h.events.some((e) => e.includes('sudo'))).toBe(false)
  expect(h.events.some((e) => e.startsWith('shed-network'))).toBe(false)
  expect(h.events.filter((e) => e.includes('poweroff'))).toHaveLength(1)
})

it('does not shut a host down when its plug will not take the countdown, and unmarks it', async () => {
  const h = harness({ refuseCountdownFor: 'ID01' })
  expect(await away(['--all'], h.deps)).toBe(1)
  expect(h.events.some((e) => e.includes('davion-gem systemctl poweroff'))).toBe(false)
  // This computer still goes: its own plug took the countdown.
  expect(h.events.at(-1)).toBe('sudo -n systemctl poweroff --no-ask-password')
  expect(h.marks.at(-1)).toMatchObject({ machines: ['davion-gem', 'aico'], clear: true })
  expect(h.lines.join('\n')).toContain('refused the countdown for davion-gem')
  expect(h.lines.join('\n')).toContain('Not shutting it down')
})

it('cancels the countdown and the mark when the shutdown does not start', async () => {
  const h = harness({ failing: ['davion-gem systemctl poweroff'] })
  expect(await away(['davion-gem'], h.deps)).toBe(1)
  const tail = h.events.slice(-4)
  expect(tail[0]).toContain('systemctl poweroff')
  expect(tail[1]).toBe('shed/ID01 delete_all_rules {}')
  expect(tail[2]).toContain('POST')
  expect(h.marks.at(-1)).toMatchObject({ clear: true })
  expect(h.lines.join('\n')).toContain('Cancelling its countdown')
})

it('changes nothing when a shutdown cannot run, so no plug is ever set for a host that stays up', async () => {
  const h = harness({ failing: ['sudo -n true'] })
  await expect(away(['--all'], h.deps)).rejects.toThrow(
    'Cannot run the shutdown for davion-sidarli',
  )
  expect(h.events.some((e) => e.startsWith('shed/') || e.startsWith('POST'))).toBe(false)
})

it('refuses before anything when a plug is silent or a socket is already off', async () => {
  const silent = harness({ silent: true })
  await expect(away(['--all'], silent.deps)).rejects.toThrow("didn't answer")
  const off = harness({ on: [1, 0] })
  await expect(away(['--all'], off.deps)).rejects.toThrow('socket (shed:1) is already off')
  expect(off.events).toEqual([])
})

it('a dry run still prints the steps when a plug is silent, and says the socket was not checked', async () => {
  const h = harness({ silent: true })
  expect(await away(['--all', '--dry-run'], h.deps)).toBe(0)
  expect(h.lines[0]).toBe('Away: davion-gem, then davion-sidarli (this computer).')
  expect(h.lines.slice(-3)).toEqual([
    "davion-gem: The power plug at 192.168.87.217 didn't answer; its socket was not checked",
    "davion-sidarli: The power plug at 192.168.87.217 didn't answer; its socket was not checked",
    'Dry run: nothing was changed.',
  ])
  expect(h.events).toEqual([])
})

it('rejects bad input with exit 2: nothing named, an unknown machine, --all with names', async () => {
  const h = harness()
  expect(await code(away([], h.deps))).toBe(2)
  expect(await code(away(['laptop'], h.deps))).toBe(2)
  expect(await code(away(['--all', 'davion-gem'], h.deps))).toBe(2)
  expect(await code(away(['--now'], h.deps))).toBe(2)
  expect(h.events).toEqual([])
})

it('will not run a shutdown that has to happen on another computer', async () => {
  const h = harness({ host: 'aico' })
  await expect(away(['davion-sidarli', '--dry-run'], h.deps)).rejects.toThrow(
    'davion-sidarli is shut down from itself',
  )
})

it('still goes on when the other Aico cannot be marked, and says so', async () => {
  const h = harness({ markFails: true })
  expect(await away(['davion-gem'], h.deps)).toBe(0)
  expect(h.lines.join('\n')).toContain('Could not mark davion-gem on here (Aico answered 500)')
  expect(h.events.some((e) => e.includes('davion-gem systemctl poweroff'))).toBe(true)
})

it('aico away mark asks this Aico only, and --clear takes the mark back', async () => {
  const h = harness()
  expect(await away(['mark', '--guests', 'davion-gem', 'aico'], h.deps)).toBe(0)
  expect(await away(['mark', '--clear', 'davion-gem'], h.deps)).toBe(0)
  expect(h.marks).toEqual([
    { machines: ['davion-gem', 'aico'], guests: true, clear: false, settleSeconds: 120 },
    { machines: ['davion-gem'], guests: false, clear: true, settleSeconds: 120 },
  ])
  expect(h.events.every((e) => e.startsWith('POST'))).toBe(true)
  expect(await code(away(['mark'], h.deps))).toBe(2)
})

it('names a machine by its own name and the hostnames the plug settings give it', () => {
  expect(namesOf(plugCfg, 'davion-gem')).toEqual(['davion-gem', 'aico'])
  expect(namesOf(plugCfg, 'davion-sidarli')).toEqual(['davion-sidarli'])
  expect(shutdownCommand(awayCfg.hosts['davion-sidarli'] as AwayHost)).toEqual([
    'sudo',
    ['-n', 'systemctl', 'poweroff', '--no-ask-password'],
  ])
})

it('while remote power is not set up, refuses to shut anything down or mark, but dry run and status still work', async () => {
  const h = harness({ disabled: true })
  const reason =
    "Remote power isn't set up yet: the plugs and BIOS power-on aren't confirmed. See docs/power-off-test.md."
  await expect(away(['--all'], h.deps)).rejects.toThrow(reason)
  await expect(away(['mark', 'davion-gem'], h.deps)).rejects.toThrow(reason)
  expect(h.events).toEqual([])
  expect(await away(['--all', '--dry-run'], h.deps)).toBe(0)
  expect(h.lines.at(-1)).toBe('Dry run: nothing was changed.')
  h.lines.length = 0
  expect(await away(['--status'], h.deps)).toBe(0)
  expect(JSON.parse(h.lines[0] as string)).toEqual({ enabled: false, reason })
  const on = harness()
  await away(['--status'], on.deps)
  expect(JSON.parse(on.lines[0] as string)).toEqual({ enabled: true })
})
