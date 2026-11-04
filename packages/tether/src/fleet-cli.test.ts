import { generateKeyPairSync } from 'node:crypto'
import { enrollmentCode, publicKeyOf } from '@aico/fleet/identity'
import { expect, it } from 'vitest'
import { approvedEnrollment, enrollmentQuestion } from './fleet-cli'

it('requires the exact machine, short code and an answered Approve ask', () => {
  const pin = { name: 'peer', publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey) }
  const ask = { question: enrollmentQuestion(pin), state: 'answered', answer: 'Approve' }
  expect(approvedEnrollment(pin, ask)).toBe(true)
  expect(approvedEnrollment(pin, { ...ask, state: 'open' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, answer: 'Reject' })).toBe(false)
  expect(approvedEnrollment(pin, { ...ask, question: 'Allow another machine?' })).toBe(false)
  const other = { ...pin, publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey) }
  expect(enrollmentCode(pin.name, pin.publicKey)).not.toBe(
    enrollmentCode(other.name, other.publicKey),
  )
  expect(approvedEnrollment(other, ask)).toBe(false)
})
