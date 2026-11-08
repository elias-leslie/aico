// How backups are counted, for `aico backups` and the Backups page alike: by source (one source has
// a copy on T7, Drive and so on). The copies in brackets are those of current sources.

export type SourceState = 'failed' | 'warn' | 'ok' | 'off'

/** Worst first, and the order the Backups page lists sources in. */
export const SOURCE_RANK: Record<SourceState, number> = { failed: 0, warn: 1, ok: 2, off: 3 }

/** A state nothing here knows counts as late, never as fine. */
const known = (state: string): SourceState =>
  state in SOURCE_RANK ? (state as SourceState) : 'warn'

interface Copy {
  source: string
  state: string
  gone?: boolean
}

/** The worst of a source's live copies; off only when none is live. */
export function sourceState(copies: readonly Copy[]): SourceState {
  const live = copies.map((copy) => known(copy.state)).filter((state) => state !== 'off')
  return live.sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b])[0] ?? 'off'
}

/** Off for good: every copy's source path is gone, as against its machine being off. */
export const sourceRetired = (copies: readonly Copy[]): boolean =>
  copies.every((copy) => copy.gone === true)

export interface BackupCounts {
  current: number
  late: number
  failed: number
  /** Sources whose path is gone; older copies are kept. */
  archived: number
  /** Sources on a machine that is off: no new copy until it is back. */
  away: number
  /** The good copies of the current sources. */
  copies: number
}

export function countBackups(entries: readonly Copy[]): BackupCounts {
  const bySource = new Map<string, Copy[]>()
  for (const entry of entries)
    bySource.set(entry.source, [...(bySource.get(entry.source) ?? []), entry])
  const counts: BackupCounts = { current: 0, late: 0, failed: 0, archived: 0, away: 0, copies: 0 }
  for (const copies of bySource.values()) {
    const state = sourceState(copies)
    if (state === 'ok') {
      counts.current += 1
      counts.copies += copies.filter((copy) => !copy.gone && copy.state === 'ok').length
    } else if (state === 'failed') counts.failed += 1
    else if (state === 'off') counts[sourceRetired(copies) ? 'archived' : 'away'] += 1
    else counts.late += 1
  }
  return counts
}
