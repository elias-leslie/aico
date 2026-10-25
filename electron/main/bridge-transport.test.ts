import { describe, expect, it } from 'vitest'
import { signalFromMessage } from './bridge-transport'

// dbus-native decodes a{sv} as [key, [types, [value]]] entries.
const v = (value: unknown): [unknown, [unknown]] => [[{ type: 'x' }], [value]]
const dict = (o: Record<string, unknown>) => Object.entries(o).map(([k, x]) => [k, v(x)])

describe('bridge signals', () => {
  it('decodes WindowOpened into a window', () => {
    const signal = signalFromMessage('WindowOpened', [
      dict({
        id: 7,
        pid: 42,
        title: 'aico [aico w1]',
        x: 10,
        y: 20,
        w: 300,
        h: 200,
        minimized: false,
      }),
    ])
    expect(signal).toMatchObject({
      type: 'opened',
      window: {
        id: 7,
        pid: 42,
        title: 'aico [aico w1]',
        rect: { x: 10, y: 20, width: 300, height: 200 },
        minimized: false,
      },
    })
  })

  it('decodes a rect change only when all four fields come', () => {
    expect(signalFromMessage('WindowChanged', [7, dict({ x: 1, y: 2, w: 3, h: 4 })])).toMatchObject(
      { type: 'changed', id: 7, fields: { rect: { x: 1, y: 2, width: 3, height: 4 } } },
    )
    expect(signalFromMessage('WindowChanged', [7, dict({ minimized: true })])).toEqual({
      type: 'changed',
      id: 7,
      fields: { minimized: true },
    })
  })

  it('decodes closes, monitor changes and expectations; ignores others', () => {
    expect(signalFromMessage('WindowClosed', [9])).toEqual({ type: 'closed', id: 9 })
    expect(signalFromMessage('MonitorsChanged', [])).toEqual({ type: 'monitors' })
    expect(signalFromMessage('ExpectationResolved', ['e1', 7, 'placed'])).toEqual({
      type: 'expectation',
      expectationId: 'e1',
      windowId: 7,
      outcome: 'placed',
    })
    expect(signalFromMessage('Whatever', [])).toBeNull()
  })
})
