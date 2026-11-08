// The background reader: takes `new` captures made on this host, has
// vision-extract read them, and writes `ready` (with text, type and the
// extracted JSON) or `failed` with a short plain reason. Uploads never wait on
// it. Every change goes through NotesStore, so it syncs like any other edit.
//
// No time limit: a read ends when its process exits or errors. How long one has
// been running shows as "Reading since <time>" (the capture's `updated_at`).

import { constants, existsSync, readdirSync, rmSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobPath, hasBlob } from '@aico/notes/blobs'
import { extensionForMime, needsPreview } from '@aico/notes/capture-files'
import type { PreviewJobs } from '@aico/notes/heic'
import { ExtractError, type ExtractRequest, type ExtractResult } from '@aico/notes/vision-extract'
import { CAPTURE_INSTRUCTIONS, CAPTURE_SCHEMA } from '@aico/notes/vision-extract/capture-schema'
import type { CaptureRow, NotesStore, RoutePlan } from './notes-db'

export type Extractor = (request: ExtractRequest) => Promise<ExtractResult>

export interface ExtractWorkerOptions {
  store: NotesStore
  blobsDir: string
  previews: PreviewJobs
  extract: Extractor
  /** The capture router: plans where a read capture goes, then acts on it. */
  router?: {
    plan(type: string | null): RoutePlan | null
    afterReady(row: CaptureRow): Promise<void>
  }
  /** Reads at once. */
  concurrency: number
  /** Where the per-read folders go; tests pass a temp dir. */
  workDir?: string
  log?: (message: string) => void
}

interface Outcome {
  type: string | null
  text: string | null
  json: string | null
  route: string | null
}

/** A failure with words fit for the owner. */
class ReadFailure extends Error {}

const READABLE = new Set(['image', 'pdf', 'audio'])

export class ExtractWorker {
  private running = 0
  private stopped = false
  private readonly active = new Set<Promise<void>>()
  private readonly log: (message: string) => void

  constructor(private readonly options: ExtractWorkerOptions) {
    this.log = options.log ?? ((message) => console.error(`[aico-web] ${message}`))
  }

  /** Puts reads cut short by a restart back in line, then starts reading. */
  start(): void {
    const requeued = this.options.store.requeueExtracting()
    if (requeued) this.log(`requeued ${requeued} capture(s) that were being read`)
    try {
      this.sweepReads()
    } catch (error) {
      this.log(`could not clear old reads: ${(error as Error).message}`)
    }
    this.kick()
  }

  /** The folder reads work in, owner-only: one read's rules can't list a folder made after them. */
  private readsDir(): string {
    return this.options.workDir ?? join(tmpdir(), 'aico-reads')
  }

  /** A restart can cut a read short before it removes its copy of the capture. Runs before any read starts. */
  private sweepReads(): void {
    const reads = this.readsDir()
    if (!existsSync(reads)) return
    for (const name of readdirSync(reads))
      if (name.startsWith('read-')) rmSync(join(reads, name), { recursive: true, force: true })
  }

  stop(): void {
    this.stopped = true
  }

  /** Starts reads for waiting captures, up to the concurrency. Call after anything new or retried. */
  kick(): void {
    while (!this.stopped && this.running < this.options.concurrency) {
      let row: CaptureRow | null
      try {
        row = this.options.store.claimForExtraction()
      } catch (error) {
        this.log(`could not claim a capture: ${(error as Error).message}`)
        return
      }
      if (!row) return
      this.running += 1
      const job = this.run(row).finally(() => {
        this.running -= 1
        this.active.delete(job)
        this.kick()
      })
      this.active.add(job)
    }
  }

  /** Resolves when nothing is being read (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active])
  }

  private async run(row: CaptureRow): Promise<void> {
    const { store } = this.options
    try {
      const outcome = await this.read(row)
      // A photo the owner added from a note is already filed there: no suggestion,
      // so the router never moves it into Groceries or a new note.
      const plan =
        row.group_id?.startsWith('chat-') || store.notes.hasCaptureAttachment(row.id)
          ? null
          : this.options.router?.plan(outcome.type)
      const ready = store.finishExtraction(row.id, outcome, plan)
      if (ready) await this.route(ready)
    } catch (error) {
      const reason =
        error instanceof ReadFailure || error instanceof ExtractError
          ? error.message
          : 'Something went wrong while reading it'
      this.log(
        `capture ${row.id} failed: ${reason}${
          error instanceof ExtractError ? ` (${error.details.join(' | ')})` : ''
        }${error instanceof ReadFailure || error instanceof ExtractError ? '' : `: ${(error as Error).stack ?? error}`}`,
      )
      try {
        store.failExtraction(row.id, reason)
      } catch (writeError) {
        this.log(
          `capture ${row.id}: could not record the failure: ${(writeError as Error).message}`,
        )
      }
    }
  }

  /** Hands a read capture to the router; a failure there never undoes the reading. */
  private async route(row: CaptureRow): Promise<void> {
    try {
      await this.options.router?.afterReady(row)
    } catch (error) {
      this.log(`capture ${row.id}: routing failed: ${(error as Error).message}`)
    }
  }

  private async read(row: CaptureRow): Promise<Outcome> {
    const { blobsDir } = this.options
    const nothing: Outcome = { type: null, text: null, json: null, route: null }
    if (!row.hash) return nothing
    if (row.kind === 'text') {
      const text = await readFile(blobPath(blobsDir, row.hash), 'utf8')
      return { type: 'note', text, json: null, route: null }
    }
    if (!READABLE.has(row.kind)) return nothing

    let source = blobPath(blobsDir, row.hash)
    if (row.kind === 'image' && needsPreview(row.mime)) {
      const { previews } = this.options
      previews.schedule(row.hash)
      await previews.idle()
      source = blobPath(blobsDir, row.hash, 'preview')
      if (!hasBlob(blobsDir, row.hash, 'preview'))
        throw new ReadFailure("Couldn't convert this photo so it could be read")
    }
    const extension =
      row.kind === 'image' && needsPreview(row.mime) ? 'jpg' : extensionForMime(row.mime)
    if (!extension) return nothing

    // The reader gets a folder of its own holding one copy with a real extension: agy follows a
    // link to the folder it's in and refuses to read outside its own.
    const reads = this.readsDir()
    await mkdir(reads, { recursive: true, mode: 0o700 })
    const dir = await mkdtemp(join(reads, 'read-'))
    try {
      const file = join(dir, `capture.${extension}`)
      await copyFile(source, file, constants.COPYFILE_FICLONE)
      const result = await this.options.extract({
        file,
        cwd: dir,
        schema: CAPTURE_SCHEMA,
        instructions: CAPTURE_INSTRUCTIONS,
        hint: row.caption,
      })
      const json = result.json as { type: string; text: string }
      this.log(`capture ${row.id} read by ${result.route} in ${(result.ms / 1000).toFixed(1)} s`)
      return {
        type: json.type,
        text: json.text,
        json: JSON.stringify(result.json),
        route: result.route,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
