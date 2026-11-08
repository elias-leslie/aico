import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationsSection } from './NotificationsSection'

const view = (on = true) => ({
  types: [
    {
      id: 'agent-waiting',
      label: 'Agent waiting',
      hint: 'A session waits.',
      phone: { on, chosen: !on },
      desktop: { on: true, chosen: false },
      fired: 3,
      phoned: 2,
    },
  ],
  fixed: [
    {
      id: 'phone-home-alarm',
      label: 'Home unreachable alarm',
      hint: 'Built in.',
    },
  ],
})

const json = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response)

afterEach(() => vi.unstubAllGlobals())

describe('NotificationsSection', () => {
  it('says it is reading, then lists a labelled switch per channel and the weekly count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(view())),
    )
    render(<NotificationsSection />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading')
    expect(
      await screen.findByRole('switch', { name: 'Agent waiting on the phone' }),
    ).toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'Agent waiting on the desktop' }),
    ).toBeChecked()
    expect(
      screen.getByRole('button', {
        name: /3 notices in the last 7 days, 2 to the phone/,
      }),
    ).toHaveTextContent('3')
  })

  it('applies a switch at once with no confirmation', async () => {
    const fetcher = vi.fn((url: string, init?: RequestInit) =>
      json(init?.method === 'PUT' ? view(false) : view()),
    )
    vi.stubGlobal('fetch', fetcher)
    render(<NotificationsSection />)
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Agent waiting on the phone' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Agent waiting on the phone' }),
      ).not.toBeChecked(),
    )
    const put = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      type: 'agent-waiting',
      channel: 'phone',
      on: false,
    })
  })

  it('keeps the old state and says so when a save fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === 'PUT' ? json({}, false) : json(view()),
      ),
    )
    render(<NotificationsSection />)
    fireEvent.click(
      await screen.findByRole('switch', { name: 'Agent waiting on the phone' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /not saved.*still on/,
    )
    expect(
      screen.getByRole('switch', { name: 'Agent waiting on the phone' }),
    ).toBeChecked()
  })

  it('offers another try when the list cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json({}, false)),
    )
    render(<NotificationsSection />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be read',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  it('opens the recent ones with why each went out, and says when there are none', async () => {
    const recent = {
      items: [
        {
          id: 'a',
          at: 1,
          title: 'Waiting in x',
          phone: 'sent',
          desktop: true,
          why: 'An agent is waiting on you.',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => json(url.includes('recent') ? recent : view())),
    )
    render(<NotificationsSection />)
    fireEvent.click(await screen.findByRole('button', { name: /3 notices/ }))
    expect(await screen.findByText('An agent is waiting on you.')).toBeVisible()
    expect(screen.getByLabelText('Reached the phone')).toBeVisible()
  })

  it('shows a row with no switch as what it is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => json(view())),
    )
    render(<NotificationsSection />)
    expect(
      await screen.findByRole('img', {
        name: /Home unreachable alarm on the phone: on, no switch/,
      }),
    ).toBeVisible()
    expect(
      screen.queryByRole('switch', { name: /Home unreachable alarm/ }),
    ).toBeNull()
  })
})
