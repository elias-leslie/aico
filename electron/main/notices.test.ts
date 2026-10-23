import type { BrowserWindow } from 'electron'
import { TetherError, TetherUnavailable } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { describeFailure, writeNotice } from './notices'

const refusal = (code: string, reason?: string) =>
  new TetherError(409, code, reason === undefined ? {} : { reason })

describe('describeFailure', () => {
  it.each([
    [
      new TetherUnavailable('socket closed'),
      'End failed: Tether is not reachable. Your sessions keep running; Aico reconnects on its own.',
    ],
    [
      refusal('admission_denied', 'memory pressure'),
      'End failed: deferred by host admission (memory pressure). Nothing was started.',
    ],
    [
      refusal('admission_denied'),
      'End failed: deferred by host admission (not enough memory or too many agents). Nothing was started.',
    ],
    [
      refusal('linger_required'),
      'End failed: user linger is off, so a session would die on logout. Run: loginctl enable-linger',
    ],
    [
      refusal('stale_generation'),
      'End failed: the session changed meanwhile. Nothing was applied; try again.',
    ],
    [
      refusal('identity_changed'),
      'End failed: the session changed meanwhile. Nothing was applied; try again.',
    ],
    [
      refusal('busy'),
      'End failed: another change to this session is in progress. Try again shortly.',
    ],
    [
      refusal('workload_unavailable', 'pane exited'),
      'End failed: the session is not running (pane exited).',
    ],
    [refusal('workload_unavailable'), 'End failed: the session is not running.'],
    [
      refusal('outcome_uncertain'),
      'End failed: the outcome is unknown. Check the session before trying again.',
    ],
    [refusal('not_found', 'no such session'), 'End failed: no such session.'],
    [refusal('not_found'), 'End failed: not_found.'],
    [new Error('boom'), 'End failed: boom'],
    ['plain text', 'End failed: plain text'],
  ])('%s', (error, text) => {
    expect(describeFailure('End failed', error)).toBe(text)
  })
})

describe('writeNotice', () => {
  const fakeWindow = (destroyed = false) => {
    const send = vi.fn()
    return {
      win: { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow,
      send,
    }
  }

  it('writes the message into the terminal in red by default', () => {
    const { win, send } = fakeWindow()
    writeNotice(win, 'Could not attach')
    expect(send).toHaveBeenCalledWith('pty:data', '\r\n\u001b[31mCould not attach\u001b[0m\r\n')
  })

  it('takes another colour', () => {
    const { win, send } = fakeWindow()
    writeNotice(win, 'Could not rename', 33)
    expect(send).toHaveBeenCalledWith('pty:data', '\r\n\u001b[33mCould not rename\u001b[0m\r\n')
  })

  it('does nothing without a live window', () => {
    const { win, send } = fakeWindow(true)
    writeNotice(win, 'x')
    writeNotice(undefined, 'x')
    expect(send).not.toHaveBeenCalled()
  })
})
