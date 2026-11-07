import { createServer, type Server } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { Refusal } from './deploy'
import {
  decode,
  duration,
  encode,
  ownSocket,
  type PlugConfig,
  type PlugDeps,
  type PlugSend,
  parseStatus,
  plug,
  socketSend,
} from './plug'

const cfg: PlugConfig = {
  address: '192.168.87.217',
  port: 9999,
  timeoutSeconds: 5,
  cycleSeconds: 10,
  sockets: [
    { machine: 'davion-sidarli', hostnames: ['davion-sidarli'] },
    { machine: 'davion-gem', hostnames: ['davion-gem', 'aico'] },
  ],
}

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

/** A plug that is only a list of states: records every request, never touches the network. */
function fakePlug(states: [number, number] = [1, 1]) {
  const requests: unknown[] = []
  const send: PlugSend = async (request) => {
    requests.push(request)
    const r = request as {
      context?: { child_ids: string[] }
      system: { set_relay_state?: { state: number } }
    }
    if (r.system.set_relay_state) {
      states[Number(r.context?.child_ids[0]?.slice(-1))] = r.system.set_relay_state.state
      return { system: { set_relay_state: { err_code: 0 } } }
    }
    return sysinfo(states)
  }
  return { send, requests, states }
}

function harness(host: string, states: [number, number] = [1, 1]) {
  const fake = fakePlug(states)
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
    fake.requests.filter((r) => Object.hasOwn((r as { system: object }).system, 'set_relay_state'))
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
  const local = { ...cfg, address: '127.0.0.1', port, timeoutSeconds: 1 }
  expect(await socketSend(local)({ system: { get_sysinfo: {} } })).toEqual(sysinfo([1, 0]))
  server.close()
  server = createServer(() => {})
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const quiet = { ...local, port: (server.address() as { port: number }).port, timeoutSeconds: 0.1 }
  await expect(socketSend(quiet)({})).rejects.toThrow("The power plug at 127.0.0.1 didn't answer")
})

it('says the plug did not answer when nothing listens', async () => {
  server = createServer()
  await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done))
  const port = (server.address() as { port: number }).port
  server.close()
  await expect(socketSend({ ...cfg, address: '127.0.0.1', port })({})).rejects.toThrow(
    "The power plug at 127.0.0.1 didn't answer",
  )
})

it('parses each socket: machine, on or off, how long on', () => {
  const parsed = parseStatus(sysinfo([1, 0]), cfg)
  expect(parsed.model).toBe('EP40(US)')
  expect(parsed.sockets).toEqual([
    { index: 0, id: 'ID00', machine: 'davion-sidarli', on: true, onSeconds: 594 },
    { index: 1, id: 'ID01', machine: 'davion-gem', on: false, onSeconds: null },
  ])
  expect(() => parseStatus({ system: {} }, cfg)).toThrow(Refusal)
  expect(duration(45)).toBe('45 s')
  expect(duration(594)).toBe('9 min')
  expect(duration(7300)).toBe('2 h 1 min')
  expect(duration(200000)).toBe('2 d 7 h')
})

it('knows which socket this computer is wired to', () => {
  expect(ownSocket(cfg, 'davion-sidarli')).toBe(0)
  expect(ownSocket(cfg, 'Davion-Gem.lan')).toBe(1)
  expect(ownSocket(cfg, 'aico')).toBe(1)
  expect(ownSocket(cfg, 'laptop')).toBeNull()
})

it('prints the status, marking this computer', async () => {
  const h = harness('davion-sidarli', [1, 0])
  expect(await plug([], h.deps)).toBe(0)
  expect(h.lines).toEqual([
    'Power plug at 192.168.87.217 (EP40(US))',
    '  0  davion-sidarli  on   for 9 min  (this computer)',
    '  1  davion-gem      off',
  ])
  expect(h.switches()).toEqual([])
})

it('refuses to switch off or cycle its own socket without --force, and says why', async () => {
  for (const verb of ['off', 'cycle']) {
    const h = harness('aico')
    const refusal = await plug([verb, 'davion-gem'], h.deps).catch((e) => e)
    expect(refusal).toBeInstanceOf(Refusal)
    expect(refusal.message).toContain('davion-gem is this computer')
    expect(refusal.message).toContain('cut this computer')
    expect(h.switches()).toEqual([])
  }
  const forced = harness('aico')
  await plug(['off', '1', '--force'], forced.deps)
  expect(forced.switches()).toHaveLength(1)
  // On is always fine, and the other machine's socket is not protected.
  const other = harness('aico', [0, 0])
  await plug(['on', 'davion-gem'], other.deps)
  await plug(['off', 'davion-sidarli'], other.deps)
  expect(other.states).toEqual([0, 1])
})

it('cycles another machine: off, wait, on', async () => {
  const h = harness('aico')
  expect(await plug(['cycle', 'davion-sidarli'], h.deps)).toBe(0)
  expect(h.slept).toEqual([10])
  expect(h.switches()).toEqual([
    { context: { child_ids: ['ID00'] }, system: { set_relay_state: { state: 0 } } },
    { context: { child_ids: ['ID00'] }, system: { set_relay_state: { state: 1 } } },
  ])
  const quick = harness('aico')
  await plug(['cycle', '0', '--wait', '3'], quick.deps)
  expect(quick.slept).toEqual([3])
})

it('rejects bad input with exit code 2 and plain words', async () => {
  const h = harness('aico')
  const code = async (argv: string[]) =>
    ((await plug(argv, h.deps).catch((e) => e)) as Refusal).code
  expect(await code(['off'])).toBe(2)
  expect(await code(['off', 'nobody'])).toBe(2)
  expect(await code(['off', '7'])).toBe(2)
  expect(await code(['toggle', '0'])).toBe(2)
  expect(await code(['on', '0', '--bogus'])).toBe(2)
  expect(await code(['cycle', '0', '--wait', 'x'])).toBe(2)
  expect(h.switches()).toEqual([])
})

it('reports a plug that refuses the switch', async () => {
  const h = harness('aico')
  h.deps.send = async (request) =>
    (request as { system: { set_relay_state?: unknown } }).system.set_relay_state
      ? { system: { set_relay_state: { err_code: -1 } } }
      : sysinfo([1, 1])
  await expect(plug(['off', '0'], h.deps)).rejects.toThrow('refused to switch davion-sidarli off')
})
