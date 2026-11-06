import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../../store'
import type { AgentTool } from '../../tools'
import { ensureContext } from './context'
import {
  effectiveTuiPath,
  isResumeSessionId,
  launchLine,
  paneCommand,
  paneGatePath,
  resumeLaunchLine,
} from './launch'
import {
  ADAPTERS,
  bindToolSource,
  defaultTui,
  getTui,
  isRootTool,
  listTuis,
  ROOT_TOOLS,
} from './registry'
import type { TuiSpec } from './spec'

// The registry loads every adapter, whose readers use more of node:fs than the
// context checks under test do.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))

// Drive resolveLauncher's no-RC, managed-pane-PATH probe: a non-null path
// resolves exactly as the pane does, null means not found (execFile errors).
function mockPaneResolve(path: string | null): void {
  vi.mocked(execFile).mockImplementation(((
    cmd: string,
    _args: string[],
    _opts: unknown,
    cb: unknown,
  ) => {
    if (cmd !== '/bin/sh') throw new Error(`Unexpected status command: ${cmd}`)
    ;(cb as (e: Error | null, out: string, err: string) => void)(
      path ? null : new Error('not found'),
      path ? `${path}\n` : '',
      '',
    )
    return undefined as never
  }) as never)
}

beforeEach(() => {
  mockPaneResolve(null)
})

function mockCodexHooks(
  path: string,
  events: Array<{ eventName: string; trusted?: boolean; command?: string }>,
): void {
  mockPaneResolve(path)
  vi.mocked(spawn).mockImplementation((() => {
    const process = new EventEmitter() as EventEmitter & {
      stdin: { write: (value: string) => void }
      stdout: EventEmitter
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    process.stdout = new EventEmitter()
    process.stderr = new EventEmitter()
    process.kill = vi.fn()
    process.stdin = {
      write: () => {
        const client = join(homedir(), '.local', 'bin', 'aico-hook')
        const hooks = events.map(({ eventName, trusted = true, command }) => ({
          eventName,
          command: command ?? `${client} codex`,
          enabled: true,
          trustStatus: trusted ? 'trusted' : 'untrusted',
        }))
        queueMicrotask(() => {
          process.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({ id: 0, result: {} })}\n${JSON.stringify({
                id: 1,
                result: { data: [{ hooks }] },
              })}\n`,
            ),
          )
        })
      },
    }
    return process as never
  }) as never)
}

afterEach(() => {
  expect(
    vi
      .mocked(execFile)
      .mock.calls.some(([, args]) => Array.isArray(args) && args.includes('deliver')),
  ).toBe(false)
  vi.unstubAllEnvs()
  bindToolSource(null)
  vi.clearAllMocks()
})

// Aico registered code specs; Tether's registry is the seeded agent_tools table.
function registerBuiltinTuis(): void {
  bindToolSource(new Store(':memory:'))
}

function registerTools(tools: AgentTool[]): void {
  bindToolSource({
    resolveTool: (slug) => tools.find((tool) => tool.slug === slug || tool.aliases.includes(slug)),
    defaultTool: () => tools.find((tool) => tool.enabled && tool.isDefault),
    listTools: (options) => tools.filter((tool) => !options?.enabledOnly || tool.enabled),
  })
}

const tool = (over: Partial<AgentTool>): AgentTool => ({
  id: 'id',
  slug: 'x',
  name: 'X',
  argv: ['x'],
  command: 'x',
  processName: 'x',
  description: null,
  color: null,
  displayOrder: 0,
  isDefault: false,
  enabled: true,
  aliases: [],
  contextHook: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const spec = (over: Partial<TuiSpec> = {}): TuiSpec => ({
  slug: 'x',
  displayName: 'X',
  icon: '•',
  accent: '#000',
  order: 0,
  enabled: true,
  command: ['x'],
  processName: 'x',
  ...over,
})

describe('registry', () => {
  it('serves the seeded agent tools in display order', () => {
    registerBuiltinTuis()
    expect(listTuis().map((t) => t.slug)).toEqual([
      'claude-code',
      'codex',
      'agy',
      'pi',
      'aico-agent',
      'shell',
    ])
  })

  it('defaults to the registry default (Codex, owner decision)', () => {
    registerBuiltinTuis()
    expect(defaultTui().slug).toBe('codex')
  })

  it('launches supported agent TUIs with explicit no-prompt execution defaults', () => {
    registerBuiltinTuis()
    const claude = getTui('claude-code')
    const codex = getTui('codex')
    const antigravity = getTui('agy')
    const pi = getTui('pi')
    expect(claude && launchLine(claude)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 claude --dangerously-skip-permissions',
    )
    expect(codex && launchLine(codex)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
    expect(codex && resumeLaunchLine(codex)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo resume --no-daemon',
    )
    expect(antigravity && launchLine(antigravity)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 agy --dangerously-skip-permissions',
    )
    expect(pi && launchLine(pi)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 pi --approve',
    )
    expect(getTui('claude')?.slug).toBe('claude-code')
    expect(getTui('shell') && launchLine(getTui('shell') as TuiSpec)).toBeNull()
  })

  it('hides disabled tools from listing but keeps them resolvable', () => {
    registerTools([tool({ slug: 'hidden', enabled: false })])
    expect(listTuis()).toHaveLength(0)
    expect(getTui('hidden')?.slug).toBe('hidden')
  })

  it('keeps resume adapters in code, keyed by canonical slug', () => {
    registerTools([tool({ slug: 'codex', argv: ['/opt/codex'] }), tool({ slug: 'other' })])
    expect(getTui('codex')?.resume?.arguments).toEqual(['resume', '--no-daemon'])
    expect(getTui('other')?.resume).toBeUndefined()
  })

  it('makes a tool root-capable exactly when it has a resume adapter', () => {
    expect(ROOT_TOOLS).toEqual(
      ADAPTERS.filter((adapter) => adapter.spec.resume)
        .map((adapter) => adapter.id)
        .sort(),
    )
    expect(ROOT_TOOLS).toEqual(['agy', 'aico-agent', 'claude-code', 'codex', 'pi'])
    for (const slug of ROOT_TOOLS) expect(isRootTool(slug)).toBe(true)
    // Canonical slugs only: the root digest covers the tool string as sent.
    for (const slug of ['claude', 'shell', 'opencode', 'toString', '__proto__', 7])
      expect(isRootTool(slug)).toBe(false)
  })
})

describe('launchLine', () => {
  it('uses declarative native resume capability independently of the tool slug', () => {
    const tool = spec({
      command: ['fixture', '--configured'],
      resume: { sessionIdPattern: /^native:[a-z]+$/, arguments: ['--resume'] },
    })
    expect(isResumeSessionId(tool, 'native:saved')).toBe(true)
    expect(isResumeSessionId(tool, 'native:saved;echo unsafe')).toBe(false)
    expect(isResumeSessionId(spec(), 'native:saved')).toBe(false)
    expect(resumeLaunchLine(tool)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 fixture --configured --resume',
    )
    expect(resumeLaunchLine(spec())).toBeNull()
    registerBuiltinTuis()
    expect(isResumeSessionId(getTui('codex'), '00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isResumeSessionId(getTui('codex'), 'last')).toBe(false)
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(
        isResumeSessionId(getTui('codex'), `00000000-0000-4000-8000-000000000001${suffix}`),
      ).toBe(false)
    }
    expect(isResumeSessionId(getTui('claude-code'), 'native:saved')).toBe(false)
    expect(isResumeSessionId(getTui('antigravity'), 'native:saved')).toBe(false)
  })
  it('joins argv into the command typed at the session', () => {
    expect(launchLine(spec({ command: ['codex', '--yolo'] }))).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
  })

  it('returns null for a bare shell (empty command)', () => {
    expect(launchLine(spec({ command: [] }))).toBeNull()
  })

  it('exports per-TUI env inline before the command', () => {
    expect(launchLine(spec({ command: ['claude'], env: { FOO: 'bar' } }))).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 FOO=bar claude',
    )
  })
})

describe('paneCommand', () => {
  it('replaces the verified gate with the real interactive shell for a shell widget', () => {
    expect(paneCommand(null)).toBe(`exec "\${SHELL:-/bin/bash}"`)
  })

  it('runs the TUI then execs an interactive shell so the pane survives its exit', () => {
    expect(paneCommand('env -u NO_COLOR claude')).toBe(
      `exec /bin/bash --noprofile --norc -c 'printf '\\''\\033[3J\\033[H\\033[2J'\\''; { read -r tether_adj </proc/self/oom_score_adj && echo 100 >/proc/self/oom_score_adj; } 2>/dev/null; env -u NO_COLOR claude; export TETHER_AGENT_EXIT=$?; { [ -n "$tether_adj" ] && echo "$tether_adj" >/proc/self/oom_score_adj; } 2>/dev/null; exec "\${SHELL:-/bin/bash}"'`,
    )
  })
})

describe('managed pane launcher PATH', () => {
  it('uses the service PATH for both the gate and a TUI without an override', () => {
    const base = { PATH: '/canonical/service/path' }
    expect(paneGatePath(base)).toBe('/canonical/service/path')
    expect(effectiveTuiPath(spec(), base)).toBe(paneGatePath(base))
  })

  it('uses a declarative TUI PATH in both resolution and the launched env command', () => {
    const tool = spec({ env: { PATH: '/tool/override' }, command: ['codex', '--yolo'] })
    expect(effectiveTuiPath(tool, { PATH: '/service/path' })).toBe('/tool/override')
    expect(launchLine(tool)).toContain('PATH=/tool/override codex --yolo')
  })
})

describe('ensureContext', () => {
  it('reports unsupported for an agent with no canonical context adapter', async () => {
    expect(await ensureContext(spec({ context: undefined }))).toEqual({
      state: 'unsupported',
      detail: 'No canonical context adapter is registered; native agent continues.',
    })
  })

  it('treats a bare shell as not applicable', async () => {
    expect((await ensureContext(spec({ command: [], context: undefined }))).state).toBe(
      'not_applicable',
    )
    expect(execFile).not.toHaveBeenCalled()
  })

  it('checks Aico Claude hooks for parent and spawned sessions', async () => {
    const command = '$HOME/.local/bin/aico-hook claude'
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command }] }],
          SubagentStart: [{ hooks: [{ command }] }],
        },
      }),
    )
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'available',
    )
    vi.mocked(readFileSync).mockReturnValue('{}')
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('checks trusted Aico native Codex hooks', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/native/codex', [{ eventName: 'sessionStart' }, { eventName: 'subagentStart' }])
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe(
      'available',
    )
    mockCodexHooks('/native/codex', [
      { eventName: 'sessionStart', trusted: false },
      { eventName: 'subagentStart' },
    ])
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('checks the Aico Pi context extension', async () => {
    vi.mocked(readFileSync).mockReturnValue('aico-hook before_agent_start event.systemPrompt')
    expect((await ensureContext(spec({ context: { kind: 'pi-extension' } }))).state).toBe(
      'available',
    )
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('absent')
    })
    expect((await ensureContext(spec({ context: { kind: 'pi-extension' } }))).state).toBe('missing')
  })
})
