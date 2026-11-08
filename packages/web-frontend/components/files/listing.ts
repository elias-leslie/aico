import type { FilePlace } from '@/lib/api/pane-files'

export type SortBy = 'name' | 'modified'

/** A short "when it changed": minutes and hours ago for today, then the day. */
export function modifiedLabel(ms: number, now = Date.now()): string {
  const ago = now - ms
  if (ago < 60_000) return 'just now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} h ago`
  const at = new Date(ms)
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  return at.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  })
}

function within(folder: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')
  return folder === base || folder.startsWith(`${base}/`)
}

/**
 * Where the newest file is the one you want: Home and the scratch folders
 * (agents save there). A project's folders read best by name.
 */
export function defaultSort(
  folder: string,
  places: readonly FilePlace[] | undefined,
  projectRoot: string | null,
): SortBy {
  if (projectRoot && within(folder, projectRoot)) return 'name'
  return places?.some((place) => within(folder, place.path))
    ? 'modified'
    : 'name'
}

const HIDDEN_KEY = 'aico-files-show-hidden'

/** The saved choice of showing dotfiles; off when nothing is saved or storage is out of reach. */
export function readShowHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function saveShowHidden(value: boolean): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, value ? '1' : '0')
  } catch {}
}
