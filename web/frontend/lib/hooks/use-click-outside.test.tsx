import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useClickOutside } from './use-click-outside'

function TestHarness({
  onOutside,
}: {
  onOutside: () => void
}) {
  const insideRef = useRef<HTMLDivElement>(null)
  useClickOutside([insideRef], onOutside, true)

  return (
    <>
      <div ref={insideRef} data-testid="inside">
        inside
      </div>
      <div
        data-testid="outside"
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
      >
        outside
      </div>
    </>
  )
}

describe('useClickOutside', () => {
  it('ignores pointer events inside the referenced element', () => {
    const onOutside = vi.fn()

    render(<TestHarness onOutside={onOutside} />)

    fireEvent.pointerDown(screen.getByTestId('inside'))

    expect(onOutside).not.toHaveBeenCalled()
  })

  it('handles outside pointer events even when bubbling is stopped', () => {
    const onOutside = vi.fn()

    render(<TestHarness onOutside={onOutside} />)

    fireEvent.pointerDown(screen.getByTestId('outside'))

    expect(onOutside).toHaveBeenCalledTimes(1)
  })
})
