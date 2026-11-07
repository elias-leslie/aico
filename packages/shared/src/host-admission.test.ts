import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hostAdmissionPath,
  hostAdmissionRed,
  MAX_REASON_CHARS,
  parseHostAdmission,
  readHostAdmission,
} from './host-admission'

describe('host admission state', () => {
  const now = 1_791_819_000_000
  const state = (fields: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      state: 'red',
      admit: false,
      reason: 'swap 80%',
      updated_at: now / 1000,
      expires_at: now / 1000 + 30,
      ...fields,
    })

  it('parses contract v1 and ignores stale, unknown or malformed state', () => {
    expect(parseHostAdmission(state({}), now)).toEqual({
      admit: false,
      state: 'red',
      memoryState: null,
      reason: 'swap 80%',
    })
    expect(parseHostAdmission(state({ state: 'green', admit: true, reason: '' }), now)).toEqual({
      admit: true,
      state: 'green',
      memoryState: null,
      reason: 'no reason given',
    })
    expect(parseHostAdmission(state({ state: 'purple' }), now)).toMatchObject({
      state: null,
    })
    expect(parseHostAdmission(state({ expires_at: now / 1000 - 1 }), now)).toBeNull()
    expect(parseHostAdmission(state({ v: 2 }), now)).toBeNull()
    expect(parseHostAdmission(state({ admit: 'no' }), now)).toBeNull()
    expect(parseHostAdmission('{not json', now)).toBeNull()
  })

  it('keeps the memory level beside the worse of memory and disk, and bounds the reason', () => {
    expect(parseHostAdmission(state({ memory_state: 'green' }), now)).toMatchObject({
      state: 'red',
      memoryState: 'green',
    })
    const long = parseHostAdmission(state({ reason: `a\u0007${'b'.repeat(500)}` }), now)
    expect(long?.reason).toHaveLength(MAX_REASON_CHARS)
    expect(long?.reason.startsWith('ab')).toBe(true)
  })

  it('says red only for a fresh red file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-admission-'))
    const file = join(dir, 'admission.json')
    writeFileSync(file, state({}))
    expect(hostAdmissionRed(file, now)).toBe(true)
    expect(hostAdmissionRed(file, now + 3_600_000)).toBe(false)
    writeFileSync(file, state({ state: 'amber' }))
    expect(hostAdmissionRed(file, now)).toBe(false)
    expect(hostAdmissionRed(join(dir, 'missing.json'), now)).toBe(false)
    expect(hostAdmissionRed(null, now)).toBe(false)
  })

  it('reads admission.json under XDG_RUNTIME_DIR and treats a missing file as no verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-admission-'))
    expect(hostAdmissionPath({ XDG_RUNTIME_DIR: dir })).toBe(
      join(dir, 'host-steward', 'admission.json'),
    )
    expect(hostAdmissionPath({})).toBeNull()
    // another user's Tether reads the file memctl publishes elsewhere; a relative override is ignored
    expect(
      hostAdmissionPath({
        XDG_RUNTIME_DIR: dir,
        TETHER_HOST_ADMISSION: '/run/host-steward-memctl/admission.json',
      }),
    ).toBe('/run/host-steward-memctl/admission.json')
    expect(
      hostAdmissionPath({ TETHER_HOST_ADMISSION: '/run/host-steward-memctl/admission.json' }),
    ).toBe('/run/host-steward-memctl/admission.json')
    expect(hostAdmissionPath({ XDG_RUNTIME_DIR: dir, TETHER_HOST_ADMISSION: 'x/y.json' })).toBe(
      join(dir, 'host-steward', 'admission.json'),
    )
    const file = join(dir, 'admission.json')
    expect(await readHostAdmission(file, now)).toBeNull()
    writeFileSync(file, state({}))
    expect(await readHostAdmission(file, now)).toEqual({
      admit: false,
      state: 'red',
      memoryState: null,
      reason: 'swap 80%',
    })
    expect(await readHostAdmission(null, now)).toBeNull()
  })
})
