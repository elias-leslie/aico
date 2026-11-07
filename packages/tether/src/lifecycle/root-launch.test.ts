import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TuiSpec } from '@aico/session-engine/tui/spec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initialLaunchLine, rootLaunchEnvironment, withRootPrompt } from './root-launch'
import { initStore } from './testing'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** A tool that prints the arguments it was launched with. */
function echoTool(resume: NonNullable<TuiSpec['resume']>): TuiSpec {
  return {
    slug: 'echo-args',
    displayName: 'Echo',
    icon: '',
    accent: '',
    order: 0,
    enabled: true,
    command: ['node', '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'],
    processName: 'node',
    resume,
  }
}

/** The arguments the launch line gives the tool for a first launch with this prompt
 * (a plain session with a launch prompt takes the same line as a root). */
async function launchedArgs(spec: TuiSpec, prompt: string): Promise<string[]> {
  const widgetId = 'echo-widget'
  let out = ''
  await withRootPrompt(widgetId, prompt, async () => {
    const line = initialLaunchLine(widgetId, spec) as string
    out = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...rootLaunchEnvironment(widgetId) },
      encoding: 'utf8',
    })
  })
  return JSON.parse(out)
}

describe('launch prompt introducer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'root-launch-'))
  beforeAll(() => {
    initStore(join(dir, 'catalog.db'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('puts the prompt after `--` by default', async () => {
    const spec = echoTool({ sessionIdPattern: UUID, arguments: ['--session'] })
    expect(await launchedArgs(spec, 'hello there')).toEqual(['--', 'hello there'])
  })

  it("puts it after the tool's own flag when the adapter names one (agy's -i)", async () => {
    const spec = echoTool({
      sessionIdPattern: UUID,
      arguments: ['--conversation'],
      promptArguments: ['-i'],
    })
    expect(await launchedArgs(spec, 'hello there')).toEqual(['-i', 'hello there'])
  })
})
