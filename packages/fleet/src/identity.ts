// A machine owns its key. Certificates are self-signed wrappers, never trust roots.
import { execFileSync } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  X509Certificate,
} from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Identity {
  name: string
  key: KeyObject
  publicKey: string
  cert: Buffer
}

export const machineName = (value: string) => value.toLowerCase().split('.')[0] ?? ''
export const validName = (name: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
export const fingerprint = (publicKey: string) =>
  createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
export const enrollmentCode = (name: string, publicKey: string) =>
  createHash('sha256')
    .update(`${name}\n${publicKey}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()
    .match(/.{4}/g)
    ?.join('-') ?? ''

export function publicKeyOf(key: KeyObject): string {
  const publicKey = key.type === 'public' ? key : createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Fleet identities require Ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

export function certificateKey(cert: Buffer): string {
  return publicKeyOf(new X509Certificate(cert).publicKey)
}

/** Reads only Aico's own link key. Never log or return its serialized bytes. */
export function loadIdentity(dir: string, name: string): Identity {
  if (!validName(name)) throw new Error('Invalid machine name')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'fleet-key.pem')
  if (!existsSync(path)) {
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(path, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
      flag: 'wx',
    })
  }
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error('Fleet key must be an owned regular file with mode 0600')
  const key = createPrivateKey(readFileSync(path))
  const publicKey = publicKeyOf(key)
  const certPath = join(dir, 'fleet-cert.pem')
  if (!existsSync(certPath)) {
    // Node 22 has no certificate issuance API. OpenSSL signs this wrapper using
    // the new Aico key in place; no key bytes pass through argv, stdout or logs.
    const cert = execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-key', path, '-subj', `/CN=${name}`, '-days', '3650'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    writeFileSync(certPath, cert, { mode: 0o600, flag: 'wx' })
  }
  const cert = readFileSync(certPath)
  if (certificateKey(cert) !== publicKey)
    throw new Error('Fleet certificate does not match the machine key')
  chmodSync(certPath, 0o600)
  return { name, key, publicKey, cert }
}
