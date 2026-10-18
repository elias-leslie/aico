import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MEMORY_POLICY } from '../memory-policy'
import { applyPaneCapDropIn, PANE_CAP_DROPIN, type PaneCapFiles } from './pane-caps'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-caps-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function files(policy: string | null) {
  let reloads = 0
  const f: PaneCapFiles = {
    userUnitDir: dir,
    defaultOomPolicy: async () => policy,
    daemonReload: async () => {
      reloads++
    },
  }
  return { f, reloads: () => reloads }
}

describe('pane cap drop-in', () => {
  it('writes the cap from the policy and reloads only when it changed', async () => {
    const { f, reloads } = files('continue')
    expect(await applyPaneCapDropIn(f, { ...DEFAULT_MEMORY_POLICY })).toBe('written')
    const text = readFileSync(join(dir, PANE_CAP_DROPIN), 'utf8')
    expect(text).toContain('MemoryMax=12G')
    expect(text).toContain('MemorySwapMax=2G')
    expect(await applyPaneCapDropIn(f, { ...DEFAULT_MEMORY_POLICY })).toBe('unchanged')
    expect(await applyPaneCapDropIn(f, { ...DEFAULT_MEMORY_POLICY, paneMemoryMaxGib: 16 })).toBe(
      'written',
    )
    expect(readFileSync(join(dir, PANE_CAP_DROPIN), 'utf8')).toContain('MemoryMax=16G')
    expect(reloads()).toBe(2)
  })

  it('refuses while panes would not be on OOMPolicy=continue', async () => {
    const { f, reloads } = files('stop')
    expect(await applyPaneCapDropIn(f, { ...DEFAULT_MEMORY_POLICY })).toBe('refused')
    expect(reloads()).toBe(0)
  })
})
