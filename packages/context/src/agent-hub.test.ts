// The Agent Hub source against a stand-in `st` on PATH: rows come from the details
// file, which is removed whether the query passed or failed, and a failure never
// repeats the hint (it quotes row text).

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('reads rows from the details file and removes it', () => {
    writeFileSync(join(dir, 'rows.txt'), '{"a":1}\n{"a":2}\n')
    fakeSt('echo \'DB:OK:0|lines=2|details:rows.txt|hint:{"a":1}\'')
    expect(agentHubSource(dir).rows('SELECT 1')).toEqual(['{"a":1}', '{"a":2}'])
    expect(existsSync(join(dir, 'rows.txt'))).toBe(false)
  })

  it('removes the details file of a failed query and keeps the hint out of the error', () => {
    writeFileSync(join(dir, 'fail.txt'), 'row text\n')
    fakeSt("echo 'DB:FAIL:1|details:fail.txt|hint:row text'")
    expect(() => agentHubSource(dir).rows('SELECT 1')).toThrow(
      /^st db query: DB:FAIL:1\|details:fail.txt$/,
    )
    expect(existsSync(join(dir, 'fail.txt'))).toBe(false)
  })

  it('reports a query that exits with an error by its first stderr line', () => {
    fakeSt("echo 'relation does not exist' >&2; exit 1")
    expect(() => agentHubSource(dir).rows('SELECT 1')).toThrow(
      'st db query failed (exit 1): relation does not exist',
    )
  })
})
