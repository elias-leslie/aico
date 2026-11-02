// What the capture router needs of an owner: take one capture, say whether it
// is reachable. Adapters live beside this file, one per owner id.

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
}

export type HandOffResult =
  | { state: 'filed'; ref: string }
  /** Not reachable or erroring on its side: try again later. */
  | { state: 'waiting'; note: string }
  /** Refused for good, with words fit for the owner. */
  | { state: 'failed'; reason: string }

export interface OwnerAdapter {
  send(job: HandOff): Promise<HandOffResult>
  /** A cheap look: is the owner reachable? Used before retrying waiting captures. */
  reachable(): Promise<boolean>
}
