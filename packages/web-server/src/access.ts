// Cloudflare Access, checked again at the origin. The public names reach this loopback server only
// through a Cloudflare tunnel, and Access gates them at the edge. A request the edge forwarded
// carries Cloudflare's own headers (Cf-Ray, Cf-Connecting-IP), which a client cannot remove; such a
// request must also carry a valid Access token for the name it asked for, so a gap in the edge
// policy (a path or host left without Access) is refused here rather than served.
//
// Requests from this machine (Caddy, Tether, the CLI, agents) and the LAN app listener carry no
// Cloudflare headers and are not checked: Caddy strips Cf-Connecting-IP and binds loopback only.
//
// The token is verified as Access documents: RS256 against the team's published keys, the
// audience tag of the Access app for the requested host, the team issuer, expiry and not-before,
// and type "app" (the login page hands any visitor a "meta" token signed by the same key with the
// same audience).

import { createPublicKey, type KeyObject, verify } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export interface AccessConfig {
  /** The team's Access domain, e.g. `team.cloudflareaccess.com`. */
  teamDomain: string
  /** Public host name -> the audience tag of the Access app that gates it. */
  audiences: Record<string, string>
}

export type AccessRefusal = 'access_required'

/** Headers only Cloudflare's edge sets on a request it forwards. */
const EDGE_HEADERS = ['cf-ray', 'cf-connecting-ip']
const HOST_PATTERN = /^([a-z0-9.-]+)(:[0-9]{1,5})?$/
const LEEWAY_S = 60
const KEYS_TTL_MS = 60 * 60 * 1000
/** An unknown key id refetches the team keys at most this often. */
const KEYS_RETRY_MS = 60 * 1000

export function viaCloudflare(headers: IncomingHttpHeaders): boolean {
  return EDGE_HEADERS.some((name) => headers[name] !== undefined)
}

type Jwk = { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown }
export type KeyFetcher = (teamDomain: string) => Promise<Jwk[]>

async function fetchTeamKeys(teamDomain: string): Promise<Jwk[]> {
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`certs answered ${res.status}`)
  const doc = (await res.json()) as { keys?: unknown }
  return Array.isArray(doc.keys) ? (doc.keys as Jwk[]) : []
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export class AccessVerifier {
  private keys = new Map<string, KeyObject>()
  private fetchedAt = 0
  private triedAt = Number.NEGATIVE_INFINITY
  private pending: Promise<void> | null = null

  constructor(
    private readonly config: AccessConfig | null,
    private readonly fetchKeys: KeyFetcher = fetchTeamKeys,
    private readonly now: () => number = Date.now,
  ) {}

  /** Why a request is refused, or null. Only requests the Cloudflare edge forwarded are checked. */
  async check(headers: IncomingHttpHeaders): Promise<AccessRefusal | null> {
    if (!viaCloudflare(headers)) return null
    const token = headers['cf-access-jwt-assertion']
    if (typeof token !== 'string' || !this.config) return 'access_required'
    const host = HOST_PATTERN.exec((headers.host ?? '').toLowerCase())?.[1]
    const audience = host ? this.config.audiences[host] : undefined
    if (!audience) return 'access_required'
    return (await this.valid(token, audience)) ? null : 'access_required'
  }

  private async valid(token: string, audience: string): Promise<boolean> {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [h64, p64, s64] = parts as [string, string, string]
    const header = decodePart(h64)
    const claims = decodePart(p64)
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return false
    const key = await this.key(header.kid)
    if (!key) return false
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${h64}.${p64}`),
      key,
      Buffer.from(s64, 'base64url'),
    )
    if (!signed) return false
    const now = this.now() / 1000
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    return (
      aud.includes(audience) &&
      claims.iss === `https://${this.config?.teamDomain}` &&
      claims.type === 'app' &&
      typeof claims.exp === 'number' &&
      claims.exp + LEEWAY_S > now &&
      (claims.nbf === undefined || (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S <= now))
    )
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const now = this.now()
    const stale = now - this.fetchedAt > KEYS_TTL_MS || !this.keys.has(kid)
    if (stale && (this.pending || now - this.triedAt > KEYS_RETRY_MS)) {
      this.pending ??= this.refresh(now).finally(() => {
        this.pending = null
      })
      await this.pending
    }
    return this.keys.get(kid)
  }

  private async refresh(now: number): Promise<void> {
    this.triedAt = now
    try {
      const keys = new Map<string, KeyObject>()
      for (const jwk of await this.fetchKeys(this.config?.teamDomain ?? '')) {
        if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue
        keys.set(
          jwk.kid,
          createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }),
        )
      }
      this.keys = keys
      this.fetchedAt = now
    } catch (error) {
      // Unknown keys fail closed until a refetch works; requests from this machine are unaffected.
      console.error('[aico-web] Access keys not fetched:', (error as Error).message)
    }
  }
}
