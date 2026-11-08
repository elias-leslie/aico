import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlanceHead } from './glance/glance-types'
import { SystemSection } from './SystemSection'

const heads = vi.hoisted(
  () => ({}) as Record<string, GlanceHead & { problems?: number | null }>,
)
vi.mock('./glance/GlanceStatus', () => ({
  useStatusGlance: () => heads.status,
  GlanceStatus: () => <p>status body</p>,
}))
vi.mock('./glance/GlanceBackups', () => ({
  useBackupsGlance: () => heads.backups,
  GlanceBackups: () => <p>backups body</p>,
}))
vi.mock('./glance/GlanceMachines', () => ({
  useMachinesGlance: () => heads.machines,
  GlanceMachines: () => <p>machines body</p>,
}))
vi.mock('../routines/Routines', () => ({
  useRoutinesHead: () => heads.routines,
  RoutinesBody: () => <p>routines body</p>,
}))

beforeEach(() => {
  localStorage.clear()
  heads.status = { value: 'All healthy', tone: 'ok', problems: 0 }
  heads.backups = { value: 'All good', tone: 'ok' }
  heads.machines = { value: '4 of 8 up', tone: null }
  heads.routines = { value: '12 · all ran', tone: 'ok' }
})

describe('SystemSection', () => {
  it('is one line when all is well, closed', () => {
    render(<SystemSection />)
    const row = screen.getByRole('button', { name: /^System/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveTextContent('All OK')
    expect(row).toHaveTextContent('4 of 8 machines up')
    expect(screen.queryByText('status body')).toBeNull()
  })

  it('opens on a click to Status, Backups, Machines and Routines', () => {
    render(<SystemSection />)
    fireEvent.click(screen.getByRole('button', { name: /^System/ }))
    for (const name of ['Status', 'Backups', 'Machines', 'Routines'])
      expect(
        screen.getByRole('button', { name: new RegExp(`^${name}`) }),
      ).toBeVisible()
  })

  it('opens by itself and wears the problems as chips on the line', () => {
    heads.backups = { value: '1 late', tone: 'late' }
    heads.machines = { value: '3 of 8 up', tone: 'warn' }
    render(<SystemSection />)
    const row = screen.getByRole('button', { name: /^System/ })
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(row).toHaveTextContent('Backups 1 late')
    expect(row).toHaveTextContent('3 of 8 machines up')
    expect(row).not.toHaveTextContent('All OK')
    expect(screen.getByTestId('system-section')).toHaveAttribute(
      'data-worst',
      'warn',
    )
  })

  it('can be shut while a problem stands, and the chips stay on the line', () => {
    heads.status = { value: '2 problems', tone: 'failed', problems: 2 }
    render(<SystemSection />)
    const row = screen.getByRole('button', { name: /^System/ })
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveTextContent('2 problems')
    expect(screen.getByTestId('system-section')).toHaveAttribute(
      'data-worst',
      'failed',
    )
  })

  it('says Checking while something is still being read, never All OK', () => {
    heads.machines = { value: 'Checking…', tone: null }
    render(<SystemSection />)
    const row = screen.getByRole('button', { name: /^System/ })
    expect(row).toHaveTextContent('Checking…')
    expect(row).not.toHaveTextContent('All OK')
  })

  it('says a section it could not read', () => {
    heads.machines = { value: 'Couldn’t read', tone: 'unknown' }
    render(<SystemSection />)
    expect(screen.getByRole('button', { name: /^System/ })).toHaveTextContent(
      'Machines unreadable',
    )
  })
})
