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

  it('keeps pinned actions and compose directly in the titlebar', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
    const titlebar = html.slice(html.indexOf('<header'), html.indexOf('</header>'))

    for (const id of ['pinned', 'compose-toggle', 'lantern-menu-btn']) {
      expect(titlebar).toContain(`id="${id}"`)
    }
    expect(titlebar).not.toContain('titlebar-secondary')
    expect(titlebar).not.toContain('titlebar-more')
    expect(titlebar).not.toContain('titlebar-essential')
    expect(titlebar).not.toContain('inert')
    expect(html).toContain('aria-label="Session name"')
  })
})
