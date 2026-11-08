import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackupEntry } from '@/lib/backups'
import { GlanceBackups, useBackupsGlance } from './GlanceBackups'

const state = vi.hoisted(() => ({
  backups: {} as Record<string, unknown>,
  open: vi.fn(),
}))
vi.mock('@/lib/hooks/use-backups', () => ({ useBackups: () => state.backups }))
vi.mock('../FrameContext', () => ({ useFrame: () => ({ open: state.open }) }))

const hour = 3_600_000
const entry = (over: Partial<BackupEntry> & { ageH?: number } = {}) => {
  const { ageH = 1, ...rest } = over
  return {
    id: `${rest.target ?? 'native'}/${rest.source ?? 'home'}`,
    source: 'home',
    name: 'Home',
    target: 'native',
    dataAt: new Date(Date.now() - ageH * hour).toISOString(),
    nextRun: new Date(Date.now() + hour).toISOString(),
    state: 'ok',
    meaning: '',
    snapshot: null,
    path: null,
    machine: 'workstation',
    limitHours: 8,
    ...rest,
  } as BackupEntry
}
const give = (entries: BackupEntry[] | null, over: object = {}) => {
  state.backups = {
    entries,
    loading: false,
    failed: false,
    stale: false,
    ...over,
  }
}
const view = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GlanceBackups />
    </QueryClientProvider>,
  )
const Head = () => {
  const head = useBackupsGlance()
  return (
    <p data-testid="head" data-tone={head.tone ?? ''}>
      {head.value}
    </p>
  )
}

beforeEach(() => {
  state.open.mockClear()
  give([
    entry({
      source: 'vault',
      name: 'Vault',
      target: 'drive',
      ageH: 38,
      state: 'warn',
      meaning: 'Its data is 38 h old.',
    }),
    entry({ target: 'native' }),
    entry({ target: 'drive' }),
    entry({
      source: 'bad',
      name: 'Broken',
      target: 'native',
      state: 'failed',
      meaning: 'The last copy failed.',
    }),
    entry({
      source: 'old',
      name: 'Old tool',
      target: 'native',
      state: 'off',
      gone: true,
    }),
  ])
})
afterEach(() => vi.unstubAllGlobals())

describe('GlanceBackups', () => {
  it('lists every source with its state, the failing one open with its reason', () => {
    view()
    expect(screen.getByText('Broken')).toBeVisible()
    expect(screen.getByText('The last copy failed.')).toBeVisible()
    expect(screen.getByRole('button', { name: /Home/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.getByText('Its data is 38 h old.')).toBeVisible()
    expect(screen.getByText('oldest 38 h, late after 8 h')).toBeVisible()
  })

  it('a failed copy being retried shows one state and no next time', () => {
    give([
      entry({
        source: 'home',
        name: 'Home',
        target: 'drive',
        state: 'failed',
        running: true,
        meaning: 'Failed once.',
      }),
    ])
    view()
    expect(screen.queryByText('Copying…')).toBeNull()
    expect(screen.getByText(/Copying now/)).toBeVisible()
    expect(screen.queryByText(/Next copy:/)).toBeNull()
  })

  it('opens a source to its copies with last good data, next copy and Restore', () => {
    view()
    fireEvent.click(screen.getByRole('button', { name: /Home/ }))
    expect(screen.getAllByText(/Last good data:/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Next copy:/).length).toBeGreaterThan(0)
    const restore = screen.getAllByRole('link', { name: /^Restore Home from/ })
    expect(restore).toHaveLength(2)
    fireEvent.click(restore[0] as HTMLElement)
    expect(state.open).toHaveBeenCalledWith(
      expect.stringContaining('/backups/restore?source=home&target='),
    )
  })

  it('folds archived sources apart until opened', () => {
    view()
    expect(screen.queryByText('Old tool')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Archived \(1\)/ }))
    expect(screen.getByText('Old tool')).toBeVisible()
  })

  it('starts a copy: pending, then the server’s word', async () => {
    let finish: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      ),
    )
    view()
    fireEvent.click(screen.getByRole('button', { name: 'Back up to T7 now' }))
    expect(
      await screen.findByRole('button', { name: 'Starting T7…' }),
    ).toBeDisabled()
    finish(Response.json({ message: 'T7 is copying now.' }))
    expect(await screen.findByText('T7 is copying now.')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Back up to T7 now' }),
    ).toBeEnabled()
  })

  it('says when starting a copy failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ detail: 'Drive is full.' }, { status: 500 }),
      ),
    )
    view()
    fireEvent.click(
      screen.getByRole('button', { name: 'Back up to Drive now' }),
    )
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Drive is full.'),
    )
  })

  it('says unread, failed and empty in different words', () => {
    give(null, { loading: true })
    const first = view()
    expect(screen.getByText('Checking backups…')).toBeVisible()
    first.unmount()
    give(null, { failed: true })
    const second = view()
    expect(screen.getByText('Backups couldn’t be read.')).toBeVisible()
    second.unmount()
    give([])
    view()
    expect(screen.getByText('No backups are registered yet.')).toBeVisible()
  })

  it('says the list is from the last read when it could not refresh', () => {
    give([entry()], { stale: true })
    view()
    expect(screen.getByText(/^As of the last read:/)).toBeVisible()
  })
})

describe('useBackupsGlance', () => {
  it('counts the sources that are late or failed', () => {
    render(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('1 failed · 1 late')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', 'failed')
  })

  it('says all current, and why when not known', () => {
    give([entry()])
    const { rerender } = render(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('All current')
    expect(screen.getByTestId('head')).toHaveAttribute('data-tone', 'ok')
    give(null, { loading: true })
    rerender(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('Checking…')
    give(null, { failed: true })
    rerender(<Head />)
    expect(screen.getByTestId('head')).toHaveTextContent('Couldn’t read')
  })
})
