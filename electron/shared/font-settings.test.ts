import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT_SETTINGS,
  fontFamilyFor,
  parseTerminalFontSettings,
} from './font-settings'

describe('parseTerminalFontSettings', () => {
  it('accepts supported font ids and sizes', () => {
    expect(parseTerminalFontSettings({ fontId: 'fira-code', fontSize: 16 })).toEqual({
      fontId: 'fira-code',
      fontSize: 16,
    })
  })

  it('falls back for unsupported values', () => {
    expect(parseTerminalFontSettings({ fontId: 'papyrus', fontSize: 99 })).toEqual(
      DEFAULT_TERMINAL_FONT_SETTINGS,
    )
  })
})

describe('fontFamilyFor', () => {
  it('returns a concrete xterm font family', () => {
    expect(fontFamilyFor('iosevka')).toContain('Iosevka')
  })
})
