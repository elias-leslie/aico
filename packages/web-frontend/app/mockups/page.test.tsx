import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MockupsPage from './page'

const nav = vi.hoisted(() => ({ params: new URLSearchParams('project=aico') }))
vi.mock('next/navigation', () => ({ useSearchParams: () => nav.params }))
vi.mock('@/components/ReadOnly', () => ({
  OfflineBanner: () => null,
  ReadOnlyScope: ({ children }: { children: React.ReactNode }) => children,
}))

const item = {
  id: '0123456789ab',
  project: 'aico',
  title: 'Compact layout',
  note: 'Initial note',
  session: '0123abcd',
  askId: 'abcdef012345',
  createdAt: '2026-11-04T10:00:00Z',
  selectedAt: null,
  state: 'pending',
  htmlUrl: '/api/mockups/0123456789ab/html?project=aico',
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })

beforeEach(() => {
  nav.params = new URLSearchParams('project=aico')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('project mockups page', () => {
  it('keeps loading, failed and empty states distinct, with a retry', async () => {
    let answer: (value: Response) => void = () => {}
    const fetch = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          answer = resolve
        }),
      )
      .mockResolvedValueOnce(json({ items: [] }))
    vi.stubGlobal('fetch', fetch)
    render(<MockupsPage />)
    expect(screen.getByRole('status').textContent).toBe('Loading mockups…')
    answer(json({ detail: 'Mockups are unavailable' }, 503))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Mockups are unavailable',
    )
    expect(screen.queryByText('No mockups for this project yet.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(
      await screen.findByText('No mockups for this project yet.'),
    ).toBeTruthy()
  })

  it('saves the note separately and sends the current note with the choice', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [item] }))
      .mockResolvedValueOnce(json({ mockup: { ...item, note: 'Saved note' } }))
      .mockResolvedValueOnce(
        json({
          mockup: {
            ...item,
            note: 'Ship this spacing',
            state: 'selected',
            selectedAt: '2026-11-04T11:00:00Z',
          },
        }),
      )
    vi.stubGlobal('fetch', fetch)
    render(<MockupsPage />)
    const note = await screen.findByRole('textbox', {
      name: 'Note for Compact layout',
    })
    const frame = screen.getByTitle('Preview: Compact layout')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe(item.htmlUrl)
    expect(frame.hasAttribute('srcdoc')).toBe(false)
    fireEvent.change(note, { target: { value: 'Saved note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect(await screen.findByText('Note saved.')).toBeTruthy()
    expect(fetch.mock.calls[1][1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ note: 'Saved note' }),
    })
    fireEvent.change(note, { target: { value: 'Ship this spacing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use this one' }))
    expect(await screen.findByText('Choice saved.')).toBeTruthy()
    expect(fetch.mock.calls[2]).toEqual([
      '/api/mockups/0123456789ab/select?project=aico',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ note: 'Ship this spacing' }),
      }),
    ])
    expect(screen.getByText('Selected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use this one' })).toBeNull()
  })

  it('keeps an unsuccessful choice available and names the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ items: [item] }))
        .mockResolvedValueOnce(
          json({ detail: 'The session is unavailable' }, 503),
        ),
    )
    render(<MockupsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use this one' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The session is unavailable',
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Use this one' }),
      ).not.toBeDisabled(),
    )
    expect(screen.getByText('Pending')).toBeTruthy()
  })
})
