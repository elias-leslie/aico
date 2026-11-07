import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@aico/session-engine/store'
import { toolCallDoing } from '@aico/session-engine/tui/adapters/agy-doing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lastSentence, promptName, toolDoing } from './doing'
import { History } from './history'
import { clip } from './types'

// Fake token built in pieces. A cut that lands inside it must not leave a readable part.
const token = `ghp_${'Fake0123456789abcdefghijklmnopqrstuv'}`
const SHOWN = /ghp_|Fake01|klmnopqrstuv/

describe('masking comes before any cut', () => {
  it('event text clipped at 4000 characters', () => {
    const text = `${'a '.repeat(1996)}${token} tail`
    expect(text.indexOf(token)).toBeLessThan(4000)
    expect(text.indexOf(token) + token.length).toBeGreaterThan(4000)
    expect(clip(text)).not.toMatch(SHOWN)
  })

  it('a command line in the doing-now words', () => {
    const command = `${'x'.repeat(385)} ${token}`
    expect(String(toolDoing('Bash', { command }))).not.toMatch(SHOWN)
    expect(String(toolDoing('exec_command', { cmd: `${'y'.repeat(60)} ${token}` }))).not.toMatch(
      SHOWN,
    )
  })

  it('the last sentence and the name of a long message', () => {
    const long = `${'word '.repeat(300)}${token}`
    const cutIn = long.length - token.length + 3
    expect(String(lastSentence(long.slice(0, cutIn + 1500)))).not.toMatch(SHOWN)
    const tailOnly = `${token}${'b'.repeat(1490)}`
    expect(String(lastSentence(`${'q'.repeat(3000)}${token}`))).not.toMatch(SHOWN)
    expect(String(lastSentence(tailOnly))).not.toMatch(SHOWN)
    expect(String(promptName(`${'n'.repeat(590)}${token}`))).not.toMatch(SHOWN)
    expect(String(promptName(`${'n'.repeat(60)} ${token}`))).not.toMatch(SHOWN)
  })

  it('the agy doing-now line', () => {
    const said = `${'a'.repeat(100)} ${token}`
    const bytes = Buffer.concat([
      Buffer.from('call_3516449928796323800'),
      Buffer.from([0x12, 11]),
      Buffer.from('run_command'),
      Buffer.from([0x1a, 0x7f]),
      Buffer.from(JSON.stringify({ toolAction: said })),
    ])
    expect(String(toolCallDoing(bytes))).not.toMatch(SHOWN)
  })
})

describe('a pushed Aico chat title', () => {
  let home: string
  let store: Store
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mask-'))
    store = new Store(':memory:')
  })
  afterEach(() => {
    store.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('is masked like every other title', () => {
    const history = new History(store.db, { homes: [home], now: () => Date.now(), skip: [] })
    const kept = history.record({
      runId: '6f20c425-600a-4119-8229-302e58fc6d17',
      cwd: '/work/demo',
      role: 'implementation',
      startedAt: Date.now() - 5000,
      endedAt: null,
      outcome: null,
      tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      toolCalls: 0,
      turns: [],
      chat: { title: `use ${token} now`, state: 'idle', updatedAt: Date.now() },
    } as never)
    expect(kept).toBe(true)
    const rows = store.db.prepare('SELECT title FROM transcripts').all() as { title: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).not.toMatch(SHOWN)
    expect(rows[0].title).toContain('hidden')
  })
})
