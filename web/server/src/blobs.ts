// The blob store: a capture's bytes, named by their SHA-256 under
// `<dir>/<hash[0:2]>/<hash>`, with variants beside it (`<hash>.thumb.jpg`,
// `<hash>.preview.jpg`). Writes are atomic (temp file, fsync, rename) and the
// name is checked against the bytes, so a half-written or wrong file is never
// left under a hash name.

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BlobVariant = 'original' | 'thumb' | 'preview'

const HASH = /^[0-9a-f]{64}$/
const SUFFIX: Record<BlobVariant, string> = {
  original: '',
  thumb: '.thumb.jpg',
  preview: '.preview.jpg',
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

export function isBlobHash(value: string): boolean {
  return HASH.test(value)
}

export function blobPath(dir: string, hash: string, variant: BlobVariant = 'original'): string {
  if (!HASH.test(hash)) throw new Error('A blob hash is 64 lowercase hex digits')
  return join(dir, hash.slice(0, 2), `${hash}${SUFFIX[variant]}`)
}

export function hasBlob(dir: string, hash: string, variant: BlobVariant = 'original'): boolean {
  return HASH.test(hash) && existsSync(blobPath(dir, hash, variant))
}

/** A temp name beside `path`, so the rename never crosses a filesystem. */
export function tempPath(path: string): string {
  return `${path}.${randomBytes(6).toString('hex')}.tmp`
}

async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = tempPath(path)
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Stores the original bytes under their hash (already there: nothing to write). */
export async function putOriginal(dir: string, bytes: Uint8Array): Promise<string> {
  const hash = sha256(bytes)
  if (!hasBlob(dir, hash)) await writeAtomic(blobPath(dir, hash), bytes)
  return hash
}

/** Stores a thumbnail or preview next to the original; replaces an earlier one. */
export async function putVariant(
  dir: string,
  hash: string,
  variant: Exclude<BlobVariant, 'original'>,
  bytes: Uint8Array,
): Promise<void> {
  await writeAtomic(blobPath(dir, hash, variant), bytes)
}

/** The bytes, or null when the blob is not here. */
export async function readBlob(
  dir: string,
  hash: string,
  variant: BlobVariant = 'original',
): Promise<Buffer | null> {
  if (!HASH.test(hash)) return null
  try {
    return await readFile(blobPath(dir, hash, variant))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** True when the stored original still hashes to its name. */
export async function verifyBlob(dir: string, hash: string): Promise<boolean> {
  const bytes = await readBlob(dir, hash)
  return bytes !== null && sha256(bytes) === hash
}
