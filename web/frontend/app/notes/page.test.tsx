import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NotesPage from './page'

const mockFetchNotesStatus = vi.fn()

vi.mock('@summitflow/notes-ui', () => ({
  NotesProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="notes-provider">{children}</div>
  ),
  NotesPanel: () => <div data-testid="notes-panel" />,
}))

vi.mock('@/lib/api/notes-status', () => ({
  fetchNotesStatus: () => mockFetchNotesStatus(),
}))

describe('Notes page', () => {
  afterEach(() => {
    vi.resetAllMocks()
  })

  it('explains standalone A-Term notes mode explicitly', async () => {
    mockFetchNotesStatus.mockResolvedValue({
      storage_mode: 'standalone',
      project_catalog_source: 'local',
    })

    render(<NotesPage />)

    await waitFor(() => {
      expect(
        screen.getByText(/A-Term owns the notes and prompt storage in this mode/i),
      ).toBeInTheDocument()
    })

    expect(
      screen.getByText(/Scope options come from A-Term's own project registry/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Prompt refinement stays off in standalone mode/i),
    ).toBeInTheDocument()
    expect(screen.getByTestId('notes-panel')).toBeInTheDocument()
  })

  it('explains companion-backed shared notes mode explicitly', async () => {
    mockFetchNotesStatus.mockResolvedValue({
      storage_mode: 'companion',
      project_catalog_source: 'companion',
    })

    render(<NotesPage />)

    await waitFor(() => {
      expect(
        screen.getByText(/SummitFlow now owns the shared notes and prompt library/i),
      ).toBeInTheDocument()
    })

    expect(
      screen.getByText(/Scope options come from the companion project catalog/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Shared prompts can span projects/i),
    ).toBeInTheDocument()
  })
})
