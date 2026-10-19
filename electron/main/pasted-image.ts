// A clipboard image reaches a terminal program as a file path. The program may
// run as another Linux user (Tether's agent instance), with no display to read
// the clipboard from, but it can read a file in a folder both users share.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PastedImageStore {
  /** Where pasted images are written; the agent user must be able to read it. */
  readonly dir: string
  /** Images older than this are deleted when a new one is written. */
  readonly maxAgeMs: number
}

const NAME = /^paste-\d+-[0-9a-f]{12}\.png$/

/** Write the PNG bytes to a new unpredictably named file and return its path.
 * Files are `0640` in a `0750` folder, so the group (and any ACL entry) reads
 * them and nobody writes; older pastes of ours are pruned on the way. */
export function savePastedImage(
  store: PastedImageStore,
  png: Uint8Array,
  now: number = Date.now(),
): string {
  mkdirSync(store.dir, { recursive: true, mode: 0o750 })
  prunePastedImages(store, now)
  const path = join(store.dir, `paste-${now}-${randomBytes(6).toString('hex')}.png`)
  writeFileSync(path, png, { mode: 0o640, flag: 'wx' })
  return path
}

function prunePastedImages(store: PastedImageStore, now: number): void {
  for (const name of readdirSync(store.dir)) {
    if (!NAME.test(name)) continue
    const path = join(store.dir, name)
    try {
      if (now - statSync(path).mtimeMs > store.maxAgeMs) unlinkSync(path)
    } catch {
      // Gone already, or not ours to delete: leave it.
    }
  }
}
