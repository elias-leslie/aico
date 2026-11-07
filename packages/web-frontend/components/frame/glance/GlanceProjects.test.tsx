import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDetail, ProjectSummary } from '@/lib/projects'
import { GlanceProjects, useProjectsGlance } from './GlanceProjects'

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

const summary = (id: string, over: Partial<ProjectSummary> = {}) => ({
  id,
  name: id,
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: null,
  ...over,
})

const DETAIL: ProjectDetail = {
  id: 'portfolio',
  name: 'portfolio',
  overview: 'Portfolio research.',
  now: [{ text: 'Close the backup gaps', blocked: 'needs you' }],
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
  ],
  problems: Array.from({ length: 1 }, () => ({
    kind: 'backup' as const,
    count: 7,
    rows: Array.from({ length: 7 }, (_, n) => ({
      name: `Backup ${n + 1}`,
      detail: `copy ${n + 1} is late`,
    })),
  })),
  agents: [
    { sessionId: 'abc12345', title: 'Fix the gaps', blocked: true },
    { sessionId: 'def67890', title: 'Review', blocked: false },
  ],
}

let overview: () => Response
let detail: () => Response
beforeEach(() => {
  overview = () =>
    Response.json([
      summary('portfolio', {
        top: 'Close the backup gaps',
        problems: [{ kind: 'backup', count: 7 }],
        agents: 2,
      }),
      ...Array.from({ length: 12 }, (_, n) => summary(`quiet-${n + 1}`)),
      summary('old', { archived: true }),
      summary('older', { archived: true }),
    ])
  detail = () => Response.json(DETAIL)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = url.split('?')[0]
      if (path === '/api/projects/overview') return overview()
      if (path === '/api/projects/portfolio') return detail()
      return new Response('{}', { status: 404 })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <GlanceProjects />
    </QueryClientProvider>,
  )
}

describe('GlanceProjects', () => {
  it('lists every active project, with no cap and no "more" line, and folds the archived ones under a count', async () => {
    show()
    expect(screen.getByText('Loading projects…')).toBeVisible()
    await screen.findByText('portfolio')
    for (let n = 1; n <= 12; n++)
      expect(screen.getByText(`quiet-${n}`)).toBeVisible()
    expect(screen.queryByText(/more$/)).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('7 backup')).toHaveClass('failed')
    expect(screen.getByText('2 working')).toHaveClass('running')
    expect(screen.queryByText('old')).toBeNull()
    const archived = screen.getByRole('button', { name: /Archived/ })
    expect(archived).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(archived)
    expect(screen.getByText('old')).toBeVisible()
    expect(screen.getByText('older')).toBeVisible()
  })

  it('opens a project in place with its overview, every problem row, the agents and the power control', async () => {
    show()
    const row = (await screen.findByText('portfolio')).closest('button')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(row as HTMLElement)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Portfolio research.')).toBeVisible()
    expect(screen.getByText('Blocked: needs you')).toBeVisible()
    // All seven rows, not the page popover's five.
    for (let n = 1; n <= 7; n++)
      expect(screen.getByText(`Backup ${n}`)).toBeVisible()
    expect(screen.queryByText(/\+ \d+ more/)).toBeNull()
    expect(screen.getByRole('link', { name: /Fix the gaps/ })).toHaveAttribute(
      'href',
      '/?session=abc12345',
    )
    expect(screen.getByRole('link', { name: 'Review' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Start VM 180 (it is stopped)' }),
    ).toBeVisible()
    // One project is open at a time.
    fireEvent.click(
      screen.getByText('quiet-1').closest('button') as HTMLElement,
    )
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('asks before a power move, names the target, and sends nothing on cancel', async () => {
    show()
    fireEvent.click(
      (await screen.findByText('portfolio')).closest('button') as HTMLElement,
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Start VM 180 (it is stopped)',
      }),
    )
    const sheet = await screen.findByTestId('confirm-dialog')
    expect(
      within(sheet).getByRole('button', { name: 'Start VM 180' }),
    ).toBeVisible()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    const posts = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      )
    expect(posts).toHaveLength(0)
  })

  it('finds a project, opens the archived group for a match, and says when none matches', async () => {
    show()
    await screen.findByText('portfolio')
    const find = screen.getByRole('searchbox', { name: 'Find a project' })
    fireEvent.change(find, { target: { value: 'older' } })
    expect(screen.getByText('older')).toBeVisible()
    expect(screen.queryByText('portfolio')).toBeNull()
    fireEvent.change(find, { target: { value: 'zzz' } })
    expect(screen.getByText('No project matches.')).toBeVisible()
  })

  it('says loading, failed (with Retry) and an empty list in different words', async () => {
    overview = () => new Response('{}', { status: 500 })
    show()
    expect(await screen.findByText('Projects couldn’t be read.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    cleanup()
    overview = () => Response.json([])
    show()
    expect(await screen.findByText('No projects yet.')).toBeVisible()
  })

  it('says a project failed to load and offers Retry', async () => {
    detail = () => new Response('{}', { status: 500 })
    show()
    fireEvent.click(
      (await screen.findByText('portfolio')).closest('button') as HTMLElement,
    )
    expect(await screen.findByText(/Couldn’t load this project/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })
})

describe('useProjectsGlance', () => {
  const Value = () => {
    const head = useProjectsGlance()
    return <p data-tone={head.tone ?? ''}>{head.value}</p>
  }
  function showValue() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    return render(
      <QueryClientProvider client={client}>
        <Value />
      </QueryClientProvider>,
    )
  }
  it('counts the active projects, not the archived ones', async () => {
    showValue()
    expect(screen.getByText('Checking…')).toBeVisible()
    expect(await screen.findByText('13 active')).toBeVisible()
  })
  it('says it could not read, in the failed tone', async () => {
    overview = () => new Response('{}', { status: 500 })
    showValue()
    const value = await screen.findByText('Couldn’t read')
    expect(value).toHaveAttribute('data-tone', 'failed')
  })
})
