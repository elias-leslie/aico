import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ProjectDetail,
  ProjectSummary,
  TimelinePage,
} from '@/lib/projects'
import { ProjectsPage } from './ProjectsPage'

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: React.ReactNode
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const summary = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'p',
  name: 'P',
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: new Date(Date.now() - 4 * 60_000).toISOString(),
  ...over,
})

const OVERVIEW: ProjectSummary[] = [
  summary({
    id: 'omninull',
    lastActivity: new Date(Date.now() - 20 * 60_000).toISOString(),
    name: 'OmniNull',
    runState: 'running',
    top: 'Trust fabric',
    problems: [{ kind: 'quiet', count: 21 }],
    agents: 1,
  }),
  summary({
    id: 'cinder',
    name: 'Cinderwake',
    waiting: { askId: 'a1', title: 'playtest the slice' },
  }),
  summary({
    id: 'portfolio',
    name: 'Portfolio AI',
    runState: 'stopped',
    problems: [{ kind: 'backup', count: 1 }],
  }),
  summary({ id: 'old', name: 'Old tool', archived: true }),
]

const DETAIL: ProjectDetail = {
  id: 'portfolio',
  name: 'Portfolio AI',
  overview: 'Portfolio research.',
  now: [
    {
      text: 'Close VM 180 backup gaps',
      session: 's1',
      plan: 'docs/plans/x/plan.md',
      blocked: 'needs you',
    },
  ],
  next: [{ text: 'Quiet polling' }],
  later: [],
  places: [
    {
      kind: 'vm',
      id: 180,
      label: 'Portfolio AI',
      power: true,
      state: 'stopped',
      since: '2026-11-06T10:40:00',
      asOf: new Date().toISOString(),
    },
    { kind: 'host', label: 'Workstation', power: false, state: 'running' },
  ],
  problems: [
    {
      kind: 'backup',
      count: 3,
      rows: [{ name: 'VM 180 nightly', detail: 'last copy 2 d ago' }],
    },
  ],
  agents: [],
}

const TIMELINE: TimelinePage = {
  days: [
    {
      date: '2026-11-04',
      commits: [
        {
          sha: 'a1',
          subject: `Long subject ${'x'.repeat(200)}`,
          at: '2026-11-04T10:00:00Z',
          release: 'v1.8.107',
        },
      ],
    },
  ],
  end: true,
}

let routes: Record<string, () => Response | Promise<Response>>
beforeEach(() => {
  routes = {
    '/api/projects/overview': () => Response.json(OVERVIEW),
    '/api/projects/portfolio': () => Response.json(DETAIL),
    '/api/projects/portfolio/timeline': () => Response.json(TIMELINE),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0]
      const route = routes[path]
      return route ? route() : new Response('{}', { status: 404 })
    }),
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => vi.unstubAllGlobals())

function show(selected = '', onSelect = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ProjectsPage selected={selected} onSelect={onSelect} />
    </QueryClientProvider>,
  )
  return onSelect
}

describe('list', () => {
  it('shows a skeleton, then waiting first, with Archived collapsed', async () => {
    show()
    expect(
      screen.getByRole('status', { name: 'Loading projects' }),
    ).toBeInTheDocument()
    await screen.findByText('Cinderwake')
    const names = screen
      .getAllByRole('button')
      .filter((b) => b.className.includes('pick'))
      .map((b) => b.textContent)
    expect(names[0]).toContain('Cinderwake')
    expect(names[1]).toContain('Portfolio AI')
    expect(screen.getByLabelText('Waiting on you')).toBeInTheDocument()
    expect(
      screen.getByText('Waiting on you: playtest the slice'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Old tool')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
    expect(screen.getByText('Old tool')).toBeInTheDocument()
  })

  it('gives each run state its own mark and badges their counts', async () => {
    show()
    await screen.findByText('OmniNull')
    expect(screen.getByRole('img', { name: 'Running' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Stopped' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '21 checks quiet' }),
    ).toHaveTextContent('21')
    expect(
      screen.getByRole('button', { name: '1 agent working' }),
    ).toBeInTheDocument()
  })

  it('filters by search and says when nothing matches', async () => {
    show()
    await screen.findByText('OmniNull')
    fireEvent.change(screen.getByLabelText('Find a project'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('No project matches')).toBeInTheDocument()
  })

  it('says it could not load, with Retry', async () => {
    routes['/api/projects/overview'] = () => new Response('{}', { status: 500 })
    show()
    expect(
      await screen.findByText('Couldn’t load projects', {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('says there are no projects, not that loading failed', async () => {
    routes['/api/projects/overview'] = () => Response.json([])
    show()
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
  })

  it('opens a project when its row is picked', async () => {
    const onSelect = show()
    fireEvent.click(
      (await screen.findByText('Portfolio AI')).closest(
        'button',
      ) as HTMLElement,
    )
    expect(onSelect).toHaveBeenCalledWith('portfolio')
  })
})

describe('detail', () => {
  it('opens the start sheet naming the target and cancels without a request', async () => {
    show('portfolio')
    const power = await screen.findByRole('button', {
      name: 'VM 180: stopped. Open power options',
    })
    fireEvent.click(power)
    const sheet = await screen.findByTestId('confirm-dialog')
    expect(within(sheet).getByText('VM 180')).toBeInTheDocument()
    expect(within(sheet).getByText(/Stopped at 10:40/)).toBeInTheDocument()
    expect(
      within(sheet).getByRole('button', { name: 'Start VM 180' }),
    ).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    const posts = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      )
    expect(posts).toHaveLength(0)
  })

  it('shows a host without power as an indicator, not a button', async () => {
    show('portfolio')
    const mark = await screen.findByRole('img', {
      name: /Workstation: running/,
    })
    expect(mark.tagName).toBe('SPAN')
  })

  it('opens a problem popover with its rows and a way to Status', async () => {
    show('portfolio')
    fireEvent.click(
      await screen.findByRole('button', { name: '3 backups failed' }),
    )
    const pop = screen.getByRole('dialog', { name: '3 backups failed' })
    expect(within(pop).getByText('VM 180 nightly')).toBeInTheDocument()
    expect(within(pop).getByText('+ 2 more')).toBeInTheDocument()
    expect(
      within(pop).getByRole('link', { name: 'Open in Status' }),
    ).toHaveAttribute('href', '/status?project=portfolio')
  })

  it('lays out Now with links, a blocked beacon, and git days with release chips and tooltips', async () => {
    show('portfolio')
    await screen.findByText('Close VM 180 backup gaps')
    const now = screen
      .getByText('Close VM 180 backup gaps')
      .closest('li') as HTMLElement
    expect(now).toHaveAttribute('title', 'needs you')
    expect(within(now).getByRole('link', { name: 'session' })).toHaveAttribute(
      'href',
      '/?session=s1',
    )
    expect(
      within(now).getByRole('button', { name: 'plan' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Wed · Nov 4')).toBeInTheDocument()
    expect(screen.getByText('v1.8.107')).toBeInTheDocument()
    const subject = screen.getByTitle(/^Long subject x+$/)
    expect(subject.textContent?.endsWith('…')).toBe(true)
    expect(await screen.findByText(/Start of history/)).toBeInTheDocument()
  })

  it('says No roadmap yet when all three lists are empty', async () => {
    routes['/api/projects/portfolio'] = () =>
      Response.json({ ...DETAIL, now: [], next: [], later: [] })
    show('portfolio')
    expect(await screen.findByText('No roadmap yet.')).toBeInTheDocument()
  })

  it('shows can’t reach Proxmox as an indicator with its time', async () => {
    routes['/api/projects/portfolio'] = () =>
      Response.json({
        ...DETAIL,
        places: [
          {
            ...DETAIL.places[0],
            state: 'unknown',
            asOf: '2026-11-06T10:02:00',
          },
        ],
      })
    show('portfolio')
    expect(
      await screen.findByText('can’t reach the Proxmox host · as of 10:02'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Open power options/ }),
    ).toBeNull()
  })

  it('retries when history fails to load, and when the project fails', async () => {
    routes['/api/projects/portfolio/timeline'] = () =>
      new Response('{}', { status: 500 })
    show('portfolio')
    expect(
      await screen.findByText('Couldn’t load history', {}, { timeout: 3000 }),
    ).toBeInTheDocument()
  })

  it('says it could not load the project', async () => {
    routes['/api/projects/portfolio'] = () =>
      new Response('{}', { status: 500 })
    show('portfolio')
    expect(
      await screen.findByText(
        'Couldn’t load this project',
        {},
        { timeout: 3000 },
      ),
    ).toBeInTheDocument()
  })
})
