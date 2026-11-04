// Public pins only. The daemon reads this file; only the enrollment CLI writes it.
import { createPublicKey } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { enrollmentCode, publicKeyOf, validName } from './identity'

export interface Pin {
  name: string
  publicKey: string
}
export function parsePins(value: unknown): Pin[] {
  if (!Array.isArray(value)) throw new Error('Fleet allowlist must be a list')
  const names = new Set<string>()
  const keys = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid fleet pin')
    const { name, publicKey } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !validName(name) || typeof publicKey !== 'string')
      throw new Error('Invalid fleet pin')
    if (
      publicKeyOf(
        createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      ) !== publicKey
    )
      throw new Error('Invalid fleet public key')
    if (names.has(name) || keys.has(publicKey)) throw new Error('Duplicate fleet identity')
    names.add(name)
    keys.add(publicKey)
    return { name, publicKey }
  })
}

export function readPins(path: string): Pin[] {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error('Fleet allowlist must be root-owned and not writable by other users')
  return parsePins(JSON.parse(readFileSync(path, 'utf8')))
}

/** Caller has checked the owner's answered Needs-you ask against this exact code. */
export function approvePin(path: string, pin: Pin, code: string): void {
  if (process.getuid?.() !== 0) throw new Error('Fleet approval requires root')
  parsePins([pin])
  if (enrollmentCode(pin.name, pin.publicKey) !== code)
    throw new Error('Enrollment code does not match')
  const pins = readPins(path)
  const current = pins.find((entry) => entry.name === pin.name)
  if (current && current.publicKey !== pin.publicKey)
    throw new Error('Revoke the old key before enrolling a replacement')
  const next = parsePins([...pins.filter((entry) => entry.name !== pin.name), pin])
  const temporary = join(dirname(path), `.fleet-pins-${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
  renameSync(temporary, path)
}
