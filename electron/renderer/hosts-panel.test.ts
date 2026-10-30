import { describe, expect, it } from 'vitest'
import type { HostRow } from '../types'
import { hostSummary, sessionsLine, sourceLabel, toolDetail, toolSummary } from './hosts-panel'

const row = (fields: Partial<HostRow> = {}): HostRow => ({
  name: 'agent-work',
  state: 'connected',
  since: 1,
  sessions: 0,
  error: null,
  wake: null,
  ...fields,
})

const tool = (state: string, credentials = [] as never[]) =>
  ({ tool: 'codex', state, source: 'agent-hub', credentials }) as never

describe('host summary', () => {
  it('leads with the state', () => {
    expect(hostSummary(row()).label).toBe('Connected')
    expect(hostSummary(row({ state: 'powered_off' })).label).toBe('Powered off')
    expect(hostSummary(row({ state: 'offline', error: 'ssh: timed out' }))).toEqual({
      label: 'Offline',
      tone: 'quiet',
      detail: 'ssh: timed out',
    })
    expect(hostSummary(row({ state: 'identity_changed' })).label).toBe('Not the same machine')
  })

  it('shows a start in progress and why one failed', () => {
    const wake = {
      state: 'starting',
      reason: 'host_starting',
      step: 'connecting',
      since: 1,
      error: null,
    }
    expect(hostSummary(row({ state: 'offline', wake } as never)).label).toBe('Starting… connecting')
    const failed = { ...wake, state: 'failed', error: 'agent-work did not come up within 240 s' }
    expect(hostSummary(row({ state: 'powered_off', wake: failed } as never)).detail).toBe(
      'Didn’t start: agent-work did not come up within 240 s',
    )
  })

  it('counts sessions, marking a count it cannot refresh', () => {
    expect(sessionsLine(row())).toBe('No sessions')
    expect(sessionsLine(row({ sessions: 2 }))).toBe('2 sessions')
    expect(sessionsLine(row({ state: 'offline', sessions: 1 }))).toBe('1 session (last seen)')
  })
})

describe('tool sign-in', () => {
  it('never shows an unknown state as signed out', () => {
    expect(toolSummary(tool('signed_in')).label).toBe('Signed in')
    expect(toolSummary(tool('needs_sign_in')).label).toBe('Needs sign-in')
    expect(toolSummary(tool('expired')).label).toBe('Expired')
    expect(toolSummary(tool('unknown')).label).toBe('Unknown')
    expect(toolSummary(tool('something-new')).label).toBe('Unknown')
  })

  it('names where the login lives, with the path and detail in the tooltip', () => {
    expect(sourceLabel('agent-hub')).toBe('Agent Hub')
    expect(sourceLabel('host:/home/u/.codex/auth.json')).toBe('This host')
    const detail = toolDetail(
      tool('needs_sign_in', [
        {
          name: 'login',
          rotates: true,
          state: 'needs_sign_in',
          source: 'host:/home/u/.codex/auth.json',
        },
        {
          name: 'key',
          rotates: false,
          state: 'unknown',
          source: 'agent-hub',
          detail: 'Agent Hub unreachable',
        },
      ] as never[]),
    )
    expect(detail).toBe(
      'login: Needs sign-in · This host\nkey: Unknown · Agent Hub (Agent Hub unreachable)',
    )
  })
})
