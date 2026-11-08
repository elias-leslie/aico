'use client'

import { type RenderKind, SANDBOX } from '@/lib/render'

/**
 * A file shown rendered: a page in a sandboxed frame, an image, or a PDF. `src` is the web
 * server's rendered page of it (see lib/render.ts for what each frame may do). Change `src` and
 * it shows the new one; `className` sizes it.
 */
export function RenderedView({
  kind,
  src,
  title,
  className,
}: {
  kind: RenderKind
  src: string
  title: string
  className?: string
}) {
  if (kind === 'image')
    return (
      <div
        className={`flex items-center justify-center overflow-auto p-3 ${className ?? ''}`}
        data-testid="rendered-image"
      >
        {/* biome-ignore lint/performance/noImgElement: a static export has no image optimizer; the file is served as it is */}
        <img
          src={src}
          alt={title}
          className="max-h-full max-w-full rounded object-contain"
          style={{ backgroundColor: 'rgb(var(--bone-rgb))' }}
        />
      </div>
    )
  const sandbox = SANDBOX[kind]
  return (
    <iframe
      title={title}
      src={src}
      {...(sandbox === null ? {} : { sandbox })}
      referrerPolicy="no-referrer"
      className={`block border-0 ${className ?? ''}`}
      style={{ backgroundColor: 'var(--ink)' }}
    />
  )
}
