import { describe, expect, it } from 'vitest'
import { LegacyATermSessions } from './legacy-aterm'

const A = 'summitflow-70b339cd-93a0-4898-8c4b-3d694ce8e8dc'
const B = 'summitflow-0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

function fake(sessions: string[]) {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-sessions')
      return { stdout: sessions.map((name) => `${name}\t1700000000\t0\n`).join('') }
    if (args[0] === 'display-message') return { stdout: '0\t0\t120\t1\tcopy-mode\n' }
    if (args[0] === 'kill-session') {
      const target = args[2]?.slice(1)
      sessions.splice(sessions.indexOf(target ?? ''), 1)
      return { stdout: '' }
    }
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  return { calls, run }
}

describe('legacy A-Term sessions', () => {
  it('announces a changed list, never the first observation', async () => {
    const live = [A, B, 'aico-0a1b2c3d']
    const { run } = fake(live)
    const changes: string[][] = []
    const legacy = new LegacyATermSessions('/fixture/default', (names) => changes.push(names), run)
    expect((await legacy.list()).map((s) => s.name)).toEqual([A, B])
    await legacy.list()
    expect(changes).toEqual([])
    expect(await legacy.end(B)).toBe(true)
    expect(changes).toEqual([[A]])
    expect(await legacy.end(B)).toBe(false)
    live.splice(0, live.length)
    await legacy.list()
    expect(changes).toEqual([[A], []])
  })

  it('reads the pane mode of an exactly listed session only', async () => {
    const { calls, run } = fake([A])
    const legacy = new LegacyATermSessions('/fixture/default', () => {}, run)
    expect(await legacy.paneMode(A)).toEqual({
      alternateScreen: false,
      mouseReporting: false,
      historySize: 120,
      inMode: true,
      mode: 'copy-mode',
    })
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['display-message', '-p', '-t', `=${A}`])
    expect(await legacy.paneMode(B)).toBeNull()
    expect(await legacy.paneMode('summitflow-x; kill-server')).toBeNull()
  })
})
