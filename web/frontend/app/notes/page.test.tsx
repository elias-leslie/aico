import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import NotesPage from './page'

vi.mock('@summitflow/notes-ui', () => ({
  NotesProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="notes-provider">{children}</div>
  ),
  NotesPanel: () => <div data-testid="notes-panel" />,
}))

describe('Notes page', () => {
  it('renders the full-page notes workspace without route explainer copy', () => {
    render(<NotesPage />)

    expect(screen.getByTestId('notes-provider')).toBeInTheDocument()
    expect(screen.getByTestId('notes-panel')).toBeInTheDocument()
    expect(
      screen.queryByText(/Notes stay local in standalone installs/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/A-Term Notes/i)).not.toBeInTheDocument()
  })
})
