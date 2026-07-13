import { describe, expect, it } from 'vitest'
import { type AudioMediaPermissionRequest, allowTrustedAudioMedia } from './media-permission'

const BASE: AudioMediaPermissionRequest = {
  permission: 'media',
  trustedRenderer: true,
  currentUrl: 'file:///opt/aico/out/renderer/index.html',
  requestingUrl: 'file:///opt/aico/out/renderer/index.html',
  isMainFrame: true,
  mediaTypes: ['audio'],
}

describe('allowTrustedAudioMedia', () => {
  it('allows microphone access for the trusted main renderer document', () => {
    expect(allowTrustedAudioMedia(BASE)).toBe(true)
  })

  it.each([
    ['untrusted web contents', { trustedRenderer: false }],
    ['a subframe', { isMainFrame: false }],
    ['another file renderer', { requestingUrl: 'file:///tmp/untrusted.html' }],
    ['video', { mediaTypes: ['video'] }],
    ['mixed audio and video', { mediaTypes: ['audio', 'video'] }],
    ['an unspecified media type', { mediaTypes: undefined }],
    ['another permission', { permission: 'notifications' }],
  ])('denies %s', (_label, override) => {
    expect(allowTrustedAudioMedia({ ...BASE, ...override })).toBe(false)
  })

  it('accepts the same trusted development origin', () => {
    expect(
      allowTrustedAudioMedia({
        ...BASE,
        currentUrl: 'http://127.0.0.1:5173/index.html',
        requestingUrl: 'http://127.0.0.1:5173/',
      }),
    ).toBe(true)
  })
})
