// The importer uses the registered Agent Hub service command; no SQL or row text is logged.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentHubSource } from './agent-hub'

let dir: string
let path: string | undefined
function fakeSt(script: string) {
  writeFileSync(join(dir, 'st'), `#!/bin/sh\n${script}\n`)
  chmodSync(join(dir, 'st'), 0o755)
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-context-'))
  path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
})
afterEach(() => {
  process.env.PATH = path
  rmSync(dir, { recursive: true, force: true })
})
describe('agentHubSource', () => {
  it('pages opaque rows through the registered Agent Hub export command', () => {
    writeFileSync(
      join(dir, 'page0'),
      JSON.stringify({ rows: ['{"a":1}', '{"a":2}'], next_offset: 2 }),
    )
    writeFileSync(join(dir, 'page2'), JSON.stringify({ rows: ['{"a":3}'], next_offset: null }))
    fakeSt('printf "%s\\n" "$*" >> calls; cat "page$5"')
    expect(agentHubSource(dir).rows('memories')).toEqual(['{"a":1}', '{"a":2}', '{"a":3}'])
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'agents context-export memories --offset 0 --limit 1000',
      'agents context-export memories --offset 2 --limit 1000',
    ])
  })
  it('passes the curated role names to the agent dataset', () => {
    fakeSt(`printf "%s" "$*" > calls; echo '{"rows":[],"next_offset":null}'`)
    agentHubSource(dir).rows('agents', ['coder', 'explorer'])
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toContain(
      '--agent-role coder --agent-role explorer',
    )
  })
  it('does not include source row text in command failures', () => {
    fakeSt("echo 'private row text' >&2; exit 1")
    expect(() => agentHubSource(dir).rows('memories')).toThrow(
      'Agent Hub context export failed (exit 1)',
    )
  })
  it.each([
    { rows: ['private row text'], next_offset: 0 },
    { rows: [{ private: 'row text' }], next_offset: null },
  ])('refuses malformed paging without disclosing rows (%j)', (payload) => {
    writeFileSync(join(dir, 'payload'), JSON.stringify(payload))
    fakeSt('cat payload')
    expect(() => agentHubSource(dir).rows('memories')).toThrow(
      'Invalid Agent Hub context export response',
    )
  })
})
