import { fireEvent, render, screen } from '@testing-library/react'
import type { HTMLAttributes } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ResizeSeparator } from './ResizeSeparator'

vi.mock('react-resizable-panels', () => ({
  Separator: ({
    className,
    onDoubleClick,
    onPointerDown,
    onPointerLeave,
    onPointerUp,
  }: HTMLAttributes<HTMLDivElement>) => (
    <div
      role="separator"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={50}
      tabIndex={0}
      data-testid="separator"
      className={className}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
    />
  ),
}))

describe('ResizeSeparator', () => {
  it('clears pointer-acquired focus after pointer release', () => {
    const groupRef = {
      current: {
        getLayout: () => ({ left: 50, right: 50 }),
        setLayout: vi.fn(),
      },
    }

    render(
      <ResizeSeparator
        orientation="horizontal"
        groupRef={groupRef}
        adjacentPanelIds={['left', 'right']}
      />,
    )

    const separator = screen.getByTestId('separator')
    separator.focus()

    fireEvent.pointerDown(separator)
    fireEvent.pointerUp(separator)

    expect(separator).not.toHaveFocus()
  })

  it('resets adjacent panes to equal sizes on double-click', () => {
    const setLayout = vi.fn()
    const groupRef = {
      current: {
        getLayout: () => ({ left: 30, right: 70 }),
        setLayout,
      },
    }

    render(
      <ResizeSeparator
        orientation="horizontal"
        groupRef={groupRef}
        adjacentPanelIds={['left', 'right']}
      />,
    )

    fireEvent.doubleClick(screen.getByTestId('separator'))

    expect(setLayout).toHaveBeenCalledWith({ left: 50, right: 50 })
  })
})
