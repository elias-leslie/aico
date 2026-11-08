import { expect, it } from 'vitest'
import type { AwayDeps } from './away'
import type { PlugDeps } from './plug'
import { magicPacket, type PowerDeps, power } from './power'

const MAC = '10:ff:e0:35:51:f1'

const cfg: PowerDeps['cfg'] = {
  answerSeconds: 1,
  peerSeconds: 1,
  hosts: {
    'davion-sidarli': {
      address: '192.0.2.1',
      port: 22,
      ssh: 'workstation',
      wake: { mac: MAC, broadcast: '192.0.2.255', port: 9 },
      shutdown: ['systemctl', 'poweroff', '--no-ask-password'],
      prepareSeconds: 120,
    },
  },
  units: [
    { unit: 'aico-web.service', label: 'Aico', scope: 'user', reloadsPage: true },
    { unit: 'cloudflared-aico.service', label: 'Address', scope: 'system' },
    { unit: 'only.service', label: 'Only', scope: 'user', machines: ['other'] },
  ],
}

interface Options {
  machine?: string
  up?: boolean
  plugSilent?: boolean
  failing?: string[]
  remoteOut?: string
  peerAnswer?: { code: number; stdout: string; output: string } | 'silent'
}

function harness(options: Options = {}) {
  const events: string[] = []
  const lines: string[] = []
  const socket = { id: 'ID0', state: 0 }
  const plugDeps: PlugDeps = {
    cfg: {
      timeoutSeconds: 1,
      cycleSeconds: 1,
      plugs: [
        {
          name: 'shed',
          address: '192.0.2.2',
          port: 9999,
          sockets: [{ machine: 'davion-sidarli', hostnames: ['davion-sidarli'] }],
        },
      ],
    },
    send: async (_plug, request) => {
      if (options.plugSilent) throw new Error('The power plug at 192.0.2.2 didn’t answer')
      const r = request as { system?: { set_relay_state?: { state: number } } }
      if (r.system?.set_relay_state) {
        events.push(`plug on=${r.system.set_relay_state.state}`)
        return { system: { set_relay_state: { err_code: 0 } } }
      }
      return { system: { get_sysinfo: { model: 'EP40', children: [socket] } } }
    },
    host: options.machine ?? 'aico',
    sleep: async () => {},
    out: (line) => lines.push(line),
  }
  const away = {
    cfg: {
      enabled: false,
      countdownSeconds: 1,
      settleSeconds: 120,
      statusUrl: 'http://127.0.0.1:3002',
      peers: ['aico-gem'],
      hosts: {},
    },
    plug: plugDeps,
    fetch: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { clear: boolean }
      events.push(body.clear ? 'clear here' : 'mark here')
      return new Response('{}')
    }) as unknown as typeof fetch,
    out: (line: string) => lines.push(line),
    run: (cmd: string, args: string[]) => {
      events.push(
        `${cmd} ${args.filter((a) => a.includes('away') || a === 'mark').join(' ')}`.trim(),
      )
      return { code: 0, out: '', err: '' }
    },
  } as AwayDeps
  const deps: PowerDeps = {
    cfg,
    away,
    plug: plugDeps,
    out: (line) => lines.push(line),
    machine: options.machine ?? 'aico',
    answers: async () => options.up ?? true,
    sendWake: async (packet, broadcast, port) => {
      events.push(`wake ${broadcast}:${port} ${packet.length}`)
    },
    peers: () => [{ name: 'davion-sidarli', exec: '/x' }],
    peerExec: (_peer, args) => {
      events.push(`peer ${args}`)
      const answer = options.peerAnswer ?? { code: 0, stdout: '', output: '' }
      return answer === 'silent' ? new Promise(() => {}) : Promise.resolve(answer)
    },
    run: (cmd, args) => {
      const command = [cmd, ...args].join(' ')
      events.push(command)
      if (cmd === 'systemctl' && args.includes('show'))
        return { code: 0, out: 'ActiveState=active\nLoadState=loaded\n', err: '' }
      if (options.failing?.some((text) => command.includes(text)))
        return { code: 1, out: '', err: 'nope' }
      if (cmd === 'ssh')
        return { code: options.remoteOut ? 255 : 0, out: options.remoteOut ?? '', err: '' }
      return { code: 0, out: '', err: '' }
    },
  }
  return { deps, events, lines }
}

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => '',
    (error: Error) => error.message,
  )

it('builds the magic packet: six 0xFF, then the MAC sixteen times', () => {
  const packet = magicPacket(MAC)
  expect(packet).toHaveLength(102)
  expect(packet.subarray(0, 6).every((byte) => byte === 0xff)).toBe(true)
  expect(packet.subarray(6, 12).toString('hex')).toBe('10ffe03551f1')
  expect(packet.subarray(96).toString('hex')).toBe('10ffe03551f1')
  expect(() => magicPacket('not-a-mac')).toThrow('not a MAC')
})

it('starting: switches the socket on and always sends the wake signal', async () => {
  const h = harness()
  expect(await power(['on', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.events).toEqual(['plug on=1', 'wake 192.0.2.255:9 102'])
})

it('starting: a plug that does not answer still sends the wake signal, and says so', async () => {
  const h = harness({ plugSilent: true })
  expect(await power(['on', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.events).toEqual(['wake 192.0.2.255:9 102'])
  expect(h.lines.join('\n')).toContain('wake signal only')
})

it('says on or off from whether the machine answers', async () => {
  const off = harness({ up: false })
  await power(['state', 'davion-sidarli'], off.deps)
  expect(off.lines).toEqual(['off'])
  const here = harness({ machine: 'davion-sidarli', up: false })
  await power(['state', 'davion-sidarli'], here.deps)
  expect(here.lines).toEqual(['on'])
})

it('shutting down on the machine: prepares sessions, marks every Aico, then powers off', async () => {
  const h = harness({ machine: 'davion-sidarli' })
  expect(await power(['off', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.events.filter((e) => !e.startsWith('sudo -n true'))).toEqual([
    'tether reboot prepare --timeout 120',
    'mark here',
    'ssh away mark',
    'sudo -n systemctl poweroff --no-ask-password',
  ])
  expect(h.lines).toContain('davion-sidarli: shutting down')
})

it('a shutdown that does not start takes the marks back and says why', async () => {
  const h = harness({ machine: 'davion-sidarli', failing: ['poweroff'] })
  expect(await refusal(power(['off', 'davion-sidarli'], h.deps))).toContain('did not start')
  expect(h.events).toContain('clear here')
})

it('a machine that cannot run its shutdown changes nothing', async () => {
  const h = harness({ machine: 'davion-sidarli', failing: ['sudo -n true'] })
  expect(await refusal(power(['off', 'davion-sidarli'], h.deps))).toContain(
    "can't run its shutdown",
  )
  expect(h.events).toEqual(['sudo -n true'])
})

it('a dry run on the machine prepares and marks nothing', async () => {
  const h = harness({ machine: 'davion-sidarli' })
  expect(await power(['off', 'davion-sidarli', '--dry-run'], h.deps)).toBe(0)
  expect(h.events).toEqual(['sudo -n true'])
  expect(h.lines[0]).toContain('ready')
})

it('from the other Aico it asks the machine itself; the link dropping as it goes down is fine', async () => {
  const h = harness({ remoteOut: 'davion-sidarli: shutting down\n' })
  expect(await power(['off', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.events[0]).toContain('workstation')
  expect(h.events[0]).toContain('power off davion-sidarli')
})

it('from the other Aico a machine that is off is already off', async () => {
  const h = harness({ up: false })
  expect(await refusal(power(['off', 'davion-sidarli'], h.deps))).toContain('already off')
  expect(h.events).toEqual([])
})

it('lists services here and a peer that answers; a silent peer is said, not waited for', async () => {
  const peerUnits = [
    {
      machine: 'davion-sidarli',
      units: [{ unit: 'a', label: 'A', state: 'active', reloadsPage: false }],
    },
  ]
  const h = harness({ peerAnswer: { code: 0, stdout: JSON.stringify(peerUnits), output: '' } })
  await power(['units', '--json'], h.deps)
  const list = JSON.parse(h.lines[0] as string)
  expect(list[0].machine).toBe('aico')
  expect(list[0].units.map((u: { unit: string }) => u.unit)).toEqual([
    'aico-web.service',
    'cloudflared-aico.service',
  ])
  expect(list[1].units).toHaveLength(1)
  const silent = harness({ peerAnswer: 'silent' })
  await power(['units', '--json'], silent.deps)
  expect(JSON.parse(silent.lines[0] as string)[1]).toMatchObject({ units: null })
})

it('restarts only a listed service: user, system through sudo, a peer through the link', async () => {
  const h = harness()
  await power(['restart', 'aico-web.service'], h.deps)
  await power(['restart', 'cloudflared-aico.service'], h.deps)
  await power(['restart', 'aico-web.service', '--on', 'davion-sidarli'], h.deps)
  expect(h.events).toEqual([
    'systemctl --user restart --no-block aico-web.service',
    'sudo -n systemctl restart --no-block cloudflared-aico.service',
    'peer restart aico-web.service',
  ])
  expect(await refusal(power(['restart', 'sshd.service'], h.deps))).toContain('not a service')
})
