import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { privateFile } from './secrets'

/** The installed Tether release contract; no machine config or data is included. */
export const RELEASE_FILES = [
  'dist/tether.mjs',
  'bin/tether',
  'scripts/install-release.sh',
  'scripts/install-shims.sh',
  'scripts/aico-root-watch.py',
  'scripts/aico-blank-slate',
  'shims/tether-shim',
  'shims/shims.list',
] as const
export const SIGNED_RELEASE = 'signed-update.json'
export const DEFAULT_UPDATE_PINS = '/etc/aico/update-pins.json'
interface ReleaseFile {
  path: string
  body: string
}
export interface Release {
  format: 'aico-update-v1'
  apiVersion: number
  releaseHash: string
  bundleHash: string
  issuedAt: number
  files: ReleaseFile[]
}
interface SignedRelease {
  payload: string
  signature: string
}
const bytes = (payload: string) => Buffer.from(`aico-signed-update-v1\n${payload}`)
export function parseUpdateKeys(value: unknown): KeyObject[] {
  const raw = (value as { keys?: unknown })?.keys
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4 || new Set(raw).size !== raw.length)
    throw new Error('Update pins require one to four distinct Ed25519 public keys')
  return raw.map((value) => {
    if (typeof value !== 'string') throw new Error('Invalid update public key')
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' })
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      key.export({ format: 'der', type: 'spki' }).toString('base64') !== value
    )
      throw new Error('Invalid update public key')
    return key
  })
}
export function readUpdateKeys(path = DEFAULT_UPDATE_PINS): KeyObject[] {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error('Update pins must be root-owned and not writable by other users')
  return parseUpdateKeys(JSON.parse(readFileSync(path, 'utf8')))
}
export function bundleHash(release: string): string {
  return createHash('sha256')
    .update(readFileSync(join(release, 'dist/tether.mjs')))
    .digest('hex')
}
const releaseFiles = (release: string): ReleaseFile[] =>
  RELEASE_FILES.map((path) => ({
    path,
    body: readFileSync(join(release, path)).toString('base64'),
  }))
const hashFiles = (files: ReleaseFile[]) =>
  createHash('sha256').update(JSON.stringify(files)).digest('hex')
export function releaseHash(release: string): string {
  return hashFiles(releaseFiles(release))
}
export function signRelease(
  release: string,
  privateKeyPath: string,
  apiVersion: number,
  issuedAt = Date.now(),
): string {
  const files = releaseFiles(release)
  const payload = JSON.stringify({
    format: 'aico-update-v1',
    apiVersion,
    releaseHash: hashFiles(files),
    bundleHash: bundleHash(release),
    issuedAt,
    files,
  })
  return JSON.stringify({
    payload,
    signature: signDetached(bytes(payload), privateKeyPath).toString('base64'),
  })
}
/** A raw Ed25519 signature of `data` with the update key (what `openssl pkeyutl -verify -rawin` checks). */
export function signDetached(data: Buffer, privateKeyPath: string): Buffer {
  const key = createPrivateKey(privateFile(privateKeyPath))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Update signer must be Ed25519')
  return sign(null, data, key)
}
export function verifyRelease(input: string, keys: KeyObject[]): Release {
  try {
    const envelope = JSON.parse(input) as SignedRelease
    if (
      typeof envelope.payload !== 'string' ||
      typeof envelope.signature !== 'string' ||
      !keys.some((key) =>
        verify(null, bytes(envelope.payload), key, Buffer.from(envelope.signature, 'base64')),
      )
    )
      throw new Error()
    const payload = JSON.parse(envelope.payload) as Release
    if (
      payload.format !== 'aico-update-v1' ||
      !Number.isSafeInteger(payload.apiVersion) ||
      payload.apiVersion < 1 ||
      !Number.isSafeInteger(payload.issuedAt) ||
      payload.issuedAt < 1 ||
      typeof payload.releaseHash !== 'string' ||
      !Array.isArray(payload.files) ||
      payload.files.length !== RELEASE_FILES.length ||
      payload.files.some(
        (file, i) =>
          file.path !== RELEASE_FILES[i] ||
          typeof file.body !== 'string' ||
          Buffer.from(file.body, 'base64').toString('base64') !== file.body,
      )
    )
      throw new Error()
    if (
      createHash('sha256')
        .update(Buffer.from(payload.files[0]?.body ?? '', 'base64'))
        .digest('hex') !== payload.bundleHash ||
      hashFiles(payload.files) !== payload.releaseHash
    )
      throw new Error()
    return payload
  } catch {
    throw new Error('Update refused: signature or release contents are invalid')
  }
}
/** API versions never go backwards; the signed issue order also covers same-API releases. */
export function newerRelease(
  candidate: Release,
  installedApi: number,
  installedHash: string,
  installed?: Release,
): boolean {
  if (
    candidate.apiVersion < installedApi ||
    (installed && candidate.apiVersion < installed.apiVersion)
  )
    throw new Error('Update refused: older API version')
  if (candidate.releaseHash === installedHash) return false
  if (installed && candidate.issuedAt <= installed.issuedAt)
    throw new Error('Update refused: older signed release')
  return true
}
/** Authenticate the complete release before writing any executable file. */
export function stageRelease(input: string, destination: string, keys: KeyObject[]): string {
  const release = verifyRelease(input, keys)
  const id = createHash('sha256').update(input).digest('hex')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  const stage = mkdtempSync(join(destination, `${id}-`))
  for (const file of release.files) {
    const target = join(stage, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, Buffer.from(file.body, 'base64'), {
      mode: file.path === 'shims/shims.list' || file.path.endsWith('.mjs') ? 0o644 : 0o755,
      flag: 'wx',
    })
  }
  writeFileSync(join(stage, SIGNED_RELEASE), input, { mode: 0o600, flag: 'wx' })
  return stage
}
