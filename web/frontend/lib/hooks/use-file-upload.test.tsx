import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fileTooLargeMessage,
  UPLOAD_LIMITS_QUERY_KEY,
  useFileUpload,
} from './use-file-upload'

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function fileOfSize(bytes: number): File {
  const file = new File(['x'], 'big.png', { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: bytes })
  return file
}

describe('useFileUpload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("refuses a file over the server's limit before sending it", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ max_bytes: 2 * 1024 * 1024 })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const xhrOpen = vi.fn()
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        upload = { addEventListener: vi.fn() }
        addEventListener = vi.fn()
        open = xhrOpen
        send = vi.fn()
        abort = vi.fn()
      },
    )
    const { result } = renderHook(() => useFileUpload(), { wrapper })
    await waitFor(() =>
      expect(client.getQueryData(UPLOAD_LIMITS_QUERY_KEY)).toBeDefined(),
    )

    let outcome: unknown
    await act(async () => {
      outcome = await result.current.uploadFile(fileOfSize(3 * 1024 * 1024))
    })
    expect(outcome).toBeNull()
    expect(result.current.error?.message).toBe(
      'File too large (3MB). Maximum size: 2MB',
    )
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/files/limits')
    expect(xhrOpen).not.toHaveBeenCalled()
  })

  it('words the refusal like the server does', () => {
    expect(fileTooLargeMessage(12.34 * 1024 * 1024, 10 * 1024 * 1024)).toBe(
      'File too large (12.3MB). Maximum size: 10MB',
    )
  })

  it('names the session the file is for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ max_bytes: 2 * 1024 * 1024 })),
      ),
    )
    const xhrOpen = vi.fn()
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        upload = { addEventListener: vi.fn() }
        addEventListener = vi.fn()
        open = xhrOpen
        send = vi.fn()
        abort = vi.fn()
      },
    )
    const { result } = renderHook(() => useFileUpload(), { wrapper })
    await act(async () => {
      void result.current.uploadFile(fileOfSize(1), 'abc 1')
    })
    await act(async () => {
      void result.current.uploadFile(fileOfSize(1))
    })
    expect(xhrOpen.mock.calls).toEqual([
      ['POST', '/api/files?session_id=abc%201'],
      ['POST', '/api/files'],
    ])
  })
})
