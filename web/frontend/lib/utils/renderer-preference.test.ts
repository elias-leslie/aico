import { beforeEach, describe, expect, it } from 'vitest'
import {
  getRendererPreference,
  isWebglUnreliablePlatform,
  RENDERER_STORAGE_KEY,
  setRendererPreference,
  shouldUseWebglRenderer,
} from './renderer-preference'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('renderer preference', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('defaults to auto and rejects stored junk', () => {
    expect(getRendererPreference()).toBe('auto')
    window.localStorage.setItem(RENDERER_STORAGE_KEY, 'metal')
    expect(getRendererPreference()).toBe('auto')
  })

  it('round-trips a stored choice', () => {
    setRendererPreference('dom')
    expect(getRendererPreference()).toBe('dom')
  })

  it('treats Android as a platform where WebGL misdraws output', () => {
    expect(isWebglUnreliablePlatform(ANDROID_UA)).toBe(true)
    expect(isWebglUnreliablePlatform(DESKTOP_UA)).toBe(false)
  })

  it('auto keeps WebGL on desktop and drops it on Android', () => {
    expect(shouldUseWebglRenderer('auto', DESKTOP_UA)).toBe(true)
    expect(shouldUseWebglRenderer('auto', ANDROID_UA)).toBe(false)
  })

  it('honours an explicit choice on every platform', () => {
    expect(shouldUseWebglRenderer('webgl', ANDROID_UA)).toBe(true)
    expect(shouldUseWebglRenderer('dom', DESKTOP_UA)).toBe(false)
  })
})
