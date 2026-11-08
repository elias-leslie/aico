'use client'

import { clsx } from 'clsx'
import {
  Binary,
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  X,
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { RenderedView } from '@/components/render/RenderedView'
import {
  type FilesSource,
  isHtmlPath,
  type ListingView,
  type PaneFileTreeEntry,
  rawFileUrl,
  sharedPageUrl,
} from '@/lib/api/pane-files'
import { isPermanentRefusal } from '@/lib/api-fetch'
import { useFileContent, useFileTree } from '@/lib/hooks/use-pane-files'
import { renderedFileUrl, renderedKindOf } from '@/lib/render'
import { modifiedLabel } from './listing'

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
  source: FilesSource
  entry: PaneFileTreeEntry
  depth: number
  selectedPath: string | null
  onSelect: (entry: PaneFileTreeEntry) => void
  view?: ListingView
  open: OpenFolders
  onToggle: (entry: PaneFileTreeEntry) => void
}

/** The folders open in the list, by path. Kept above the rows so a find can't close them; one
 * closed during a find keeps its row (open false) until the find changes. */
type OpenFolders = ReadonlyMap<
  string,
  { entry: PaneFileTreeEntry; open: boolean }
>

const findText = (view?: ListingView) => view?.match?.trim().toLowerCase() ?? ''

/** A folder's listing during a find: its open folders stay, above the names found. */
function withOpenFolders(
  entries: PaneFileTreeEntry[] | undefined,
  parent: string,
  open: OpenFolders,
  view?: ListingView,
): PaneFileTreeEntry[] | undefined {
  if (!findText(view)) return entries
  const shown = new Set(entries?.map((entry) => entry.path))
  const kept = [...open.values()]
    .map((folder) => folder.entry)
    .filter(
      (entry) =>
        !shown.has(entry.path) &&
        (view?.showHidden !== false || !entry.name.startsWith('.')) &&
        entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/'))) ===
          parent,
    )
  return kept.length ? [...kept, ...(entries ?? [])] : entries
}

function TreeNode({
  source,
  entry,
  depth,
  selectedPath,
  onSelect,
  view,
  open,
  onToggle,
}: TreeNodeProps) {
  const expanded = open.get(entry.path)?.open ?? false
  const isSelected = selectedPath === entry.path
  // Finding narrows an open folder too, unless the folder is itself what was found: then all of it.
  const inside =
    view && entry.name.toLowerCase().includes(findText(view))
      ? { ...view, match: undefined }
      : view
  const childTree = useFileTree(
    source,
    entry.path,
    expanded && entry.is_directory,
    inside,
  )
  const children = withOpenFolders(childTree.entries, entry.path, open, inside)
  const FileIcon = getFileIcon(entry)

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (entry.is_directory) {
        onToggle(entry)
        return
      }
      // A double-click still opens it: the second click would close it again.
      if (event.detail <= 1) onSelect(entry)
    },
    [entry, onSelect, onToggle],
  )

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

        <span
          className="n"
          title={
            entry.is_symlink
              ? entry.link_broken
                ? `${entry.name}: a link to ${entry.link_target ?? 'nothing'}, which isn’t there`
                : `${entry.name}: a link to ${entry.link_target ?? 'another path'}`
              : undefined
          }
        >
          {entry.name}
          {entry.is_symlink ? (
            <span className="lnk">
              {entry.link_broken
                ? ` → ${entry.link_target ?? ''} (nothing there)`
                : ` → ${entry.link_target ?? ''}`}
            </span>
          ) : null}
        </span>
        <span className="s meta">
          {entry.modified !== undefined ? (
            <span
              className="when"
              title={new Date(entry.modified).toLocaleString()}
            >
              {modifiedLabel(entry.modified)}
            </span>
          ) : null}
          {entry.is_directory ? (
            <ChevronRight
              aria-hidden="true"
              className={clsx(
                'h-3.5 w-3.5 transition-transform',
                expanded && 'rotate-90',
              )}
            />
          ) : entry.size !== undefined ? (
            <span className="size">{formatSize(entry.size)}</span>
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
          ) : childTree.isError ? (
            <li
              className="py-1.5 text-xs"
              style={{ paddingLeft: 38 + depth * 16, color: 'var(--mist)' }}
            >
              {childTree.error?.message || 'Couldn’t load this folder.'}
            </li>
          ) : (
            <>
              {children?.map((child) => (
                <TreeNode
                  key={child.path}
                  source={source}
                  entry={child}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  view={inside}
                  open={open}
                  onToggle={onToggle}
                />
              ))}
              {!children?.length && (
                <li
                  className="py-1.5 text-xs"
                  style={{ paddingLeft: 38 + depth * 16, color: 'var(--mist)' }}
                >
                  {findText(inside) ? 'No match in here' : 'Empty'}
                </li>
              )}
              <MoreRow tree={childTree} indent={38 + depth * 16} />
            </>
          )}
        </ul>
      )}
    </li>
  )
}

/** The rest of a long folder: how many are shown, and a button for the next page. */
function MoreRow({
  tree,
  indent,
}: {
  tree: ReturnType<typeof useFileTree>
  indent: number
}) {
  if (!tree.hasMore) return null
  return (
    <li
      className="flex flex-wrap items-center gap-2 py-1"
      style={{ paddingLeft: indent }}
    >
      <span className="text-xs" style={{ color: 'var(--mist)' }}>
        Showing {tree.entries?.length ?? 0} of {tree.total ?? 'many'}
      </span>
      <button
        type="button"
        className="lantern-btn"
        disabled={tree.loadingMore}
        onClick={tree.loadMore}
      >
        {tree.loadingMore ? 'Loading' : 'Show more'}
      </button>
    </li>
  )
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** A path inside a folder, as one absolute path. */
function joinPath(root: string, path: string): string {
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
  shared = false,
  view,
}: {
  source: FilesSource
  initialSelected?: FileChoice | null
  /** Types the path into the session; without it there is no Insert path. */
  onInsertPath?: (path: string) => void
  /** A shared or attached folder: a web page's Open shows it rendered. */
  shared?: boolean
  /** Order and dotfiles of a listing of any folder. */
  view?: ListingView
}) {
  const tree = useFileTree(source, '', true, view)
  const [selected, setSelected] = useState<FileChoice | null>(initialSelected)
  const [open, setOpen] = useState<OpenFolders>(new Map())
  const finding = findText(view)
  const toggle = useCallback(
    (entry: PaneFileTreeEntry) => {
      setOpen((current) => {
        const next = new Map(current)
        if (!current.get(entry.path)?.open)
          next.set(entry.path, { entry, open: true })
        else if (finding) next.set(entry.path, { entry, open: false })
        else next.delete(entry.path)
        return next
      })
    },
    [finding],
  )
  const [foundFor, setFoundFor] = useState(finding)
  if (foundFor !== finding) {
    setFoundFor(finding)
    setOpen(new Map([...open].filter(([, folder]) => folder.open)))
  }
  const entries = withOpenFolders(tree.entries, '', open, view)
  const list = useRef<HTMLDivElement>(null)
  // Tapping the file that's showing closes it, as the preview's own X does.
  const pick = useCallback((entry: PaneFileTreeEntry) => {
    setSelected((current) => (current?.path === entry.path ? null : entry))
  }, [])

  return (
    // max-md: keeps a plain `flex` off this element so it cannot beat md:grid.
    <div className="min-h-0 flex-1 max-md:flex max-md:flex-col md:grid md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <div
        ref={list}
        tabIndex={-1}
        className={clsx(
          'min-h-0 overflow-auto overscroll-contain px-2 pb-2 outline-none',
          selected ? 'max-h-[42%] flex-none md:max-h-none' : 'flex-1',
        )}
      >
        {tree.isLoading ? (
          <p className="files-state">Loading files</p>
        ) : tree.isError ? (
          <div className="files-state">
            <p>{tree.error?.message || 'Couldn’t load the files.'}</p>
            {isPermanentRefusal(tree.error) ? null : (
              <button
                type="button"
                className="lantern-btn mt-3"
                onClick={() => void tree.refetch()}
              >
                Try again
              </button>
            )}
          </div>
        ) : entries?.length ? (
          <ul className="m-0 list-none p-0">
            {entries.map((entry) => (
              <TreeNode
                key={entry.path}
                source={source}
                entry={entry}
                depth={0}
                selectedPath={selected?.path ?? null}
                onSelect={pick}
                view={view}
                open={open}
                onToggle={toggle}
              />
            ))}
            <MoreRow tree={tree} indent={10} />
          </ul>
        ) : (
          <p className="files-state">
            {view?.match?.trim()
              ? `No name here has “${view.match.trim()}” in it.`
              : 'This folder is empty.'}
          </p>
        )}
      </div>

      <FilePreview
        source={source}
        selected={selected}
        onInsertPath={onInsertPath}
        onClose={() => {
          setSelected(null)
          // The X goes with the preview; Escape and Tab need focus still in here.
          list.current?.focus()
        }}
        className={selected ? 'flex' : 'hidden md:flex'}
        shared={shared}
      />
    </div>
  )
}

/**
 * The chosen file of a folder: its name, size and kind, Open / Insert path /
 * Copy, and its text or image. A folder that is not a tab's opens images
 * inline and the file by itself.
 */
export function FilePreview({
  source,
  selected,
  onInsertPath,
  onClose,
  className,
  shared = false,
}: {
  source: FilesSource
  selected: FileChoice | null
  /** Types the path into the session; without it there is no Insert path. */
  onInsertPath?: (path: string) => void
  /** Puts the preview away; without it there is no close button. */
  onClose?: () => void
  className?: string
  /** A shared or attached file: a web page's Open shows it rendered. */
  shared?: boolean
}) {
  const [copiedThing, setCopiedThing] = useState<'path' | 'content' | null>(
    null,
  )
  // Rendered or Source, for the file the pick was made on; another file starts from its default.
  const [pick, setPick] = useState<{
    path: string
    mode: 'rendered' | 'source'
  } | null>(null)
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
  // A shared web page's Open shows it rendered, in its own tab (only shared files are served so).
  const pageUrl =
    shared && selectedPath && root !== null && isHtmlPath(selectedPath)
      ? sharedPageUrl(selectedPath)
      : null
  const image =
    rawUrl && IMAGE_EXTENSIONS.has(content.data?.extension?.toLowerCase() ?? '')
      ? rawUrl
      : null
  // HTML, SVG, Markdown and PDF can be shown rendered (in a folder of this computer): text shows
  // its source until asked, a PDF has no source worth showing.
  const renderKind =
    root !== null && relativePath !== null && content.data
      ? renderedKindOf(content.data.name)
      : null
  const mode =
    pick?.path === selectedPath
      ? pick.mode
      : renderKind === 'pdf'
        ? 'rendered'
        : 'source'
  const rendered = renderKind !== null && mode === 'rendered'

  // A file that won't open may have no row to tap again: this is the way out.
  const closeState = onClose && (
    <button type="button" className="lantern-btn mt-3 ml-2" onClick={onClose}>
      Close
    </button>
  )

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
    if (selectedPath) onInsertPath?.(selectedPath)
  }, [onInsertPath, selectedPath])

  const infoPills = useMemo(() => {
    if (!content.data) return []
    return [
      `${formatSize(content.data.size)}`,
      image
        ? 'image'
        : content.data.is_binary
          ? 'binary'
          : `${content.data.lines} lines`,
      content.data.language,
    ].filter(Boolean)
  }, [content.data, image])

  return (
    <section
      aria-label={selected?.name ?? 'Preview'}
      className={clsx(
        'mx-1 mb-1 min-h-0 flex-1 flex-col overflow-hidden rounded',
        className ?? 'flex',
      )}
      style={{
        backgroundColor: 'var(--ink)',
        boxShadow: 'inset 0 0 0 1px var(--frame-edge)',
      }}
    >
      {!selected ? (
        <p className="files-state m-auto">Pick a file to preview it.</p>
      ) : content.isLoading ? (
        <div className="files-state m-auto">
          <p>Loading the file</p>
          {closeState}
        </div>
      ) : content.isError ? (
        <div className="files-state m-auto">
          <p>{content.error?.message || 'Couldn’t open this file.'}</p>
          {isPermanentRefusal(content.error) ? null : (
            <button
              type="button"
              className="lantern-btn mt-3"
              onClick={() => void content.refetch()}
            >
              Try again
            </button>
          )}
          {closeState}
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
            <div className="flex flex-wrap items-center gap-1.5">
              {renderKind && selectedPath && (
                <fieldset aria-label="View" className="lantern-seg compact">
                  {(['rendered', 'source'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={mode === option}
                      onClick={() =>
                        setPick({ path: selectedPath, mode: option })
                      }
                    >
                      {option === 'rendered' ? 'Rendered' : 'Source'}
                    </button>
                  ))}
                </fieldset>
              )}
              {rawUrl && (
                <a
                  href={pageUrl ?? rawUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="lantern-btn small"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {pageUrl
                    ? 'Open page'
                    : content.data.is_binary && !image
                      ? 'Download'
                      : 'Open'}
                </a>
              )}
              {rawUrl && !(content.data.is_binary && !image) && (
                <a
                  href={rawUrl}
                  download={selected.name}
                  className="lantern-btn small"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
              )}
              {onInsertPath && (
                <button
                  type="button"
                  onClick={handleInsertPath}
                  className="lantern-btn small primary"
                >
                  Insert path
                </button>
              )}
              <button
                type="button"
                onClick={() => handleCopy('path')}
                className="lantern-btn small"
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
                  className="lantern-btn small"
                >
                  {copiedThing === 'content' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedThing === 'content' ? 'Copied' : 'Copy contents'}
                </button>
              )}
              {onClose && (
                <button
                  type="button"
                  className="lantern-icon-btn compact"
                  aria-label="Close preview"
                  title="Close preview"
                  onClick={onClose}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={1.7} />
                </button>
              )}
            </div>
          </div>

          {content.data.truncated && !rendered && (
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

          {renderKind !== null &&
          mode === 'rendered' &&
          root !== null &&
          relativePath !== null ? (
            <RenderedView
              kind={renderKind}
              src={renderedFileUrl(root, relativePath)}
              title={`Rendered: ${content.data.name}`}
              className="min-h-0 w-full flex-1"
            />
          ) : image ? (
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
  )
}
