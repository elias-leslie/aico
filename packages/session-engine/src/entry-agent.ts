// An entry process and an old conversation file cannot prove its container's
// agent is running. Entries can supply a read-only control-plane probe instead.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSessionEntry, getWidget } from './lifecycle/catalog'
import { ENTRY_RETRY_EXIT, resolveEntry } from './lifecycle/entries'
import { isResumeSessionId } from './lifecycle/tui/launch'
import { getTui } from './lifecycle/tui/registry'

const execute = promisify(execFile)
export type EntryAgent =
  | { kind: 'unconfigured' }
  | { kind: 'running'; pid: number; resumeId: string }
  | { kind: 'waiting' | 'failed'; reason: string }

export async function probeEntryAgent(id: string): Promise<EntryAgent> {
  const entry = getSessionEntry(id)
  if (!entry) return { kind: 'unconfigured' }
  const resolved = resolveEntry(entry)
  if (resolved.kind !== 'ok') return { kind: 'failed', reason: resolved.reason }
  const probe = resolved.entry.probe
  if (!probe) return { kind: 'unconfigured' }
  try {
    const { stdout } = await execute(probe[0] as string, [...probe.slice(1), entry.arg], {
      timeout: 10_000,
      maxBuffer: 4096,
    })
    const result: unknown = JSON.parse(stdout)
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('invalid probe')
    const { running, pid, resumeId } = result as Record<string, unknown>
    if (running === false && pid === null && resumeId === null)
      return { kind: 'waiting', reason: 'the entry has no live agent yet' }
    if (
      running !== true ||
      !Number.isSafeInteger(pid) ||
      (pid as number) <= 0 ||
      !isResumeSessionId(getTui(getWidget(id)?.tool ?? ''), resumeId)
    )
      throw new Error('invalid probe')
    return { kind: 'running', pid: pid as number, resumeId }
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean }
    if (failure.code === ENTRY_RETRY_EXIT || failure.killed)
      return { kind: 'waiting', reason: 'the entry agent probe is temporarily unavailable' }
    return {
      kind: 'failed',
      reason: 'the entry agent probe failed or returned invalid process metadata',
    }
  }
}
