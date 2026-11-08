// The Backups list as the owner reads it: one line of how it stands, then
// each source with its copies (T7, Drive, CT 160) under one name.

import { BACKUP_TARGET_NAMES } from '@aico/shared/backup-targets'

export type BackupTarget = 'native' | 'drive' | 'append' | 'external'
export type BackupState = 'ok' | 'warn' | 'failed' | 'off'

export interface BackupEntry {
  id: string
  source: string
  name: string
  target: BackupTarget
  dataAt: string | null
  nextRun: string | null
  state: BackupState | string
  meaning: string
  snapshot: string | null
  path: string | null
  machine: string
  running?: boolean
  /** The source path is gone: older copies are kept, no new ones are made. */
  gone?: boolean
  /** How old its data may get before it counts as late, in hours. */
  limitHours?: number
}

export interface BackupGroup {
  source: string
  name: string
  /** The worst of its copies: failed, then late, then current. */
  state: 'failed' | 'warn' | 'ok' | 'off'
  copies: BackupEntry[]
  /** Off because the source is gone for good (archived), or only because its machine is off. */
  retired: boolean
}

export const targetLabel = (target: BackupTarget): string =>
  (BACKUP_TARGET_NAMES as Record<string, string>)[target] ?? 'Backup'

const RANK = { failed: 0, warn: 1, ok: 2, off: 3 } as const
const known = (state: string): keyof typeof RANK =>
  state in RANK ? (state as keyof typeof RANK) : 'warn'

interface BackupCounts {
  current: number
  late: number
  failed: number
  /** Sources whose path is gone; older copies are kept. */
  archived: number
  /** Sources on a machine that is off: no new copy until it is back. */
  away: number
}

/** Counts sources, as the list shows them, not each copy of a source. */
function countBackups(groups: readonly BackupGroup[]): BackupCounts {
  const counts = { current: 0, late: 0, failed: 0, archived: 0, away: 0 }
  for (const group of groups) {
    if (group.state === 'ok') counts.current += 1
    else if (group.state === 'failed') counts.failed += 1
    else if (group.state === 'off')
      counts[group.retired ? 'archived' : 'away'] += 1
    else counts.late += 1
  }
  return counts
}

/** "All 57 sources current (98 copies), 2 on a machine that is off, 17 archived." or what is wrong first. Counts sources, like the list, with the copies beside it; `aico backups` says the same. */
export function backupSummary(entries: readonly BackupEntry[]): string {
  if (!entries.length) return 'No backups are registered yet.'
  const groups = groupBySource(entries)
  const { current, late, failed, archived, away } = countBackups(groups)
  const live = current + late + failed
  const copies = groups
    .filter((group) => group.state === 'ok')
    .reduce(
      (sum, group) =>
        sum +
        group.copies.filter((copy) => !copy.gone && copy.state === 'ok').length,
      0,
    )
  const parts: string[] = []
  if (failed) parts.push(`${failed} failed`)
  if (late) parts.push(`${late} ${late === 1 ? 'needs' : 'need'} a fresh copy`)
  if (current) {
    const noun = current === 1 ? 'source' : 'sources'
    const lead =
      !failed && !late ? `All ${current} ${noun}` : `${current} ${noun}`
    parts.push(
      `${lead} current (${copies} ${copies === 1 ? 'copy' : 'copies'})`,
    )
  }
  if (away) parts.push(`${away} on a machine that is off`)
  if (archived) parts.push(`${archived} archived`)
  if (!live && (archived || away))
    return `Nothing is backed up now; ${parts.join(', ')}.`
  return `${parts.join(', ')}.`
}

/** "36 h", "55 min", "3 days": an age or a limit in the fewest words. */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 90) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

/** Sources with their copies: problems first, then by name; archived sources last. */
export function groupBySource(entries: readonly BackupEntry[]): BackupGroup[] {
  const bySource = new Map<string, BackupEntry[]>()
  for (const entry of entries) {
    const list = bySource.get(entry.source) ?? []
    list.push(entry)
    bySource.set(entry.source, list)
  }
  const order: BackupTarget[] = ['native', 'drive', 'append', 'external']
  const groups: BackupGroup[] = [...bySource].map(([source, copies]) => {
    const sorted = [...copies].sort(
      (a, b) => order.indexOf(a.target) - order.indexOf(b.target),
    )
    // A source with any live copy is live: its archived copies sit beside them.
    const live = sorted.filter((copy) => known(copy.state) !== 'off')
    const state = live.length
      ? live
          .map((copy) => known(copy.state))
          .sort((a, b) => RANK[a] - RANK[b])[0]
      : 'off'
    return {
      source,
      name: sorted[0]?.name ?? source,
      state: state ?? 'off',
      copies: sorted,
      retired: sorted.every((copy) => copy.gone === true),
    }
  })
  return groups.sort(
    (a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name),
  )
}

export interface TargetAge {
  target: BackupTarget
  /** The age of the oldest copy still counted as live there, in ms. */
  ageMs: number
  /** What that copy's limit is, in ms. */
  limitMs: number
  /** The oldest copy's source, by name. */
  name: string
  copies: number
}

/** Per destination, how old its most overdue live copy is against that copy's own limit. A copy
 * with no data date or no limit, one on a machine that is off, and archived ones are left out:
 * they have no age to compare. Most overdue first. */
export function ageByTarget(
  entries: readonly BackupEntry[],
  now: number,
): TargetAge[] {
  const worst = new Map<BackupTarget, TargetAge & { ratio: number }>()
  for (const entry of entries) {
    if (entry.gone || entry.state === 'off') continue
    if (!entry.dataAt || !entry.limitHours) continue
    const ageMs = Math.max(0, now - Date.parse(entry.dataAt))
    if (Number.isNaN(ageMs)) continue
    const limitMs = entry.limitHours * 3_600_000
    const ratio = ageMs / limitMs
    const seen = worst.get(entry.target)
    if (!seen)
      worst.set(entry.target, {
        target: entry.target,
        ageMs,
        limitMs,
        name: entry.name,
        copies: 1,
        ratio,
      })
    else {
      seen.copies += 1
      if (ratio > seen.ratio)
        Object.assign(seen, { ageMs, limitMs, name: entry.name, ratio })
    }
  }
  return [...worst.values()]
    .sort((a, b) => b.ratio - a.ratio)
    .map(({ ratio: _ratio, ...rest }) => rest)
}

const COPY_WORD: Record<string, string> = {
  ok: 'Current',
  failed: 'Failed',
  off: 'Archived',
}

/** One copy's state in a word: "Current", "Copying…", "Needs a fresh copy". */
export const copyWord = (
  row: Pick<BackupEntry, 'state' | 'running'>,
): string =>
  row.running ? 'Copying…' : (COPY_WORD[row.state] ?? 'Needs a fresh copy')

/** The destinations Back up now can start a copy to: those with a live (not archived) copy. */
export function runnableTargets(
  entries: readonly BackupEntry[],
): ('native' | 'drive' | 'append')[] {
  return (['native', 'drive', 'append'] as const).filter((target) =>
    entries.some((row) => row.target === target && row.state !== 'off'),
  )
}
