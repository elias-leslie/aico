// A photo or file added from a note: saved as a capture (so it has the same
// limits, types and thumbnail as any capture), then attached to the note. The
// server files nothing else from it: a capture already held by a note gets no
// suggested owner.

import { uploadCapture, uploadThumb } from './api/captures'
import { attachCapture, type NoteAttachment } from './api/notes'
import { makeThumbnail } from './capture-thumb'

export async function addFileToNote(
  noteId: string,
  file: File,
  options: { clientId: string; onProgress?: (percent: number) => void },
): Promise<NoteAttachment> {
  const capture = await uploadCapture({
    file,
    clientId: options.clientId,
    onProgress: options.onProgress,
  })
  // The thumbnail is best effort: without one the note shows the picture itself.
  if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) {
    try {
      const jpeg = await makeThumbnail(file)
      if (jpeg) await uploadThumb(capture.id, jpeg)
    } catch {
      // Left without a thumbnail.
    }
  }
  return attachCapture(noteId, capture.id)
}
