// Shapes the hub files share. Leaves, so peer.ts and wake.ts name them without
// importing each other.

export type WakeStep = 'powering_on' | 'connecting' | 'checking_services'

/** What a create is waiting for on a host, shown while it waits and after it failed. */
export interface WakeProgress {
  state: 'starting' | 'failed'
  reason: 'host_starting'
  step: WakeStep
  since: number
  error: string | null
}

/** What a Tether release is, whatever its API version: the hash of its installed files and,
 * when a signed update sits beside them, when it was issued (the deploy order). */
export interface ReleaseIdentity {
  hash: string
  issuedAt: number | null
}
