// Captures own the original. Chats keep capture ids until the prompt is sent.
import { readFile } from 'node:fs/promises'
import { blobPath } from '@aico/notes/blobs'
import type { ImageContent } from '@earendil-works/pi-ai'
import type { CaptureDeps } from './captures'
import { HttpError } from './tether'

export function chatAttachmentIds(value: unknown, captures?: CaptureDeps): string[] {
  if (value === undefined) return []
  if (!captures) throw new HttpError(503, 'Attachments are unavailable.')
  if (
    !Array.isArray(value) ||
    value.length > captures.limits.maxFiles ||
    !value.every((id) => typeof id === 'string' && /^[0-9a-f]{12}$/.test(id))
  )
    throw new HttpError(422, 'Choose files from Aico’s capture picker.')
  const ids = [...new Set(value)] as string[]
  for (const id of ids) {
    const row = captures.store.getCapture(id)
    if (!row?.hash)
      throw new HttpError(
        404,
        'An attached file is no longer available. Remove it and choose it again.',
      )
  }
  return ids
}

export async function readChatAttachments(ids: string[], captures: CaptureDeps) {
  chatAttachmentIds(ids, captures)
  const text: string[] = []
  const images: ImageContent[] = []
  for (const id of ids) {
    const row = captures.store.getCapture(id)
    if (!row?.hash) throw new HttpError(404, 'An attached file is no longer available.')
    const path = blobPath(captures.blobsDir, row.hash)
    if (row.kind === 'image') {
      const native = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(row.mime)
      const data = await readFile(
        native ? path : blobPath(captures.blobsDir, row.hash, 'preview'),
      ).catch(() => {
        throw new HttpError(
          409,
          'This photo is still being prepared. Try sending it again shortly.',
        )
      })
      images.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: native ? row.mime : 'image/jpeg',
      })
      text.push(`Attached photo: ${row.name}`)
    } else if (row.mime.startsWith('text/') || row.mime === 'application/json') {
      text.push(`Attached file: ${row.name}\n${await readFile(path, 'utf8')}`)
    } else {
      text.push(
        `Attached file: ${row.name} (${row.mime}). Read the original at ${path}${row.text ? `\nAico’s reading:\n${row.text}` : ''}`,
      )
    }
  }
  return { text: text.join('\n\n'), images }
}
