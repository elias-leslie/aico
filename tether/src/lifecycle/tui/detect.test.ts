import { describe, expect, it } from 'vitest'
import { detectTuiFromProcessNames, parseProcessTable, processTreeNames } from './detect'
import type { TuiSpec } from './spec'

const spec = (slug: string, processName: string, order: number): TuiSpec => ({
  slug,
  displayName: slug,
  icon: '',
  accent: '',
  order,
  enabled: true,
  command: [slug],
  processName,
})

describe('process table parsing', () => {
  it('parses ps pid/ppid/comm output', () => {
    expect(parseProcessTable('  10     1 bash\n  11    10 codex\n')).toEqual([
      { pid: 10, ppid: 1, comm: 'bash' },
      { pid: 11, ppid: 10, comm: 'codex' },
    ])
  })

  it('walks the full process tree under the pane root', () => {
    const rows = parseProcessTable(`
      10 1 bash
      11 10 node
      12 11 codex
      13 12 gitnexus
      20 1 claude
    `)
    expect(processTreeNames(rows, 10)).toEqual(['bash', 'node', 'codex', 'gitnexus'])
  })
})

describe('TUI detection', () => {
  it('detects the TUI whose process name is present', () => {
    const detected = detectTuiFromProcessNames(
      [spec('claude-code', 'claude', 0), spec('codex', 'codex', 1)],
      ['bash', 'node', 'codex', 'gitnexus'],
    )
    expect(detected?.slug).toBe('codex')
  })

  it('ignores specs without a process name', () => {
    expect(detectTuiFromProcessNames([spec('shell', '', 99)], ['bash'])).toBeUndefined()
  })
})
