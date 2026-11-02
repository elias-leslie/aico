import { describe, expect, it } from 'vitest'

import { withOwnWidget } from './own-session'

const tree: Record<number, { env: string; parent: number }> = {
  30: { env: 'PATH=/bin\0HOME=/h', parent: 20 }, // the tool's shell: no widget
  20: { env: 'PATH=/bin\0AICO_WIDGET_ID=0123abcd\0X=1', parent: 10 }, // the harness
  10: { env: 'AICO_WIDGET_ID=ffffffff', parent: 1 },
}
const proc = {
  environ: (pid: number) => {
    const entry = tree[pid]
    if (!entry) throw new Error('gone')
    return entry.env
  },
  parent: (pid: number) => (tree[pid] as { parent: number }).parent,
}

describe('withOwnWidget', () => {
  it('keeps an environment that already names the session', () => {
    const env = { AICO_WIDGET_ID: 'aico-widget-0123abcd' }
    expect(withOwnWidget(env, 30, proc)).toBe(env)
  })

  it('takes the session from the nearest ancestor that holds one', () => {
    expect(withOwnWidget({ PATH: '/bin' }, 30, proc).AICO_WIDGET_ID).toBe('0123abcd')
  })

  it('leaves the environment alone outside Aico or when /proc is unreadable', () => {
    expect(withOwnWidget({}, 99, proc)).toEqual({})
  })
})
