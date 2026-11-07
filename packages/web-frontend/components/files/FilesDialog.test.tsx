import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
  paths: ['/srv/out/image.png', '/srv/out/run/', '/srv/out/mock.html'],
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
    if (path === '/srv/out/image.png' || path === '/tmp/agent/out.txt')
      return json({ path, kind: 'file' })
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
        : root === '/srv/out/run'
          ? [
              {
                name: 'log.txt',
                path: 'log.txt',
                is_directory: false,
                size: 2,
                extension: '.txt',
              },
            ]
          : [
              {
                name: 'tmp-file.txt',
                path: 'tmp-file.txt',
                is_directory: false,
                size: 2,
                extension: '.txt',
              },
            ]
    return json({ entries, path: '', total: entries.length })
  }
  if (pathname === '/api/files/places')
    return json({
      places: [
        { id: 'home', label: 'Home', path: '/home/me' },
        { id: '/tmp', label: '/tmp', path: '/tmp' },
      ],
    })
  if (pathname === '/api/sessions/ab12cd34/files/root')
    return json({ root: '/srv/work', host: null })
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
  fetcher: (url: string, init?: RequestInit) => Promise<Response> | Response = (
    url,
  ) => serve(url),
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    fetcher(url, init),
  )
  vi.stubGlobal('fetch', fetchMock)
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
  return { onInsertPath, fetchMock }
}

/** The folders the browser has asked to list, in order. */
function treeRoots(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), 'http://aico.test'))
    .filter((url) => url.pathname === '/api/files/tree')
    .map((url) => url.searchParams.get('root') ?? '')
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

  it('removes a share from Shared and the list refreshes without it', async () => {
    let removed = false
    const { fetchMock } = renderDialog(
      { kind: 'shared' },
      null,
      (url, init) => {
        if (init?.method === 'DELETE') {
          removed = true
          return json({ id: share.id, removed: true })
        }
        return url.startsWith('/api/shows') && removed
          ? json({ shows: [] })
          : serve(url)
      },
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove Image and prompt from Shared',
      }),
    )
    expect(await screen.findByText(/Nothing shared yet/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(`/api/shows/${share.id}`, {
      method: 'DELETE',
    })
  })

  it('says so when a share could not be removed, and keeps it', async () => {
    renderDialog({ kind: 'shared' }, null, (url, init) =>
      init?.method === 'DELETE'
        ? json({ detail: 'Tether is not reachable' }, 503)
        : serve(url),
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove Image and prompt from Shared',
      }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t remove it: Tether is not reachable',
    )
    expect(screen.getByText('Image and prompt')).toBeVisible()
  })

  it('opens a shared web page rendered in its own tab, with Source beside it', async () => {
    renderDialog({ kind: 'shared' })
    const page = await screen.findByRole('link', { name: /mock\.html/ })
    expect(page).toHaveAttribute('href', '/api/files/page/srv/out/mock.html')
    expect(page).toHaveAttribute('target', '_blank')
    expect(
      screen.getByRole('button', { name: 'View source of mock.html' }),
    ).toBeVisible()
  })

  it('browses a shared folder', async () => {
    renderDialog({ kind: 'shared' })
    fireEvent.click(await screen.findByRole('button', { name: /run/ }))
    expect(await screen.findByText('log.txt')).toBeVisible()
    expect(
      within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole(
        'button',
        { name: 'run' },
      ),
    ).toHaveAttribute('aria-current', 'location')
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
    expect(
      screen.getByRole('button', { name: 'This project' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it("opens on This project, a session's own folder, with its path above it", async () => {
    renderDialog(null, { kind: 'session', sessionId: 'ab12cd34' })
    expect(await screen.findByText('README.md')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'This project' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Everywhere' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    const crumbs = within(
      await screen.findByRole('navigation', { name: 'Folder path' }),
    )
    expect(crumbs.getByRole('button', { name: 'work' })).toHaveAttribute(
      'aria-current',
      'location',
    )
  })

  it('goes above the project from the breadcrumb, up to the top', async () => {
    renderDialog(null, { kind: 'session', sessionId: 'ab12cd34' })
    const crumbs = within(
      await screen.findByRole('navigation', { name: 'Folder path' }),
    )
    fireEvent.click(crumbs.getByRole('button', { name: 'srv' }))
    expect(await screen.findByText('tmp-file.txt')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Everywhere' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(treeRoots()).toContain('/srv')
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole(
        'button',
        { name: 'Top folder, /' },
      ),
    )
    await waitFor(() => expect(treeRoots()).toContain('/'))
  })

  it('switches between This project and Everywhere, Everywhere starting in the project folder', async () => {
    renderDialog(null, { kind: 'session', sessionId: 'ab12cd34' })
    fireEvent.click(await screen.findByRole('button', { name: 'Everywhere' }))
    expect(await screen.findByText('tmp-file.txt')).toBeVisible()
    expect(treeRoots()).toContain('/srv/work')
    expect(screen.getByRole('textbox', { name: 'Go to a path' })).toHaveValue(
      '/srv/work',
    )
    fireEvent.click(screen.getByRole('button', { name: 'This project' }))
    expect(await screen.findByText('README.md')).toBeVisible()
  })

  it('opens on Home with Shared in sight when no session is open', async () => {
    renderDialog(null, null)
    expect(await screen.findByText('tmp-file.txt')).toBeVisible()
    expect(treeRoots()).toEqual(['/home/me'])
    expect(screen.getByRole('button', { name: /Home/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Shared' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'This project' })).toBeNull()
  })

  it('jumps to a path typed in the box, a file opening in its folder', async () => {
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    const box = screen.getByRole('textbox', { name: 'Go to a path' })
    fireEvent.change(box, { target: { value: '/tmp/agent/out.txt' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(treeRoots()).toContain('/tmp/agent'))
    expect(
      within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole(
        'button',
        { name: 'agent' },
      ),
    ).toHaveAttribute('aria-current', 'location')
    fireEvent.change(box, { target: { value: '/nowhere' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(
      await screen.findByText('This file was moved or deleted'),
    ).toBeVisible()
    // The box stays to try another path.
    expect(screen.getByRole('textbox', { name: 'Go to a path' })).toBeVisible()
  })

  it('jumps to a shortcut folder and to Shared', async () => {
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    fireEvent.click(screen.getByRole('button', { name: '/tmp' }))
    await waitFor(() => expect(treeRoots().at(-1)).toBe('/tmp'))
    fireEvent.click(screen.getByRole('button', { name: 'Shared' }))
    expect(await screen.findByText('Image and prompt')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Shared' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('shows a symlink as a link, and says when a folder cannot be read', async () => {
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (
        pathname === '/api/files/stat' &&
        searchParams.get('path') === '/root'
      )
        return json({ path: '/root', kind: 'folder' })
      if (
        pathname === '/api/files/tree' &&
        searchParams.get('root') === '/home/me'
      )
        return json({
          entries: [
            {
              name: 'latest',
              path: 'latest',
              is_directory: true,
              is_symlink: true,
              link_target: '/srv/out',
            },
            {
              name: 'old',
              path: 'old',
              is_directory: false,
              is_symlink: true,
              link_target: 'gone',
              link_broken: true,
              size: 0,
            },
          ],
          path: '',
          total: 2,
          offset: 0,
        })
      if (
        pathname === '/api/files/tree' &&
        searchParams.get('root') === '/root'
      )
        return json(
          { detail: 'Can’t read this folder: permission denied' },
          403,
        )
      return serve(url)
    })
    expect(
      await screen.findByRole('button', { name: /latest.*\/srv\/out/ }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', { name: /old.*nothing there/ }),
    ).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Go to a path' }), {
      target: { value: '/root' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(
      await screen.findByText('Can’t read this folder: permission denied'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('pages a long folder with Show more', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `f${from + index}`,
        path: `f${from + index}`,
        is_directory: false,
        size: 1,
        extension: null,
      }))
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (
        pathname === '/api/files/tree' &&
        searchParams.get('root') === '/home/me'
      ) {
        const offset = Number(searchParams.get('offset') ?? 0)
        return json({
          entries: offset ? page(3, 2) : page(0, 3),
          path: '',
          total: 5,
          offset,
        })
      }
      return serve(url)
    })
    expect(await screen.findByText('Showing 3 of 5')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('f4')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('says on another host that Everywhere is this computer’s files', async () => {
    renderDialog(null, { kind: 'pane', paneId: 'pane-remote' }, (url) =>
      url.startsWith('/api/panes/pane-remote/files/root')
        ? json({ root: null, host: 'agent-work' })
        : serve(url),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Everywhere' }))
    expect(
      await screen.findByText(/agent-work’s files are under This project/),
    ).toBeVisible()
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
          request={{ kind: 'shared' }}
          onClose={vi.fn()}
          onInsertPath={vi.fn()}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/Nothing shared yet/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'This project' })).toBeNull()
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
