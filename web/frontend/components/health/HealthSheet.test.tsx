import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NightshiftViewResult } from '@/lib/health'
import { view } from '@/test-stubs/health-view'
import { HealthLauncher } from './HealthButton'
import { HealthSheet } from './HealthSheet'

const health = vi.hoisted(() => ({
  result: undefined as NightshiftViewResult | undefined,
  isLoading: false,
  isError: false,
  refetch: () => {},
}))
vi.mock('@/lib/hooks/use-health', () => ({ useHealth: () => health }))
vi.mock('@/lib/hooks/use-media-query', () => ({ useMediaQuery: () => false }))

const tile = (
  id: string,
  state: 'ok' | 'note' | 'warn' | 'unkn',
  summary: string,
) => ({
  id,
  label: id,
  state,
  summary,
  age: 1_468_800,
  checked: 240,
  link: '',
})

describe('HealthSheet', () => {
  beforeEach(() => {
    health.result = undefined
    health.isError = false
  })

  it('shows tiles, who handles each problem and links out for decisions', () => {
    health.result = {
      available: true,
      view: view({
        tiles: [
          tile('disk', 'ok', 'System disk: 54% used'),
          tile('pve', 'warn', 'Guests: 2 down'),
          tile('backups', 'note', 'Backups verified'),
        ],
        findings: [
          {
            id: 'row-pve-guests',
            host: 'pve',
            host_label: 'PVE lab host',
            check: 'Guests',
            state: 'warn',
            summary: '2 guests not running',
            who: 'You',
            owner: true,
            next: '',
            age: 1_468_800,
            checked: 240,
            calls: 1,
            link: 'https://ns.example/#needs-you',
          },
        ],
        needs_you: 1,
        approvals: [
          {
            id: 'a',
            title: 'GitHub admin for 30 min',
            url: 'https://ap.example/e/a',
            left: 600,
          },
        ],
      }),
    }
    render(<HealthSheet open onOpenChange={() => {}} />)
    expect(screen.getByTestId('health-tile-disk')).toHaveAttribute(
      'data-state',
      'ok',
    )
    expect(
      screen.getByText('Nightshift has 1 call waiting for you.'),
    ).toBeInTheDocument()
    // How old the data is, apart from how long the problem has been open.
    expect(screen.getByTestId('health-tile-pve')).toHaveTextContent(
      'checked 4 min ago · open 17 days',
    )
    expect(screen.getByTestId('health-tile-disk')).toHaveTextContent(
      'checked 4 min ago',
    )
    // OK and Note tiles show only when they were checked: nothing is open.
    for (const id of ['disk', 'backups'])
      expect(screen.getByTestId(`health-tile-${id}`)).not.toHaveTextContent(
        'open',
      )
    const problem = screen.getByTestId('health-finding')
    expect(problem).toHaveTextContent(
      'PVE lab host · Guests · checked 4 min ago · open 17 days',
    )
    expect(within(problem).getByText(/your call/)).toBeInTheDocument()
    expect(
      within(problem).getByRole('link', { name: /Answer in Nightshift/ }),
    ).toHaveAttribute('href', 'https://ns.example/#needs-you')
    expect(
      within(screen.getByTestId('health-approval')).getByRole('link', {
        name: /security key/,
      }),
    ).toHaveAttribute('href', 'https://ap.example/e/a')
    // Read-only: nothing here answers or approves.
    expect(
      screen.queryByRole('button', { name: /expected|approve/i }),
    ).toBeNull()
  })

  it('shows every tile as unknown when Nightshift is not answering', () => {
    health.result = { available: false, reason: 'not_answering' }
    render(<HealthSheet open onOpenChange={() => {}} />)
    expect(screen.getByTestId('health-unknown')).toHaveTextContent(
      'Nightshift isn’t answering',
    )
    for (const id of ['disk', 'backups', 'services', 'pve'])
      expect(screen.getByTestId(`health-tile-${id}`)).toHaveAttribute(
        'data-state',
        'unkn',
      )
    expect(screen.queryByText(/No problems/)).toBeNull()
  })
})

describe('HealthLauncher', () => {
  it('names the state for screen readers', () => {
    health.result = { available: false, reason: 'not_answering' }
    render(<HealthLauncher variant="icon" />)
    expect(
      screen.getByRole('button', { name: /Nightshift isn’t answering/ }),
    ).toBeInTheDocument()
  })
})
