// The portfolio-ai owner: receipts go to its household capture API
// (`POST /api/captures`, backend/app/api/captures.py). `client_id` is a UUIDv5
// of our capture id, so a repeat (a retry, a second tap) answers with the
// same row and never makes a second one. The agent token comes from a file
// named in config and is sent only as a header; it is never logged.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { HandOff, HandOffResult, OwnerAdapter } from './types'

export interface PortfolioAiOptions {
  /** Where portfolio-ai answers on this host (the forwarder on loopback). */
  url: string
  /** A file holding the agent token (HOUSEHOLD_AGENT_TOKEN_FILE); null sends none. */
  tokenFile: string | null
}

/** Aico's namespace for the UUIDv5 ids it gives owners (random once, fixed forever). */
const CAPTURE_NAMESPACE = '6f0c2b1e-3a54-4d8e-9a77-5b1d2c9e84a3'

/** portfolio-ai's contract: what it sniffs and its size limit (backend/app/api/captures.py). */
export const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
export const MAX_BYTES = 15 * 1024 * 1024
export const SUFFIX: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

/** RFC 4122 version 5: SHA-1 of the namespace bytes then the name. */
export function uuidV5(name: string, namespace = CAPTURE_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function detailOf(body: string): string | null {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail
    return typeof detail === 'string' && detail ? detail.slice(0, 200) : null
  } catch {
    return null
  }
}

/**
 * The way to portfolio-ai (the loopback forwarder and the agent token), shared
 * by everything Aico sends it: receipts here, vehicle events in `vehicles.ts`.
 */
export class PortfolioLink {
  private readonly url: string

  constructor(private readonly options: PortfolioAiOptions) {
    this.url = options.url.replace(/\/+$/, '')
  }

  private async headers(): Promise<Record<string, string>> {
    if (!this.options.tokenFile) return {}
    try {
      const token = (await readFile(this.options.tokenFile, 'utf8')).trim()
      return token ? { 'X-Portfolio-Agent-Token': token } : {}
    } catch {
      return {} // loopback may still be allowed; a 403 below says what to fix
    }
  }

  async reachable(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/health`)).ok
    } catch {
      return false
    }
  }

  /**
   * Posts a form and maps the answer: 2xx hands the parsed JSON to `ok`; no
   * connection or a 5xx is `waiting`; 403 and other 4xx are `failed` in words
   * for the owner. `conflict` replaces the generic sentence for a 409.
   */
  async post(
    path: string,
    form: FormData,
    ok: (json: Record<string, unknown>) => HandOffResult,
    conflict?: string,
  ): Promise<HandOffResult> {
    let response: Response
    try {
      response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: await this.headers(),
        body: form,
      })
    } catch {
      return { state: 'waiting', note: "Portfolio AI isn't answering right now" }
    }
    const body = await response.text().catch(() => '')
    if (response.status >= 500)
      return { state: 'waiting', note: `Portfolio AI had an error (${response.status})` }
    if (response.status === 403)
      return {
        state: 'failed',
        reason: 'Portfolio AI refused Aico. Its agent token file may be missing or out of date',
      }
    if (response.status === 409 && conflict) return { state: 'failed', reason: conflict }
    if (!response.ok) {
      const detail = detailOf(body)
      return {
        state: 'failed',
        reason: `Portfolio AI said no (${response.status})${detail ? `: ${detail}` : ''}`,
      }
    }
    let json: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(body) as unknown
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
    } catch {
      // handled by `ok`: no id means failed
    }
    return ok(json)
  }
}

export class PortfolioAiOwner implements OwnerAdapter {
  private readonly link: PortfolioLink

  constructor(options: PortfolioAiOptions) {
    this.link = new PortfolioLink(options)
  }

  reachable(): Promise<boolean> {
    return this.link.reachable()
  }

  async send(job: HandOff): Promise<HandOffResult> {
    if (!ACCEPTED_MIME.has(job.mime))
      return { state: 'failed', reason: 'Portfolio AI takes JPEG, PNG, WebP or PDF receipts' }
    if (job.bytes.length > MAX_BYTES)
      return { state: 'failed', reason: 'Portfolio AI takes receipts up to 15 MB' }

    const form = new FormData()
    form.append('client_id', uuidV5(job.captureId))
    form.append('member_scope', 'local')
    form.append('kind', job.kind)
    form.append('store_name', job.storeName.slice(0, 120))
    form.append('note', job.note.slice(0, 1000))
    form.append(
      'file',
      new Blob([job.bytes], { type: job.mime }),
      `${job.kind}.${SUFFIX[job.mime]}`,
    )
    return this.link.post('/api/captures', form, ({ id }) =>
      typeof id === 'string' && id
        ? { state: 'filed', ref: id }
        : { state: 'failed', reason: 'Portfolio AI answered without a capture id' },
    )
  }
}
