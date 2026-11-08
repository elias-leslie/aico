'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Code, File, Folder, Globe, Link, X } from 'lucide-react'
import { baseName } from '@/components/AgentShowToast'
import { isHtmlPath, sharedPageUrl } from '@/lib/api/pane-files'
import { removeShow, useShareList } from '@/lib/hooks/use-agent-shows'

/** When it was shared: the time today, else the day. */
function sharedWhen(createdAt: string, now = new Date()): string {
  const at = new Date(createdAt)
  return at.toDateString() === now.toDateString()
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/** The full moment it was shared, for the tooltip. */
function sharedAt(createdAt: string): string {
  return new Date(createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** A path's folder, for the line under its name. */
function folderOf(path: string): string {
  const trimmed = path.replace(/(?<=.)\/$/, '')
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1)
}

/**
 * What agents shared, newest first: each file or folder links to where it is,
 * and opens in the viewer; a web link, or a shared web page, opens in a new tab.
 */
export function SharedFiles({
  highlight,
  sessionName,
  onOpenPath,
}: {
  /** The share to point out, from a notice or a push link */
  highlight?: string
  sessionName?: (session: string) => string | null
  onOpenPath: (path: string) => void
}) {
  const client = useQueryClient()
  const remove = useMutation({
    mutationFn: removeShow,
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ['agent-shows', 'all'] }),
  })
  const shares = useShareList()

  if (shares.isLoading) return <p className="files-state">Loading shares</p>
  if (shares.isError)
    return (
      <div className="files-state">
        <p>Couldn’t load what agents shared.</p>
        <button
          type="button"
          className="lantern-btn mt-3"
          onClick={() => void shares.refetch()}
        >
          Try again
        </button>
      </div>
    )
  const items = [...(shares.data ?? [])].reverse()
  if (!items.length)
    return (
      <p className="files-state">
        Nothing shared yet. When an agent shares a file or folder, it shows up
        here.
      </p>
    )

  return (
    <ul className="m-0 min-h-0 flex-1 list-none overflow-auto overscroll-contain px-2 pb-3">
      {items.map((share) => {
        const from = share.session ? sessionName?.(share.session) : null
        const name =
          share.title ??
          (share.kind === 'url' ? 'link' : baseName(share.paths[0]))
        return (
          <li
            key={share.id}
            aria-current={share.id === highlight ? 'true' : undefined}
            ref={
              share.id === highlight
                ? (node) => node?.scrollIntoView?.({ block: 'nearest' })
                : undefined
            }
            className="lantern-share"
          >
            <div className="flex items-start gap-1 pr-1">
              <p
                className="m-0 min-w-0 flex-1 px-2.5 pt-2.5 pb-1 text-xs"
                style={{ color: 'var(--mist)' }}
                title={`Shared by ${from ? `session “${from}”` : 'an agent whose session has ended'}, ${sharedAt(share.createdAt)}`}
              >
                <span style={{ color: 'var(--bone)' }} dir="auto">
                  {share.title ??
                    (share.kind === 'url'
                      ? 'A link'
                      : baseName(share.paths[0]))}
                </span>
                {' · '}
                {from ?? 'an agent'} · {sharedWhen(share.createdAt)}
                {share.host ? ` · on ${share.host}` : ''}
              </p>
              {share.host ? null : (
                <button
                  type="button"
                  className="lantern-icon-btn compact flex-none"
                  aria-label={`Remove ${name} from Shared`}
                  title="Remove from Shared (the file stays where it is)"
                  disabled={remove.isPending && remove.variables === share.id}
                  onClick={() => remove.mutate(share.id)}
                >
                  <X className="h-4 w-4" strokeWidth={1.7} />
                </button>
              )}
            </div>
            {remove.isError && remove.variables === share.id ? (
              <p
                role="alert"
                className="m-0 px-2.5 pb-1 text-xs"
                style={{ color: 'var(--ember)' }}
              >
                Couldn’t remove it: {remove.error.message}
              </p>
            ) : null}
            {share.kind === 'url' ? (
              <a
                href={share.url}
                target="_blank"
                rel="noopener noreferrer"
                className="lantern-file-row"
              >
                <Link strokeWidth={1.7} />
                <span className="n">{share.url}</span>
              </a>
            ) : (
              share.paths.map((path) => {
                const isFolder = path.endsWith('/')
                const Icon = isFolder ? Folder : File
                if (!isFolder && !share.host && isHtmlPath(path))
                  return (
                    // A web page opens rendered in its own tab; Source shows its text here.
                    <div key={path} className="flex items-center gap-1 pr-1">
                      <a
                        href={sharedPageUrl(path)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="lantern-file-row min-w-0 flex-1"
                        title={`${path} (opens in a new tab)`}
                      >
                        <Globe strokeWidth={1.7} />
                        <span className="n">{baseName(path)}</span>
                        <span className="s">{folderOf(path)}</span>
                      </a>
                      <button
                        type="button"
                        className="lantern-btn small flex-none"
                        aria-label={`View source of ${baseName(path)}`}
                        onClick={() => onOpenPath(path)}
                      >
                        <Code className="h-3.5 w-3.5" strokeWidth={1.7} />
                        Source
                      </button>
                    </div>
                  )
                return (
                  <button
                    key={path}
                    type="button"
                    className="lantern-file-row"
                    onClick={() => onOpenPath(path)}
                    disabled={share.host !== undefined}
                    title={
                      share.host ? `${path} (on ${share.host}, not here)` : path
                    }
                  >
                    <Icon
                      className={isFolder ? 'dir' : undefined}
                      strokeWidth={1.7}
                    />
                    <span className="n">{baseName(path)}</span>
                    <span className="s">{folderOf(path)}</span>
                  </button>
                )
              })
            )}
          </li>
        )
      })}
    </ul>
  )
}
