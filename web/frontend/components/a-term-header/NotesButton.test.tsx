import { NotesButton, NotesProvider } from '@summitflow/notes-ui'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTES_PROJECT_SCOPE } from '@/lib/notes-config'

describe('NotesButton', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stays visible when background notes requests fail', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchSpy)

    render(
      <NotesProvider
        apiPrefix="/api"
        projectScope={DEFAULT_NOTES_PROJECT_SCOPE}
      >
        <NotesButton popOutUrl="/notes" />
      </NotesProvider>,
    )

    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument()

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    expect(screen.getByRole('button', { name: 'Notes' })).toBeInTheDocument()
  })
})
