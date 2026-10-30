import { describe, expect, it } from 'vitest'
import { view } from '../test-stubs/health-view'
import {
  type HealthFinding,
  handledBy,
  type NightshiftOwnerView,
  type NightshiftViewResult,
  pillState,
  unknownReason,
} from './health'

const finding = (over: Partial<HealthFinding> = {}): HealthFinding => ({
  id: 'row-ws-units',
  host: 'ws',
  host_label: 'Workstation',
  check: 'Failed units',
  state: 'warn',
  summary: '1 unit restarting',
  who: 'Agent',
  owner: false,
  next: '',
  age: 600,
  link: 'https://ns.example/#row-ws-units',
  ...over,
})

const ok = (v: NightshiftOwnerView): NightshiftViewResult => ({
  available: true,
  view: v,
})

describe('pillState', () => {
  it('counts critical and warning checks', () => {
    expect(pillState(ok(view()), false, false)).toMatchObject({
      label: 'Health OK',
      tone: 'good',
    })
    expect(
      pillState(ok(view({ findings: [finding()] })), false, false),
    ).toMatchObject({
      label: 'Health: 1 warning',
      tone: 'warn',
      count: 1,
    })
    const both = view({
      findings: [finding({ state: 'crit' }), finding(), finding()],
    })
    expect(pillState(ok(both), false, false)).toMatchObject({
      label: 'Health: 1 critical',
      tone: 'danger',
      count: 3,
      title: 'Health: 1 critical, 2 warnings',
    })
  })

  it('never says OK when health is unknown', () => {
    const unknown = { label: 'Health unknown', tone: 'quiet', count: 0 }
    expect(
      pillState({ available: false, reason: 'not_answering' }, false, false),
    ).toMatchObject(unknown)
    expect(pillState(undefined, true, false)).toMatchObject(unknown)
    expect(pillState(ok(view()), true, false)).toMatchObject(unknown) // a failed refresh
    const stale = view({ snapshot: { state: 'stale', age: 2400 } })
    expect(pillState(ok(stale), false, false)).toMatchObject(unknown)
    expect(unknownReason(ok(stale), false)).toBe(
      'Nightshift’s last check was 40 min ago, so health is unknown until it reports again.',
    )
    expect(pillState(undefined, false, true)).toMatchObject({
      label: 'Health',
      tone: 'quiet',
    })
  })
})

describe('handledBy', () => {
  it('says who has each problem', () => {
    expect(handledBy(finding({ owner: true, who: 'You' }))).toMatch(/your call/)
    expect(handledBy(finding())).toBe('A steward agent is on it.')
    expect(handledBy(finding({ who: 'Nightshift' }))).toBe(
      'Nightshift fixes this itself.',
    )
  })
})
