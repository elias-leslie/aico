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
  bindToolSource,
  defaultTui,
  getTui,
  isRootTool,
  listTuis,
  RESUME_ADAPTERS,
  ROOT_TOOLS,
} from './registry'
import type { TuiSpec } from './spec'

vi.mock('node:fs', () => ({
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
    if (cmd !== '/bin/sh') {
      ;(cb as (e: Error | null, out: string, err: string) => void)(
        null,
        `${JSON.stringify({ status: 'ok', payload_hash: 'a'.repeat(64) })}\n`,
        '',
      )
      return undefined as never
    }
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
  vi.stubEnv('TETHER_PROJECTS_DIR', '/opt/projects')
  vi.stubEnv('AGENT_HUB_REPO', '')
  vi.stubEnv('CODEX_CONFIG_REPO', '')
})

function mockCodexHooks(
  path: string,
  events: Array<{ eventName: string; trusted?: boolean }>,
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
        const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
        const hooks = events.map(({ eventName, trusted = true }) => ({
          eventName,
          command: `${client} bind --surface codex`,
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
    expect(listTuis().map((t) => t.slug)).toEqual(['claude-code', 'codex', 'agy', 'pi', 'shell'])
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
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 claude --dangerously-skip-permissions',
    )
    expect(codex && launchLine(codex)).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
    expect(codex && resumeLaunchLine(codex)).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo resume --no-daemon',
    )
    expect(antigravity && launchLine(antigravity)).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 agy --dangerously-skip-permissions',
    )
    expect(pi && launchLine(pi)).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 pi --approve',
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
    expect(ROOT_TOOLS).toEqual(Object.keys(RESUME_ADAPTERS).sort())
    expect(ROOT_TOOLS).toEqual(['claude-code', 'codex'])
    expect(isRootTool('codex')).toBe(true)
    // Canonical slugs only: the root digest covers the tool string as sent.
    for (const slug of ['claude', 'pi', 'agy', 'shell', 'toString', '__proto__', 7])
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
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 fixture --configured --resume',
    )
    expect(resumeLaunchLine(spec())).toBeNull()
    registerBuiltinTuis()
    expect(isResumeSessionId(getTui('codex'), '00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isResumeSessionId(getTui('codex'), 'last')).toBe(false)
    for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      expect(
        isResumeSessionId(getTui('codex'), '00000000-0000-4000-8000-000000000001' + suffix),
      ).toBe(false)
    }
    expect(isResumeSessionId(getTui('claude-code'), 'native:saved')).toBe(false)
    expect(isResumeSessionId(getTui('antigravity'), 'native:saved')).toBe(false)
  })
  it('joins argv into the command typed at the session', () => {
    expect(launchLine(spec({ command: ['codex', '--yolo'] }))).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
  })

  it('returns null for a bare shell (empty command)', () => {
    expect(launchLine(spec({ command: [] }))).toBeNull()
  })

  it('exports per-TUI env inline before the command', () => {
    expect(launchLine(spec({ command: ['claude'], env: { FOO: 'bar' } }))).toBe(
      '/usr/bin/choom -n 100 -- /usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 FOO=bar claude',
    )
  })
})

describe('paneCommand', () => {
  it('replaces the verified gate with the real interactive shell for a shell widget', () => {
    expect(paneCommand(null)).toBe(`exec "\${SHELL:-/bin/bash}"`)
  })

  it('runs the TUI then execs an interactive shell so the pane survives its exit', () => {
    expect(paneCommand('env -u NO_COLOR claude')).toBe(
      `exec /bin/bash --noprofile --norc -c 'printf '\\''\\033[3J\\033[H\\033[2J'\\''; env -u NO_COLOR claude; exec "\${SHELL:-/bin/bash}"'`,
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

  it('reports ok when Claude launcher and lifecycle hooks are canonical', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockPaneResolve('/home/demo/.claude/bin/claude')
    vi.mocked(realpathSync).mockReturnValue(
      '/opt/projects/agent-hub/integrations/context-delivery/claude/launcher',
    )
    vi.mocked(readFileSync).mockImplementation(((path: string) => {
      if (path.endsWith('settings.json')) {
        const command = `${join(homedir(), '.local', 'bin', 'agent-hub-context-client')} bind --surface claude_code`
        return JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ command }] }],
            SubagentStart: [{ hooks: [{ command }] }],
          },
        })
      }
      return 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 exec "$REAL_CLAUDE" "--add-dir" "$CONTEXT_DIR" # CLAUDE.md\n'
    }) as never)
    const s = await ensureContext(
      spec({
        command: ['claude', '--dangerously-skip-permissions'],
        context: { kind: 'claude-session-start' },
        env: { PATH: '/canonical/managed-pane-path' },
      }),
    )
    expect(s.state).toBe('available')
    expect(s.detail).toContain('canonical additive Claude launcher')
    expect(s.detail).toContain('canonical context available')
    expect(execFile).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'command -v -- "$1"', 'aico-resolve-launcher', 'claude'],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: '/canonical/managed-pane-path' }),
      }),
      expect.any(Function),
    )
  })

  it('reports missing when the managed pane resolves the stock upstream Claude binary', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockPaneResolve('/home/demo/.local/bin/claude') // a claude resolves, but not the wrapper
    vi.mocked(realpathSync).mockReturnValue('/home/demo/.local/bin/claude')
    vi.mocked(readFileSync).mockReturnValue('\x7fELF stock claude binary bytes\n')
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports missing when claude is not on the managed pane PATH', async () => {
    vi.mocked(existsSync).mockReturnValue(true) // hook present
    mockPaneResolve(null) // managed pane PATH finds no claude
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports missing when Claude settings or client is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports ok for lossless Codex launcher and trusted native bindings', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart' },
    ])
    vi.mocked(realpathSync).mockReturnValue('/opt/projects/codex-config/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'CODEX_REAL AGENT_HUB_CONTEXT_CLIENT developer_instructions=\n',
    )
    const s = await ensureContext(spec({ context: { kind: 'codex-hooks' } }))
    expect(s.state).toBe('available')
    expect(s.detail).toContain('lossless context')
  })

  it('reports missing when a required native Codex hook is untrusted', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart', trusted: false },
    ])
    vi.mocked(realpathSync).mockReturnValue('/opt/projects/codex-config/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'CODEX_REAL AGENT_HUB_CONTEXT_CLIENT developer_instructions=\n',
    )
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports missing when the native Codex subagent hook is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [{ eventName: 'sessionStart' }])
    vi.mocked(realpathSync).mockReturnValue('/opt/projects/codex-config/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'CODEX_REAL AGENT_HUB_CONTEXT_CLIENT developer_instructions=\n',
    )
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports missing when Codex resolves to a legacy context-replacing wrapper', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.codex/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart' },
    ])
    vi.mocked(realpathSync).mockReturnValue('/home/demo/.codex/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'exec "$CODEX_REAL" -c model_instructions_file="$CONTEXT_FILE" "$@"\n',
    )
    const status = await ensureContext(spec({ context: { kind: 'codex-hooks' } }))
    expect(status.state).toBe('missing')
    expect(status.detail).toContain('canonical lossless additive Codex launcher')
  })

  it('reports missing when codex is not on the managed pane PATH', async () => {
    mockPaneResolve(null)
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('shows degraded status when the adapter is installed but live delivery fails', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue(
      '/opt/projects/agent-hub/integrations/context-delivery/pi/agent-hub.ts',
    )
    vi.mocked(readFileSync).mockReturnValue(
      'pi.on("input", () => ({ action: "continue" })); pi.on("before_agent_start", () => event.systemPrompt + contract.rendered); "AH: DEGRADED"',
    )
    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(new Error('Agent Hub unavailable'), '', 'delivery unavailable')
      return undefined as never
    }) as never)

    const status = await ensureContext(spec({ context: { kind: 'pi-extension' } }))

    expect(status.state).toBe('missing')
    expect(status.detail).toContain(
      'Agent Hub live delivery unavailable or unconfirmed; native model continues',
    )
    expect(status.detail).toContain('delivery unavailable')
  })

  it('reports ok when Pi uses the source-linked additive Agent Hub extension', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue(
      '/opt/projects/agent-hub/integrations/context-delivery/pi/agent-hub.ts',
    )
    vi.mocked(readFileSync).mockReturnValue(
      'pi.on("input", () => ({ action: "continue" })); pi.on("before_agent_start", () => event.systemPrompt + contract.rendered); "AH: DEGRADED"',
    )
    const s = await ensureContext(spec({ context: { kind: 'pi-extension' } }))
    expect(s.state).toBe('available')
    expect(s.detail).toContain('canonical additive')
  })

  it('reports missing when the Pi extension is copied or drifted', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue('/home/demo/.pi/agent/extensions/agent-hub.ts')
    vi.mocked(readFileSync).mockReturnValue('pi.on("before_agent_start", () => {})')
    expect((await ensureContext(spec({ context: { kind: 'pi-extension' } }))).state).toBe('missing')
  })

  it('says where checkouts are looked for instead of guessing ~/projects', async () => {
    vi.stubEnv('TETHER_PROJECTS_DIR', '')
    vi.mocked(existsSync).mockReturnValue(true)
    for (const context of [
      { kind: 'pi-extension' as const },
      { kind: 'claude-session-start' as const },
      { kind: 'codex-hooks' as const },
      { kind: 'canonical-retrieval' as const, surface: 'antigravity' as const },
    ]) {
      const status = await ensureContext(spec({ command: ['agent'], context }))
      expect(status.state).toBe('missing')
      expect(status.detail).toContain('TETHER_PROJECTS_DIR is not set')
      expect(status.detail).not.toContain('/projects/')
    }
  })

  it('uses a checkout named directly even without TETHER_PROJECTS_DIR', async () => {
    vi.stubEnv('TETHER_PROJECTS_DIR', '')
    vi.stubEnv('AGENT_HUB_REPO', '/opt/projects/agent-hub')
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue(
      '/opt/projects/agent-hub/integrations/context-delivery/pi/agent-hub.ts',
    )
    vi.mocked(readFileSync).mockReturnValue(
      'pi.on("input", () => ({ action: "continue" })); pi.on("before_agent_start", () => event.systemPrompt + contract.rendered); "AH: DEGRADED"',
    )
    const status = await ensureContext(spec({ context: { kind: 'pi-extension' } }))
    expect(status.state).toBe('available')
  })
})
