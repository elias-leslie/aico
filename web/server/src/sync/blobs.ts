// Photos and files ride beside the rows: after a pull, every blob a live row
// names that is not on disk is fetched from the peer (the original, then its
// thumb and preview), checked against its SHA-256 name, and renamed into place.
// Blobs no row names any more go after a grace period.

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { type BlobVariant, hasBlob, putOriginal, putVariant, sha256 } from '../blobs'
import { missingBlobs, type SyncHandle } from './engine'
import type { Peer } from './peer'

export interface BlobCopy {
  fetched: number
  /** Hashes whose download did not match its name; dropped, tried again next pass. */
  mismatched: string[]
  /** The peer has no such file (yet). */
  absent: number
}

const VARIANTS: Exclude<BlobVariant, 'original'>[] = ['thumb', 'preview']

/**
 * Copies what `handle`'s live rows need from `peer`. A transport error stops the
 * pass (the next one starts over); nothing of a blob is stored until all of its
 * variants arrived, and the original goes in last, so a half copy is never "present".
 */
export async function copyMissingBlobs(
  handle: SyncHandle,
  peer: Peer,
  blobsDir: string,
  log: (message: string) => void = () => {},
): Promise<BlobCopy> {
  const result: BlobCopy = { fetched: 0, mismatched: [], absent: 0 }
  for (const hash of missingBlobs(handle, (found) => hasBlob(blobsDir, found))) {
    const original = await peer.blob(hash, 'original')
    if (!original) {
      result.absent += 1
      continue
    }
    if (sha256(original) !== hash) {
      log(`blob ${hash.slice(0, 8)} from the peer does not match its name; will retry`)
      result.mismatched.push(hash)
      continue
    }
    const variants: [Exclude<BlobVariant, 'original'>, Buffer][] = []
    for (const variant of VARIANTS) {
      const bytes = await peer.blob(hash, variant)
      if (bytes) variants.push([variant, bytes])
    }
    for (const [variant, bytes] of variants) await putVariant(blobsDir, hash, variant, bytes)
    await putOriginal(blobsDir, original)
    result.fetched += 1
  }
  return result
}

const BLOB_FILE = /^([0-9a-f]{64})(\.thumb\.jpg|\.preview\.jpg)?$/

/** Hashes any row names, tombstones included: a delete is remembered for 180 days, a returning edit needs the file. */
function referenced(handles: readonly SyncHandle[]): Set<string> {
  const hashes = new Set<string>()
  for (const handle of handles)
    for (const table of handle.tables) {
      if (!table.blob) continue
      const rows = handle.db
        .prepare(
          `SELECT DISTINCT ${table.blob} AS hash FROM ${table.name} WHERE ${table.blob} IS NOT NULL`,
        )
        .all() as { hash: string }[]
      for (const { hash } of rows) hashes.add(hash)
    }
  return hashes
}

/**
 * Removes blob files (and stale temp files) that no row names and that are older
 * than the grace period; the age keeps a file whose row has not landed yet.
 */
export async function removeUnreferenced(
  blobsDir: string,
  handles: readonly SyncHandle[],
  options: { graceMs: number; now: number },
): Promise<number> {
  const keep = referenced(handles)
  const cutoff = options.now - options.graceMs
  let removed = 0
  let dirs: string[]
  try {
    dirs = await readdir(blobsDir)
  } catch {
    return 0
  }
  for (const dir of dirs) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue
    for (const name of await readdir(join(blobsDir, dir))) {
      const match = BLOB_FILE.exec(name)
      if (match ? keep.has(match[1] as string) : !name.endsWith('.tmp')) continue
      const path = join(blobsDir, dir, name)
      const info = await stat(path).catch(() => null)
      if (!info || info.mtimeMs >= cutoff) continue
      await unlink(path)
      removed += 1
    }
  }
  return removed
}
