import { describe, expect, it } from 'vitest'
import {
  isWebglUnreliablePlatform,
  shouldUseWebglRenderer,
} from './webgl-renderer'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('renderer choice', () => {
  it('treats Android as a platform where WebGL misdraws output', () => {
    expect(isWebglUnreliablePlatform(ANDROID_UA)).toBe(true)
    expect(isWebglUnreliablePlatform(DESKTOP_UA)).toBe(false)
  })

  it('keeps WebGL on desktop and drops it on Android', () => {
    expect(shouldUseWebglRenderer(DESKTOP_UA)).toBe(true)
    expect(shouldUseWebglRenderer(ANDROID_UA)).toBe(false)
  })
})
