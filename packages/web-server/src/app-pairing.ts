// Existing Android pairing protocol, served by Aico. Gate material is handed only to the
// owner's pairing page; phone registration proves its own key and spends a short-lived code.
import { createHash, ECDH, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { dirname } from 'node:path'
import {
  AppError,
  CLOCK_SKEW_S,
  deviceIdOf,
  type PhoneRegistry,
  signatureHolds,
} from './app-phones'

export interface PairingConfig {
  base: string
  origins: string[]
  gateFile: string
  optionsFile: string
  codesFile: string
  ttlSeconds: number
}

const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))
interface Code {
  exp: number
  web_label: string
}

export class Pairing {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly phones: PhoneRegistry,
    private readonly config: PairingConfig,
  ) {}

  private codes(): Record<string, Code> {
    return existsSync(this.config.codesFile)
      ? (read(this.config.codesFile) as unknown as Record<string, Code>)
      : {}
  }

  private save(codes: Record<string, Code>): void {
    mkdirSync(dirname(this.config.codesFile), { recursive: true, mode: 0o700 })
    const tmp = `${this.config.codesFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(codes), { mode: 0o600 })
    renameSync(tmp, this.config.codesFile)
  }

  issue(label: string, now: number): string {
    let gate: Record<string, unknown>
    let fcm: Record<string, unknown>
    try {
      gate = read(this.config.gateFile)
      fcm = read(this.config.optionsFile)
    } catch {
      throw new AppError(503, 'Phone pairing is not set up on this host.')
    }
    if (
      !gate.cid ||
      !gate.csec ||
      !['project_id', 'app_id', 'api_key', 'sender_id'].every(
        (key) => typeof fcm[key] === 'string' && fcm[key],
      )
    )
      throw new AppError(503, 'Phone pairing settings are incomplete.')
    const code = randomBytes(24).toString('base64url')
    const codes = Object.fromEntries(
      Object.entries(this.codes())
        .filter(([, c]) => c.exp > now)
        .sort((a, b) => a[1].exp - b[1].exp)
        .slice(-4),
    )
    codes[hash(code)] = { exp: now + this.config.ttlSeconds, web_label: label.slice(0, 80) }
    this.save(codes)
    const payload = {
      v: 1,
      base: this.config.base,
      code,
      cid: gate.cid,
      csec: gate.csec,
      origins: [...new Set([this.config.base, ...this.config.origins])],
      web_label: label.slice(0, 80),
      fcm: Object.fromEntries(
        ['project_id', 'app_id', 'api_key', 'sender_id'].map((key) => [key, fcm[key]]),
      ),
    }
    return `intent://pair?p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}#Intent;scheme=nightshift;package=dev.summitflow.nightshift;end`
  }

  register(
    raw: Buffer,
    path: string,
    headers: IncomingHttpHeaders,
    now: number,
  ): Promise<{ device_id: string; name: string }> {
    const run = this.tail.then(async () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw.toString())
      } catch {
        throw new AppError(400, 'JSON object required')
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new AppError(400, 'JSON object required')
      const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '')
      const sigPub = str('sig_pub'),
        encPub = str('enc_pub'),
        auth = str('auth')
      try {
        for (const key of [sigPub, encPub]) {
          const point = Buffer.from(key, 'base64url')
          if (point.length !== 65 || point[0] !== 4 || point.toString('base64url') !== key)
            throw new Error()
          ECDH.convertKey(point, 'prime256v1')
        }
        if (Buffer.from(auth, 'base64url').length !== 16) throw new Error()
      } catch {
        throw new AppError(400, 'bad phone keys')
      }
      const ts = String(headers['x-nightshift-ts'] ?? '')
      if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > CLOCK_SKEW_S)
        throw new AppError(401, 'phone clock is too far off')
      if (!signatureHolds(sigPub, 'POST', path, ts, raw, String(headers['x-nightshift-sig'] ?? '')))
        throw new AppError(401, 'signature refused; pair the app again')
      const codes = this.codes(),
        key = hash(str('code')),
        code = codes[key]
      if (!code || code.exp <= now)
        throw new AppError(401, 'pairing code expired or used; tap Pair this phone again')
      const id = deviceIdOf(sigPub),
        name = (str('model') || 'Phone').replace(/\s+/g, ' ').slice(0, 40)
      await this.phones.register({
        id,
        sig_pub: sigPub,
        enc_pub: encPub,
        auth,
        fcm_token: str('fcm_token').slice(0, 4096),
        token_at: now,
        name,
        app_version: str('app_version').slice(0, 20),
        web_label: code.web_label,
        added_at: now,
      })
      // Re-read: a pairing page may have minted another code while the phone file was queued.
      const current = this.codes()
      delete current[key]
      this.save(current)
      return { device_id: id, name }
    })
    this.tail = run.catch(() => {})
    return run
  }
}
