import { describe, expect, it } from 'vitest'
import { formatAnsiColorProfile, profileAnsiColors } from './ansi-color-profile'

describe('profileAnsiColors', () => {
  it('counts basic and bright ANSI colors', () => {
    const profile = profileAnsiColors('\x1b[31mred\x1b[92mgreen\x1b[0m')

    expect(profile.basicColors).toBe(1)
    expect(profile.brightColors).toBe(1)
    expect(profile.resetCount).toBe(1)
    expect(profile.dominantMode).toBe('ansi')
    expect(formatAnsiColorProfile(profile)).toContain('mode=ansi')
  })

  it('counts 256-color escapes', () => {
    const profile = profileAnsiColors('\x1b[38;5;196mred\x1b[48;5;21mblue\x1b[0m')

    expect(profile.color256).toBe(2)
    expect(profile.dominantMode).toBe('256')
  })

  it('counts truecolor and OSC palette escapes', () => {
    const profile = profileAnsiColors(
      '\x1b]4;1;rgb:ff/00/00\x07\x1b[38;2;10;20;30mtext\x1b[0m',
    )

    expect(profile.oscPalette).toBe(1)
    expect(profile.truecolor).toBe(1)
    expect(profile.dominantMode).toBe('rgb')
  })
})
