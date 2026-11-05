// The vehicles owner: car captures (an odometer photo, a service invoice, "just
// changed the oil, rotated the tires") go to portfolio-ai's review queue as one
// `vehicle_event` per upload batch (`group_id`), the same way receipts go: same
// forwarder, same agent token, idempotent on `capture_id`. Nothing becomes a car
// record until the owner confirms it there. Audio is never sent: its transcript
// travels as service text. The router files every car capture in the batch with
// the one event and purges them like receipts.

import type { CaptureRow } from '../notes-db'
import {
  ACCEPTED_MIME,
  MAX_BYTES,
  type PortfolioAiOptions,
  PortfolioLink,
  SUFFIX,
  uuidV5,
} from './portfolio-ai'
import type { GroupMember, HandOff, HandOffResult, OwnerAdapter } from './types'

/** portfolio-ai's limits for an event (backend/app/models/vehicles.py, api/vehicles.py). */
const MAX_FILES = 12
const MAX_SERVICES = 30
const KIND_MAX = 80
const NOTE_MAX = 1000
const HINT_MAX = 200

export interface VehicleEvent {
  capture_id: string
  vehicle_hint: string | null
  occurred_on: string
  odometer: { value: number; unit: 'mi' | 'km' } | null
  services: { kind: string; note: string }[]
}

interface Reading {
  odometer?: { odometer?: unknown; unit?: unknown } | null
  vehicle?: { hint?: unknown; date?: unknown; services?: unknown } | null
}

const words = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function read(row: CaptureRow): Reading {
  try {
    const value = JSON.parse(row.extract_json ?? 'null') as Reading | null
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** A real calendar date written YYYY-MM-DD, else null. */
function isoDate(value: unknown): string | null {
  const text = words(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const date = new Date(`${text}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text
}

/** The day Aico got the capture, on this computer's calendar (portfolio-ai would use the upload day). */
function dayOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** Portfolio-ai's id for the event: one per upload batch, so any member's Send is the same event. */
export function eventId(self: CaptureRow): string {
  return uuidV5(`vehicles:${self.group_id ?? self.id}`)
}

/**
 * The `vehicle_event` for a batch. Odometer, hint, date and services come from
 * the readings; with no services read, the caption or a spoken or typed
 * member's text stands in as one service line. Same input, same event, so a
 * resend is a repeat and never a conflict.
 */
function buildEvent(self: CaptureRow, group: readonly GroupMember[]): VehicleEvent {
  const readings = group.map((member) => read(member.capture))

  let odometer: VehicleEvent['odometer'] = null
  for (const reading of readings) {
    const value = reading.odometer?.odometer
    if (typeof value === 'number' && value >= 0 && value <= 2_000_000) {
      odometer = { value, unit: words(reading.odometer?.unit).toLowerCase() === 'km' ? 'km' : 'mi' }
      break
    }
  }

  const hint = readings.map((r) => words(r.vehicle?.hint)).find(Boolean)
  const date = readings.map((r) => isoDate(r.vehicle?.date)).find(Boolean)

  const seen = new Set<string>()
  const services: VehicleEvent['services'] = []
  const add = (kind: string, note: string) => {
    const entry = { kind: kind.slice(0, KIND_MAX), note: note.slice(0, NOTE_MAX) }
    const key = `${entry.kind.toLowerCase()}|${entry.note.toLowerCase()}`
    if (!entry.kind || seen.has(key) || services.length >= MAX_SERVICES) return
    seen.add(key)
    services.push(entry)
  }
  for (const reading of readings) {
    const list = reading.vehicle?.services
    if (!Array.isArray(list)) continue
    for (const item of list as { kind?: unknown; note?: unknown }[])
      add(words(item?.kind), words(item?.note))
  }
  if (services.length === 0) {
    const spoken = group
      .filter((m) => m.capture.kind === 'audio' || m.capture.kind === 'text')
      .map((m) => words(m.capture.text))
    const caption = group.map((m) => words(m.capture.caption)).find(Boolean) ?? ''
    for (const text of [...spoken, caption]) {
      if (text) add(text.split('\n')[0] as string, text.length > KIND_MAX ? text : '')
    }
  }

  return {
    capture_id: eventId(self),
    vehicle_hint: hint ? hint.slice(0, HINT_MAX) : null,
    occurred_on: date ?? dayOf(self.created_at),
    odometer,
    services,
  }
}

export class VehiclesOwner implements OwnerAdapter {
  readonly grouped = true
  private readonly link: PortfolioLink

  constructor(options: PortfolioAiOptions) {
    this.link = new PortfolioLink(options)
  }

  reachable(): Promise<boolean> {
    return this.link.reachable()
  }

  async send(job: HandOff): Promise<HandOffResult> {
    const event = buildEvent(job.capture, job.group)
    const own = job.group.filter((m) => m.own)
    const files: { bytes: Uint8Array; mime: string }[] = []
    for (const member of own) {
      const { kind } = member.capture
      if (kind !== 'image' && kind !== 'pdf') continue // audio and text travel as service text
      if (!member.bytes)
        return { state: 'failed', reason: 'A picture is no longer on this computer' }
      if (!ACCEPTED_MIME.has(member.mime))
        return { state: 'failed', reason: 'Portfolio AI takes JPEG, PNG, WebP or PDF files' }
      if (member.bytes.length > MAX_BYTES)
        return { state: 'failed', reason: 'Portfolio AI takes files up to 15 MB' }
      files.push({ bytes: member.bytes, mime: member.mime })
    }
    if (files.length > MAX_FILES)
      return { state: 'failed', reason: `Portfolio AI takes up to ${MAX_FILES} files at once` }
    if (!event.odometer && event.services.length === 0 && files.length === 0)
      return { state: 'failed', reason: 'There is no odometer reading, service or picture to send' }

    const form = new FormData()
    form.append('event', JSON.stringify(event))
    for (const [index, file] of files.entries())
      form.append(
        'files',
        new Blob([file.bytes], { type: file.mime }),
        `vehicle-${index + 1}.${SUFFIX[file.mime]}`,
      )
    return this.link.post(
      '/api/vehicles/captures',
      form,
      ({ id }) =>
        typeof id === 'string' && id
          ? { state: 'filed', ref: id }
          : { state: 'failed', reason: 'Portfolio AI answered without a review id' },
      'Portfolio AI already holds a different car event under this id. Delete that review row there, then try again',
    )
  }
}
