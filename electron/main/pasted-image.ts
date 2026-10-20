// A clipboard image reaches a terminal program as a file path. The program may
// run as another Linux user (Tether's agent instance), with no display to read
// the clipboard from, but it can read a file in a folder both users share.

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export interface PastedImageStore {
  /** Where pasted images are written; the agent user must be able to read it. */
  readonly dir: string
  /** Images older than this are deleted when a new one is written. */
  readonly maxAgeMs: number
}

const NAME = /^paste-\d+-[0-9a-f]{12}\.png$/

// Like the owner exchange used by show.ts, only the owner writes these
// directories. Reject planted links before creating, pruning, or writing.
function ownerDirectory(path: string, owner: number): void {
  let stat: Stats
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    ownerDirectory(dirname(path), owner)
    mkdirSync(path, { mode: 0o755 })
    chmodSync(path, 0o755)
    return
  }
  if (
    !stat.isDirectory() ||
    stat.uid !== owner ||
    (stat.mode & 0o022) !== 0 ||
    realpathSync(path) !== resolve(path)
  ) {
    throw new Error(
      'Pasted image directories must be owned by you, writable only by you, and not links.',
    )
  }
}

/** Write explicitly shared PNG bytes to a new unpredictably named file.
 * Owner exchange permissions (`0755` directories and `0644` files) let the
 * agent read without a handoff ACL; older regular pastes are pruned. */
export function savePastedImage(
  store: PastedImageStore,
  png: Uint8Array,
  now: number = Date.now(),
): string {
  const owner = process.getuid?.()
  if (owner === undefined) throw new Error('Owner identity is unavailable.')
  ownerDirectory(dirname(store.dir), owner)
  ownerDirectory(store.dir, owner)
  chmodSync(store.dir, 0o755)
  prunePastedImages(store, now)
  const path = join(store.dir, `paste-${now}-${randomBytes(6).toString('hex')}.png`)
  writeFileSync(path, png, { mode: 0o644, flag: 'wx' })
  chmodSync(path, 0o644)
  return path
}

function prunePastedImages(store: PastedImageStore, now: number): void {
  for (const name of readdirSync(store.dir)) {
    if (!NAME.test(name)) continue
    const path = join(store.dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && stat.uid === process.getuid?.() && now - stat.mtimeMs > store.maxAgeMs)
        unlinkSync(path)
    } catch {
      // Gone already, or not ours to delete: leave it.
    }
  }
}
