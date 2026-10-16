import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BONE, INK } from '../shared/palette'
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

  it('keeps raw colours in tokens.css only', () => {
    // A #hex colour (not an HTML character reference like &#9671;) or an
    // rgb()/rgba() with literal channels.
    const raw = /(?<!&)#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi
    for (const file of ['./chrome.css', './control-surface.css', './index.html']) {
      expect([file, css(file).match(raw) ?? []]).toEqual([file, []])
    }
  })

  it('draws the window surface and terminal in the --ink and --bone tokens', () => {
    const channels = (hex: string) =>
      [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(' ')
    expect(css('./tokens.css')).toContain(`--ink-rgb: ${channels(INK)};`)
    expect(css('./tokens.css')).toContain(`--bone-rgb: ${channels(BONE)};`)
  })
})
