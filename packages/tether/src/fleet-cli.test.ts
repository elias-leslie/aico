import { generateKeyPairSync } from 'node:crypto'
import { enrollmentCode, fingerprint, publicKeyOf } from '@aico/fleet/identity'
import { expect, it } from 'vitest'
import { approvedEnrollment, enrollmentBody, enrollmentQuestion } from './fleet-cli'

it('requires the exact machine, short code and an answered Approve ask', () => {
  const pin = {
    name: 'peer',
    role: 'full' as const,
    publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey),
  }
  const ask = {
    body: enrollmentBody(pin),
    question: enrollmentQuestion(pin),
    state: 'answered',
    answer: 'Approve',
  }
  expect(approvedEnrollment(pin, ask)).toBe(true)
  expect(enrollmentQuestion(pin)).toContain(fingerprint(pin.publicKey))
  expect(enrollmentQuestion(pin)).toContain('as full')
  expect(approvedEnrollment({ ...pin, role: 'worker' }, ask)).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, body: 'Public key: another key' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, state: 'open' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, answer: 'Reject' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, question: 'Allow another machine?' })).toBe(false)
  const other = { ...pin, publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey) }
  expect(enrollmentCode(pin.name, pin.publicKey)).not.toBe(
    enrollmentCode(other.name, other.publicKey),
  )
  expect(approvedEnrollment(other, ask)).toBe(false)
})
