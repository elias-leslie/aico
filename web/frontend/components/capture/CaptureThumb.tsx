'use client'

import { FileAudio, FileText, Image as ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { type Capture, captureThumbSource } from '@/lib/api/captures'

function KindIcon({ kind }: { kind: string }) {
  const props = { className: 'h-5 w-5', strokeWidth: 1.5, 'aria-hidden': true }
  if (kind === 'image') return <ImageIcon {...props} />
  if (kind === 'audio') return <FileAudio {...props} />
  return <FileText {...props} />
}

/** The small picture for a capture; an icon for kinds with none (or when it won't load). */
export function CaptureThumb({
  capture,
  size = 56,
}: {
  capture: Capture
  size?: number
}) {
  const source = captureThumbSource(capture)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const showImage = source !== null && failedFor !== source
  return (
    <span
      className="grid flex-none place-items-center overflow-hidden rounded-md"
      style={{
        width: size,
        height: size,
        background: 'var(--paper)',
        color: 'var(--mist)',
      }}
    >
      {showImage ? (
        // biome-ignore lint/performance/noImgElement: the server's small picture, already sized
        <img
          src={source}
          alt=""
          loading="lazy"
          data-testid="capture-thumb"
          className="h-full w-full object-cover"
          onError={() => setFailedFor(source)}
        />
      ) : (
        <KindIcon kind={capture.kind} />
      )}
    </span>
  )
}
