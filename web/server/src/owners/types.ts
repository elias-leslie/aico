// What the capture router needs of an owner: take one capture, say whether it
// is reachable. Adapters live beside this file, one per owner id.

import type { CaptureRow } from '../notes-db'

/** One live capture of the same upload batch (`group_id`), for owners that take a whole group. */
export interface GroupMember {
  capture: CaptureRow
  /** This member is routed to the same owner, so its file goes with the event and it is filed with it. */
  own: boolean
  /** The file to send (a HEIC as its JPEG preview); null for context members and files already gone. */
  bytes: Uint8Array | null
  mime: string
}

export interface HandOff {
  /** Aico's capture id; the owner's idempotency key is made from it. */
  captureId: string
  bytes: Uint8Array
  mime: string
  /** What the owner calls this kind of capture (`receipt`). */
  kind: string
  /** The store or sender, when the reading found one. */
  storeName: string
  /** The owner's own words (Aico's caption). */
  note: string
  /** The capture itself, for owners that live inside Aico. */
  capture: CaptureRow
  /** For a `grouped` owner: every live capture in this one's batch, oldest first (this one included). */
  group: GroupMember[]
}

export type HandOffResult =
  | { state: 'filed'; ref: string }
  /** Not reachable or erroring on its side: try again later. */
  | { state: 'waiting'; note: string }
  /** Refused for good, with words fit for the owner. */
  | { state: 'failed'; reason: string }

export interface OwnerAdapter {
  /** Lives inside Aico: takes the capture row and needs no file bytes sent. */
  readonly local?: boolean
  /** Takes the whole batch as one event: the router passes `group` and files every own member with it. */
  readonly grouped?: boolean
  send(job: HandOff): Promise<HandOffResult>
  /** A cheap look: is the owner reachable? Used before retrying waiting captures. */
  reachable(): Promise<boolean>
}
