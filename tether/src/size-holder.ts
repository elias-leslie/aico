// Which attached client last claimed a session's shared tmux window size.
// Every client sizes the same window (resize-claim), so the last claimer is
// the one the window fits; the others see it at a size that is not theirs.
// Kept in Tether's settings too, so a restart does not forget who holds a
// window that a claim pinned: the holder's tmux client outlives Tether.

/** Which app on which device made a claim (`{app: 'desktop', device: <hostname>}`),
 * so the other views can say where the session is being viewed. */
export interface ViewerLabel {
  app: string
  device: string
}

export interface SizeHolder {
  clientPid: number
  cols: number
  rows: number
  /** The session generation the claim was made on. */
  generation: string
  claimedAt: string
  /** Null when the claimer sent no label (an older client). */
  viewer: ViewerLabel | null
}

const APP = /^[a-z][a-z0-9-]{0,31}$/
// A device name is shown to the owner: printable text, no control characters.
const DEVICE = /^[^\p{Cc}\p{Cf}]{1,64}$/u

/** A claim's optional `viewer` field: undefined when absent, null when malformed. */
export function parseViewerLabel(value: unknown): ViewerLabel | undefined | null {
  if (value === undefined) return undefined
  const label = value as Record<string, unknown> | null
  if (!label || typeof label !== 'object' || Array.isArray(label)) return null
  const keys = Object.keys(label)
  if (keys.length !== 2 || !keys.includes('app') || !keys.includes('device')) return null
  const { app, device } = label
  if (typeof app !== 'string' || !APP.test(app)) return null
  if (typeof device !== 'string' || device.trim() !== device || !DEVICE.test(device)) return null
  return { app, device }
}

const holders = new Map<string, SizeHolder>()

/** Where the holders are saved, one JSON object keyed by session id. */
export interface SizeHolderStorage {
  read(): string | null
  write(value: string): void
}

let storage: SizeHolderStorage | null = null

function save(): void {
  storage?.write(JSON.stringify(Object.fromEntries(holders)))
}

function parseHolder(value: unknown): SizeHolder | null {
  const h = value as Record<string, unknown> | null
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null
  const int = (v: unknown) => Number.isSafeInteger(v)
  if (!int(h.clientPid) || !int(h.cols) || !int(h.rows)) return null
  if (typeof h.generation !== 'string' || typeof h.claimedAt !== 'string') return null
  const viewer = h.viewer === null ? null : parseViewerLabel(h.viewer)
  if (viewer === undefined || (viewer === null && h.viewer !== null)) return null
  return {
    clientPid: h.clientPid as number,
    cols: h.cols as number,
    rows: h.rows as number,
    generation: h.generation,
    claimedAt: h.claimedAt,
    viewer,
  }
}

/** Load the saved holders and save every change from now on. A holder whose
 * session is gone (`listed` says no) or that does not parse is dropped. */
export function persistSizeHolders(next: SizeHolderStorage, listed: (id: string) => boolean): void {
  storage = next
  holders.clear()
  let saved: unknown = null
  try {
    saved = JSON.parse(next.read() ?? 'null')
  } catch {
    // An unreadable value starts empty, as before a first claim.
  }
  const entries = saved && typeof saved === 'object' ? Object.entries(saved) : []
  for (const [id, value] of entries) {
    const holder = parseHolder(value)
    if (holder && listed(id)) holders.set(id, holder)
  }
  if (holders.size !== entries.length) save()
}

export function recordSizeHolder(
  id: string,
  claim: {
    clientPid: number
    cols: number
    rows: number
    generation: string
    viewer?: ViewerLabel | null
  },
  now: () => Date = () => new Date(),
): SizeHolder {
  const holder = { ...claim, claimedAt: now().toISOString(), viewer: claim.viewer ?? null }
  holders.set(id, holder)
  save()
  return holder
}

/** The holder for this exact generation, or null (unknown, or the session was replaced). */
export function sizeHolderOf(id: string, generation: string): SizeHolder | null {
  const holder = holders.get(id)
  if (!holder) return null
  if (holder.generation !== generation) {
    holders.delete(id)
    save()
    return null
  }
  return holder
}

export function forgetSizeHolder(id: string): void {
  if (holders.delete(id)) save()
}

export function resetSizeHolders(): void {
  holders.clear()
  storage = null
}
