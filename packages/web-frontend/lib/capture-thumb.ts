// The thumbnail is made in the browser (canvas, 480 px JPEG under 256 KB) and
// sent after the file. A file the browser cannot decode (a HEIC outside
// Safari) gets none here; the server's preview stands in for it.

const THUMB_EDGE = 480
const THUMB_MAX_BYTES = 256 * 1024
const QUALITIES = [0.82, 0.7, 0.55, 0.4]

export function thumbSize(
  width: number,
  height: number,
  edge = THUMB_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // Fall through to an image element.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/** A JPEG under the server's limit, or null when the browser can't decode the file. */
export async function makeThumbnail(file: File): Promise<Blob | null> {
  let source: ImageBitmap | HTMLImageElement
  try {
    source = await decode(file)
  } catch {
    return null
  }
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width
  const height =
    'naturalHeight' in source ? source.naturalHeight : source.height
  if (!width || !height) return null
  const size = thumbSize(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) return null
  // A transparent PNG would turn black as a JPEG.
  context.fillStyle = '#1c1f24'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(source, 0, 0, size.width, size.height)
  if ('close' in source) source.close()
  for (const quality of QUALITIES) {
    const blob = await toJpeg(canvas, quality)
    if (blob && blob.size <= THUMB_MAX_BYTES) return blob
  }
  return null
}
