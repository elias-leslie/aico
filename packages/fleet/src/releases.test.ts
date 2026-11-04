import { generateKeyPairSync } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  parseUpdateKeys,
  RELEASE_FILES,
  readUpdateKeys,
  signRelease,
  stageRelease,
  verifyRelease,
} from './releases'

let dir: string
let keyPath: string
const pair = generateKeyPairSync('ed25519')
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-release-'))
  keyPath = join(dir, 'signer')
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  for (const file of RELEASE_FILES) {
    mkdirSync(dirname(join(dir, 'release', file)), { recursive: true })
    writeFileSync(join(dir, 'release', file), `fixture ${file}`)
  }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
it('verifies and stages the entire release signed by an approved Ed25519 key', () => {
  const envelope = signRelease(join(dir, 'release'), keyPath)
  const stage = stageRelease(envelope, join(dir, 'staged'), [pair.publicKey])
  expect(readFileSync(join(stage, 'dist/tether.mjs'), 'utf8')).toBe('fixture dist/tether.mjs')
  expect(verifyRelease(envelope, [pair.publicKey]).files).toHaveLength(RELEASE_FILES.length)
})
it('refuses unsigned, tampered and wrongly signed releases before creating the stage', () => {
  const envelope = signRelease(join(dir, 'release'), keyPath)
  const parsed = JSON.parse(envelope)
  const tampered = JSON.stringify({
    ...parsed,
    payload: parsed.payload.replace('aico-update-v1', 'aico-update-v2'),
  })
  for (const input of [
    parsed.payload,
    '{}',
    tampered,
    JSON.stringify({ ...parsed, signature: '' }),
  ]) {
    expect(() => stageRelease(input, join(dir, 'refused'), [pair.publicKey])).toThrow(
      'Update refused',
    )
    expect(existsSync(join(dir, 'refused'))).toBe(false)
  }
  expect(() => verifyRelease(envelope, [generateKeyPairSync('ed25519').publicKey])).toThrow(
    'Update refused',
  )
})
it('rejects empty, duplicate, excessive and non-Ed25519 pins, and writable pin files', () => {
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  expect(parseUpdateKeys({ keys: [publicKey] })).toHaveLength(1)
  for (const keys of [[], [publicKey, publicKey], ['invalid'], Array(5).fill(publicKey)])
    expect(() => parseUpdateKeys({ keys })).toThrow()
  const file = join(dir, 'pins')
  writeFileSync(file, JSON.stringify({ keys: [publicKey] }))
  chmodSync(file, 0o666)
  expect(() => readUpdateKeys(file)).toThrow('root-owned')
})
it('refuses to sign with an exposed private key', () => {
  chmodSync(keyPath, 0o644)
  expect(() => signRelease(join(dir, 'release'), keyPath)).toThrow('0600')
})
