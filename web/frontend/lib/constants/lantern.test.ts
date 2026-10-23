import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LANTERN_MONO_FAMILY, LANTERN_RIM } from './lantern'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Lantern tokens on the web', () => {
  it('imports the desktop tokens and fonts instead of copying them', () => {
    const globals = read('../../app/globals.css')
    expect(globals).toContain(
      '@import "../../../electron/renderer/tokens.css";',
    )
    expect(globals).toContain('@import "../../../assets/fonts/fonts.css";')
    expect(read('../../app/layout.tsx')).not.toContain('next/font')
  })

  it('keeps raw colours in tokens.css only', () => {
    const raw = /#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi
    expect(read('../../app/globals.css').match(raw) ?? []).toEqual([])
  })

  it('matches the desktop rim colour and terminal typeface', () => {
    expect(read('../../../../electron/renderer/tokens.css')).toContain(
      `--rim: ${LANTERN_RIM};`,
    )
    expect(read('../../../../electron/shared/font-settings.ts')).toContain(
      `family: "${LANTERN_MONO_FAMILY}"`,
    )
  })
})
