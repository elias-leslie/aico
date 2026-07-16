import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureContext } from './context'
import { effectiveTuiPath, launchLine, paneCommand, paneGatePath } from './launch'
import {
  clearRegistry,
  defaultTui,
  getTui,
  listTuis,
  registerBuiltinTuis,
  registerTui,
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
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: unknown,
  ) => {
    ;(cb as (e: Error | null, out: string, err: string) => void)(
      path ? null : new Error('not found'),
      path ? `${path}\n` : '',
      '',
    )
    return undefined as never
  }) as never)
}

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
  clearRegistry()
  vi.clearAllMocks()
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
  it('registers the built-in TUIs once, idempotently', () => {
    registerBuiltinTuis()
    registerBuiltinTuis() // second call is a no-op, not a duplicate-slug throw
    expect(listTuis().map((t) => t.slug)).toEqual([
      'claude-code',
      'claude-gpt',
      'codex',
      'opencode',
      'gemini',
      'pi',
      'hermes',
      'shell',
    ])
  })

  it('defaults to the lowest-order enabled TUI (Claude Code)', () => {
    registerBuiltinTuis()
    expect(defaultTui().slug).toBe('claude-code')
  })

  it('launches supported agent TUIs with explicit no-prompt execution defaults', () => {
    registerBuiltinTuis()
    const claude = getTui('claude-code')
    const claudeGpt = getTui('claude-gpt')
    const codex = getTui('codex')
    const gemini = getTui('gemini')
    const pi = getTui('pi')
    expect(claude && launchLine(claude)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 claude --dangerously-skip-permissions',
    )
    expect(claudeGpt && launchLine(claudeGpt)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 claude-gpt --dangerously-skip-permissions',
    )
    expect(codex && launchLine(codex)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
    expect(gemini && launchLine(gemini)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 gemini --yolo --skip-trust',
    )
    expect(pi && launchLine(pi)).toBe(
      '/usr/bin/env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 pi --approve',
    )
  })

  it('rejects duplicate slugs', () => {
    registerTui(spec({ slug: 'dup' }))
    expect(() => registerTui(spec({ slug: 'dup' }))).toThrow(/duplicate/)
  })

  it('hides disabled TUIs from listing but keeps them resolvable', () => {
    registerTui(spec({ slug: 'hidden', enabled: false }))
    expect(listTuis()).toHaveLength(0)
    expect(getTui('hidden')?.slug).toBe('hidden')
  })
})

describe('launchLine', () => {
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
  it('passes through when a TUI declares no hook', async () => {
    expect(await ensureContext(spec({ context: undefined }))).toEqual({
      state: 'ok',
      detail: 'no context hook',
    })
  })

  it('reports ok when Claude launcher and lifecycle hooks are canonical', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockPaneResolve('/home/demo/.claude/bin/claude')
    vi.mocked(realpathSync).mockReturnValue(
      '/srv/workspaces/projects/agent-hub/integrations/context-delivery/claude/launcher',
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
        context: { kind: 'claude-session-start' },
        env: { PATH: '/canonical/managed-pane-path' },
      }),
    )
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('lossless context')
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
    vi.mocked(realpathSync).mockReturnValue('/srv/workspaces/projects/codex-config/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'CODEX_REAL AGENT_HUB_CONTEXT_CLIENT developer_instructions=\n',
    )
    const s = await ensureContext(spec({ context: { kind: 'codex-hooks' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('lossless context')
  })

  it('reports missing when a required native Codex hook is untrusted', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart', trusted: false },
    ])
    vi.mocked(realpathSync).mockReturnValue('/srv/workspaces/projects/codex-config/bin/codex')
    vi.mocked(readFileSync).mockReturnValue(
      'CODEX_REAL AGENT_HUB_CONTEXT_CLIENT developer_instructions=\n',
    )
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports missing when the native Codex subagent hook is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [{ eventName: 'sessionStart' }])
    vi.mocked(realpathSync).mockReturnValue('/srv/workspaces/projects/codex-config/bin/codex')
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

  it('reports ok when Gemini settings declare the canonical BeforeModel hook', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        hooks: {
          BeforeModel: [
            { hooks: [{ type: 'command', command: `${client} hook --surface gemini` }] },
          ],
        },
      }),
    )
    const s = await ensureContext(spec({ context: { kind: 'gemini-hooks' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('BeforeModel')
  })

  it('reports missing when Gemini settings retain the legacy Aico shim', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ hooks: { SessionStart: [{ command: '/x/aico-mandates-gemini.sh' }] } }),
    )
    expect((await ensureContext(spec({ context: { kind: 'gemini-hooks' } }))).state).toBe('missing')
  })

  it('reports ok when Pi uses the source-linked additive Agent Hub extension', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue(
      '/srv/workspaces/projects/agent-hub/integrations/context-delivery/pi/agent-hub.ts',
    )
    vi.mocked(readFileSync).mockReturnValue(
      'pi.on("input", () => ({ action: "continue" })); pi.on("before_agent_start", () => event.systemPrompt + contract.rendered); "AH: DEGRADED"',
    )
    const s = await ensureContext(spec({ context: { kind: 'pi-extension' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('canonical additive')
  })

  it('reports missing when the Pi extension is copied or drifted', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(realpathSync).mockReturnValue('/home/demo/.pi/agent/extensions/agent-hub.ts')
    vi.mocked(readFileSync).mockReturnValue('pi.on("before_agent_start", () => {})')
    expect((await ensureContext(spec({ context: { kind: 'pi-extension' } }))).state).toBe('missing')
  })

  it('reports ok when Hermes config declares the Aico pre_llm_call hook', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue(
      'hooks:\n  pre_llm_call:\n    - command: "/x/aico-mandates-hermes.sh"\n',
    )
    const s = await ensureContext(spec({ context: { kind: 'hermes-shell-hooks' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('config.yaml')
  })

  it('reports missing when Hermes config lacks the Aico hook', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    vi.mocked(readFileSync).mockReturnValue('hooks:\n  post_tool_call: []\n')
    expect((await ensureContext(spec({ context: { kind: 'hermes-shell-hooks' } }))).state).toBe(
      'missing',
    )
  })
})
