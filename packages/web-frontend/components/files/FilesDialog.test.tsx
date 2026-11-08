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

/** The last listing the browser asked for, as its query. */
function lastTree(): URLSearchParams {
  const urls = vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), 'http://aico.test'))
    .filter((url) => url.pathname === '/api/files/tree')
  return urls[urls.length - 1].searchParams
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
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

  it('sorts Home and /tmp by Modified and project folders by Name, and the pick holds', async () => {
    renderDialog(null, { kind: 'session', sessionId: 'ab12cd34' })
    fireEvent.click(await screen.findByRole('button', { name: 'Everywhere' }))
    await screen.findByText('tmp-file.txt')
    expect(lastTree().get('root')).toBe('/srv/work')
    expect(lastTree().get('sort')).toBeNull()
    expect(screen.getByRole('button', { name: 'Name' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: '/tmp' }))
    await waitFor(() => expect(lastTree().get('root')).toBe('/tmp'))
    await waitFor(() => expect(lastTree().get('sort')).toBe('modified'))
    expect(screen.getByRole('button', { name: 'Modified' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Name' }))
    await waitFor(() => expect(lastTree().get('sort')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /Home/ }))
    await waitFor(() => expect(lastTree().get('root')).toBe('/home/me'))
    expect(lastTree().get('sort')).toBeNull()
  })

  it('hides dotfiles in Everywhere until Show hidden, and remembers the choice', async () => {
    window.localStorage.clear()
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    expect(lastTree().get('hidden')).toBe('0')
    const toggle = screen.getByRole('button', { name: 'Show hidden' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    await waitFor(() => expect(lastTree().get('hidden')).toBeNull())
    expect(window.localStorage.getItem('aico-files-show-hidden')).toBe('1')
    cleanup()
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    expect(lastTree().get('hidden')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show hidden' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('finds by name in this folder, and a new folder starts unfiltered', async () => {
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find in this folder' }),
      {
        target: { value: 'tmp' },
      },
    )
    await waitFor(() => expect(lastTree().get('match')).toBe('tmp'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Go to a path' }), {
      target: { value: '/tmp/agent/out.txt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    await waitFor(() => expect(lastTree().get('root')).toBe('/tmp/agent'))
    expect(lastTree().get('match')).toBeNull()
    expect(
      screen.getByRole('searchbox', { name: 'Find in this folder' }),
    ).toHaveValue('')
  })

  it('keeps an open folder open while finding, and offers Download on a text file', async () => {
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname === '/api/files/content')
        return json({
          path: searchParams.get('path'),
          name: 'inner.txt',
          content: 'hello',
          size: 5,
          lines: 1,
          extension: '.txt',
          language: null,
          is_binary: false,
          is_truncated: false,
        })
      if (pathname !== '/api/files/tree') return serve(url)
      return json(
        searchParams.get('path')
          ? {
              entries: [
                {
                  name: 'inner.txt',
                  path: 'tmp-dir/inner.txt',
                  is_directory: false,
                  size: 5,
                  extension: '.txt',
                },
              ],
              path: 'tmp-dir',
              total: 1,
            }
          : {
              entries: [
                {
                  name: 'tmp-dir',
                  path: 'tmp-dir',
                  is_directory: true,
                  children_count: 1,
                },
              ],
              path: '',
              total: 1,
            },
      )
    })
    fireEvent.click(await screen.findByText('tmp-dir'))
    const inner = await screen.findByText('inner.txt')
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find in this folder' }),
      { target: { value: 'tmp' } },
    )
    await waitFor(() => expect(lastTree().get('match')).toBe('tmp'))
    await waitFor(() => expect(screen.queryByText('Loading files')).toBeNull())
    // The same row, never unmounted: the list stayed up through the new answer.
    expect(inner).toBeInTheDocument()
    fireEvent.click(inner)
    const download = await screen.findByRole('link', { name: 'Download' })
    expect(download).toHaveAttribute('download', 'inner.txt')
  })

  it('narrows an open folder while finding, and keeps it open', async () => {
    const file = (name: string, path: string) => ({
      name,
      path,
      is_directory: false,
      size: 5,
      extension: '.ts',
    })
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname !== '/api/files/tree') return serve(url)
      const match = searchParams.get('match') ?? ''
      const inFolder = searchParams.get('path') === 'src'
      const all = inFolder
        ? [file('keep.ts', 'src/keep.ts'), file('other.ts', 'src/other.ts')]
        : [
            {
              name: 'src',
              path: 'src',
              is_directory: true,
              children_count: 2,
            },
            file('keep-top.ts', 'keep-top.ts'),
          ]
      const entries = all.filter((entry) => entry.name.includes(match))
      return json({
        entries,
        path: inFolder ? 'src' : '',
        total: entries.length,
      })
    })
    fireEvent.click(await screen.findByText('src'))
    await screen.findByText('other.ts')
    const find = screen.getByRole('searchbox', { name: 'Find in this folder' })

    fireEvent.change(find, { target: { value: 'keep' } })
    await waitFor(() => expect(screen.queryByText('other.ts')).toBeNull())
    expect(screen.getByText('src')).toBeInTheDocument()
    expect(screen.getByText('keep.ts')).toBeInTheDocument()
    expect(screen.getByText('keep-top.ts')).toBeInTheDocument()

    fireEvent.change(find, { target: { value: 'nothing' } })
    expect(await screen.findByText('No match in here')).toBeInTheDocument()

    fireEvent.change(find, { target: { value: '' } })
    expect(await screen.findByText('other.ts')).toBeInTheDocument()

    // Closed during a find, it keeps its row until the find changes.
    fireEvent.change(find, { target: { value: 'keep' } })
    await waitFor(() => expect(screen.queryByText('other.ts')).toBeNull())
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.queryByText('keep.ts')).toBeNull())
    expect(screen.getByText('src')).toBeInTheDocument()
    fireEvent.change(find, { target: { value: 'keep-' } })
    await waitFor(() => expect(screen.queryByText('src')).toBeNull())
  })

  it('shows all of a folder found by name, and narrows a folder open inside another', async () => {
    const file = (name: string, path: string) => ({
      name,
      path,
      is_directory: false,
      size: 5,
      extension: '.ts',
    })
    const folder = (name: string, path: string) => ({
      name,
      path,
      is_directory: true,
      children_count: 1,
    })
    const tree: Record<string, object[]> = {
      '': [folder('box', 'box'), folder('found', 'found')],
      box: [folder('deep', 'box/deep'), file('x.ts', 'box/x.ts')],
      'box/deep': [
        file('found.ts', 'box/deep/found.ts'),
        file('y.ts', 'box/deep/y.ts'),
      ],
      found: [file('inside.ts', 'found/inside.ts')],
    }
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname !== '/api/files/tree') return serve(url)
      const match = searchParams.get('match') ?? ''
      const path = searchParams.get('path') ?? ''
      const entries = (tree[path] ?? []).filter((entry) =>
        (entry as { name: string }).name.includes(match),
      )
      return json({ entries, path, total: entries.length })
    })
    fireEvent.click(await screen.findByText('box'))
    fireEvent.click(await screen.findByText('deep'))
    await screen.findByText('y.ts')
    fireEvent.click(screen.getByText('found'))
    await screen.findByText('inside.ts')
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find in this folder' }),
      { target: { value: 'found' } },
    )
    await waitFor(() => expect(screen.queryByText('y.ts')).toBeNull())
    expect(screen.queryByText('x.ts')).toBeNull()
    expect(screen.getByText('deep')).toBeInTheDocument()
    expect(screen.getByText('found.ts')).toBeInTheDocument()
    expect(screen.getByText('inside.ts')).toBeInTheDocument()
  })

  it('closes the preview with its X, or by tapping the file again', async () => {
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname !== '/api/files/content') return serve(url)
      return json({
        path: searchParams.get('path'),
        name: 'tmp-file.txt',
        content: 'hello',
        size: 5,
        lines: 1,
        extension: '.txt',
        language: null,
        is_binary: false,
        is_truncated: false,
      })
    })
    fireEvent.click(await screen.findByText('tmp-file.txt'))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Close preview' }),
    )
    expect(await screen.findByText('Pick a file to preview it.')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /tmp-file\.txt/ }))
    await screen.findByRole('button', { name: 'Close preview' })
    fireEvent.click(screen.getByRole('button', { name: /tmp-file\.txt/ }))
    expect(await screen.findByText('Pick a file to preview it.')).toBeVisible()
  })

  it('closes a file that won’t open, and a double-click leaves a file open', async () => {
    let broken = true
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname !== '/api/files/content') return serve(url)
      if (broken) return json({ detail: 'This file was moved or deleted' }, 404)
      return json({
        path: searchParams.get('path'),
        name: 'tmp-file.txt',
        content: 'hello',
        size: 5,
        lines: 1,
        extension: '.txt',
        language: null,
        is_binary: false,
        is_truncated: false,
      })
    })
    const row = () => screen.findByRole('button', { name: /tmp-file\.txt/ })
    fireEvent.click(await row())
    await screen.findByText('This file was moved or deleted')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(await screen.findByText('Pick a file to preview it.')).toBeVisible()

    broken = false
    fireEvent.click(await row(), { detail: 1 })
    await screen.findByRole('button', { name: 'Close preview' })
    fireEvent.click(await row(), { detail: 2 })
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeVisible()
  })

  it('keeps a hidden folder out of a find once hidden files are off', async () => {
    renderDialog(null, null, (url) => {
      const { pathname, searchParams } = new URL(url, 'http://aico.test')
      if (pathname !== '/api/files/tree') return serve(url)
      const hidden = searchParams.get('hidden') === '0'
      const match = searchParams.get('match') ?? ''
      const inFolder = searchParams.get('path') === '.config'
      const all = inFolder
        ? [
            {
              name: 'inner.txt',
              path: '.config/inner.txt',
              is_directory: false,
              size: 1,
              extension: '.txt',
            },
          ]
        : [
            {
              name: '.config',
              path: '.config',
              is_directory: true,
              children_count: 1,
            },
          ]
      const entries = all.filter(
        (entry) =>
          entry.name.includes(match) && !(hidden && entry.name.startsWith('.')),
      )
      return json({ entries, path: '', total: entries.length })
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Show hidden' }))
    fireEvent.click(await screen.findByText('.config'))
    await screen.findByText('inner.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }))
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find in this folder' }),
      { target: { value: 'nothing' } },
    )
    await waitFor(() => expect(screen.queryByText('.config')).toBeNull())
  })

  it('works when storage is out of reach', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }))
    await waitFor(() => expect(lastTree().get('hidden')).toBeNull())
    vi.restoreAllMocks()
  })

  it('shows when each entry changed and how big a file is', async () => {
    const modified = Date.now() - 4 * 60_000
    renderDialog(null, null, (url) =>
      new URL(url, 'http://aico.test').pathname === '/api/files/tree'
        ? json({
            entries: [
              {
                name: 'report.md',
                path: 'report.md',
                is_directory: false,
                size: 2048,
                extension: '.md',
                modified,
              },
            ],
            path: '',
            total: 1,
          })
        : serve(url),
    )
    expect(await screen.findByText('4 min ago')).toBeVisible()
    expect(screen.getByText('2.0 KB')).toBeVisible()
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

  it('marks Shared with the shares that came since it was last open, and clears it on opening', async () => {
    window.localStorage.setItem(
      'aico:shared-opened-at',
      '2026-10-27T09:00:00.000Z',
    )
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    const button = await screen.findByRole('button', { name: 'Shared 1 new' })
    expect(within(button).getByTestId('shared-new')).toHaveTextContent('1 new')
    fireEvent.click(button)
    expect(await screen.findByText('Image and prompt')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Shared' })).toBeVisible()
    expect(screen.queryByTestId('shared-new')).toBeNull()
    expect(window.localStorage.getItem('aico:shared-opened-at')).toBe(
      share.createdAt,
    )
  })

  it('does not call the shares already there new on a first visit', async () => {
    renderDialog(null, null)
    await screen.findByText('tmp-file.txt')
    await waitFor(() =>
      expect(window.localStorage.getItem('aico:shared-opened-at')).toBe(
        share.createdAt,
      ),
    )
    expect(screen.queryByTestId('shared-new')).toBeNull()
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

  describe('Rendered and Source', () => {
    /** A one-file folder at /tmp/work, opened on that file. */
    function openFile(name: string, content: string | null, binary = false) {
      return renderDialog(
        { kind: 'path', path: `/tmp/work/${name}` },
        null,
        (url) => {
          const { pathname, searchParams } = new URL(url, 'http://aico.test')
          if (pathname === '/api/files/stat')
            return json({ path: searchParams.get('path'), kind: 'file' })
          if (pathname === '/api/files/tree')
            return json({
              entries: [
                {
                  name,
                  path: name,
                  is_directory: false,
                  size: 9,
                  extension: name.slice(name.lastIndexOf('.')),
                },
              ],
              path: '',
              total: 1,
            })
          if (pathname === '/api/files/content')
            return json({
              path: name,
              name,
              content,
              size: 9,
              lines: 1,
              extension: name.slice(name.lastIndexOf('.')),
              is_binary: binary,
              language: null,
              truncated: false,
            })
          return serve(url)
        },
      )
    }

    it('shows an HTML file as source first, and rendered in a sandbox without same-origin on request', async () => {
      openFile('page.html', '<h1>Hello</h1>')
      expect(await screen.findByText('<h1>Hello</h1>')).toBeVisible()
      const view = screen.getByRole('group', { name: 'View' })
      expect(
        within(view).getByRole('button', { name: 'Source' }),
      ).toHaveAttribute('aria-pressed', 'true')
      fireEvent.click(within(view).getByRole('button', { name: 'Rendered' }))
      const frame = await screen.findByTitle('Rendered: page.html')
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
      expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
      expect(frame).toHaveAttribute(
        'src',
        '/api/files/view?root=%2Ftmp%2Fwork&path=page.html',
      )
      expect(frame).not.toHaveAttribute('srcdoc')
      expect(screen.queryByText('<h1>Hello</h1>')).toBeNull()
      fireEvent.click(within(view).getByRole('button', { name: 'Source' }))
      expect(await screen.findByText('<h1>Hello</h1>')).toBeVisible()
      expect(screen.queryByTitle('Rendered: page.html')).toBeNull()
    })

    it('frames SVG with no scripts and Markdown with the viewer only', async () => {
      openFile('logo.svg', '<svg/>')
      await screen.findByText('<svg/>')
      fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
      expect(await screen.findByTitle('Rendered: logo.svg')).toHaveAttribute(
        'sandbox',
        '',
      )
      cleanup()
      openFile('notes.md', '# Notes')
      await screen.findByText('# Notes')
      fireEvent.click(screen.getByRole('button', { name: 'Rendered' }))
      expect(await screen.findByTitle('Rendered: notes.md')).toHaveAttribute(
        'sandbox',
        'allow-scripts',
      )
    })

    it('opens a PDF rendered, and offers no toggle for other files', async () => {
      openFile('spec.pdf', null, true)
      const frame = await screen.findByTitle('Rendered: spec.pdf')
      expect(frame).not.toHaveAttribute('sandbox')
      fireEvent.click(screen.getByRole('button', { name: 'Source' }))
      expect(await screen.findByText(/Binary file/)).toBeVisible()
      cleanup()
      openFile('plain.txt', 'just text')
      expect(await screen.findByText('just text')).toBeVisible()
      expect(screen.queryByRole('group', { name: 'View' })).toBeNull()
    })
  })
})
