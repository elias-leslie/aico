// How a file is shown rendered: which kinds Aico can render, where the web server serves the
// rendered page, and what the frame holding it may do. One place for the Designs tab and the
// Files preview, so both frame a file the same way.

export type RenderKind =
  | 'html'
  | 'svg'
  | 'image'
  | 'pdf'
  | 'markdown'
  | 'mermaid'

/**
 * The frame's `sandbox` attribute for a kind; never allow-same-origin, so a rendered page has an
 * opaque origin and can't use Aico's cookies or API. HTML, Markdown and Mermaid run scripts (a
 * design's own, or the vendored viewers); an SVG runs none. A PDF is a document, not a page: its
 * viewer won't open in a sandbox, and the server serves it as a PDF only.
 */
export const SANDBOX: Record<RenderKind, string | null> = {
  html: 'allow-scripts',
  markdown: 'allow-scripts',
  mermaid: 'allow-scripts',
  svg: '',
  image: null,
  pdf: null,
}

export const KIND_LABEL: Record<RenderKind, string> = {
  html: 'HTML',
  svg: 'SVG',
  image: 'Image',
  pdf: 'PDF',
  markdown: 'Markdown',
  mermaid: 'Diagram',
}

/** The kinds the Files preview can show rendered, by file name; null for any other file. */
export function renderedKindOf(
  name: string,
): 'html' | 'svg' | 'markdown' | 'pdf' | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'svg') return 'svg'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'pdf') return 'pdf'
  return null
}

/** The web server's rendered page of a file in a folder. */
export function renderedFileUrl(root: string, path: string): string {
  return `/api/files/view?${new URLSearchParams({ root, path })}`
}
