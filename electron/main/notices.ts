// Plain-words failure text, and the notice that shows it in a session's own
// terminal.

import type { BrowserWindow } from 'electron'
import { TetherError, TetherUnavailable } from 'tether/client'

export function writeNotice(win: BrowserWindow | undefined, message: string, color = 31): void {
  if (win && !win.isDestroyed())
    win.webContents.send('pty:data', `\r\n\u001b[${color}m${message}\u001b[0m\r\n`)
}

const HOST_STATE_WORDS: Record<string, string> = {
  offline: 'offline',
  connecting: 'still connecting',
  powered_off: 'powered off',
  identity_changed: 'not the same machine as before',
}

/** Plain words for a Tether refusal, shown in the session's own terminal. */
export function describeFailure(action: string, error: unknown): string {
  if (error instanceof TetherUnavailable)
    return `${action}: Tether is not reachable. Your sessions keep running; Aico reconnects on its own.`
  if (error instanceof TetherError) {
    switch (error.code) {
      case 'admission_denied':
        return `${action}: deferred by host admission (${error.reason ?? 'not enough memory or too many agents'}). Nothing was started.`
      case 'linger_required':
        return `${action}: user linger is off, so a session would die on logout. Run: loginctl enable-linger`
      case 'stale_generation':
      case 'identity_changed':
        return `${action}: the session changed meanwhile. Nothing was applied; try again.`
      case 'busy':
        return `${action}: another change to this session is in progress. Try again shortly.`
      case 'workload_unavailable':
        return `${action}: the session is not running${error.reason ? ` (${error.reason})` : ''}.`
      case 'instructions_unsupported':
        return `${action}: this tool can't take instructions. Nothing was started.`
      case 'host_unavailable': {
        const host = typeof error.body.host === 'string' ? error.body.host : 'The host'
        const state = HOST_STATE_WORDS[String(error.body.state)] ?? 'not reachable'
        return `${action}: ${host} is ${state}${error.reason ? ` (${error.reason})` : ''}. Nothing was started.`
      }
      case 'unknown_host':
        return `${action}: Tether does not know that host. Nothing was started.`
      case 'outcome_uncertain':
        return `${action}: the outcome is unknown. Check the session before trying again.`
      default:
        return `${action}: ${error.reason ?? error.code}.`
    }
  }
  return `${action}: ${error instanceof Error ? error.message : String(error)}`
}
