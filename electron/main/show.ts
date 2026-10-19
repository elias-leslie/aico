// Agent handoffs are untrusted metadata and bytes. Only a click reads a file;
// the preview uses the bounded owner copy, never an agent path or active content.
import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BrowserWindow, Clipboard, Dialog, IpcMain, Shell, WebContents } from 'electron'
import type { SelectionToast } from '../types'

export const MAX_SHOWN_BYTES = 25 * 1024 * 1024
const TEXT_LIMIT = 1024 * 1024

export function validShowName(name: string): boolean {
  return (
    /^(?:[0-9a-f]{8}|none)\/out\/[A-Za-z0-9._-]+$/.test(name) &&
    !name.includes('\n') &&
    !name.includes('..') &&
    !name.endsWith('/.')
  )
}

interface ShareBase {
  id: string
  session: string | null
  title: string | null
  name: string
}
type Share = ShareBase & ({ kind: 'file' } | { kind: 'url'; url: string })

export function parseShare(data: Record<string, unknown>): Share | null {
  const { id, session, title, name, kind, url } = data
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{12}$/.test(id) ||
    id.length !== 12 ||
    (session !== null &&
      (typeof session !== 'string' || session.length !== 8 || !/^[0-9a-f]{8}$/.test(session))) ||
    (title !== null &&
      (typeof title !== 'string' || title.length > 240 || /[\p{Cc}\p{Cf}]/u.test(title))) ||
    typeof name !== 'string'
  )
    return null
  const base = { id, session, title, name }
  if (kind === 'file' && validShowName(name)) return { ...base, kind }
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

const at = (directory: FileHandle, name: string): string => `/proc/self/fd/${directory.fd}/${name}`
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

async function readShownBytes(file: FileHandle): Promise<Buffer> {
  const stat = await file.stat()
  if (!stat.isFile()) throw new Error('The shared file must be a regular file.')
  if (stat.size > MAX_SHOWN_BYTES) throw new Error('The shared file exceeds 25 MB.')
  const chunks: Buffer[] = []
  const buffer = Buffer.alloc(64 * 1024)
  let total = 0
  for (;;) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, MAX_SHOWN_BYTES - total + 1),
      null,
    )
    if (!bytesRead) break
    total += bytesRead
    if (total > MAX_SHOWN_BYTES) throw new Error('The shared file exceeds 25 MB.')
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
  }
  return Buffer.concat(chunks, total)
}

async function childDirectory(
  parent: FileHandle,
  name: string,
  owner?: number,
  create = true,
): Promise<FileHandle> {
  const path = at(parent, name)
  let created = false
  const directory = await open(path, DIRECTORY_FLAGS).catch(async (error: unknown) => {
    if (!create || owner === undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
    const stat = await parent.stat()
    if (stat.uid !== owner || (stat.mode & 0o022) !== 0) {
      throw new Error(
        'The exchange parent must exist and be owned by you before Aico can create the owner directory.',
      )
    }
    await mkdir(path, { mode: 0o755 })
      .then(() => {
        created = true
      })
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
    return open(path, DIRECTORY_FLAGS)
  })
  try {
    const stat = await directory.stat()
    if (owner !== undefined && (stat.uid !== owner || (stat.mode & 0o022) !== 0)) {
      throw new Error('Owner exchange directories must be owned by you and writable only by you.')
    }
    if (created) await directory.chmod(0o755)
    return directory
  } catch (error) {
    await directory.close()
    throw error
  }
}

export async function copyShownFile(exchangeRoot: string, id: string, name: string) {
  if (id.length !== 12 || !/^[0-9a-f]{12}$/.test(id) || !validShowName(name))
    throw new Error('Invalid shared file name.')
  const owner = process.getuid?.()
  if (owner === undefined) throw new Error('Owner identity is unavailable.')
  const handles: FileHandle[] = []
  const keep = (handle: FileHandle): FileHandle => {
    handles.push(handle)
    return handle
  }
  try {
    const root = keep(await open(exchangeRoot, DIRECTORY_FLAGS))
    const parts = name.split('/')
    const targetParts = ['owner', 'shown', `${id}-${parts[0]}`, 'out']
    const path = join(exchangeRoot, ...targetParts, parts[2])
    // Repeated handoffs use the retained owner bytes even if the agent's
    // original has since changed or disappeared. Do not create directories yet.
    try {
      let existingDir = root
      for (const part of targetParts)
        existingDir = keep(await childDirectory(existingDir, part, owner, false))
      const existing = keep(await open(at(existingDir, parts[2]), FILE_FLAGS))
      return { path, bytes: await readShownBytes(existing) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Pin each directory: O_NOFOLLOW on just the final file would still allow
    // the agent to substitute a symlink for its session or out directory.
    let sourceDir = root
    for (const part of ['agent', ...parts.slice(0, -1)]) {
      sourceDir = keep(await childDirectory(sourceDir, part))
    }
    const source = keep(await open(at(sourceDir, parts[2]), FILE_FLAGS))
    const bytes = await readShownBytes(source)
    let targetDir = root
    for (const part of targetParts) targetDir = keep(await childDirectory(targetDir, part, owner))
    const targetAt = at(targetDir, parts[2])
    let existing = false
    const target = keep(
      await open(
        targetAt,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        existing = true
        return open(targetAt, FILE_FLAGS)
      }),
    )
    if (existing) return { path, bytes: await readShownBytes(target) }
    try {
      await target.writeFile(bytes)
      await target.chmod(0o644)
    } catch (error) {
      await unlink(targetAt)
      throw error
    }
    return { path, bytes }
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}

export function shownType(
  bytes: Buffer,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'text' | 'other' {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif'
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  if (bytes.toString('latin1', 0, 5) === '%PDF-') return 'other'
  if (bytes.length < TEXT_LIMIT) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: binary controls distinguish text from files to reveal.
      if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return 'text'
    } catch {
      /* Binary or invalid UTF-8: reveal the copy. */
    }
  }
  return 'other'
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )

export function previewHtml(bytes: Buffer, title: string): string | null {
  const type = shownType(bytes)
  if (type === 'other') return null
  const content =
    type === 'text'
      ? `<pre>${escapeHtml(bytes.toString('utf8'))}</pre>`
      : `<img alt="${escapeHtml(title)}" src="data:${type};base64,${bytes.toString('base64')}">`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:dark}body{margin:20px;background:#0b0d11;color:#e7e2d6;font:14px system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{display:block;max-width:100%;height:auto}</style></head><body>${content}</body></html>`
}

interface SharesDeps {
  exchangeRoot: string
  windowFor(session: string | null): BrowserWindow | undefined
  sessionName(session: string | null): string | undefined
  preview(path: string, title: string): Promise<void>
  clipboard: Pick<Clipboard, 'writeText'>
  shell: Pick<Shell, 'showItemInFolder'>
  dialog: Pick<Dialog, 'showMessageBox' | 'showErrorBox'>
}

export function createAgentShares(deps: SharesDeps) {
  const pending = new Map<string, { share: Share & { kind: 'file' }; recipient: WebContents }>()
  let dialogOpen = false
  const fail = (error: unknown): void =>
    deps.dialog.showErrorBox(
      'Could not show shared file',
      error instanceof Error ? error.message : String(error),
    )
  async function showFile(share: Share & { kind: 'file' }): Promise<void> {
    try {
      const copy = await copyShownFile(deps.exchangeRoot, share.id, share.name)
      const title = share.title || share.name
      const html = previewHtml(copy.bytes, title)
      if (html === null) deps.shell.showItemInFolder(copy.path)
      else {
        const path = join(dirname(dirname(copy.path)), 'preview.html')
        await writeFile(path, html, { mode: 0o644 })
        await deps.preview(path, title)
      }
    } catch (error) {
      fail(error)
    }
  }
  return {
    notify(data: Record<string, unknown>): void {
      const share = parseShare(data)
      if (!share) return
      const kind = `Agent shared: ${share.title || share.name}`
      const sessionName = deps.sessionName(share.session)
      const snippet = [sessionName, share.kind === 'url' ? share.url : null]
        .filter(Boolean)
        .join('\n')
      const win = deps.windowFor(share.session)
      if (win && !win.isDestroyed()) {
        const action: SelectionToast['action'] =
          share.kind === 'url' ? { kind: 'copy', text: share.url } : { kind: 'file', id: share.id }
        if (share.kind === 'file') {
          if (pending.size >= 100) pending.delete(pending.keys().next().value ?? '')
          pending.set(share.id, { share, recipient: win.webContents })
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
          buttons: [share.kind === 'url' ? 'Copy' : 'Show file', 'Close'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then(async ({ response }) => {
          if (response !== 0) return
          if (share.kind === 'url') deps.clipboard.writeText(share.url)
          else await showFile(share)
        })
        .catch(fail)
        .finally(() => {
          dialogOpen = false
        })
    },
    registerIpc: (ipcMain: Pick<IpcMain, 'on'>): void => {
      ipcMain.on('show:file', (event, id: unknown) => {
        if (typeof id !== 'string') return
        const item = pending.get(id)
        if (!item || item.recipient !== event.sender) return
        pending.delete(id)
        void showFile(item.share)
      })
    },
  }
}
