import { describe, expect, it, vi } from 'vitest'
import { denyAllPermissions } from './permissions'

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>,
) => void
type CheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: Record<string, unknown>,
) => boolean

// Every permission name Electron passes to either handler.
const PERMISSIONS = [
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'hid',
  'idle-detection',
  'keyboardLock',
  'media',
  'mediaKeySystem',
  'midi',
  'midiSysex',
  'notifications',
  'openExternal',
  'pointerLock',
  'serial',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
  'usb',
  'window-management',
  'fileSystem',
  'unknown',
]

const PAGE = 'file:///opt/aico/out/renderer/index.html'

function install() {
  const handlers: { request?: RequestHandler; check?: CheckHandler } = {}
  const session = {
    setPermissionRequestHandler: vi.fn((fn: RequestHandler) => {
      handlers.request = fn
    }),
    setPermissionCheckHandler: vi.fn((fn: CheckHandler) => {
      handlers.check = fn
    }),
  }
  denyAllPermissions(session as never)
  return { session, handlers }
}

describe('denyAllPermissions', () => {
  it('installs both the request handler and the check handler', () => {
    const { session, handlers } = install()
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(handlers.request).toBeTypeOf('function')
    expect(handlers.check).toBeTypeOf('function')
  })

  it.each(PERMISSIONS)('denies a %s request from an Aico window, even audio-only media', (p) => {
    const { handlers } = install()
    const callback = vi.fn()
    handlers.request?.({ getURL: () => PAGE }, p, callback, {
      requestingUrl: PAGE,
      isMainFrame: true,
      mediaTypes: ['audio'],
    })
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it.each(PERMISSIONS)('answers a %s check with false, with or without webContents', (p) => {
    const { handlers } = install()
    const details = { requestingUrl: PAGE, isMainFrame: true, mediaType: 'audio' }
    expect(handlers.check?.({ getURL: () => PAGE }, p, PAGE, details)).toBe(false)
    expect(handlers.check?.(null, p, PAGE, details)).toBe(false)
  })
})
