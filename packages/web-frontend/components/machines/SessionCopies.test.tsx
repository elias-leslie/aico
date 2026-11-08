import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CopySession, HeldMachine } from '@/lib/hooks/use-machine-guests'
import type { Machine } from '@/lib/machines'
import { SessionCopies } from './SessionCopies'

const data: { machines: HeldMachine[] | null; failed: boolean } = {
  machines: null,
  failed: false,
}
vi.mock('@/lib/hooks/use-machine-guests', () => ({
  useSessionCopies: () => ({ machines: data.machines, failed: data.failed }),
}))

const machine = { key: 'aico', name: 'Standby' } as Machine
const session = (over: Partial<CopySession> = {}): CopySession => ({
  id: 's1',
  tool: 'claude-code',
  title: 'Fix the sync',
  project: 'aico',
  state: 'working',
  detail: null,
  doing: 'Running the tests',
  waitingOn: null,
  needsYou: false,
  lastActivity: Date.now(),
  lastOwner: { at: 1, text: 'please fix the sync' },
  lastAgent: { at: 2, text: 'tests are running' },
  git: { branch: 'main', head: 'abc', dirty: 2 },
  copy: { bytes: 3 * 1024 * 1024, files: 2, cut: false },
  ...over,
})

describe('SessionCopies', () => {
  beforeEach(() => {
    data.machines = null
    data.failed = false
  })

  it('says it couldn’t read them, instead of showing none', () => {
    data.failed = true
    render(
      <SessionCopies
        machine={{ ...machine, sessionHost: true, here: false } as Machine}
      />,
    )
    expect(screen.getByText('Sessions unknown')).toBeTruthy()
  })

  it('shows nothing until it holds a session of this machine', () => {
    const { container, rerender } = render(<SessionCopies machine={machine} />)
    expect(container.firstChild).toBeNull()
    data.machines = [
      { machine: 'aico', at: Date.now(), sessions: [] },
      { machine: 'other', at: Date.now(), sessions: [session()] },
    ]
    rerender(<SessionCopies machine={machine} />)
    expect(container.firstChild).toBeNull()
  })

  it('lists what was running with badges, the words behind the tap, and no control', () => {
    data.machines = [
      {
        machine: 'aico',
        at: Date.now(),
        sessions: [
          session(),
          session({
            id: 's2',
            title: 'Waits for you',
            needsYou: true,
            state: 'blocked',
            copy: null,
            git: null,
            lastOwner: null,
            lastAgent: null,
          }),
        ],
      },
    ]
    render(<SessionCopies machine={machine} />)
    expect(screen.getByText('Fix the sync')).toBeTruthy()
    expect(screen.getByLabelText('Working')).toBeTruthy()
    expect(screen.getByLabelText('Needs you')).toBeTruthy()
    expect(screen.getByLabelText('Conversation copy here, 3 MB')).toBeTruthy()
    expect(
      screen.getByLabelText('No copy of this conversation here'),
    ).toBeTruthy()
    expect(screen.getByText('please fix the sync')).toBeTruthy()
    expect(screen.getByTitle('2 uncommitted on main')).toBeTruthy()
    // Picking a session up here is Level 2: nothing offers it yet.
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(document.body.textContent).not.toMatch(/terminal/i)
  })
})
