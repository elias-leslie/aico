import { describe, expect, it } from 'vitest'
import { paneModeArgs, parsePaneMode } from './pane-mode'

describe('pane mode', () => {
  it('asks one exact pane for its mode, read-only', () => {
    expect(paneModeArgs('/s/server.sock', '%7')).toEqual([
      '-S',
      '/s/server.sock',
      'display-message',
      '-p',
      '-t',
      '%7',
      '#{?alternate_on,1,0}\t#{?mouse_any_flag,1,0}\t#{history_size}\t#{?pane_in_mode,1,0}\t#{pane_mode}',
    ])
  })

  it('parses copy mode, a plain pane and garbage', () => {
    expect(parsePaneMode('0\t1\t4200\t1\tcopy-mode\n')).toEqual({
      alternateScreen: false,
      mouseReporting: true,
      historySize: 4200,
      inMode: true,
      mode: 'copy-mode',
    })
    expect(parsePaneMode('1\t0\t0\t0\t\n')).toEqual({
      alternateScreen: true,
      mouseReporting: false,
      historySize: 0,
      inMode: false,
      mode: null,
    })
    expect(parsePaneMode('')).toEqual({
      alternateScreen: false,
      mouseReporting: false,
      historySize: 0,
      inMode: false,
      mode: null,
    })
    expect(parsePaneMode('0\t0\t-5\t1\tcopy mode; rm\n')).toMatchObject({
      historySize: 0,
      inMode: true,
      mode: null,
    })
  })
})
