import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { H } from './arcade/engine'

const css = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

describe('design tokens', () => {
  it('keeps the titlebar arcade as tall as the titlebar token', () => {
    expect(css('./tokens.css')).toContain(`--titlebar-height: ${H}px;`)
  })

  it('sizes the titlebar and places the lantern menu from the titlebar token', () => {
    expect(css('./chrome.css')).toMatch(/\.titlebar \{[^}]*height: var\(--titlebar-height\);/)
    expect(css('./control-surface.css')).toMatch(
      /\.aico-menu \{[^}]*top: var\(--titlebar-height\);/,
    )
  })
})
