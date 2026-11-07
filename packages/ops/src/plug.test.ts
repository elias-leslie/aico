import { createServer, type Server } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { Refusal } from './deploy'
import {
  decode,
  duration,
  encode,
  ownSocket,
  type PlugConfig,
  type PlugDef,
  type PlugDeps,
  PlugSilent,
  parseStatus,
  plug,
  socketSend,
} from './plug'

const shed: PlugDef = {
  name: 'shed',
  address: '192.168.87.217',
  port: 9999,
  sockets: [{ machine: 'davion-sidarli', hostnames: ['davion-sidarli'] }, { machine: null }],
}
const house: PlugDef = {
  name: 'house',
  address: '192.168.87.193',
  port: 9999,
  sockets: [{ machine: 'davion-gem', hostnames: ['davion-gem', 'aico'] }, { machine: null }],
}
const cfg: PlugConfig = { timeoutSeconds: 5, cycleSeconds: 10, plugs: [shed, house] }

const sysinfo = (states: [number, number], onTime = [594, 7300]) => ({
  system: {
    get_sysinfo: {
      model: 'EP40(US)',
      children: states.map((state, i) => ({
        id: `ID0${i}`,
        state,
        alias: `Socket ${i}`,
        on_time: state ? onTime[i] : 0,
      })),
    },
  },
})

/** Two plugs that are only lists of states: records every request, never touches the network. */
function fakePlugs(states: Record<string, [number, number]>, silent: string[] = []) {
  const requests: { plug: string; request: unknown }[] = []
  const send: PlugDeps['send'] = async (plug, request) => {
    requests.push({ plug: plug.name, request })
    if (silent.includes(plug.name)) throw new PlugSilent(plug.address)
    const r = request as {
      context?: { child_ids: string[] }
      system: { set_relay_state?: { state: number } }
    }
    const mine = states[plug.name] as [number, number]
    if (r.system.set_relay_state) {
      mine[Number(r.context?.child_ids[0]?.slice(-1))] = r.system.set_relay_state.state
      return { system: { set_relay_state: { err_code: 0 } } }
    }
    return sysinfo(mine)
  }
  return { send, requests }
}

function harness(
  host: string,
  states: Record<string, [number, number]> = { shed: [1, 1], house: [1, 1] },
  silent: string[] = [],
) {
  const fake = fakePlugs(states, silent)
  const lines: string[] = []
  const slept: number[] = []
  const deps: PlugDeps = {
    cfg,
    send: fake.send,
    host,
    sleep: async (s) => void slept.push(s),
    out: (line) => void lines.push(line),
  }
  const switches = () =>
    fake.requests.filter((r) => 'set_relay_state' in (r.request as { system: object }).system)
  return { deps, lines, slept, switches, states }
}

let server: Server | undefined
afterEach(() => server?.close())

it('encodes with the 4-byte length and the autokey cipher, and decodes it back', () => {
  const message = { system: { get_sysinfo: {} } }
  const wire = encode(message)
  expect(wire.readUInt32BE(0)).toBe(wire.length - 4)
  // Known vector from the protocol: the first byte is 171 xor "{".
  expect(wire[4]).toBe(171 ^ '{'.charCodeAt(0))
  expect(decode(wire.subarray(4))).toEqual(message)
  const unicode = { alias: 'Kasa – Plug é' }
  expect(decode(encode(unicode).subarray(4))).toEqual(unicode)
})

it('reads a reply split over several packets and says nothing answered on silence', async () => {
  const reply = encode(sysinfo([1, 0]))
  server = createServer((connection) => {
    connection.once('data', () => {
      connection.write(reply.subarray(0, 7))
      setTimeout(() => connection.write(reply.subarray(7)), 20)
    })
  })
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  const local: PlugDef = { ...shed, address: '127.0.0.1', port }
  expect(await socketSend(local, 1)({ system: { get_sysinfo: {} } })).toEqual(sysinfo([1, 0]))
  server.close()
  server = createServer(() => {})
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const quiet = { ...local, port: (server.address() as { port: number }).port }
  await expect(socketSend(quiet, 0.1)({})).rejects.toThrow(
    "The power plug at 127.0.0.1 didn't answer",
  )
})

it('says the plug did not answer when nothing listens', async () => {
  server = createServer()
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  server.close()
  await expect(socketSend({ ...shed, address: '127.0.0.1', port }, 1)({})).rejects.toThrow(
    "The power plug at 127.0.0.1 didn't answer",
  )
})

it('parses each socket: machine or empty, on or off, how long on', () => {
  const parsed = parseStatus(sysinfo([1, 0]), shed)
  expect(parsed.model).toBe('EP40(US)')
  expect(parsed.sockets).toEqual([
    { plug: 'shed', index: 0, id: 'ID00', machine: 'davion-sidarli', on: true, onSeconds: 594 },
    { plug: 'shed', index: 1, id: 'ID01', machine: null, on: false, onSeconds: null },
  ])
  expect(() => parseStatus({ system: {} }, shed)).toThrow(Refusal)
  expect(duration(45)).toBe('45 s')
  expect(duration(594)).toBe('9 min')
  expect(duration(7300)).toBe('2 h 1 min')
  expect(duration(200000)).toBe('2 d 7 h')
})

it('knows which plug and socket this computer is wired to', () => {
  expect(ownSocket(cfg, 'davion-sidarli')).toEqual({ plug: 'shed', index: 0 })
  expect(ownSocket(cfg, 'Davion-Gem.lan')).toEqual({ plug: 'house', index: 0 })
  expect(ownSocket(cfg, 'aico')).toEqual({ plug: 'house', index: 0 })
  expect(ownSocket(cfg, 'laptop')).toBeNull()
})

it('prints every plug, marking this computer and the empty sockets', async () => {
  const h = harness('davion-sidarli', { shed: [1, 0], house: [1, 1] })
  expect(await plug([], h.deps)).toBe(0)
  expect(h.lines).toEqual([
    'Shed plug (192.168.87.217, EP40(US))',
    '  0  davion-sidarli  on   for 9 min  (this computer)',
    '  1  (empty)         off',
    'House plug (192.168.87.193, EP40(US))',
    '  0  davion-gem      on   for 9 min',
    '  1  (empty)         on   for 2 h 1 min',
  ])
  expect(h.switches()).toEqual([])
})

it('shows the plugs that answer when one is silent, and fails only when none answers', async () => {
  const some = harness('davion-sidarli', { shed: [1, 1], house: [1, 1] }, ['house'])
  expect(await plug([], some.deps)).toBe(0)
  expect(some.lines).toContain(
    "House plug (192.168.87.193): The power plug at 192.168.87.193 didn't answer",
  )
  expect(some.lines).toContain('Shed plug (192.168.87.217, EP40(US))')
  const none = harness('davion-sidarli', { shed: [1, 1], house: [1, 1] }, ['house', 'shed'])
  expect(await plug([], none.deps)).toBe(1)
  const json = harness('davion-sidarli', { shed: [1, 1], house: [1, 1] }, ['house'])
  await plug(['--json'], json.deps)
  const parsed = JSON.parse(json.lines[0] as string)
  expect(parsed.plugs[1]).toEqual({
    name: 'house',
    address: '192.168.87.193',
    error: "The power plug at 192.168.87.193 didn't answer",
  })
  expect(parsed.plugs[0].sockets).toHaveLength(2)
})

it('refuses to switch off or cycle its own socket without --force, and says why', async () => {
  for (const verb of ['off', 'cycle']) {
    for (const target of ['davion-gem', 'house:0']) {
      const h = harness('aico')
      const refusal = await plug([verb, target], h.deps).catch((e) => e)
      expect(refusal).toBeInstanceOf(Refusal)
      expect(refusal.message).toContain('davion-gem is this computer')
      expect(refusal.message).toContain('cut this computer')
      expect(h.switches()).toEqual([])
    }
  }
  const forced = harness('aico')
  await plug(['off', 'house:0', '--force'], forced.deps)
  expect(forced.switches()).toHaveLength(1)
  // On is always fine, and the other machine's socket is not protected.
  const other = harness('aico', { shed: [0, 0], house: [0, 0] })
  await plug(['on', 'davion-gem'], other.deps)
  await plug(['off', 'davion-sidarli'], other.deps)
  expect(other.states).toEqual({ shed: [0, 0], house: [1, 0] })
})

it('finds a machine across plugs and addresses an empty socket as PLUG:SOCKET', async () => {
  const h = harness('aico')
  await plug(['off', 'davion-sidarli'], h.deps)
  await plug(['on', 'shed:1'], h.deps)
  await plug(['off', 'House:1'], h.deps)
  expect(h.switches().map((r) => [r.plug, JSON.stringify(r.request)])).toEqual([
    ['shed', '{"context":{"child_ids":["ID00"]},"system":{"set_relay_state":{"state":0}}}'],
    ['shed', '{"context":{"child_ids":["ID01"]},"system":{"set_relay_state":{"state":1}}}'],
    ['house', '{"context":{"child_ids":["ID01"]},"system":{"set_relay_state":{"state":0}}}'],
  ])
  expect(h.lines.at(-1)).toBe('empty socket (house:1) is off')
})

it('cycles another machine: off, wait, on, on the plug that feeds it', async () => {
  const h = harness('aico')
  expect(await plug(['cycle', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.slept).toEqual([10])
  expect(h.switches()).toEqual([
    {
      plug: 'shed',
      request: { context: { child_ids: ['ID00'] }, system: { set_relay_state: { state: 0 } } },
    },
    {
      plug: 'shed',
      request: { context: { child_ids: ['ID00'] }, system: { set_relay_state: { state: 1 } } },
    },
  ])
  const quick = harness('davion-sidarli')
  await plug(['cycle', 'house:0', '--wait', '3'], quick.deps)
  expect(quick.slept).toEqual([3])
})

it('rejects bad input with exit code 2 and plain words', async () => {
  const h = harness('aico')
  const code = async (argv: string[]) =>
    ((await plug(argv, h.deps).catch((e) => e)) as Refusal).code
  expect(await code(['off'])).toBe(2)
  expect(await code(['off', 'nobody'])).toBe(2)
  expect(await code(['off', '1'])).toBe(2)
  expect(await code(['off', 'shed:7'])).toBe(2)
  expect(await code(['off', 'garage:0'])).toBe(2)
  expect(await code(['toggle', 'shed:0'])).toBe(2)
  expect(await code(['on', 'shed:0', '--bogus'])).toBe(2)
  expect(await code(['cycle', 'shed:0', '--wait', 'x'])).toBe(2)
  expect(h.switches()).toEqual([])
})

it('reports a plug that refuses the switch', async () => {
  const h = harness('aico')
  const before = h.deps.send
  h.deps.send = async (p, request) =>
    (request as { system: { set_relay_state?: unknown } }).system.set_relay_state
      ? { system: { set_relay_state: { err_code: -1 } } }
      : before(p, request)
  await expect(plug(['off', 'davion-sidarli'], h.deps)).rejects.toThrow(
    'refused to switch davion-sidarli off',
  )
})
