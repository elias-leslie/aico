// The phone route: FCM HTTP v1 data messages carrying the whole item, encrypted
// to the app's own key (RFC 8291, one aes128gcm record), the message the paired
// Aico/Nightshift Android app reads today (Nightshift notify/fcm.py and
// deadman.encrypt, app contract `m`).
//
// Nothing secret is held here. The short-lived FCM access token is minted by
// root (the Firebase key never leaves root) and read from its file; the paired
// devices (FCM token, the app's public key and auth secret) are read from
// theirs. Both paths come from config and neither file is ever logged.

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { asksOwner, type Notice } from './notice'

export const FCM_URL = 'https://fcm.googleapis.com/v1/projects/{project}/messages:send'
/** Plaintext bytes: FCM data is 4096 bytes, less base64 and the record overhead. */
export const PAYLOAD_MAX = 2900
/** How long FCM keeps an undelivered message, by severity (Nightshift push.TTL). */
export const TTL_S: Readonly<Record<Notice['severity'], number>> = {
  critical: 86400,
  warning: 43200,
  info: 43200,
  ok: 3600,
}
const SEND_TIMEOUT_MS = 10_000

export const b64u = (data: Buffer) => data.toString('base64url')
export const unb64u = (text: string) => Buffer.from(text, 'base64url')

/** RFC 8291 message encryption: one aes128gcm record (RFC 8188) from a fresh sender key. */
export function encrypt(
  p256dh: string,
  auth: string,
  plaintext: Buffer,
  salt: Buffer = randomBytes(16),
): Buffer {
  const receiver = unb64u(p256dh)
  const ecdh = createECDH('prime256v1')
  const sender = ecdh.generateKeys()
  const secret = ecdh.computeSecret(receiver)
  const info = (label: string) => Buffer.from(`Content-Encoding: ${label}\0`)
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      unb64u(auth),
      Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]),
      32,
    ),
  )
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, info('aes128gcm'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('nonce'), 12))
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  // 0x02 marks the last (only) record.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(5)
  header.writeUInt32BE(4096, 0)
  header.writeUInt8(sender.length, 4)
  return Buffer.concat([salt, header, sender, body])
}

/** A paired phone, as the device file lists it. */
export interface Device {
  id: string
  fcmToken: string
  encPub: string
  auth: string
}

/** The device file's phones that can take a push; null when the file cannot be read. */
export function readDevices(path: string): Device[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  return raw.flatMap((item) => {
    const d = (item ?? {}) as Record<string, unknown>
    const ok =
      typeof d.id === 'string' &&
      d.id &&
      typeof d.fcm_token === 'string' &&
      d.fcm_token &&
      !d.token_gone &&
      typeof d.enc_pub === 'string' &&
      unb64u(d.enc_pub).length === 65 &&
      typeof d.auth === 'string' &&
      unb64u(d.auth).length === 16
    return ok
      ? [
          {
            id: d.id as string,
            fcmToken: d.fcm_token as string,
            encPub: d.enc_pub as string,
            auth: d.auth as string,
          },
        ]
      : []
  })
}

/** The project and access token root minted, when it is good for another minute. */
export function readAccessToken(
  path: string,
  now: number,
): { project: string; token: string } | null {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const expires = Number(data.expires_at) * 1000
    if (typeof data.access_token !== 'string' || !data.access_token) return null
    if (typeof data.project_id !== 'string' || !data.project_id) return null
    if (!(expires - now >= 60_000)) return null
    return { project: data.project_id, token: data.access_token }
  } catch {
    return null
  }
}

const CHANNEL_TEXT = {
  critical: 'Aico: critical alert',
  needs_you: 'Aico needs you',
  warning: 'Aico warning',
  info: 'Aico update',
} as const
export type Channel = keyof typeof CHANNEL_TEXT

export function channelOf(notice: Notice): Channel {
  if (notice.severity === 'critical') return 'critical'
  if (asksOwner(notice)) return 'needs_you'
  return notice.severity === 'warning' ? 'warning' : 'info'
}

/**
 * The app's item (contract `m`) for a stored notice, cut to fit: detail first, then body, then
 * title. `url` is where a tap goes: the notice's own link, else Aico.
 */
export function itemPlaintext(
  id: string,
  notice: Notice,
  sentAt: number,
  publicHost: string | null,
): Buffer {
  const channel = channelOf(notice)
  const url = notice.open ?? (publicHost ? `https://${publicHost}/` : undefined)
  const body = notice.body.trim()
  let detail = (notice.detail ?? '').trim()
  // Never the body twice; whole words only.
  if (body && detail.startsWith(body) && !/^[\p{L}\p{N}]/u.test(detail.slice(body.length)))
    detail = detail
      .slice(body.length)
      .replace(/^[\s:;,.\-–—]+/, '')
      .trim()
  const lines = [
    ...notice.fields.map((field) => `${field.label}: ${field.value}`),
    ...(notice.if_ignored ? [`If you leave it: ${notice.if_ignored.replace(/\.$/, '')}.`] : []),
  ]
  detail = [detail, ...lines].filter(Boolean).join('\n')
  const ts = Math.floor(sentAt / 1000)
  const message: Record<string, unknown> = {
    v: 1,
    id,
    title: notice.title,
    body: notice.body,
    detail,
    severity: notice.severity,
    channel,
    tag: notice.key ?? `n-${id}`,
    group: notice.source,
    kind: 'manual',
    ts,
    ...(url ? { url } : {}),
    actions: url ? [{ id: 'open', label: 'Open', tier: 'view', url }] : [],
    public: CHANNEL_TEXT[channel],
  }
  if (notice.expires) message.ends = ts + Math.round(notice.expires)
  let data = Buffer.from(JSON.stringify(message))
  for (const field of ['detail', 'body', 'title'] as const) {
    if (data.length <= PAYLOAD_MAX) break
    const text = Buffer.from(String(message[field]))
    const keep = Math.max(text.length - (data.length - PAYLOAD_MAX + 3), 0)
    // Cutting bytes can split a character; TextDecoder drops the broken tail.
    message[field] = `${new TextDecoder().decode(text.subarray(0, keep)).replace(/�$/, '')}…`
    data = Buffer.from(JSON.stringify(message))
  }
  return data
}

/**
 * One send's outcome: sent (FCM took it); retry (unreachable, 429, 5xx, or no usable access
 * token yet); gone (the device's token is unregistered); rejected:<status> (FCM refused it).
 */
export type SendResult = 'sent' | 'retry' | 'no-token' | 'gone' | `rejected:${number}`

export interface PhoneSender {
  /** The paired phones; null when the device file cannot be read. */
  devices(): Device[] | null
  send(device: Device, plaintext: Buffer, ttlS: number): Promise<SendResult>
}

export interface FcmConfig {
  /** Root's minted access token (JSON: access_token, expires_at, project_id). */
  tokenFile: string
  /** The paired devices (JSON list: id, fcm_token, enc_pub, auth). */
  devicesFile: string
}

export class FcmSender implements PhoneSender {
  constructor(
    private readonly config: FcmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  devices(): Device[] | null {
    return readDevices(this.config.devicesFile)
  }

  async send(device: Device, plaintext: Buffer, ttlS: number): Promise<SendResult> {
    const access = readAccessToken(this.config.tokenFile, this.now())
    if (!access) return 'no-token'
    const message = {
      message: {
        token: device.fcmToken,
        data: { t: 'm', ct: b64u(encrypt(device.encPub, device.auth, plaintext)) },
        android: { priority: 'HIGH', ttl: `${ttlS}s` },
      },
    }
    let response: Response
    try {
      response = await this.fetchImpl(FCM_URL.replace('{project}', access.project), {
        method: 'POST',
        headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
    } catch {
      return 'retry'
    }
    if (response.ok) return 'sent'
    let error: { status?: string; details?: { errorCode?: string }[] } = {}
    try {
      error = ((await response.json()) as { error?: typeof error }).error ?? {}
    } catch {
      // No JSON body: the status decides.
    }
    const codes = new Set((error.details ?? []).map((detail) => String(detail?.errorCode)))
    if (codes.has('UNREGISTERED') || (response.status === 404 && error.status === 'NOT_FOUND'))
      return 'gone'
    if (response.status === 429 || response.status >= 500) return 'retry'
    return `rejected:${response.status}`
  }
}
