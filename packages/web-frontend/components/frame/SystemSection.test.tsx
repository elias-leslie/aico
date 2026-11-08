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
    heads.backups = { value: '1 late', tone: 'late', needs: 1 }
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
    heads.status = {
      value: '2 problems',
      tone: 'failed',
      problems: 2,
      needs: 2,
    }
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

  it('stays shut for warnings: a muted "4 problems" chip, not an amber problem', () => {
    heads.status = { value: '4 problems', tone: 'off', problems: 4, needs: 0 }
    render(<SystemSection />)
    const row = screen.getByRole('button', { name: /^System/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveTextContent('4 problems')
    expect(row).not.toHaveTextContent('All OK')
    expect(row.querySelector('.status-chip.off')).not.toBeNull()
    expect(row.querySelector('.status-chip.warn')).toBeNull()
    expect(screen.getByTestId('system-section')).toHaveAttribute(
      'data-worst',
      'ok',
    )
  })

  it('stays shut for a failure or a down machine that does not need the owner, and for an unreadable section', () => {
    heads.status = {
      value: '2 problems',
      tone: 'failed',
      problems: 2,
      needs: 0,
    }
    heads.machines = { value: '3 of 8 up', tone: 'warn', needs: 0 }
    heads.routines = { value: 'Couldn’t read', tone: 'unknown' }
    render(<SystemSection />)
    expect(screen.getByRole('button', { name: /^System/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('says the same on its line as the Status row does', () => {
    heads.status = { value: '4 problems', tone: 'off', problems: 4, needs: 0 }
    render(<SystemSection />)
    fireEvent.click(screen.getByRole('button', { name: /^System/ }))
    const statusRow = screen.getByRole('button', { name: /^Status/ })
    expect(statusRow).toHaveTextContent('4 problems')
    expect(screen.getByRole('button', { name: /^System/ })).toHaveTextContent(
      '4 problems',
    )
  })

  it('opens for a backup out of date or a machine down, and stays shut once the owner shuts it', () => {
    heads.machines = { value: '3 of 8 up', tone: 'warn', needs: 1 }
    const first = render(<SystemSection />)
    const row = () => screen.getByRole('button', { name: /^System/ })
    expect(row()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(row())
    expect(row()).toHaveAttribute('aria-expanded', 'false')
    // The same state, on a later render and on a reload: still shut.
    first.rerender(<SystemSection />)
    expect(row()).toHaveAttribute('aria-expanded', 'false')
    first.unmount()
    render(<SystemSection />)
    expect(row()).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens again when more needs the owner, and when a need returns after it was gone', () => {
    heads.backups = { value: '1 late', tone: 'late', needs: 1 }
    const view = render(<SystemSection />)
    const row = () => screen.getByRole('button', { name: /^System/ })
    fireEvent.click(row())
    expect(row()).toHaveAttribute('aria-expanded', 'false')
    heads.backups = { value: '2 late', tone: 'late', needs: 2 }
    view.rerender(<SystemSection />)
    expect(row()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(row())
    expect(row()).toHaveAttribute('aria-expanded', 'false')
    // Resolved: forgotten. The same need later is new.
    heads.backups = { value: 'All current', tone: 'ok' }
    view.rerender(<SystemSection />)
    heads.backups = { value: '1 late', tone: 'late', needs: 1 }
    view.rerender(<SystemSection />)
    expect(row()).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps a need that cannot be read right now from reopening it later', () => {
    heads.backups = { value: '1 late', tone: 'late', needs: 1 }
    const view = render(<SystemSection />)
    const row = () => screen.getByRole('button', { name: /^System/ })
    fireEvent.click(row())
    heads.backups = { value: 'Couldn’t read', tone: 'failed' }
    view.rerender(<SystemSection />)
    heads.backups = { value: '1 late', tone: 'late', needs: 1 }
    view.rerender(<SystemSection />)
    expect(row()).toHaveAttribute('aria-expanded', 'false')
  })
})
