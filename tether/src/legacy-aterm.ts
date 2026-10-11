// A-Term's pre-Tether sessions: `summitflow-<uuid>` on the user's DEFAULT tmux
// server (`/tmp/tmux-<uid>/default`). Tether lists them so a client can attach
// or end them, but never adopts, catalogs, reconfigures or starts that server.
// End is `tmux kill-session` against one exact session name, nothing broader.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { terminalClientEnv } from './lifecycle/terminal-env'
import { isATermSessionName } from './lifecycle/tmux'

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

export class LegacyATermSessions {
  constructor(private readonly socket: string) {}

  private run(args: string[]): Promise<{ stdout: string }> {
    // `-N`-free read commands never start a server; list-sessions against a
    // missing socket fails instead of creating one.
    return execFileAsync(TMUX_BIN, ['-S', this.socket, ...args], {
      encoding: 'utf8',
      env: terminalClientEnv(),
      timeout: TIMEOUT_MS,
    })
  }

  async list(): Promise<LegacySession[]> {
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

  /** Kill exactly one listed session. Returns false when it is not present. */
  async end(name: string): Promise<boolean> {
    if (!(await this.get(name))) return false
    await this.run(['kill-session', '-t', `=${name}`])
    return true
  }
}
