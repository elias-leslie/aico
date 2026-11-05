import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { probeEntryAgent } from './entry-agent'
import { insertWidget } from './lifecycle/catalog'
import { resolveEntry } from './lifecycle/entries'
import { initStore } from './lifecycle/testing'

const ID = 'a9e70001'
const RESUME = '3e0161b0-9591-4f68-a80a-656951537274'
let dir: string
let saved: string | undefined
function configure(script: string) {
  const file = join(dir, 'probe.cjs')
  writeFileSync(file, script)
  writeFileSync(
    join(dir, 'entries.json'),
    JSON.stringify({
      synthetic: {
        argv: ['/bin/true'],
        home: `${dir}/{arg}/home`,
        probe: [process.execPath, file],
      },
    }),
  )
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-entry-probe-'))
  saved = process.env.TETHER_ENTRIES_FILE
  process.env.TETHER_ENTRIES_FILE = join(dir, 'entries.json')
  const store = initStore(join(dir, 'catalog.db'))
  insertWidget(ID, 'pi')
  store.db
    .prepare('INSERT INTO session_entries (session_id,name,arg) VALUES (?,?,?)')
    .run(ID, 'synthetic', 'test-hunt')
})
afterEach(() => {
  if (saved === undefined) delete process.env.TETHER_ENTRIES_FILE
  else process.env.TETHER_ENTRIES_FILE = saved
  rmSync(dir, { recursive: true, force: true })
})
it('runs only the configured probe with the exact entry argument', async () => {
  configure(
    `if(process.argv[2]!=='test-hunt')process.exit(78); console.log(JSON.stringify({running:true,pid:123,resumeId:'${RESUME}'}))`,
  )
  expect(await probeEntryAgent(ID)).toEqual({ kind: 'running', pid: 123, resumeId: RESUME })
})
it('does not infer an agent from a ready entry or an old session file', async () => {
  configure('console.log(JSON.stringify({running:false,pid:null,resumeId:null}))')
  expect(await probeEntryAgent(ID)).toMatchObject({ kind: 'waiting' })
})
it('keeps a failed transient probe retryable and rejects malformed metadata', async () => {
  configure('process.exit(75)')
  expect(await probeEntryAgent(ID)).toMatchObject({ kind: 'waiting' })
  configure(`console.log(JSON.stringify({running:true,pid:null,resumeId:'${RESUME}'}))`)
  expect(await probeEntryAgent(ID)).toMatchObject({ kind: 'failed' })
  configure('process.exit(78)')
  expect(await probeEntryAgent(ID)).toMatchObject({ kind: 'failed' })
})
it('rejects an invalid configured probe instead of silently trusting the entry process', () => {
  writeFileSync(
    join(dir, 'entries.json'),
    JSON.stringify({
      synthetic: {
        argv: ['/bin/true'],
        home: `${dir}/{arg}/home`,
        probe: ['relative'],
      },
    }),
  )
  expect(resolveEntry({ name: 'synthetic', arg: 'test-hunt' }).kind).toBe('invalid_config')
})
