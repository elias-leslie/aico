import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureContext } from './context'
import { launchLine, paneCommand } from './launch'
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
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

// Drive resolveLauncher's `bash -lc 'command -v <name>'` probe: a non-null path
// resolves on the login shell, null means not found (execFile errors).
function mockLoginResolve(path: string | null): void {
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
  vi.mocked(execFile).mockImplementation(((
    command: string,
    _args: string[],
    _opts: unknown,
    cb: unknown,
  ) => {
    const callback = cb as (e: Error | null, out: string, err: string) => void
    if (command === 'bash') {
      callback(null, `${path}\n`, '')
    } else {
      const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
      const hooks = events.map(({ eventName, trusted = true }) => ({
        eventName,
        command: `${client} hook --surface codex`,
        enabled: true,
        trustStatus: trusted ? 'trusted' : 'untrusted',
      }))
      callback(
        null,
        `${JSON.stringify({ id: 0, result: {} })}\n${JSON.stringify({
          id: 1,
          result: { data: [{ hooks }] },
        })}\n`,
        '',
      )
    }
    return { stdin: { end: vi.fn() } } as never
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
    const codex = getTui('codex')
    const gemini = getTui('gemini')
    const pi = getTui('pi')
    expect(claude && launchLine(claude)).toBe(
      'env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 claude --dangerously-skip-permissions',
    )
    expect(codex && launchLine(codex)).toBe(
      'env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
    expect(gemini && launchLine(gemini)).toBe(
      'env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 gemini --yolo --skip-trust',
    )
    expect(pi && launchLine(pi)).toBe('env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 pi --approve')
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
      'env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 codex --yolo',
    )
  })

  it('returns null for a bare shell (empty command)', () => {
    expect(launchLine(spec({ command: [] }))).toBeNull()
  })

  it('exports per-TUI env inline before the command', () => {
    expect(launchLine(spec({ command: ['claude'], env: { FOO: 'bar' } }))).toBe(
      'env -u NO_COLOR COLORTERM=truecolor CLICOLOR=1 FOO=bar claude',
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

describe('ensureContext', () => {
  it('passes through when a TUI declares no hook', async () => {
    expect(await ensureContext(spec({ context: undefined }))).toEqual({
      state: 'ok',
      detail: 'no context hook',
    })
  })

  it('reports ok when the login-shell claude resolves to a context wrapper', async () => {
    vi.mocked(existsSync).mockReturnValue(true) // hook present + resolved path exists
    mockLoginResolve('/home/demo/.claude/bin/claude')
    vi.mocked(readFileSync).mockReturnValue(
      'exec "$REAL_CLAUDE" --append-system-prompt-file "$CONTEXT_FILE" "$@"\n',
    )
    const s = await ensureContext(spec({ context: { kind: 'claude-session-start' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('--append-system-prompt-file')
  })

  it('reports missing when the login-shell claude is the stock upstream binary', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockLoginResolve('/home/demo/.local/bin/claude') // a claude resolves, but not the wrapper
    vi.mocked(readFileSync).mockReturnValue('\x7fELF stock claude binary bytes\n')
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports missing when claude is not on the login-shell PATH', async () => {
    vi.mocked(existsSync).mockReturnValue(true) // hook present
    mockLoginResolve(null) // login shell finds no claude
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports missing when the Claude SessionStart hook is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect((await ensureContext(spec({ context: { kind: 'claude-session-start' } }))).state).toBe(
      'missing',
    )
  })

  it('reports ok for trusted native Codex startup and subagent hooks', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart' },
    ])
    const s = await ensureContext(spec({ context: { kind: 'codex-hooks' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('trusted native SessionStart + SubagentStart')
  })

  it('reports missing when a required native Codex hook is untrusted', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [
      { eventName: 'sessionStart' },
      { eventName: 'subagentStart', trusted: false },
    ])
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports missing when the native Codex subagent hook is absent', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    mockCodexHooks('/home/demo/.local/bin/codex', [{ eventName: 'sessionStart' }])
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports missing when codex is not on the login-shell PATH', async () => {
    mockLoginResolve(null)
    expect((await ensureContext(spec({ context: { kind: 'codex-hooks' } }))).state).toBe('missing')
  })

  it('reports ok when Gemini settings declare the canonical BeforeAgent hook', async () => {
    vi.mocked(existsSync).mockReturnValue(true)
    const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        hooks: {
          BeforeAgent: [
            { hooks: [{ type: 'command', command: `${client} hook --surface gemini` }] },
          ],
        },
      }),
    )
    const s = await ensureContext(spec({ context: { kind: 'gemini-hooks' } }))
    expect(s.state).toBe('ok')
    expect(s.detail).toContain('BeforeAgent')
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
      'pi.on("before_agent_start", () => event.systemPrompt + contract.rendered)',
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
