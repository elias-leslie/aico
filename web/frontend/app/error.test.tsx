import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ErrorPage from './error'

describe('global error page', () => {
  it('shows a generic user-safe error message and keeps the digest reference', () => {
    const reset = vi.fn()

    render(
      <ErrorPage
        error={Object.assign(new Error('Database stack trace: password=secret'), {
          digest: 'digest-123',
        })}
        reset={reset}
      />,
    )

    expect(
      screen.getByText(/An unexpected error interrupted A-Term/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Database stack trace: password=secret/i),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Reference: digest-123/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Reload A-Term/i }))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
