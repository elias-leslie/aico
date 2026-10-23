// Which attached client last claimed a session's shared tmux window size.
// Every client sizes the same window (resize-claim), so the last claimer is
// the one the window fits; the others see it at a size that is not theirs.
// Kept in memory only: after a restart the holder is unknown until a claim.

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
  return holder
}

/** The holder for this exact generation, or null (unknown, or the session was replaced). */
export function sizeHolderOf(id: string, generation: string): SizeHolder | null {
  const holder = holders.get(id)
  if (!holder) return null
  if (holder.generation !== generation) {
    holders.delete(id)
    return null
  }
  return holder
}

export function forgetSizeHolder(id: string): void {
  holders.delete(id)
}

export function resetSizeHolders(): void {
  holders.clear()
}
