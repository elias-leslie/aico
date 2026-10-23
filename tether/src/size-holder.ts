// Which attached client last claimed a session's shared tmux window size.
// Every client sizes the same window (resize-claim), so the last claimer is
// the one the window fits; the others see it at a size that is not theirs.
// Kept in memory only: after a restart the holder is unknown until a claim.

export interface SizeHolder {
  clientPid: number
  cols: number
  rows: number
  /** The session generation the claim was made on. */
  generation: string
  claimedAt: string
}

const holders = new Map<string, SizeHolder>()

export function recordSizeHolder(
  id: string,
  claim: { clientPid: number; cols: number; rows: number; generation: string },
  now: () => Date = () => new Date(),
): SizeHolder {
  const holder = { ...claim, claimedAt: now().toISOString() }
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
