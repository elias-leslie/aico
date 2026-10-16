// Electron grants a renderer's permission requests (microphone, camera,
// notifications, geolocation, clipboard read, ...) unless the app installs a
// handler. No Aico window needs any of them, so both the request handler and
// the check handler refuse every permission, from every webContents and frame.

import type { Session } from 'electron'

export function denyAllPermissions(
  session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>,
): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}
