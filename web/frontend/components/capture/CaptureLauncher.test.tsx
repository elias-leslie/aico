import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addCaptureFiles, resetCaptureQueue } from '@/lib/capture-queue'
import { CaptureLauncher } from './CaptureLauncher'

vi.mock('./CaptureSheet', () => ({
  CaptureSheet: () => <div data-testid="capture-sheet-stub" />,
}))

afterEach(() => resetCaptureQueue())

describe('CaptureLauncher', () => {
  it.each(['icon', 'row'] as const)(
    'opens the sheet from the %s button',
    (variant) => {
      render(<CaptureLauncher variant={variant} />)
      expect(screen.queryByTestId('capture-sheet-stub')).toBeNull()
      fireEvent.click(screen.getByTestId('capture-btn'))
      expect(screen.getByTestId('capture-sheet-stub')).toBeInTheDocument()
    },
  )

  it('counts files still waiting, so a closed sheet does not hide a draft', () => {
    render(<CaptureLauncher />)
    expect(
      screen.getByTestId('capture-btn').getAttribute('aria-label'),
    ).not.toMatch(/waiting/)
    act(() =>
      addCaptureFiles([new File(['x'], 'a.jpg', { type: 'image/jpeg' })]),
    )
    expect(
      screen.getByTestId('capture-btn').getAttribute('aria-label'),
    ).toMatch(/1 waiting/)
  })

  it('is never mounted inside a session view', () => {
    const root = join(__dirname, '..')
    for (const file of [
      'Terminal.tsx',
      'TerminalContent.tsx',
      'TerminalTabs.tsx',
    ]) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain(
        'CaptureLauncher',
      )
    }
    for (const file of [
      'terminal-content/TerminalFileSection.tsx',
      'terminal-content/TerminalMobileSection.tsx',
    ]) {
      expect(readFileSync(join(root, file), 'utf8')).not.toContain(
        'CaptureLauncher',
      )
    }
  })
})
