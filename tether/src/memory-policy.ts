/**
 * Agent-pane memory policy: the pane cap and the kill policy for runaway
 * agent tool jobs. Tether owns it as data (the `settings` row
 * `memory_policy`); the owner edits it through `GET/PUT /v1/memory-policy`
 * (A-Term's settings panel). Host memory policy (the host's pressure state,
 * admission, swap, systemd-oomd, the app.slice cap) stays with Nightshift.
 */

export type KillOrder = 'largest' | 'background-first'

export const KILL_ORDERS: readonly KillOrder[] = ['largest', 'background-first']

export interface MemoryPolicy {
  /** Pane cap (MemoryMax) on every tmux-spawn pane scope, in GiB. */
  paneMemoryMaxGib: number
  /** Pane swap cap (MemorySwapMax), in GiB. */
  paneSwapMaxGib: number
  /** Kill the largest agent tool job when host memory is critical. */
  killEnabled: boolean
  /** Host memory must have been critical this long before a kill. */
  killAfterSeconds: number
  /** At most one kill per this many seconds. */
  killGapSeconds: number
  /** A job smaller than this is left to the pane cap and the kernel. */
  killMinGib: number
  /** largest: the biggest job anywhere. background-first: spare the pane the
   * owner is looking at while a background pane has a job big enough. */
  killOrder: KillOrder
}

export const DEFAULT_MEMORY_POLICY: Readonly<MemoryPolicy> = Object.freeze({
  paneMemoryMaxGib: 12,
  paneSwapMaxGib: 2,
  killEnabled: true,
  killAfterSeconds: 10,
  killGapSeconds: 30,
  killMinGib: 1,
  killOrder: 'largest',
})

interface Bound {
  min: number
  max: number
  integer: boolean
}

export const MEMORY_POLICY_BOUNDS: Readonly<Record<string, Bound>> = Object.freeze({
  paneMemoryMaxGib: { min: 2, max: 64, integer: true },
  paneSwapMaxGib: { min: 0, max: 16, integer: true },
  killAfterSeconds: { min: 5, max: 300, integer: true },
  killGapSeconds: { min: 10, max: 600, integer: true },
  killMinGib: { min: 0.25, max: 16, integer: false },
})

export class MemoryPolicyError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
  }
}

/** Merge a partial update onto `base`; unknown fields and out-of-range values
 * are refused with the field named. */
export function applyMemoryPolicyPatch(
  base: MemoryPolicy,
  patch: Record<string, unknown>,
): MemoryPolicy {
  const next: MemoryPolicy = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'killEnabled') {
      if (typeof value !== 'boolean') throw new MemoryPolicyError(key, 'must be true or false')
      next.killEnabled = value
    } else if (key === 'killOrder') {
      if (!KILL_ORDERS.includes(value as KillOrder))
        throw new MemoryPolicyError(key, `must be one of ${KILL_ORDERS.join(', ')}`)
      next.killOrder = value as KillOrder
    } else if (key in MEMORY_POLICY_BOUNDS) {
      const bound = MEMORY_POLICY_BOUNDS[key] as Bound
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (bound.integer && !Number.isInteger(value)) ||
        value < bound.min ||
        value > bound.max
      )
        throw new MemoryPolicyError(
          key,
          `must be ${bound.integer ? 'a whole number ' : ''}from ${bound.min} to ${bound.max}`,
        )
      ;(next as unknown as Record<string, number>)[key] = value
    } else {
      throw new MemoryPolicyError(key, 'unknown field')
    }
  }
  return next
}

/** A stored value, read leniently: missing or bad fields fall back to the
 * defaults, so an older row never stops the guard. */
export function parseStoredMemoryPolicy(raw: string | null): MemoryPolicy {
  if (!raw) return { ...DEFAULT_MEMORY_POLICY }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_MEMORY_POLICY }
  }
  const policy: MemoryPolicy = { ...DEFAULT_MEMORY_POLICY }
  if (parsed && typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed)) {
      try {
        Object.assign(policy, applyMemoryPolicyPatch(policy, { [key]: value }))
      } catch {
        // keep the default for this field
      }
    }
  }
  return policy
}

export const GIB = 2 ** 30
