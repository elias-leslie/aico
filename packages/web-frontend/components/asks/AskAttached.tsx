'use client'

import { ArrowLeft, File, FileX, Folder } from 'lucide-react'
import { formatBytes } from '@/lib/capture-format'
import type { AttachedFile, OwnerAsk } from '@/lib/hooks/use-asks'
import { FileBrowser, FilePreview } from '../files/FileBrowser'

/** What a file is, from its name: a short word the owner knows. */
const KINDS: Record<string, string> = {
  md: 'Markdown',
  mdx: 'Markdown',
  txt: 'Text',
  log: 'Log',
  pdf: 'PDF',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  gif: 'Image',
  webp: 'Image',
  svg: 'Image',
  html: 'HTML',
  htm: 'HTML',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  csv: 'CSV',
  diff: 'Diff',
  patch: 'Diff',
}

function attachedKind(file: AttachedFile): string {
  if (file.kind === 'folder') return 'Folder'
  const dot = file.name.lastIndexOf('.')
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
  return KINDS[ext] ?? (ext && ext.length <= 5 ? ext.toUpperCase() : 'File')
}

/** The line under the name: kind and size, or why it cannot open. */
function detail(file: AttachedFile, host: string | undefined): string {
  if (file.kind === 'missing') return 'File moved or deleted'
  const what =
    file.kind === 'file' && file.size !== null
      ? `${attachedKind(file)} · ${formatBytes(file.size)}`
      : attachedKind(file)
  return host ? `${what} · on ${host}` : what
}

/**
 * The files an agent attached to its question: one chip each, which opens the
 * file in place. A moved or deleted file says so and does not open; a file on
 * another computer opens there, not here.
 */
export function AttachedFiles({
  ask,
  onOpen,
}: {
  ask: OwnerAsk
  onOpen: (file: AttachedFile) => void
}) {
  const files = ask.attached ?? []
  if (!files.length) return null
  return (
    <section aria-label="Attached" className="mb-2">
      <p className="mb-1 text-[12px]" style={{ color: 'var(--mist)' }}>
        Attached
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {files.map((file) => {
          const missing = file.kind === 'missing'
          const Icon = missing ? FileX : file.kind === 'folder' ? Folder : File
          const away = ask.host !== undefined
          return (
            <li key={file.path} className="min-w-0 max-w-full">
              <button
                type="button"
                className="lantern-ask-attached"
                data-testid="ask-attached"
                data-missing={missing ? 'true' : undefined}
                disabled={missing || away}
                title={
                  away ? `${file.path} (on ${ask.host}, not here)` : file.path
                }
                onClick={() => onOpen(file)}
              >
                <Icon
                  aria-hidden="true"
                  className={file.kind === 'folder' ? 'dir' : undefined}
                  strokeWidth={1.7}
                />
                <span className="min-w-0">
                  <span className="n" dir="auto">
                    {file.name}
                  </span>
                  <span className="s">{detail(file, ask.host)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Where the path's folder is and its own name, for the viewer. */
function splitPath(path: string): { root: string; name: string } {
  const trimmed = path.replace(/(?<=.)\/$/, '')
  const cut = trimmed.lastIndexOf('/')
  return { root: trimmed.slice(0, cut) || '/', name: trimmed.slice(cut + 1) }
}

/**
 * An attached file in Needs you's place, in the same viewer Files uses, with
 * the way back to the question. A folder shows its files.
 */
export function AttachedFileView({
  file,
  question,
  onBack,
}: {
  file: AttachedFile
  question: string
  onBack: () => void
}) {
  const { root, name } = splitPath(file.path)
  return (
    <section
      aria-label={file.name}
      data-testid="ask-attached-view"
      className="flex min-h-0 flex-1 flex-col pb-1"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onBack()
      }}
    >
      <div className="flex flex-none items-center gap-1 px-2 pb-2">
        <button
          type="button"
          // Focus lands here, so the keyboard and a screen reader start at the way back.
          // biome-ignore lint/a11y/noAutofocus: the view replaces the list the focus was in
          autoFocus
          className="lantern-icon-btn"
          aria-label="Back to the question"
          title="Back to the question"
          onClick={onBack}
        >
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
        <div className="min-w-0 flex-1">
          <p
            className="m-0 truncate text-[12px]"
            style={{ color: 'var(--mist)' }}
          >
            {question}
          </p>
          <p
            className="m-0 truncate text-[11.5px]"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--mist)' }}
            title={file.path}
          >
            {file.kind === 'folder' ? file.path : root}
          </p>
        </div>
      </div>
      {file.kind === 'folder' ? (
        <FileBrowser source={{ kind: 'location', root: file.path }} />
      ) : (
        <FilePreview
          source={{ kind: 'location', root }}
          selected={{ path: name, name }}
        />
      )}
    </section>
  )
}
