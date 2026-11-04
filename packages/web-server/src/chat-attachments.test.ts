import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { putOriginal } from '@aico/notes/blobs'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { CaptureDeps } from './captures'
import { chatAttachmentIds, readChatAttachments } from './chat-attachments'
import { NotesStore } from './notes-db'

let captures: CaptureDeps
beforeEach(async () => {
  captures = {
    store: new NotesStore(':memory:', { hostName: 'test' }),
    blobsDir: await mkdtemp(join(tmpdir(), 'aico-chat-attachments-')),
    limits: { maxBytes: 1000, maxFiles: 2 },
  }
})
afterEach(async () => {
  captures.store.close()
  await rm(captures.blobsDir, { recursive: true, force: true })
})
async function file(name: string, mime: string, kind: 'text' | 'image', bytes: Buffer) {
  const hash = await putOriginal(captures.blobsDir, bytes)
  return captures.store.insertCapture({
    clientId: name,
    name,
    mime,
    kind,
    size: bytes.length,
    hash,
  }).capture
}
it('supplies the actual photo as an image and a text file as text', async () => {
  const image = await file('photo.png', 'image/png', 'image', Buffer.from('photo bytes'))
  const text = await file(
    'sync-log.txt',
    'text/plain',
    'text',
    Buffer.from('capture test succeeded'),
  )
  const result = await readChatAttachments([image.id, text.id], captures)
  expect(result.images).toEqual([
    { type: 'image', data: Buffer.from('photo bytes').toString('base64'), mimeType: 'image/png' },
  ])
  expect(result.text).toContain('Attached photo: photo.png')
  expect(result.text).toContain('capture test succeeded')
})
it('validates refs and counts, and does not silently drop a photo before its preview exists', async () => {
  expect(() => chatAttachmentIds(['../../file'], captures)).toThrow('capture picker')
  expect(() => chatAttachmentIds(['000000000000'], captures)).toThrow('no longer available')
  expect(() =>
    chatAttachmentIds(['000000000000', '000000000001', '000000000002'], captures),
  ).toThrow('capture picker')
  const photo = await file('photo.heic', 'image/heic', 'image', Buffer.from('heic'))
  await expect(readChatAttachments([photo.id], captures)).rejects.toThrow('still being prepared')
})
