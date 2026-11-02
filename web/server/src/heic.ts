// HEIC previews. A HEIC is stored exactly as sent; the server makes a JPEG
// beside it with `heif-convert` (libheif-examples) so the page and extraction
// can read it. The runner is injected, so tests never start the real tool.
// A missing tool or a failed conversion leaves the capture saved with no
// preview ("unavailable"), never an upload error.

import { execFile } from 'node:child_process'
import { open, rename, unlink } from 'node:fs/promises'
import { blobPath, hasBlob, tempPath } from './blobs'

/** Runs a program; resolves with its exit code, rejects when it cannot start. */
export type Runner = (argv: string[]) => Promise<number>

/** Conversions that run longer than this are stopped (a hung decoder, not a slow one). */
const CONVERT_TIMEOUT_MS = 120_000

export const execRunner: Runner = (argv) =>
  new Promise((resolve, reject) => {
    const [program, ...args] = argv
    execFile(program as string, args, { timeout: CONVERT_TIMEOUT_MS }, (error) => {
      if (!error) return resolve(0)
      const code = (error as NodeJS.ErrnoException).code
      if (typeof code === 'number') return resolve(code)
      reject(error)
    })
  })

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

async function looksLikeJpeg(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const head = Buffer.alloc(3)
    const { bytesRead } = await file.read(head, 0, 3, 0)
    return bytesRead === 3 && head.equals(JPEG_MAGIC)
  } finally {
    await file.close()
  }
}

/**
 * `heif-convert -q 85 SRC DST`: converts to a temp `.jpg` (the tool picks the
 * format from the suffix) and renames it into place once it is a JPEG.
 */
export async function makePreview(runner: Runner, src: string, dst: string): Promise<boolean> {
  const temp = `${tempPath(dst)}.jpg`
  try {
    if ((await runner(['heif-convert', '-q', '85', src, temp])) !== 0) return false
    if (!(await looksLikeJpeg(temp))) return false
    await rename(temp, dst)
    return true
  } catch {
    return false
  } finally {
    await unlink(temp).catch(() => {})
  }
}

export type PreviewState = 'ready' | 'pending' | 'unavailable'

/** Makes previews one at a time, in the background, and remembers what failed. */
export class PreviewJobs {
  private readonly queued = new Set<string>()
  private readonly failed = new Set<string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly runner: Runner,
  ) {}

  /** `ready` once the file exists; `pending` while queued or running; `unavailable` after a failure. */
  state(hash: string): PreviewState {
    if (hasBlob(this.dir, hash, 'preview')) return 'ready'
    if (this.queued.has(hash)) return 'pending'
    if (this.failed.has(hash)) return 'unavailable'
    // Not seen since this server started (a restart cut it short): try now.
    this.schedule(hash)
    return 'pending'
  }

  schedule(hash: string): void {
    if (this.queued.has(hash) || hasBlob(this.dir, hash, 'preview')) return
    this.queued.add(hash)
    this.failed.delete(hash)
    this.tail = this.tail.then(async () => {
      const made = await makePreview(
        this.runner,
        blobPath(this.dir, hash),
        blobPath(this.dir, hash, 'preview'),
      )
      this.queued.delete(hash)
      if (!made) {
        this.failed.add(hash)
        console.error(`[aico-web] no HEIC preview for ${hash.slice(0, 12)}: heif-convert failed`)
      }
    })
  }

  /** Resolves when everything scheduled so far has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.tail
  }
}
