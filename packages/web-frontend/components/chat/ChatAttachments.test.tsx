import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { uploadCapture } from '@/lib/api/captures'
import { useChatAttachments } from './ChatAttachments'

vi.mock('@/lib/api/captures', async (original) => ({
  ...(await original<typeof import('@/lib/api/captures')>()),
  uploadCapture: vi.fn(),
}))
it('keeps an upload alive when the user returns to the session list', async () => {
  let finish: (value: Awaited<ReturnType<typeof uploadCapture>>) => void =
    () => {}
  let signal: AbortSignal | undefined
  vi.mocked(uploadCapture).mockImplementationOnce((input) => {
    signal = input.signal
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const save = vi.fn()
  const first = renderHook(() =>
    useChatAttachments('upload-navigation-test', [], save),
  )
  act(() =>
    first.result.current.add([
      new File(['photo'], 'photo.png', { type: 'image/png' }),
    ]),
  )
  expect(first.result.current.uploading).toBe(true)
  first.unmount()
  expect(signal?.aborted).toBe(false)
  await act(async () =>
    finish({ id: '000000000002', name: 'photo.png' } as Awaited<
      ReturnType<typeof uploadCapture>
    >),
  )
  expect(save).toHaveBeenLastCalledWith(['000000000002'])
  const returned = renderHook(() =>
    useChatAttachments('upload-navigation-test', [], save),
  )
  expect(returned.result.current.ids).toEqual(['000000000002'])
  expect(returned.result.current.uploading).toBe(false)
  act(() => returned.result.current.clear())
})
