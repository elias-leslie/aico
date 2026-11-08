import { describe, expect, it } from 'vitest'
import { countBackups, sourceRetired, sourceState } from './backup-count'

const copy = (source: string, state: string, gone = false) => ({ source, state, gone })

describe('counting backups', () => {
  it('counts sources, and only the good copies of current sources', () => {
    expect(
      countBackups([
        copy('notes', 'ok'),
        copy('notes', 'ok'),
        copy('mail', 'ok'),
        copy('mail', 'failed'),
        copy('photos', 'ok'),
        copy('photos', 'warn'),
      ]),
    ).toEqual({ current: 1, late: 1, failed: 1, archived: 0, away: 0, copies: 2 })
  })

  it('tells a source that is gone from one whose machine is off', () => {
    expect(
      countBackups([
        copy('old', 'off', true),
        copy('old', 'off', true),
        copy('vm', 'off'),
        copy('half', 'off', true),
        copy('half', 'off'),
      ]),
    ).toEqual({ current: 0, late: 0, failed: 0, archived: 1, away: 2, copies: 0 })
  })

  it('leaves a gone copy out of a live source and its copy count', () => {
    expect(countBackups([copy('notes', 'ok'), copy('notes', 'off', true)])).toMatchObject({
      current: 1,
      archived: 0,
      copies: 1,
    })
  })

  it('reads a state it does not know as late', () => {
    expect(sourceState([copy('a', 'ok'), copy('a', 'strange')])).toBe('warn')
  })

  it('takes the worst live copy, off only when none is live', () => {
    expect(sourceState([copy('a', 'warn'), copy('a', 'failed'), copy('a', 'off')])).toBe('failed')
    expect(sourceState([copy('a', 'off')])).toBe('off')
    expect(sourceRetired([copy('a', 'off', true), copy('a', 'off')])).toBe(false)
  })
})
