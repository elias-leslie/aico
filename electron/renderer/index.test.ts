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
})
