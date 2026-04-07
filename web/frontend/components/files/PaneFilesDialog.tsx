'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { clsx } from 'clsx'
import {
  AlertTriangle,
  Binary,
  Check,
  ChevronRight,
  Copy,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  usePaneFileContent,
  usePaneFileTree,
} from '@/lib/hooks/use-pane-files'
import type { PaneFileTreeEntry } from '@/lib/api/pane-files'

interface PaneFilesDialogProps {
  isOpen: boolean
  paneId: string
  onClose: () => void
  onInsertPath: (path: string) => void
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java',
  '.cpp', '.c', '.h', '.hpp', '.php', '.rb', '.swift', '.kt',
  '.sh', '.bash', '.zsh', '.css', '.scss', '.html', '.htm',
  '.xml', '.sql',
])
const JSON_EXTENSIONS = new Set(['.json', '.jsonc', '.json5'])
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.yaml', '.yml', '.txt', '.toml', '.ini', '.cfg', '.env',
])

function formatSize(bytes: number): string {
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
  paneId: string
  entry: PaneFileTreeEntry
  depth: number
  selectedPath: string | null
  onSelect: (entry: PaneFileTreeEntry) => void
}

function TreeNode({
  paneId,
  entry,
  depth,
  selectedPath,
  onSelect,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const isSelected = selectedPath === entry.path
  const childTree = usePaneFileTree(paneId, entry.path, expanded && entry.is_directory)
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
        className={clsx(
          'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors',
          isSelected
            ? 'bg-[var(--term-accent)]/12 text-[var(--term-accent)]'
            : 'text-slate-300 hover:bg-slate-800/60',
        )}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        {entry.is_directory ? (
          <ChevronRight
            className={clsx(
              'h-3.5 w-3.5 flex-shrink-0 text-slate-500 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        {entry.is_directory ? (
          expanded ? (
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-[var(--term-accent)]/80" />
          ) : (
            <Folder className="h-4 w-4 flex-shrink-0 text-slate-500" />
          )
        ) : FileIcon ? (
          <FileIcon className="h-4 w-4 flex-shrink-0 text-slate-500" />
        ) : null}

        <span className="truncate">{entry.name}</span>
      </button>

      {entry.is_directory && expanded && (
        <ul role="group" className="py-0.5">
          {childTree.isLoading ? (
            <li
              className="flex items-center gap-2 py-1 text-xs text-slate-500"
              style={{ paddingLeft: 32 + depth * 16 }}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </li>
          ) : childTree.data?.entries?.map((child) => (
            <TreeNode
              key={child.path}
              paneId={paneId}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function PaneFilesDialog({
  isOpen,
  paneId,
  onClose,
  onInsertPath,
}: PaneFilesDialogProps) {
  const tree = usePaneFileTree(paneId, '', isOpen)
  const [selectedEntry, setSelectedEntry] = useState<PaneFileTreeEntry | null>(null)
  const [copiedThing, setCopiedThing] = useState<'path' | 'content' | null>(null)
  const content = usePaneFileContent(paneId, selectedEntry?.path ?? null, isOpen)

  useEffect(() => {
    if (!isOpen) {
      setSelectedEntry(null)
      setCopiedThing(null)
    }
  }, [isOpen])

  const selectedAbsolutePath = content.data?.absolute_path ?? selectedEntry?.absolute_path ?? null

  const handleCopy = useCallback(async (kind: 'path' | 'content') => {
    const value =
      kind === 'path'
        ? selectedAbsolutePath
        : content.data?.content
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedThing(kind)
      window.setTimeout(() => setCopiedThing(null), 1500)
    } catch {}
  }, [content.data?.content, selectedAbsolutePath])

  const handleInsertPath = useCallback(() => {
    if (!selectedAbsolutePath) return
    onInsertPath(selectedAbsolutePath)
    onClose()
  }, [onClose, onInsertPath, selectedAbsolutePath])

  const infoPills = useMemo(() => {
    if (!content.data) return []
    return [
      `${formatSize(content.data.size)}`,
      content.data.is_binary ? 'binary' : `${content.data.lines} lines`,
      content.data.language,
    ].filter(Boolean)
  }, [content.data])

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/75 backdrop-blur-sm" />
        <Dialog.Content
          className={clsx(
            'fixed inset-x-3 top-3 bottom-3 z-[71] flex flex-col overflow-hidden rounded-2xl border border-slate-800/80 bg-[#08070d] shadow-[0_28px_80px_rgba(0,0,0,0.55)]',
            'sm:inset-x-6 sm:top-6 sm:bottom-6',
          )}
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-semibold text-slate-100">
                Files
              </Dialog.Title>
              <p className="truncate text-xs text-slate-500">
                {tree.data?.root ?? 'Loading pane root...'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
              aria-label="Close files"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_minmax(0,1fr)]">
            <div className="border-b border-slate-800/80 md:border-b-0 md:border-r">
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-slate-800/60 px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  Browser
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-2">
                  {tree.isLoading ? (
                    <div className="flex items-center gap-2 px-4 py-4 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading files...
                    </div>
                  ) : tree.isError ? (
                    <div className="px-4 py-4 text-sm text-rose-400">
                      {tree.error?.message ?? 'Failed to load pane files'}
                    </div>
                  ) : tree.data?.entries.length ? (
                    <ul className="space-y-0.5">
                      {tree.data.entries.map((entry) => (
                        <TreeNode
                          key={entry.path}
                          paneId={paneId}
                          entry={entry}
                          depth={0}
                          selectedPath={selectedEntry?.path ?? null}
                          onSelect={setSelectedEntry}
                        />
                      ))}
                    </ul>
                  ) : (
                    <div className="px-4 py-4 text-sm text-slate-500">
                      No files found
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {!selectedEntry ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-slate-500">
                  Select a file to preview it and insert its path into the terminal.
                </div>
              ) : content.isLoading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading file...
                </div>
              ) : content.isError ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-sm text-rose-400">
                  {content.error?.message ?? 'Failed to load file'}
                </div>
              ) : content.data ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/80 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-100">
                        {content.data.name}
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {content.data.absolute_path}
                      </div>
                    </div>
                    {infoPills.map((pill) => (
                      <span
                        key={pill}
                        className="rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-400"
                      >
                        {pill}
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={handleInsertPath}
                      className="rounded-md border border-[var(--term-accent)]/30 bg-[var(--term-accent)]/12 px-3 py-1.5 text-xs font-medium text-[var(--term-accent)] transition-colors hover:bg-[var(--term-accent)]/18"
                    >
                      Insert Path
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy('path')}
                      className="rounded-md border border-slate-700/70 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                    >
                      {copiedThing === 'path' ? (
                        <span className="inline-flex items-center gap-1">
                          <Check className="h-3 w-3" />
                          Copied Path
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Copy className="h-3 w-3" />
                          Copy Path
                        </span>
                      )}
                    </button>
                    {!content.data.is_binary && content.data.content && (
                      <button
                        type="button"
                        onClick={() => handleCopy('content')}
                        className="rounded-md border border-slate-700/70 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                      >
                        {copiedThing === 'content' ? (
                          <span className="inline-flex items-center gap-1">
                            <Check className="h-3 w-3" />
                            Copied Contents
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <Copy className="h-3 w-3" />
                            Copy Contents
                          </span>
                        )}
                      </button>
                    )}
                  </div>

                  {content.data.truncated && (
                    <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/8 px-4 py-2 text-xs text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Preview truncated to 1 MB
                    </div>
                  )}

                  {content.data.is_binary ? (
                    <div className="flex flex-1 items-center justify-center px-6 text-center">
                      <div>
                        <Binary className="mx-auto mb-3 h-10 w-10 text-slate-700" />
                        <p className="text-sm text-slate-300">Binary file</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatSize(content.data.size)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <pre className="min-h-0 flex-1 overflow-auto bg-[#05040a] p-4 text-sm text-slate-200 whitespace-pre-wrap">
                      {content.data.content}
                    </pre>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
