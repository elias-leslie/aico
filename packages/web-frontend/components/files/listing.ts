import { agoOrDate } from '@aico/shared/time'
import type { FilePlace } from '@/lib/api/pane-files'

export type SortBy = 'name' | 'modified'

/** A short "when it changed": minutes and hours ago for two days, then the day. */
export const modifiedLabel = (ms: number, now = Date.now()): string =>
  agoOrDate(ms, now)

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
