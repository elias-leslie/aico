// A-Term's pre-Tether sessions: `summitflow-<uuid>` on the user's DEFAULT tmux
// server (`/tmp/tmux-<uid>/default`). Tether lists them so a client can attach
// or end them, but never adopts, catalogs, reconfigures or starts that server.
// End is `tmux kill-session` against one exact session name, nothing broader.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { terminalClientEnv } from './lifecycle/terminal-env'
import { isATermSessionName } from './lifecycle/tmux'
import { type PaneMode, paneModeArgs, parsePaneMode } from './pane-mode'

const execFileAsync = promisify(execFile)
const TMUX_BIN = '/usr/bin/tmux'
const TIMEOUT_MS = 2_000

export interface LegacySession {
  kind: 'legacy-attach-only'
  name: string
  aTermSessionId: string
  createdAt: number
  attachedClients: number
}

export function defaultATermSocket(uid = process.getuid?.() ?? -1): string {
  return `/tmp/tmux-${uid}/default`
}

function tmuxError(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer } | null)?.stderr
  return Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? '')
}

/** "no server running" and a missing socket mean there is nothing to list. */
function isNoServer(detail: string): boolean {
  return /no server running|error connecting to .*\((?:No such file or directory|Connection refused)\)/i.test(
    detail,
  )
}

/** Called with the sorted names whenever the observed legacy list changes. */
export type LegacyChangeListener = (names: string[]) => void

export class LegacyATermSessions {
  /** Last observed names (sorted), or null before the first observation. */
  private observed: string[] | null = null
  private watchTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly socket: string,
    private readonly onChange: LegacyChangeListener = () => {},
    /** Runs `tmux -S <socket> <args>`; replaced in tests. */
    private readonly runTmux: (args: string[]) => Promise<{ stdout: string }> = (args) =>
      // `-N`-free read commands never start a server; list-sessions against a
      // missing socket fails instead of creating one.
      execFileAsync(TMUX_BIN, ['-S', socket, ...args], {
        encoding: 'utf8',
        env: terminalClientEnv(),
        timeout: TIMEOUT_MS,
      }),
  ) {}

  private run(args: string[]): Promise<{ stdout: string }> {
    return this.runTmux(args)
  }

  /** Record what a list saw and announce a difference from the last one. */
  private observe(sessions: LegacySession[]): void {
    const names = sessions.map((session) => session.name).sort()
    const previous = this.observed
    this.observed = names
    if (previous !== null && previous.join('\n') !== names.join('\n')) this.onChange(names)
  }

  /**
   * Poll the list while legacy sessions exist, so their End or exit outside
   * Tether is announced. Nothing creates legacy sessions any more, so the
   * poll stops for good once the list is empty.
   */
  watch(intervalMs: number): void {
    this.unwatch()
    const tick = async () => {
      this.watchTimer = null
      let names: string[] | null = null
      try {
        names = (await this.list()).map((session) => session.name)
      } catch {
        // tmux busy or going away: try again next tick.
      }
      if (names?.length === 0) return
      this.watchTimer = setTimeout(() => void tick(), intervalMs)
      this.watchTimer.unref()
    }
    void tick()
  }

  unwatch(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
  }

  async list(): Promise<LegacySession[]> {
    const sessions = await this.read()
    this.observe(sessions)
    return sessions
  }

  private async read(): Promise<LegacySession[]> {
    let stdout: string
    try {
      ;({ stdout } = await this.run([
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_created}\t#{session_attached}',
      ]))
    } catch (error) {
      if (isNoServer(tmuxError(error))) return []
      throw error
    }
    const sessions: LegacySession[] = []
    for (const line of stdout.split('\n')) {
      const [name, created, attached] = line.split('\t')
      if (!name || !isATermSessionName(name)) continue
      sessions.push({
        kind: 'legacy-attach-only',
        name,
        aTermSessionId: name.slice('summitflow-'.length),
        createdAt: (Number(created) || 0) * 1000,
        attachedClients: Number(attached) || 0,
      })
    }
    return sessions
  }

  async get(name: string): Promise<LegacySession | null> {
    if (!isATermSessionName(name)) return null
    return (await this.list()).find((session) => session.name === name) ?? null
  }

  /** The exact client argv. `=` makes tmux match the name exactly, never a prefix. */
  attachArgv(name: string): string[] {
    if (!isATermSessionName(name)) throw new Error('not an A-Term legacy session name')
    return [TMUX_BIN, '-S', this.socket, 'attach-session', '-t', `=${name}`]
  }

  /** Pane mode of one listed session's active pane, read-only. */
  async paneMode(name: string): Promise<PaneMode | null> {
    if (!(await this.get(name))) return null
    try {
      const { stdout } = await this.run(paneModeArgs(this.socket, `=${name}`).slice(2))
      return parsePaneMode(stdout)
    } catch {
      return null
    }
  }

  /** Kill exactly one listed session. Returns false when it is not present. */
  async end(name: string): Promise<boolean> {
    if (!(await this.get(name))) return false
    await this.run(['kill-session', '-t', `=${name}`])
    await this.list().catch(() => undefined)
    return true
  }
}
