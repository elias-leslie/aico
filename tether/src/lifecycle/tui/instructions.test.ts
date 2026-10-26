import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { blankSlateBase, forWorkspace } from './blank-slate'
import { staticContextStatus } from './context'
import {
  instructionsDir,
  parseInstructions,
  saveInstructions,
  sessionInstructions,
  withInstructions,
} from './instructions'
import { launchLine, resumeLaunchLine } from './launch'
import { INSTRUCTION_ADAPTERS, RESUME_ADAPTERS } from './registry'
import type { TuiSpec } from './spec'

const snapshot = {
  prompt: 'code-reviewer',
  name: 'Code Reviewer',
  revision: '20110df2-9d3f-4e0d-85af-38d9b844a282',
  contentHash: 'abc123',
  createdAt: '2026-07-16T19:04:58Z',
  content: 'Review "carefully".\nKeep $HOME and `ticks` literal.',
}

const homes: string[] = []
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'tether-instructions-'))
  homes.push(dir)
  return { HOME: dir, TETHER_LIB_DIR: '/opt/tether' }
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tool = (slug: string, command: string[]): TuiSpec =>
  ({
    slug,
    command,
    instructions: INSTRUCTION_ADAPTERS[slug],
    resume: RESUME_ADAPTERS[slug],
  }) as unknown as TuiSpec

/** The argv a launch line hands its command, with the command swapped for printf. */
function launchedArgs(line: string): string[] {
  const out = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
    encoding: 'utf8',
  })
  return out.split('\0').slice(0, -1)
}

describe('chosen instructions', () => {
  it('accepts an Agent Hub revision snapshot and refuses anything else', () => {
    expect(parseInstructions(snapshot)).toEqual(snapshot)
    expect(
      parseInstructions({ ...snapshot, contentHash: undefined, createdAt: undefined }),
    ).toEqual({ ...snapshot, contentHash: null, createdAt: null })
    for (const bad of [
      null,
      'code-reviewer',
      { ...snapshot, extra: 1 },
      { ...snapshot, revision: '20110df2' },
      { ...snapshot, prompt: '../etc' },
      { ...snapshot, name: 'two\nlines' },
      { ...snapshot, content: '  ' },
      { ...snapshot, content: "a ''' b" },
      { ...snapshot, content: 'bell\u0007' },
      { ...snapshot, content: 'x'.repeat(64 * 1024 + 1) },
    ])
      expect(parseInstructions(bad)).toBeNull()
  })

  it('keeps one private snapshot per session and reads back only its revision', () => {
    const env = home()
    expect(sessionInstructions('aaaa0001', env)).toBeNull()
    saveInstructions('aaaa0002', snapshot, env)
    const { content, ...summary } = snapshot
    expect(sessionInstructions('aaaa0002', env)).toEqual(summary)
    expect(readFileSync(join(instructionsDir(env), 'aaaa0002.md'), 'utf8')).toBe(content)
    expect(statSync(join(instructionsDir(env), 'aaaa0002.md')).mode & 0o777).toBe(0o600)
  })

  it('adds the content through each tool adapter, read from the file at launch', () => {
    const env = home()
    saveInstructions('aaaa0003', snapshot, env)
    const printf = (slug: string) => tool(slug, ['printf', '%s\\0', '--first'])
    for (const slug of ['claude-code', 'pi']) {
      const args = launchedArgs(launchLine(withInstructions(printf(slug), 'aaaa0003', env)) ?? '')
      expect(args).toEqual(['--first', '--append-system-prompt', snapshot.content])
    }
    const codex = launchedArgs(launchLine(withInstructions(printf('codex'), 'aaaa0003', env)) ?? '')
    expect(codex).toEqual(['--first', '-c', `developer_instructions='''${snapshot.content}'''`])
  })

  it('puts the instructions before resume arguments and inside Blank Slate', () => {
    const env = home()
    saveInstructions('aaaa0004', snapshot, env)
    const file = join(instructionsDir(env), 'aaaa0004.md')
    const codex = withInstructions(tool('codex', ['codex', '--yolo']), 'aaaa0004', env)
    expect(resumeLaunchLine(codex)).toBe(
      `/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo -c "developer_instructions='''$(cat ${file})'''" resume --no-daemon`,
    )
    const root = join(blankSlateBase(env), 'b8f2')
    const blank = withInstructions(
      forWorkspace(tool('claude-code', ['claude', '--x']), root, env),
      'aaaa0004',
      env,
    )
    expect(launchLine(blank)).toBe(
      `/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 /opt/tether/scripts/aico-blank-slate claude-code --x --append-system-prompt "$(cat ${file})"`,
    )
    expect(staticContextStatus(blank)?.detail).toContain(
      'Blank Slate with chosen instructions code-reviewer@20110df2',
    )
  })

  it('leaves sessions without a snapshot, and tools without an adapter, unchanged', () => {
    const env = home()
    const claude = tool('claude-code', ['claude'])
    expect(withInstructions(claude, 'aaaa0005', env)).toBe(claude)
    saveInstructions('aaaa0006', snapshot, env)
    const agy = tool('agy', ['agy'])
    expect(withInstructions(agy, 'aaaa0006', env)).toBe(agy)
    const shell = tool('claude-code', [])
    expect(withInstructions(shell, 'aaaa0006', env)).toBe(shell)
  })
})
