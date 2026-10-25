// The desktop bridge's D-Bus interface for compositor.ts: bus name watching,
// calls and signals, decoded to plain values. Contract: docs/desktop-bridge.md
// and dev.summitflow.DesktopBridge.xml in the desktop-automation repo.

import * as dbusNative from '@homebridge/dbus-native'
import type {
  BridgeSignal,
  BridgeTransport,
  BridgeWindow,
  MonitorInfo,
  Point,
  Rect,
} from './compositor'

const NAME = 'dev.summitflow.DesktopBridge'
const PATH = '/dev/summitflow/DesktopBridge'
const DBUS = 'org.freedesktop.DBus'

// The package's own typings stop at systemBus; this is the part used here.
interface Message {
  type: number
  sender?: string
  path?: string
  interface?: string
  member?: string
  body?: unknown[]
}
interface Bus {
  connection: {
    on(event: 'message', listener: (message: Message) => void): void
    on(event: 'error' | 'end', listener: (error?: Error) => void): void
  }
  invoke(
    message: {
      destination: string
      path: string
      interface: string
      member: string
      signature?: string
      body?: unknown[]
    },
    callback: (
      error: { name?: string; message?: string } | null | undefined,
      ...out: unknown[]
    ) => void,
  ): void
  addMatch(rule: string, callback: (error?: Error) => void): void
}
const sessionBus = (dbusNative as unknown as { sessionBus(): Bus }).sessionBus
const SIGNAL = 4

type Variant = [unknown, [unknown]]
type Dict = Record<string, unknown>

/** An `a{sv}`: dbus-native hands it over as [key, [types, [value]]] entries. */
function decodeDict(entries: unknown): Dict {
  const out: Dict = {}
  if (!Array.isArray(entries)) return out
  for (const entry of entries as [string, Variant][]) out[entry[0]] = entry[1]?.[1]?.[0]
  return out
}

const num = (v: unknown): number => Number(v)

function windowFromDict(d: Dict): BridgeWindow {
  return {
    id: num(d.id),
    pid: num(d.pid),
    title: String(d.title ?? ''),
    rect: { x: num(d.x), y: num(d.y), width: num(d.w), height: num(d.h) },
    minimized: d.minimized === true,
    maximized: d.maximized === true,
    fullscreen: d.fullscreen === true,
    focused: d.focused === true,
    workspace: num(d.workspace ?? 0),
    monitor: num(d.monitor ?? 0),
  }
}

/** A WindowChanged carries only what changed; a rect change carries all of x,y,w,h. */
function patchFromDict(d: Dict): Partial<BridgeWindow> {
  const patch: Partial<BridgeWindow> = {}
  if ('x' in d && 'y' in d && 'w' in d && 'h' in d)
    patch.rect = { x: num(d.x), y: num(d.y), width: num(d.w), height: num(d.h) }
  for (const key of ['minimized', 'maximized', 'fullscreen', 'focused'] as const)
    if (key in d) patch[key] = d[key] === true
  for (const key of ['workspace', 'monitor'] as const) if (key in d) patch[key] = num(d[key])
  if ('title' in d) patch.title = String(d.title)
  return patch
}

function monitorFromDict(d: Dict): MonitorInfo {
  const rect = (x: string, y: string, w: string, h: string): Rect => ({
    x: num(d[x]),
    y: num(d[y]),
    width: num(d[w]),
    height: num(d[h]),
  })
  return {
    id: String(num(d.index)),
    primary: d.primary === true,
    bounds: rect('x', 'y', 'w', 'h'),
    workArea: rect('wa_x', 'wa_y', 'wa_w', 'wa_h'),
    scale: num(d.scale ?? 1),
  }
}

export function signalFromMessage(member: string, body: unknown[]): BridgeSignal | null {
  switch (member) {
    case 'WindowOpened':
      return { type: 'opened', window: windowFromDict(decodeDict(body[0])) }
    case 'WindowClosed':
      return { type: 'closed', id: num(body[0]) }
    case 'WindowChanged':
      return { type: 'changed', id: num(body[0]), fields: patchFromDict(decodeDict(body[1])) }
    case 'MonitorsChanged':
      return { type: 'monitors' }
    case 'ExpectationResolved':
      return {
        type: 'expectation',
        expectationId: String(body[0]),
        windowId: num(body[1]),
        outcome: String(body[2]),
      }
    default:
      return null
  }
}

export function createBridgeTransport(): BridgeTransport {
  let bus: Bus | undefined
  let stopped = false

  function call(
    member: string,
    signature?: string,
    body?: unknown[],
    target: { iface: string; path: string; destination: string } = {
      iface: NAME,
      path: PATH,
      destination: NAME,
    },
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      if (!bus) {
        reject(new Error('no session bus'))
        return
      }
      bus.invoke(
        {
          destination: target.destination,
          path: target.path,
          interface: target.iface,
          member,
          signature,
          body,
        },
        (error, ...out) => {
          if (error) reject(new Error(`${error.name ?? 'dbus'}: ${String(error.message ?? '')}`))
          else resolve(out) // one entry per out argument of the method
        },
      )
    })
  }
  const callDbus = (member: string, signature: string, body: unknown[]) =>
    call(member, signature, body, { iface: DBUS, path: '/org/freedesktop/DBus', destination: DBUS })

  const rows = (value: unknown): Dict[] =>
    Array.isArray(value) ? (value as unknown[]).map(decodeDict) : []

  return {
    start(handlers) {
      try {
        bus = sessionBus()
      } catch (error) {
        console.warn(
          '[aico:compositor] no session bus:',
          error instanceof Error ? error.message : error,
        )
        return
      }
      const b = bus
      let owned = false
      const set = (now: boolean) => {
        if (stopped || now === owned) return
        owned = now
        if (now) handlers.up()
        else handlers.down()
      }
      b.connection.on('error', (error) => {
        console.warn('[aico:compositor] session bus error:', error?.message)
        set(false)
      })
      b.connection.on('end', () => set(false))
      b.connection.on('message', (message) => {
        if (message.type !== SIGNAL || !message.member) return
        const body = message.body ?? []
        if (message.interface === DBUS && message.member === 'NameOwnerChanged') {
          if (body[0] === NAME) set(Boolean(body[2]))
          return
        }
        if (message.interface !== NAME) return
        const signal = signalFromMessage(message.member, body)
        if (signal) handlers.signal(signal)
      })
      b.addMatch(
        `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${NAME}'`,
        () => {},
      )
      b.addMatch(`type='signal',sender='${NAME}',interface='${NAME}'`, () => {})
      callDbus('NameHasOwner', 's', [NAME]).then(
        ([has]) => set(Boolean(has)),
        () => {},
      )
    },
    stop() {
      stopped = true
    },
    async interfaceVersion() {
      const [value] = (await call('Get', 'ss', [NAME, 'InterfaceVersion'], {
        iface: 'org.freedesktop.DBus.Properties',
        path: PATH,
        destination: NAME,
      })) as [[unknown, [unknown]] | undefined]
      return num(value?.[1]?.[0])
    },
    async list() {
      return rows((await call('List'))[0]).map(windowFromDict)
    },
    async monitors() {
      return rows((await call('Monitors'))[0]).map(monitorFromDict)
    },
    async moveResize(id, r) {
      await call('MoveResize', 'tiiii', [id, r.x, r.y, r.width, r.height])
    },
    async activate(id) {
      await call('Activate', 't', [id])
    },
    async expect(pid, token, r, timeoutMs) {
      const [id] = await call('Expect', 'usiiiiu', [
        pid,
        token,
        r.x,
        r.y,
        r.width,
        r.height,
        timeoutMs,
      ])
      return String(id)
    },
    async cancelExpect(expectationId) {
      await call('CancelExpect', 's', [expectationId])
    },
    async pointer(): Promise<Point> {
      // Two out arguments: x and y.
      const [x, y] = await call('Pointer')
      return { x: num(x), y: num(y) }
    },
  }
}
