// Agent shares are untrusted metadata. A file share links to files where they
// already are; Open shows it in Aico's web app (Files > Shared), which reads
// them through its own checks. A web link is only ever copied.
import type { BrowserWindow, Clipboard, Dialog, IpcMain, Shell, WebContents } from 'electron'
import type { SelectionToast } from '../types'

interface ShareBase {
  id: string
  session: string | null
  title: string | null
}
type Share = ShareBase & ({ kind: 'files'; paths: string[] } | { kind: 'url'; url: string })

/** A path's last part; a shared folder's path ends in `/`. */
const lastPart = (path: string): string =>
  path
    .replace(/(?<=.)\/$/, '')
    .split('/')
    .pop() || path

export function parseShare(data: Record<string, unknown>): Share | null {
  const { id, session, title, kind, paths, url } = data
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{12}$/.test(id) ||
    (session !== null && (typeof session !== 'string' || !/^[0-9a-f]{8}$/.test(session))) ||
    (title !== null &&
      (typeof title !== 'string' || title.length > 240 || /[\p{Cc}\p{Cf}]/u.test(title)))
  )
    return null
  const base = { id, session, title }
  if (
    kind === 'files' &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= 20 &&
    paths.every(
      (path) =>
        typeof path === 'string' &&
        path.startsWith('/') &&
        path.length <= 4096 &&
        !/[\p{Cc}\p{Cf}]/u.test(path),
    )
  )
    return { ...base, kind, paths: paths as string[] }
  if (
    kind === 'url' &&
    typeof url === 'string' &&
    url.length <= 8000 &&
    /^https?:\/\//i.test(url) &&
    !/[\p{Cc}\p{Cf}\s]/u.test(url)
  ) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ...base, kind, url }
    } catch {
      /* Invalid URL: no action. */
    }
  }
  return null
}

/** What a share holds, in a few words. */
export function shareSummary(share: Share): string {
  if (share.kind === 'url') return share.url
  const more = share.paths.length - 1
  return `${lastPart(share.paths[0])}${more ? ` and ${more} more` : ''}`
}

interface SharesDeps {
  /** Aico's web app, where Files > Shared opens a share */
  webUrl: string
  windowFor(session: string | null): BrowserWindow | undefined
  sessionName(session: string | null): string | undefined
  clipboard: Pick<Clipboard, 'writeText'>
  shell: Pick<Shell, 'openExternal'>
  dialog: Pick<Dialog, 'showMessageBox' | 'showErrorBox'>
}

export function createAgentShares(deps: SharesDeps) {
  const pending = new Map<string, WebContents>()
  let dialogOpen = false
  const fail = (error: unknown): void =>
    deps.dialog.showErrorBox(
      'Could not open what was shared',
      error instanceof Error ? error.message : String(error),
    )
  const open = (id: string): void => {
    deps.shell.openExternal(`${deps.webUrl}/?show=${id}`).catch(fail)
  }
  return {
    notify(data: Record<string, unknown>): void {
      const share = parseShare(data)
      if (!share) return
      const kind = `Agent shared: ${share.title || shareSummary(share)}`
      const sessionName = deps.sessionName(share.session)
      const snippet = [sessionName, share.title ? shareSummary(share) : null]
        .filter(Boolean)
        .join('\n')
      const win = deps.windowFor(share.session)
      if (win && !win.isDestroyed()) {
        const action: SelectionToast['action'] =
          share.kind === 'url' ? { kind: 'copy', text: share.url } : { kind: 'file', id: share.id }
        if (share.kind === 'files') {
          if (pending.size >= 100) pending.delete(pending.keys().next().value ?? '')
          pending.set(share.id, win.webContents)
        }
        win.webContents.send('selection:toast', { kind, snippet, action } satisfies SelectionToast)
        return
      }
      // No open widget: retain an actionable notification through Aico's
      // existing dialog UI. Copying a URL never invokes the owner's browser.
      if (dialogOpen) return
      dialogOpen = true
      void deps.dialog
        .showMessageBox({
          type: 'info',
          title: kind,
          message: kind,
          detail: snippet,
          buttons: [share.kind === 'url' ? 'Copy' : 'Open', 'Close'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then(({ response }) => {
          if (response !== 0) return
          if (share.kind === 'url') deps.clipboard.writeText(share.url)
          else open(share.id)
        })
        .catch(fail)
        .finally(() => {
          dialogOpen = false
        })
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on'>): void => {
      ipcMain.on('show:file', (event, id: unknown) => {
        if (typeof id !== 'string') return
        if (pending.get(id) !== event.sender) return
        pending.delete(id)
        open(id)
      })
    },
  }
}
