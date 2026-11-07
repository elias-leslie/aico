// The Backups list as the owner reads it: one line of how it stands, then
// each source with its copies (T7, Drive, CT 160) under one name.

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
}

export interface BackupGroup {
  source: string
  name: string
  /** The worst of its copies: failed, then late, then current. */
  state: 'failed' | 'warn' | 'ok' | 'off'
  copies: BackupEntry[]
}

const TARGET_LABEL: Record<BackupTarget, string> = {
  native: 'T7',
  drive: 'Drive',
  append: 'CT 160',
  external: 'Owner backup',
}

export const targetLabel = (target: BackupTarget): string =>
  TARGET_LABEL[target] ?? 'Backup'

const RANK = { failed: 0, warn: 1, ok: 2, off: 3 } as const
const known = (state: string): keyof typeof RANK =>
  state in RANK ? (state as keyof typeof RANK) : 'warn'

interface BackupCounts {
  current: number
  late: number
  failed: number
  archived: number
}

function countBackups(entries: readonly BackupEntry[]): BackupCounts {
  const counts = { current: 0, late: 0, failed: 0, archived: 0 }
  for (const entry of entries) {
    const state = known(entry.state)
    if (state === 'ok') counts.current += 1
    else if (state === 'failed') counts.failed += 1
    else if (state === 'off') counts.archived += 1
    else counts.late += 1
  }
  return counts
}

/** "All 98 current, 36 archived." or what is wrong first: "2 failed, 1 needs a fresh copy, 95 current, 36 archived." */
export function backupSummary(entries: readonly BackupEntry[]): string {
  if (!entries.length) return 'No backups are registered yet.'
  const { current, late, failed, archived } = countBackups(entries)
  const live = current + late + failed
  const parts: string[] = []
  if (failed) parts.push(`${failed} failed`)
  if (late) parts.push(`${late} ${late === 1 ? 'needs' : 'need'} a fresh copy`)
  if (current)
    parts.push(
      !failed && !late ? `All ${current} current` : `${current} current`,
    )
  if (archived) parts.push(`${archived} archived`)
  if (!live && archived)
    return `Nothing is backed up now; ${archived} archived.`
  return `${parts.join(', ')}.`
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
    }
  })
  return groups.sort(
    (a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name),
  )
}
