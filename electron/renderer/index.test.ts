import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('renderer status confirmation', () => {
  it('exposes the shared toast as an atomic polite status region', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
    const toast = html.match(/<div class="selection-toast"[^>]*>/)?.[0]

    expect(toast).toContain('role="status"')
    expect(toast).toContain('aria-live="polite"')
    expect(toast).toContain('aria-atomic="true"')
  })

  it('keeps the always-visible controls outside the secondary disclosure', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
    const secondary = html.slice(
      html.indexOf('<div class="titlebar-secondary'),
      html.indexOf('<div class="pinned titlebar-essential'),
    )

    expect(secondary).toContain('id="pinned"')
    expect(secondary).toContain('id="compose-toggle"')
    for (const id of ['titlebar-essential', 'titlebar-more', 'lantern-menu-btn']) {
      expect(html).toContain(`id="${id}"`)
      expect(secondary).not.toContain(`id="${id}"`)
    }
    expect(html).toContain('aria-controls="titlebar-secondary" aria-expanded="false"')
    expect(html).toContain('aria-label="Session name"')
  })
})
