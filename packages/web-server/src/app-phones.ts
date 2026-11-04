// The paired phones, for the phone app's API (app-api.ts): one JSON file in Aico's data directory
// (0600) with each phone's keys, FCM token and what its last ack said. The file keeps Nightshift's
// record shape, so the phone paired there stays paired here: the first start copies Nightshift's
// file when this one does not exist yet. The sender (packages/notify fcm.ts) reads the same file.
//
// Every request from the app is signed by the phone's own key (docs of the wire protocol: the
// Nightshift app protocol, unchanged): METHOD \n PATH \n TS \n b64u(sha256(body)), ECDSA P-256
// SHA-256, DER signature, the timestamp within 5 minutes of this clock.

import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const CLOCK_SKEW_S = 300
/** Channels the app's state report may name (Nightshift's list; the app creates these). */
const CHANNELS = ['critical', 'needs_you', 'warning', 'info', 'reports']

/** A refusal the app reads: `{error}` with this status. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** One paired phone, as the file stores it (snake_case, as Nightshift wrote it). */
export interface Phone {
  id: string
  sig_pub: string
  enc_pub: string
  auth: string
  fcm_token?: string
  token_at?: number
  token_gone?: number | null
  name?: string
  app_version?: string
  added_at?: number
  last_ack?: number
  last_probe?: number
  read_error?: string
  read_error_at?: number
  state?: PhoneState
  state_at?: number
  [extra: string]: unknown
}

/** What the app reports about itself with each ack. */
export interface PhoneState {
  notifications: boolean
  channels: Record<string, number>
  dnd_bypass: Record<string, boolean>
  interruption_filter: number | null
  battery_unrestricted: boolean
  app_version: string
}

const b64u = (data: Buffer) => data.toString('base64url')
const unb64u = (text: string) => Buffer.from(text, 'base64url')

/** DER SubjectPublicKeyInfo header for an uncompressed P-256 point. */
const SPKI_P256 = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')

/** `base64url(sha256(sig_pub))` cut to 22 characters: the id the app names itself by. */
export function deviceIdOf(sigPub: string): string {
  return b64u(createHash('sha256').update(unb64u(sigPub)).digest()).slice(0, 22)
}

export function canonical(method: string, path: string, ts: string, body: Buffer): string {
  return `${method}\n${path}\n${ts}\n${b64u(createHash('sha256').update(body).digest())}`
}

/** Whether `sig` (base64url DER) is the phone's signature over the request. */
export function signatureHolds(
  sigPub: string,
  method: string,
  path: string,
  ts: string,
  body: Buffer,
  sig: string,
): boolean {
  try {
    const point = unb64u(sigPub)
    if (point.length !== 65 || point[0] !== 4) return false
    const key = createPublicKey({
      key: Buffer.concat([SPKI_P256, point]),
      format: 'der',
      type: 'spki',
    })
    return verify('sha256', Buffer.from(canonical(method, path, ts, body)), key, unb64u(sig))
  } catch {
    return false
  }
}

function readPhones(path: string): Phone[] | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) return null
    return raw.filter((d): d is Phone => !!d && typeof d === 'object' && typeof d.id === 'string')
  } catch {
    return null
  }
}

export function cleanState(raw: Record<string, unknown>): PhoneState {
  const int = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value)
  const channels = (raw.channels ?? {}) as Record<string, unknown>
  const dnd = (raw.dnd_bypass ?? {}) as Record<string, unknown>
  return {
    notifications: raw.notifications === true,
    channels: Object.fromEntries(
      Object.entries(channels).filter(([k, v]) => CHANNELS.includes(k) && int(v)),
    ) as Record<string, number>,
    dnd_bypass: Object.fromEntries(
      Object.entries(dnd)
        .filter(([k]) => CHANNELS.includes(k))
        .map(([k, v]) => [k, v === true]),
    ),
    interruption_filter: int(raw.interruption_filter) ? raw.interruption_filter : null,
    battery_unrestricted: raw.battery_unrestricted === true,
    app_version: String(raw.app_version ?? '').slice(0, 20),
  }
}

/** Why this phone cannot show Aico alerts, or '' (only notifications off, or an alert it could not read). */
export function cantBuzz(phone: Phone): string {
  if (phone.read_error) return 'the app could not read an Aico alert; it may need pairing again'
  if (!phone.state) return ''
  return phone.state.notifications ? '' : 'notifications are off for the app'
}

export class PhoneRegistry {
  /** Writers go one at a time; every change is read-modify-write of the whole file. */
  private tail: Promise<unknown> = Promise.resolve()
  /** Signatures of state-changing requests seen inside the clock window (signature -> epoch s it stops counting). */
  private seen = new Map<string, number>()

  constructor(
    readonly path: string,
    seedFrom?: string,
  ) {
    if (!existsSync(path) && seedFrom && existsSync(seedFrom)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      copyFileSync(seedFrom, path)
      chmodSync(path, 0o600)
      console.log(`[app] phones copied from ${seedFrom} to ${path}`)
    }
  }

  /** The paired phones; null when the file exists but cannot be read. A missing file is no phones. */
  all(): Phone[] | null {
    if (!existsSync(this.path)) return []
    return readPhones(this.path)
  }

  get(id: string): Phone | null {
    return this.all()?.find((phone) => phone.id === id) ?? null
  }

  /** The phone that signed this request, or an AppError (401: pair again). `now` in epoch seconds. */
  verify(
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
    now: number,
  ): Phone {
    const header = (name: string) => {
      const value = headers[name]
      return (Array.isArray(value) ? value[0] : value) ?? ''
    }
    const phones = this.all()
    if (!phones) throw new AppError(503, 'the phone file cannot be read')
    const phone = phones.find((p) => p.id === header('x-nightshift-device'))
    if (!phone) throw new AppError(401, 'unknown device; pair the app again')
    const ts = header('x-nightshift-ts')
    if (!/^\d+$/.test(ts) || Math.abs(Number(ts) - now) > CLOCK_SKEW_S)
      throw new AppError(401, "clock or timestamp off; check the phone's time")
    if (!signatureHolds(phone.sig_pub, method, path, ts, body, header('x-nightshift-sig')))
      throw new AppError(401, 'signature refused; pair the app again')
    // A signed POST is good for one answer: the clock window alone would let a copy repeat an act.
    if (method !== 'GET') {
      for (const [sig, until] of this.seen) if (until <= now) this.seen.delete(sig)
      const sig = header('x-nightshift-sig')
      if (this.seen.has(sig))
        throw new AppError(401, 'request already used; the app signs a new one')
      this.seen.set(sig, now + CLOCK_SKEW_S * 2)
    }
    return phone
  }

  private change(id: string, update: (phone: Phone) => void): Promise<void> {
    const run = this.tail.then(() => {
      const phones = readPhones(this.path)
      if (!phones) throw new AppError(503, 'the phone file cannot be read')
      const phone = phones.find((p) => p.id === id)
      if (!phone) return
      update(phone)
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(phones), { mode: 0o600 })
      renameSync(tmp, this.path)
    })
    this.tail = run.catch(() => {})
    return run
  }

  /** The app's acks: it is alive; a push it could not read (`e`) or read (`m`); its state report. */
  ack(id: string, body: Record<string, unknown>, now: number): Promise<void> {
    const acks = Array.isArray(body.acks) ? body.acks.slice(0, 100) : []
    let readError = ''
    let readOk = false
    for (const ack of acks) {
      if (!ack || typeof ack !== 'object') continue
      const { t, error } = ack as { t?: unknown; error?: unknown }
      if (t === 'e') {
        readError =
          String(error ?? 'unknown')
            .slice(0, 60)
            .replace(/[^A-Za-z0-9._-]/g, '') || 'unknown'
        readOk = false
      } else if (t === 'm') {
        readOk = true
        readError = ''
      }
    }
    const state =
      body.state && typeof body.state === 'object' && !Array.isArray(body.state)
        ? cleanState(body.state as Record<string, unknown>)
        : null
    return this.change(id, (phone) => {
      phone.last_ack = now
      if (readError) {
        phone.read_error = readError
        phone.read_error_at = now
      } else if (readOk) {
        delete phone.read_error
        delete phone.read_error_at
      }
      if (state) {
        phone.state = state
        phone.state_at = now
      }
    })
  }

  /** FCM rotated the phone's token. */
  setToken(id: string, token: string, now: number): Promise<void> {
    const clean = token.slice(0, 4096)
    if (!clean) throw new AppError(400, 'fcm_token required')
    return this.change(id, (phone) => {
      if (clean === phone.fcm_token) return
      phone.fcm_token = clean
      phone.token_at = now
      phone.token_gone = null
    })
  }

  /** The outage probe reached us (shown on the app's Status screen). */
  probed(id: string, now: number): Promise<void> {
    return this.change(id, (phone) => {
      phone.last_probe = now
    })
  }
}
