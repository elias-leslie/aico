import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentShowToast } from './AgentShowToast'

const metadata = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Report',
  name: 'ab12cd34/out/report.pdf',
}

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
})

describe('AgentShowToast', () => {
  it('opens only the authenticated file route and supports dismissal', () => {
    const dismiss = vi.fn()
    render(
      <AgentShowToast
        show={{ ...metadata, kind: 'file', title: '<script>literal</script>' }}
        onDismiss={dismiss}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Agent shared: <script>literal</script>',
    )
    expect(document.querySelector('script')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `/api/a-term/shows/${metadata.id}/file`,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss shared item' }))
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('shows URL text and copies it without creating a link or opening a window', async () => {
    const url = 'https://agent.example/report?value=1&other=2'
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    render(
      <AgentShowToast
        show={{ ...metadata, kind: 'url', name: url, url }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(url)).toBeVisible()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
    expect(writeText).toHaveBeenCalledWith(url)
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to the name and reports a failed copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    render(
      <AgentShowToast
        show={{
          ...metadata,
          title: null,
          kind: 'url',
          name: 'https://agent.example',
          url: 'https://agent.example',
        }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Agent shared: https://agent.example',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(
      await screen.findByRole('button', { name: 'Copy failed' }),
    ).toBeVisible()
  })
})
