import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Design } from '@/lib/api/designs'
import { DesignsView } from './DesignsView'

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  params: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => nav.params,
}))
vi.mock('@/lib/offline', () => ({
  useOffline: () => ({ offline: false }),
  offlineMessage: () => '',
}))

const design = (fields: Partial<Design> = {}): Design => ({
  id: '0123456789ab',
  project: 'aico',
  title: 'Compact layout',
  note: 'Initial note',
  kind: 'html',
  size: 20,
  session: '0123abcd',
  askId: 'abcdef012345',
  createdAt: '2026-11-07T10:00:00Z',
  updatedAt: '2026-11-07T10:00:00Z',
  selectedAt: null,
  state: 'pending',
  viewUrl: '/api/mockups/0123456789ab/view?project=aico',
  ...fields,
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })

const projects = [
  { id: 'aico', name: 'Aico' },
  { id: 'neri', name: 'Neri' },
]

/** Answers the list from `lists` (the last one repeats) and the projects. */
function serve(lists: (Response | Promise<Response>)[], extra = vi.fn()) {
  let index = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/projects') return json(projects)
    if (url === '/api/mockups') {
      const answer = lists[Math.min(index, lists.length - 1)]
      index += 1
      return (await answer).clone()
    }
    return extra(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <DesignsView />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  nav.replace.mockReset()
  nav.params = new URLSearchParams('tab=designs&project=aico')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Designs tab', () => {
  it('keeps loading, failed and empty states distinct, with a retry', async () => {
    let answer: (value: Response) => void = () => {}
    serve([
      new Promise<Response>((resolve) => {
        answer = resolve
      }),
      json({ items: [], unreadable: 0 }),
    ])
    mount()
    expect(screen.getByText('Loading designs')).toBeVisible()
    answer(json({ detail: 'Designs are unavailable' }, 503))
    expect(
      await screen.findByText(/Couldn’t load designs: Designs are unavailable/),
    ).toBeVisible()
    expect(screen.queryByTestId('designs-empty')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('designs-empty')).toHaveTextContent(
      'No designs yet',
    )
  })

  it('lists designs by project, the one the window was opened for first, and opens one in the address', async () => {
    serve([
      json({
        items: [
          design({
            id: '000000000001',
            project: 'neri',
            title: 'Neri board',
            updatedAt: '2026-11-07T12:00:00Z',
          }),
          design({
            id: '000000000002',
            title: 'Older layout',
            updatedAt: '2026-11-07T09:00:00Z',
          }),
          design({
            id: '000000000003',
            title: 'Newer layout',
            updatedAt: '2026-11-07T11:00:00Z',
          }),
        ],
        unreadable: 0,
      }),
    ])
    mount()
    const groups = await screen.findAllByRole('region', { name: /Aico|Neri/ })
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Aico',
      'Neri',
    ])
    expect(
      within(groups[0])
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Newer layoutPending', 'Older layoutPending'])
    fireEvent.click(screen.getByRole('button', { name: /Neri board/ }))
    expect(nav.replace).toHaveBeenCalledWith(
      '/workbench?tab=designs&project=aico&design=000000000001',
    )
  })

  it('frames each kind with what it may do: scripts for HTML, Markdown and diagrams, none for SVG, no sandbox for a PDF', async () => {
    const kinds = [
      ['html', 'allow-scripts'],
      ['markdown', 'allow-scripts'],
      ['mermaid', 'allow-scripts'],
      ['svg', ''],
      ['pdf', null],
    ] as const
    for (const [kind, sandbox] of kinds) {
      cleanup()
      nav.params = new URLSearchParams(
        'tab=designs&project=aico&design=0123456789ab',
      )
      serve([json({ items: [design({ kind })], unreadable: 0 })])
      mount()
      const frame = await screen.findByTitle('Design: Compact layout')
      if (sandbox === null) expect(frame).not.toHaveAttribute('sandbox')
      else expect(frame).toHaveAttribute('sandbox', sandbox)
      expect(frame.getAttribute('sandbox') ?? '').not.toContain(
        'allow-same-origin',
      )
      expect(frame).not.toHaveAttribute('srcdoc')
      expect(frame.getAttribute('src')).toBe(
        '/api/mockups/0123456789ab/view?project=aico&v=2026-11-07T10%3A00%3A00Z',
      )
    }
  })

  it('shows an image as an image', async () => {
    serve([json({ items: [design({ kind: 'image' })], unreadable: 0 })])
    mount()
    expect(
      await screen.findByRole('img', { name: 'Design: Compact layout' }),
    ).toHaveAttribute(
      'src',
      expect.stringContaining('/api/mockups/0123456789ab/view?project=aico&v='),
    )
  })

  it('reloads the open design when an agent adds it again', async () => {
    serve([
      json({ items: [design()], unreadable: 0 }),
      json({
        items: [design({ updatedAt: '2026-11-07T10:05:00Z' })],
        unreadable: 0,
      }),
    ])
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mount()
    const frame = await screen.findByTitle('Design: Compact layout')
    expect(frame.getAttribute('src')).toContain('v=2026-11-07T10%3A00%3A00Z')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100)
    })
    await waitFor(() =>
      expect(
        screen.getByTitle('Design: Compact layout').getAttribute('src'),
      ).toContain('v=2026-11-07T10%3A05%3A00Z'),
    )
  })

  it('saves the note, then sends the choice with the current note, and says the others were passed', async () => {
    const extra = vi.fn(async (url: string, init?: RequestInit) => {
      const chosen = url.includes('/select')
      return json({
        mockup: design({
          note: JSON.parse(String(init?.body)).note,
          ...(chosen
            ? { state: 'selected', selectedAt: '2026-11-07T11:00:00Z' }
            : {}),
        }),
      })
    })
    const fetchMock = serve(
      [
        json({
          items: [
            design(),
            design({
              id: '000000000009',
              title: 'Wide layout',
              updatedAt: '2026-11-07T09:00:00Z',
            }),
          ],
          unreadable: 0,
        }),
      ],
      extra,
    )
    mount()
    const note = await screen.findByRole('textbox', {
      name: 'Note for Compact layout',
    })
    fireEvent.change(note, { target: { value: 'Saved note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect(await screen.findByText('Note saved.')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mockups/0123456789ab?project=aico',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ note: 'Saved note' }),
      }),
    )
    fireEvent.change(note, { target: { value: 'Ship this spacing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this one' }))
    expect(await screen.findByText('Choice saved.')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mockups/0123456789ab/select?project=aico',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ note: 'Ship this spacing' }),
      }),
    )
    expect(screen.queryByRole('button', { name: 'Use this one' })).toBeNull()
    expect(screen.getByText('Selected')).toBeVisible()
    expect(screen.getByText('Not selected')).toBeVisible()
  })

  it('keeps an unsuccessful choice available and names the error', async () => {
    serve(
      [json({ items: [design()], unreadable: 0 })],
      vi.fn(async () => json({ detail: 'The session is unavailable' }, 503)),
    )
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Use this one' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session is unavailable',
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use this one' }),
      ).not.toBeDisabled(),
    )
    expect(screen.getByText('Pending')).toBeVisible()
  })

  it('says when the project has no designs yet, and when some projects could not be read', async () => {
    nav.params = new URLSearchParams('tab=designs&project=neri')
    serve([json({ items: [design()], unreadable: 2 })])
    mount()
    expect(await screen.findByText('Neri has no designs yet.')).toBeVisible()
    expect(
      screen.getByText(/2 projects’ designs couldn’t be read/),
    ).toBeVisible()
  })
})
