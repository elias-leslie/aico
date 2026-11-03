import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneOverflowMenu } from './PaneOverflowMenu'

const checkIns = vi.hoisted(() => ({
  menu: {} as Record<string, unknown>,
  set: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/lib/hooks/use-check-ins', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/hooks/use-check-ins')>()),
  useCheckInMenu: () => checkIns.menu,
  useCheckInActions: () => ({
    set: { mutate: checkIns.set, isPending: false, error: null },
    cancel: { mutate: checkIns.cancel, isPending: false, error: null },
  }),
}))

describe('PaneOverflowMenu', () => {
  it('lists the session actions with End session last', () => {
    render(
      <PaneOverflowMenu
        onCloseSession={vi.fn()}
        onRename={vi.fn()}
        onRefresh={vi.fn()}
        onReset={vi.fn()}
        onUpload={vi.fn()}
        fontSize={14}
        onFontSizeChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))

    expect(
      screen.getAllByRole('menuitem').map((item) => item.textContent),
    ).toEqual([
      'Upload a file',
      'Rename',
      'Reset session',
      'Redraw',
      'End session',
    ])
    expect(screen.getByRole('group', { name: 'Text size' })).toHaveTextContent(
      '14',
    )
    expect(
      screen
        .getByRole('menuitem', { name: 'End session' })
        .getAttribute('title'),
    ).toBe('End session: stop its process everywhere it is open.')
  })

  it('invokes the selected action and closes the menu', () => {
    const onUpload = vi.fn()

    render(<PaneOverflowMenu onUpload={onUpload} />)

    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Upload a file' }))

    expect(onUpload).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('steps the text size and stops at the ends', () => {
    const onFontSizeChange = vi.fn()
    const { rerender } = render(
      <PaneOverflowMenu fontSize={14} onFontSizeChange={onFontSizeChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Larger text' }))
    expect(onFontSizeChange).toHaveBeenLastCalledWith(15)
    fireEvent.click(screen.getByRole('button', { name: 'Smaller text' }))
    expect(onFontSizeChange).toHaveBeenLastCalledWith(13)

    rerender(
      <PaneOverflowMenu fontSize={10} onFontSizeChange={onFontSizeChange} />,
    )
    expect(screen.getByRole('button', { name: 'Smaller text' })).toBeDisabled()
    // The menu stays open while the size changes.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  describe('Check in later', () => {
    const ready = {
      isPending: false,
      isError: false,
      data: {
        status: 'ready',
        choices: [
          { label: 'In 1 hour', time: '6:30 PM', dueAt: 111 },
          { label: 'Tonight', time: '9:00 PM', dueAt: 222 },
          { label: 'Tomorrow morning', time: 'Tue 8:00 AM', dueAt: 333 },
        ],
        pending: [
          { id: 'aaaaaaaaaaaa', time: '5:30 PM', dueAt: 4_102_444_800_000 },
        ],
      },
    }
    const open = () => {
      render(<PaneOverflowMenu checkInSessionId="s1" onUpload={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Check in later' }))
    }

    beforeEach(() => {
      checkIns.set.mockReset()
      checkIns.cancel.mockReset()
      checkIns.menu = ready
    })

    it('is offered only for a session that can have one', () => {
      render(<PaneOverflowMenu onUpload={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Session menu' }))
      expect(
        screen.queryByRole('menuitem', { name: 'Check in later' }),
      ).not.toBeInTheDocument()
    })

    it('lists the quick times with when they land', () => {
      open()
      expect(
        screen.getAllByRole('menuitem').map((item) => item.textContent),
      ).toEqual([
        'In 1 hour6:30 PM',
        'Tonight9:00 PM',
        'Tomorrow morningTue 8:00 AM',
      ])
    })

    it('sets a quick time and closes the menu', () => {
      checkIns.set.mockImplementation((_at, options) => options.onSuccess())
      open()
      fireEvent.click(screen.getByRole('menuitem', { name: /Tonight/ }))
      expect(checkIns.set).toHaveBeenCalledWith(222, expect.anything())
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('sets a time of its own from the picker', () => {
      open()
      const set = screen.getByRole('button', { name: 'Set' })
      expect(set).toBeDisabled()
      fireEvent.change(screen.getByLabelText('Pick a time'), {
        target: { value: '2030-01-02T17:30' },
      })
      fireEvent.click(set)
      expect(checkIns.set).toHaveBeenCalledWith(
        new Date('2030-01-02T17:30').getTime(),
        expect.anything(),
      )
    })

    it('cancels a pending check-in', () => {
      open()
      fireEvent.click(
        screen.getByRole('button', { name: 'Cancel check-in at 5:30 PM' }),
      )
      expect(checkIns.cancel).toHaveBeenCalledWith('aaaaaaaaaaaa')
    })

    it('says plainly when the session cannot take one', () => {
      checkIns.menu = {
        isPending: false,
        isError: false,
        data: { status: 'unsupported', choices: [], pending: [] },
      }
      open()
      expect(
        screen.getByText(/Aico can't tell when this session is idle/),
      ).toBeInTheDocument()
      expect(screen.queryByLabelText('Pick a time')).not.toBeInTheDocument()
    })

    it('says so when the times do not load, and goes back to the menu', () => {
      checkIns.menu = {
        isPending: false,
        isError: true,
        error: new Error('Tether is not reachable'),
      }
      open()
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Tether is not reachable',
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Back to the session menu' }),
      )
      expect(
        screen.getByRole('menuitem', { name: 'Check in later' }),
      ).toBeInTheDocument()
    })
  })
})
