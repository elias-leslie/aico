// Public pins and consumed owner approvals. Only the enrollment CLI writes them.
import { createPublicKey } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { writeFileDurable } from '@aico/shared/durable-file'
import { enrollmentCode, publicKeyOf, validName } from './identity'

export interface Pin {
  name: string
  publicKey: string
  role: 'full' | 'worker'
}
export interface Allowlist {
  pins: Pin[]
  usedAskIds: string[]
}
export function parsePins(value: unknown): Pin[] {
  if (!Array.isArray(value)) throw new Error('Fleet pins must be a list')
  const names = new Set<string>()
  const keys = new Set<string>()
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid fleet pin')
    const { name, publicKey, role } = entry as Record<string, unknown>
    if (
      typeof name !== 'string' ||
      !validName(name) ||
      typeof publicKey !== 'string' ||
      (role !== 'full' && role !== 'worker')
    )
      throw new Error('Invalid fleet pin or role')
    if (
      publicKeyOf(
        createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      ) !== publicKey
    )
      throw new Error('Invalid fleet public key')
    if (names.has(name) || keys.has(publicKey)) throw new Error('Duplicate fleet identity')
    names.add(name)
    keys.add(publicKey)
    return { name, publicKey, role }
  })
}
export function parseAllowlist(value: unknown): Allowlist {
  const list = value as Allowlist | null
  if (
    !list ||
    !Array.isArray(list.usedAskIds) ||
    list.usedAskIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(list.usedAskIds).size !== list.usedAskIds.length
  )
    throw new Error('Fleet allowlist requires used approval ids')
  return { pins: parsePins(list.pins), usedAskIds: [...list.usedAskIds] }
}
function checkedStat(path: string) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error('Fleet allowlist must be root-owned and not writable by other users')
  return stat
}
export function readAllowlist(path: string): Allowlist {
  checkedStat(path)
  return parseAllowlist(JSON.parse(readFileSync(path, 'utf8')))
}
export function readPins(path: string): Pin[] {
  return readAllowlist(path).pins
}
/** Frames use memory; the existing Status interval checks for file replacement.
 * An invalid or missing replacement revokes cached trust until it is repaired. */
export class PinCache {
  private stamp = ''
  private pins: Pin[] = []
  constructor(
    private readonly path: string,
    private readonly read = readPins,
    private readonly stat = checkedStat,
  ) {}
  get = (): Pin[] => this.pins
  refresh(): void {
    try {
      const stat = this.stat(this.path)
      const stamp = `${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}:${stat.mode}`
      if (stamp === this.stamp) return
      this.pins = this.read(this.path)
      this.stamp = stamp
    } catch (error) {
      this.stamp = ''
      this.pins = []
      throw error
    }
  }
}
/** Approval ids survive revocation: an old yes cannot re-enroll a removed key. */
export function addApprovedPin(list: Allowlist, pin: Pin, askId: string): Allowlist {
  if (!askId || list.usedAskIds.includes(askId)) throw new Error('Owner approval was already used')
  const current = list.pins.find((entry) => entry.name === pin.name)
  if (current && current.publicKey !== pin.publicKey)
    throw new Error('Revoke the old key before enrolling a replacement')
  return parseAllowlist({
    pins: [...list.pins.filter((entry) => entry.name !== pin.name), pin],
    usedAskIds: [...list.usedAskIds, askId],
  })
}
export function approvePin(path: string, pin: Pin, code: string, askId: string): void {
  if (process.getuid?.() !== 0) throw new Error('Fleet approval requires root')
  if (enrollmentCode(pin.name, pin.publicKey) !== code)
    throw new Error('Enrollment code does not match')
  const next = addApprovedPin(readAllowlist(path), pin, askId)
  writeFileDurable(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
}
