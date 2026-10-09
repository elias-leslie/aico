import { describe, expect, it } from 'vitest'
import {
  readScrollbackPage,
  scrollbackPageCount,
  scrollbackPageFromLine,
  type TmuxStdout,
} from './scrollback-page'
import { capturePageTargetArgs, paneScrollbackInfoTargetArgs, type TmuxTarget } from './tmux'

const target: TmuxTarget = { socket: null, session: '%7' }

function fakeTmux(info: string, text = 'page') {
  const calls: Array<{ args: string[]; maxBuffer: number }> = []
  const tmux: TmuxStdout = async (args, maxBuffer) => {
    calls.push({ args, maxBuffer })
    return calls.length === 1 ? info : text
  }
  return { tmux, calls }
}

describe('scrollback page request parsing', () => {
  it('defaults and clamps the line count', () => {
    expect(scrollbackPageCount(undefined)).toBe(5000)
    expect(scrollbackPageCount('100')).toBe(5000)
    expect(scrollbackPageCount(Number.NaN)).toBe(5000)
    expect(scrollbackPageCount(0)).toBe(1)
    expect(scrollbackPageCount(12.9)).toBe(12)
    expect(scrollbackPageCount(1e9)).toBe(5000)
  })

  it('treats a missing or invalid start line as the tail', () => {
    expect(scrollbackPageFromLine(undefined)).toBeUndefined()
    expect(scrollbackPageFromLine(null)).toBeUndefined()
    expect(scrollbackPageFromLine('3')).toBeUndefined()
    expect(scrollbackPageFromLine(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(scrollbackPageFromLine(-4)).toBe(0)
    expect(scrollbackPageFromLine(7.8)).toBe(7)
  })
})

describe('readScrollbackPage', () => {
  it('captures the tail page with colour escapes by default', async () => {
    const { tmux, calls } = fakeTmux('1000 40\n', 'tail text')
    const page = await readScrollbackPage(tmux, target, { count: 100 })

    expect(page).toEqual({ fromLine: 940, totalLines: 1040, historySize: 1000, text: 'tail text' })
    expect(calls).toEqual([
      { args: paneScrollbackInfoTargetArgs(target), maxBuffer: 1024 },
      {
        args: capturePageTargetArgs(target, {
          fromLine: 940,
          toLineExclusive: 1040,
          totalLines: 1040,
          startCoord: -60,
          endCoord: 39,
        }),
        maxBuffer: 16 * 1024 * 1024,
      },
    ])
    expect(calls[1].args).toContain('-e')
  })

  it('captures bare text only for an explicit plain request', async () => {
    const plain = fakeTmux('10 5')
    await readScrollbackPage(plain.tmux, target, { fromLine: 2, count: 3, plain: true })
    expect(plain.calls[1].args).not.toContain('-e')

    const truthy = fakeTmux('10 5')
    await readScrollbackPage(truthy.tmux, target, { plain: 'yes' })
    expect(truthy.calls[1].args).toContain('-e')
  })

  it('ignores a non-object request', async () => {
    const { tmux } = fakeTmux('0 24')
    expect(await readScrollbackPage(tmux, target, 'junk')).toMatchObject({
      fromLine: 0,
      totalLines: 24,
      historySize: 0,
    })
  })

  it('returns an empty page without capturing when the pane has no lines', async () => {
    const { tmux, calls } = fakeTmux('0 0')
    expect(await readScrollbackPage(tmux, target, undefined)).toEqual({
      fromLine: 0,
      totalLines: 0,
      historySize: 0,
      text: '',
    })
    expect(calls).toHaveLength(1)
  })

  it('propagates a tmux failure to the caller', async () => {
    const failure = new Error('no server running')
    const tmux: TmuxStdout = async () => {
      throw failure
    }
    await expect(readScrollbackPage(tmux, target, undefined)).rejects.toBe(failure)
  })
})
