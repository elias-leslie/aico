import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ATermHandle } from '@/components/ATerm'
import { useATermActionHandlers } from './use-a-term-action-handlers'

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  clearError: vi.fn(),
}))

vi.mock('@/lib/hooks/use-file-upload', () => ({
  useFileUpload: () => ({
    uploadFile: mocks.uploadFile,
    progress: 0,
    isUploading: false,
    error: null,
    clearError: mocks.clearError,
  }),
}))

describe('useATermActionHandlers', () => {
  beforeEach(() => {
    mocks.uploadFile.mockReset()
    mocks.clearError.mockReset()
  })

  it('pastes uploaded file paths into the pane that triggered upload', async () => {
    const nativePasteInput = vi.fn()
    const externalPasteInput = vi.fn()
    const aTermRefs = {
      current: new Map<string, ATermHandle | null>([
        [
          'native-session',
          {
            pasteInput: nativePasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as ATermHandle,
        ],
        [
          'external-session',
          {
            pasteInput: externalPasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as ATermHandle,
        ],
      ]),
    }

    mocks.uploadFile.mockResolvedValue({
      path: '/tmp/uploaded.txt',
      filename: 'uploaded.txt',
      size: 32,
      mime_type: 'text/plain',
    })

    const { result } = renderHook(() =>
      useATermActionHandlers({
        aTermRefs,
        activeSessionId: 'native-session',
        showCleaner: false,
        setShowCleaner: vi.fn(),
        setCleanerRawPrompt: vi.fn(),
        setShowVoice: vi.fn(),
        voiceStartListening: vi.fn(),
        voiceStopListening: vi.fn(),
        voiceResetTranscript: vi.fn(),
        voiceStatus: 'idle',
      }),
    )

    act(() => {
      result.current.handleUploadClick('external-session')
    })

    await act(async () => {
      await result.current.handleFileSelect(new File(['data'], 'uploaded.txt'))
    })

    expect(externalPasteInput).toHaveBeenCalledWith('/tmp/uploaded.txt')
    expect(nativePasteInput).not.toHaveBeenCalled()
  })
})
