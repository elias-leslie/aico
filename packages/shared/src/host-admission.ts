// host-steward's admission verdict (admission.json, contract v1): where it is, how it is
// parsed and read. Tether's launch admission, recovery, the memory guard and the hub's
// placement all read the same file, so the reader lives here and they differ only in what
// they do with the verdict. A missing, unparsable, other-version or expired file is no verdict.

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HostAdmissionVerdict {
  admit: boolean
  /** green, amber or red; null when the file names none. */
  state: 'green' | 'amber' | 'red' | null
  /** Memory alone (memory_state, since 2026-10-31: state is the
   * worse of memory and disk); null when the file has none. */
  memoryState?: 'green' | 'amber' | 'red' | null
  reason: string
}

/** The longest reason kept from the file. */
export const MAX_REASON_CHARS = 200

/** host-steward's admission state, rewritten atomically every ~10 s. In
 * $XDG_RUNTIME_DIR/host-steward/, or the absolute path in TETHER_HOST_ADMISSION
 * (a Tether running as another user than the memctl user's reads the file memctl
 * publishes in a dir that user can read). */
export function hostAdmissionPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TETHER_HOST_ADMISSION?.startsWith('/')) return env.TETHER_HOST_ADMISSION
  const runtime = env.XDG_RUNTIME_DIR
  return runtime ? join(runtime, 'host-steward', 'admission.json') : null
}

/** The verdict in host-steward's admission.json (contract v1). Null when the
 * file is missing, unparsable, of another version or past `expires_at`, so
 * the caller falls back to its own thresholds. */
export function parseHostAdmission(text: string, nowMs: number): HostAdmissionVerdict | null {
  let state: unknown
  try {
    state = JSON.parse(text)
  } catch {
    return null
  }
  if (!state || typeof state !== 'object') return null
  const {
    v,
    admit,
    reason,
    expires_at: expiresAt,
    state: level,
    memory_state: memory,
  } = state as Record<string, unknown>
  if (v !== 1 || typeof admit !== 'boolean' || typeof expiresAt !== 'number') return null
  if (expiresAt * 1000 <= nowMs) return null
  const clean = typeof reason === 'string' ? reason.replace(/[^\x20-\x7e]/g, '').trim() : ''
  return {
    admit,
    state: level === 'green' || level === 'amber' || level === 'red' ? level : null,
    memoryState: memory === 'green' || memory === 'amber' || memory === 'red' ? memory : null,
    reason: clean.slice(0, MAX_REASON_CHARS) || 'no reason given',
  }
}

/** Host admission is red (memory or disk): heavy and probing work such
 * as `wait cmd` watchers waits. False when the file is missing or stale. */
export function hostAdmissionRed(path: string | null, nowMs: number = Date.now()): boolean {
  if (!path) return false
  try {
    return parseHostAdmission(readFileSync(path, 'utf8'), nowMs)?.state === 'red'
  } catch {
    return false
  }
}

export async function readHostAdmission(
  path: string | null,
  nowMs: number = Date.now(),
): Promise<HostAdmissionVerdict | null> {
  if (!path) return null
  try {
    return parseHostAdmission(await readFile(path, 'utf8'), nowMs)
  } catch {
    return null
  }
}
