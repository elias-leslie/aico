import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSource } from '@/lib/api/pane-files'
import type { FilesRequest } from '@/lib/files-opener'
import { FilesDialog } from './FilesDialog'

const share = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Image and prompt',
  createdAt: '2026-10-27T10:00:00.000Z',
  kind: 'files',
  paths: ['/srv/out/image.png', '/srv/out/run/'],
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

/** Answers the Files routes from a small fake disk. */
function serve(url: string) {
  const { pathname, searchParams } = new URL(url, 'http://aico.test')
  if (pathname === '/api/shows') return json({ shows: [share] })
  if (pathname === '/api/files/stat') {
    const path = searchParams.get('path')
    if (path === '/srv/out/image.png') return json({ path, kind: 'file' })
    if (path === '/srv/out/run/')
      return json({ path: '/srv/out/run', kind: 'folder' })
    return json({ detail: 'This file was moved or deleted' }, 404)
  }
  if (pathname === '/api/files/tree') {
    const root = searchParams.get('root')
    const entries =
      root === '/srv/out'
        ? [
            {
              name: 'image.png',
              path: 'image.png',
              is_directory: false,
              size: 3,
              extension: '.png',
            },
          ]
        : [
            {
              name: 'log.txt',
              path: 'log.txt',
              is_directory: false,
              size: 2,
              extension: '.txt',
            },
          ]
    return json({ entries, path: '', total: entries.length })
  }
  if (pathname === '/api/sessions/ab12cd34/files/tree')
    return json({
      entries: [
        {
          name: 'README.md',
          path: 'README.md',
          is_directory: false,
          size: 5,
          extension: '.md',
        },
      ],
      path: '',
      total: 1,
    })
  if (pathname === '/api/files/content')
    return json({
      path: searchParams.get('path'),
      name: 'image.png',
      content: null,
      size: 3,
      lines: 0,
      extension: '.png',
      is_binary: true,
      language: null,
      truncated: false,
    })
  return json({ detail: 'Not found' }, 404)
}

function renderDialog(
  request: FilesRequest | null,
  project: ProjectSource | null = null,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => serve(url)),
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const onInsertPath = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <FilesDialog
        isOpen
        project={project}
        request={request}
        onClose={vi.fn()}
        onInsertPath={onInsertPath}
        sessionName={() => 'Research'}
      />
    </QueryClientProvider>,
  )
  return { onInsertPath }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FilesDialog', () => {
  it('lists shares and opens a shared image where it is', async () => {
    const { onInsertPath } = renderDialog({ kind: 'shared', showId: share.id })
    expect(await screen.findByText('Image and prompt')).toBeVisible()
    expect(screen.getByText(/Research/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /image\.png/ }))
    const image = await screen.findByRole('img', { name: 'image.png' })
    expect(image).toHaveAttribute(
      'src',
      '/api/files/raw?root=%2Fsrv%2Fout&path=image.png',
    )
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'target',
      '_blank',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Insert path' }))
    expect(onInsertPath).toHaveBeenCalledWith('/srv/out/image.png')
    fireEvent.click(screen.getByRole('button', { name: 'Back to Shared' }))
    expect(await screen.findByText('Image and prompt')).toBeVisible()
  })

  it('browses a shared folder', async () => {
    renderDialog({ kind: 'shared' })
    fireEvent.click(await screen.findByRole('button', { name: /run/ }))
    expect(await screen.findByText('log.txt')).toBeVisible()
    expect(screen.getByTitle('/srv/out/run')).toBeVisible()
  })

  it('opens a clicked path, and says when it is gone', async () => {
    renderDialog(
      { kind: 'path', path: '/srv/gone.txt' },
      {
        kind: 'pane',
        paneId: 'pane-1',
      },
    )
    expect(
      await screen.findByText('This file was moved or deleted'),
    ).toBeVisible()
    expect(screen.getByText('/srv/gone.txt')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Shared' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it("opens on the Project view of a session's own folder", async () => {
    renderDialog(null, { kind: 'session', sessionId: 'ab12cd34' })
    expect(await screen.findByText('README.md')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Project' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Shared' })).toBeVisible()
  })

  it('says when nothing is shared yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ shows: [] })),
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <FilesDialog
          isOpen
          project={null}
          request={null}
          onClose={vi.fn()}
          onInsertPath={vi.fn()}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/Nothing shared yet/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull()
  })

  it('shows a refusal from another host at once, without Try again', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      json(
        {
          detail:
            'agent-work needs an update before its files can be shown here.',
        },
        409,
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    // The app's own retry policy, not the tests' retry: false.
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <FilesDialog
          isOpen
          project={{ kind: 'pane', paneId: 'pane-remote' }}
          request={null}
          onClose={vi.fn()}
          onInsertPath={vi.fn()}
        />
      </QueryClientProvider>,
    )
    // findByText gives up after 1 s, before a first retry would have finished.
    expect(
      await screen.findByText(
        'agent-work needs an update before its files can be shown here.',
      ),
    ).toBeVisible()
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).startsWith('/api/panes/pane-remote/files/tree'),
      ),
    ).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
