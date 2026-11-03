import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setFilesOpener } from '@/lib/files-opener'
import { AgentShowToast } from './AgentShowToast'

const metadata = {
  id: 'ab12cd34ef56',
  session: 'ab12cd34',
  title: 'Report',
  createdAt: '2026-10-27T10:00:00.000Z',
}
const files = {
  ...metadata,
  kind: 'files' as const,
  paths: ['/srv/out/report.pdf'],
}

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
)

afterEach(() => {
  cleanup()
  setFilesOpener(null)
  vi.restoreAllMocks()
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard)
  } else {
    Reflect.deleteProperty(navigator, 'clipboard')
  }
})

describe('AgentShowToast', () => {
  it('names the session that shared it', () => {
    render(
      <AgentShowToast
        show={files}
        onDismiss={vi.fn()}
        sessionName="uilint — web look"
      />,
    )
    expect(screen.getByText('Shared by uilint — web look')).toBeVisible()
    expect(screen.getByText('Report')).toBeVisible()
    expect(screen.getByText('report.pdf')).toBeVisible()
  })

  it('opens the share in Files, and says how many files it holds', () => {
    const dismiss = vi.fn()
    const opened = vi.fn()
    setFilesOpener(opened)
    render(
      <AgentShowToast
        show={{
          ...files,
          title: '<script>literal</script>',
          paths: [...files.paths, '/srv/out/notes'],
        }}
        onDismiss={dismiss}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared by an agent<script>literal</script>report.pdf and 1 more',
    )
    expect(document.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(opened).toHaveBeenCalledWith({ kind: 'shared', showId: metadata.id })
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('opens the first file by itself when no session is open', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<AgentShowToast show={files} onDismiss={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledWith(
      '/api/files/raw?root=%2Fsrv%2Fout&path=report.pdf',
      '_blank',
      'noopener',
    )
  })

  it('can be dismissed', () => {
    const dismiss = vi.fn()
    render(<AgentShowToast show={files} onDismiss={dismiss} />)
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
        show={{ ...metadata, kind: 'url', url }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByText(url)).toBeVisible()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible()
    expect(writeText).toHaveBeenCalledWith(url)
    expect(open).not.toHaveBeenCalled()
  })

  it('falls back to the link and reports a failed copy', async () => {
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
          url: 'https://agent.example',
        }}
        onDismiss={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'Shared by an agenthttps://agent.example',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(
      await screen.findByRole('button', { name: 'Couldn’t copy' }),
    ).toBeVisible()
  })
})
