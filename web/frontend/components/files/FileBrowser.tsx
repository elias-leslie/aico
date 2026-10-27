'use client'

import { clsx } from 'clsx'
import {
  Binary,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import {
  type FilesSource,
  type PaneFileTreeEntry,
  rawFileUrl,
} from '@/lib/api/pane-files'
import { useFileContent, useFileTree } from '@/lib/hooks/use-pane-files'

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.php',
  '.rb',
  '.swift',
  '.kt',
  '.sh',
  '.bash',
  '.zsh',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.xml',
  '.sql',
])
const JSON_EXTENSIONS = new Set(['.json', '.jsonc', '.json5'])
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.txt',
  '.toml',
  '.ini',
  '.cfg',
  '.env',
])

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(entry: PaneFileTreeEntry) {
  if (entry.is_directory) return null
  const extension = entry.extension?.toLowerCase()
  if (extension && CODE_EXTENSIONS.has(extension)) return FileCode
  if (extension && JSON_EXTENSIONS.has(extension)) return FileJson
  if (extension && TEXT_EXTENSIONS.has(extension)) return FileText
  return File
}

interface TreeNodeProps {
  source: FilesSource
  entry: PaneFileTreeEntry
  depth: number
  selectedPath: string | null
  onSelect: (entry: PaneFileTreeEntry) => void
}

function TreeNode({
  source,
  entry,
  depth,
  selectedPath,
  onSelect,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const isSelected = selectedPath === entry.path
  const childTree = useFileTree(
    source,
    entry.path,
    expanded && entry.is_directory,
  )
  const FileIcon = getFileIcon(entry)

  const handleClick = useCallback(() => {
    if (entry.is_directory) {
      setExpanded((current) => !current)
      return
    }
    onSelect(entry)
  }, [entry, onSelect])

  return (
    <li aria-expanded={entry.is_directory ? expanded : undefined}>
      <button
        type="button"
        onClick={handleClick}
        aria-current={isSelected ? 'true' : undefined}
        className="lantern-file-row"
        style={{ paddingLeft: 10 + depth * 16 }}
      >
        {entry.is_directory ? (
          expanded ? (
            <FolderOpen className="dir" strokeWidth={1.7} />
          ) : (
            <Folder className="dir" strokeWidth={1.7} />
          )
        ) : FileIcon ? (
          <FileIcon strokeWidth={1.7} />
        ) : null}

        <span className="n">{entry.name}</span>
        <span className="s">
          {entry.is_directory ? (
            <ChevronRight
              aria-hidden="true"
              className={clsx(
                'h-3.5 w-3.5 transition-transform',
                expanded && 'rotate-90',
              )}
            />
          ) : entry.size !== undefined ? (
            formatSize(entry.size)
          ) : null}
        </span>
      </button>

      {entry.is_directory && expanded && (
        <ul role="group">
          {childTree.isLoading ? (
            <li
              className="py-1.5 text-xs"
              style={{ paddingLeft: 38 + depth * 16, color: 'var(--mist)' }}
            >
              Loading
            </li>
          ) : (
            childTree.data?.entries?.map((child) => (
              <TreeNode
                key={child.path}
                source={source}
                entry={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))
          )}
        </ul>
      )}
    </li>
  )
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** A path inside a folder, as one absolute path. */
export function joinPath(root: string, path: string): string {
  if (!path) return root
  return `${root.replace(/\/+$/, '')}/${path}`
}

/** A file in the browser: its path inside the source and its name. */
export interface FileChoice {
  path: string
  name: string
}

/**
 * A folder's files beside a preview of the chosen one. A tab's folder gives
 * paths relative to it; any other folder gives absolute paths, opens images
 * inline and opens the file by itself.
 */
export function FileBrowser({
  source,
  initialSelected = null,
  onInsertPath,
}: {
  source: FilesSource
  initialSelected?: FileChoice | null
  /** Types the path into the session. */
  onInsertPath: (path: string) => void
}) {
  const tree = useFileTree(source, '')
  const [selected, setSelected] = useState<FileChoice | null>(initialSelected)
  const [copiedThing, setCopiedThing] = useState<'path' | 'content' | null>(
    null,
  )
  const content = useFileContent(source, selected?.path ?? null)
  const root = source.kind === 'location' ? source.root : null
  const relativePath = content.data?.path ?? selected?.path ?? null
  const selectedPath =
    relativePath === null || root === null
      ? relativePath
      : joinPath(root, relativePath)
  const rawUrl =
    root !== null && relativePath !== null
      ? rawFileUrl(root, relativePath)
      : null
  const image =
    rawUrl && IMAGE_EXTENSIONS.has(content.data?.extension?.toLowerCase() ?? '')
      ? rawUrl
      : null

  const handleCopy = useCallback(
    async (kind: 'path' | 'content') => {
      const value = kind === 'path' ? selectedPath : content.data?.content
      if (!value) return
      try {
        await navigator.clipboard.writeText(value)
        setCopiedThing(kind)
        window.setTimeout(() => setCopiedThing(null), 1500)
      } catch {}
    },
    [content.data?.content, selectedPath],
  )

  const handleInsertPath = useCallback(() => {
    if (selectedPath) onInsertPath(selectedPath)
  }, [onInsertPath, selectedPath])

  const infoPills = useMemo(() => {
    if (!content.data) return []
    return [
      `${formatSize(content.data.size)}`,
      content.data.is_binary ? 'binary' : `${content.data.lines} lines`,
      content.data.language,
    ].filter(Boolean)
  }, [content.data])

  return (
    <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[320px_minmax(0,1fr)]">
      <div
        className={clsx(
          'min-h-0 overflow-auto overscroll-contain px-2 pb-2',
          selected ? 'max-h-[42%] flex-none md:max-h-none' : 'flex-1',
        )}
      >
        {tree.isLoading ? (
          <p className="files-state">Loading files</p>
        ) : tree.isError ? (
          <div className="files-state">
            <p>{tree.error?.message || 'Couldn’t load the files.'}</p>
            <button
              type="button"
              className="lantern-btn mt-3"
              onClick={() => void tree.refetch()}
            >
              Try again
            </button>
          </div>
        ) : tree.data?.entries.length ? (
          <ul className="m-0 list-none p-0">
            {tree.data.entries.map((entry) => (
              <TreeNode
                key={entry.path}
                source={source}
                entry={entry}
                depth={0}
                selectedPath={selected?.path ?? null}
                onSelect={setSelected}
              />
            ))}
          </ul>
        ) : (
          <p className="files-state">This folder is empty.</p>
        )}
      </div>

      <section
        aria-label={selected?.name ?? 'Preview'}
        className={clsx(
          'mx-1 mb-1 min-h-0 flex-1 flex-col overflow-hidden rounded',
          selected ? 'flex' : 'hidden md:flex',
        )}
        style={{
          backgroundColor: 'var(--ink)',
          boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
        }}
      >
        {!selected ? (
          <p className="files-state m-auto">Pick a file to preview it.</p>
        ) : content.isLoading ? (
          <p className="files-state m-auto">Loading the file</p>
        ) : content.isError ? (
          <div className="files-state m-auto">
            <p>{content.error?.message || 'Couldn’t open this file.'}</p>
            <button
              type="button"
              className="lantern-btn mt-3"
              onClick={() => void content.refetch()}
            >
              Try again
            </button>
          </div>
        ) : content.data ? (
          <>
            <div
              className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 py-2 pr-2 pl-3"
              style={{
                borderBottom: '1px solid rgb(var(--glass-rgb) / 0.06)',
              }}
            >
              <div className="min-w-0 flex-[1_1_12rem]">
                <p
                  className="m-0 truncate text-[12.5px]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                  title={content.data.path}
                >
                  {content.data.name}
                </p>
                <p
                  className="m-0 truncate text-[11.5px]"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--mist)',
                  }}
                >
                  {infoPills.join(' · ')}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {rawUrl && (
                  <a
                    href={rawUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lantern-btn h-8! px-2.5! text-xs!"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleInsertPath}
                  className="lantern-btn primary h-8! px-2.5! text-xs!"
                >
                  Insert path
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy('path')}
                  className="lantern-btn h-8! px-2.5! text-xs!"
                >
                  {copiedThing === 'path' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedThing === 'path' ? 'Copied' : 'Copy path'}
                </button>
                {!content.data.is_binary && content.data.content && (
                  <button
                    type="button"
                    onClick={() => handleCopy('content')}
                    className="lantern-btn h-8! px-2.5! text-xs!"
                  >
                    {copiedThing === 'content' ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedThing === 'content' ? 'Copied' : 'Copy contents'}
                  </button>
                )}
              </div>
            </div>

            {content.data.truncated && (
              <p
                className="m-0 flex-none px-3 py-1.5 text-xs"
                style={{
                  color: 'var(--mist)',
                  backgroundColor: 'var(--paper)',
                }}
              >
                Showing the first 1 MB
              </p>
            )}

            {image ? (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
                {/* biome-ignore lint/performance/noImgElement: a static export has no image optimizer; the file is served as it is */}
                <img
                  src={image}
                  alt={content.data.name}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            ) : content.data.is_binary ? (
              <div className="files-state m-auto">
                <Binary
                  aria-hidden="true"
                  className="mx-auto mb-2 h-8 w-8"
                  strokeWidth={1.5}
                />
                <p>Binary file, {formatSize(content.data.size)}</p>
              </div>
            ) : (
              <pre
                className="m-0 min-h-0 flex-1 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap"
                style={{
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1.45,
                  color: 'var(--bone)',
                }}
              >
                {content.data.content}
              </pre>
            )}
          </>
        ) : null}
      </section>
    </div>
  )
}
