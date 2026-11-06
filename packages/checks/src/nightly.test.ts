import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Coordination } from './hook'
import { deepStages, type GateResult, nightly, runDeep, summary } from './nightly'
import { loadConfig } from './plan'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(toml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'aico-nightly-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, '.st-check.toml'), toml)
  return root
}

const node = JSON.stringify(process.execPath)
const deepToml = `[native]\nlegacy_tools = []\n
[[deep.stages]]\nid = "ok"\nargv = [${node}, "-e", "console.log('PASS 3 checks')"]\n
[[deep.stages]]\nid = "bad"\nargv = [${node}, "-e", "console.log('FAIL socket gone'); process.exit(1)"]\ntimeout_seconds = 30\n`

const gate = (over: Partial<GateResult> = {}): GateResult => ({
  passed: true,
  ms: 142_400,
  sha: 'abcdef1234567890',
  results: [
    { id: 'vitest', state: 'pass', ms: 87_000, required: true },
    { id: 'tsc', state: 'pass', ms: 7_000, required: true },
    { id: 'biome', state: 'pass', ms: 3_000, required: true },
    { id: 'cargo-tray', state: 'skip', ms: 0, required: true },
    { id: 'dead-code', state: 'pass', ms: 300, required: true },
  ],
  ...over,
})

const noCoordination = {} as Coordination

describe('nightly deep lane', () => {
  it('reads the deep stages and runs one, keeping its last line', async () => {
    const root = repo(deepToml)
    const stages = deepStages(root)
    expect(stages.map((s) => [s.id, s.timeoutS])).toEqual([
      ['ok', 600],
      ['bad', 30],
    ])
    const lines: string[] = []
    const bad = await runDeep(root, stages[1], process.env, (l) => lines.push(l))
    expect(bad).toMatchObject({ id: 'bad', passed: false, last: 'FAIL socket gone' })
    expect(lines).toContain('  bad: FAIL socket gone')
    expect((await runDeep(root, stages[0], process.env, () => {})).passed).toBe(true)
  })

  it('names a failed stage by its error line, not its trailing output', async () => {
    const root = repo('')
    const script =
      "console.log('src/a.ts(3,1): error TS2304: Cannot find name x'); console.log('Done in 13ms'); process.exit(2)"
    const result = await runDeep(
      root,
      { id: 'build', argv: [process.execPath, '-e', script], timeoutS: 30 },
      process.env,
      () => {},
    )
    expect(result).toMatchObject({
      passed: false,
      last: 'src/a.ts(3,1): error TS2304: Cannot find name x',
    })
  })

  it('stops a deep stage at its timeout', async () => {
    const root = repo('')
    const result = await runDeep(
      root,
      { id: 'slow', argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeoutS: 0.2 },
      process.env,
      () => {},
    )
    expect(result).toMatchObject({ passed: false, last: 'stopped after 0.2 s' })
  })

  it('says the gate time against last night, the slowest stages and what failed', () => {
    expect(summary(gate(), [{ id: 'ok', passed: true, ms: 1, last: '' }], 138_000)).toBe(
      'Nightly checks passed: gate passed in 142 s (last night 138 s) at abcdef1234; slowest vitest 87 s, tsc 7 s, biome 3 s. live passed: ok.',
    )
    const failed = gate({
      passed: false,
      results: [{ id: 'tsc', state: 'fail', ms: 7_000, required: true }],
    })
    expect(
      summary(failed, [{ id: 'bad', passed: false, ms: 1, last: 'FAIL socket gone' }], null),
    ).toBe(
      'Nightly checks failed: gate failed (tsc) in 142 s at abcdef1234; slowest tsc 7 s. live failed: bad (FAIL socket gone).',
    )
    expect(summary(gate({ passed: false, refused: 'held by agent x' }), [], null)).toContain(
      'gate did not run: held by agent x. no live checks declared.',
    )
  })

  it('runs the gate then every deep stage, remembers the gate time and fails on any failure', async () => {
    const root = repo(deepToml)
    const config = loadConfig(root)
    if ('unsupported' in config) throw new Error(config.unsupported)
    const ran: string[] = []
    const run = () =>
      nightly({
        config,
        coordination: noCoordination,
        env: process.env,
        out: () => {},
        gate: async () => gate(),
        deep: async (stage) => {
          ran.push(stage.id)
          return { id: stage.id, passed: stage.id === 'ok', ms: 5, last: 'x' }
        },
      })
    const first = await run()
    expect(first.ok).toBe(false)
    expect(ran).toEqual(['ok', 'bad'])
    expect(first.line).not.toContain('last night')
    const second = await run()
    expect(second.line).toContain('(last night 142 s)')
  })
})
