import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalHandle } from '@/components/Terminal'
import { useTerminalActionHandlers } from './use-terminal-action-handlers'

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

describe('useTerminalActionHandlers', () => {
  beforeEach(() => {
    mocks.uploadFile.mockReset()
    mocks.clearError.mockReset()
  })

  it('pastes uploaded file paths into the pane that triggered upload', async () => {
    const nativePasteInput = vi.fn()
    const externalPasteInput = vi.fn()
    const terminalRefs = {
      current: new Map<string, TerminalHandle | null>([
        [
          'native-session',
          {
            pasteInput: nativePasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as TerminalHandle,
        ],
        [
          'external-session',
          {
            pasteInput: externalPasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as TerminalHandle,
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
      useTerminalActionHandlers({
        terminalRefs,
        activeSessionId: 'native-session',
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
    // The upload names the session it is for, so a remote one is stored on its host.
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.any(File),
      'external-session',
    )
  })

  it('uploads for the active session when no pane was picked', async () => {
    const pasteInput = vi.fn()
    const terminalRefs = {
      current: new Map<string, TerminalHandle | null>([
        ['active-session', { pasteInput } as unknown as TerminalHandle],
      ]),
    }
    mocks.uploadFile.mockResolvedValue({
      path: '/home/agent/.cache/aico/uploads/x.png',
      filename: 'x.png',
      size: 1,
      mime_type: 'image/png',
    })
    const { result } = renderHook(() =>
      useTerminalActionHandlers({
        terminalRefs,
        activeSessionId: 'active-session',
      }),
    )
    await act(async () => {
      await result.current.handleFileSelect(new File(['x'], 'x.png'))
    })
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      expect.any(File),
      'active-session',
    )
    expect(pasteInput).toHaveBeenCalledWith(
      '/home/agent/.cache/aico/uploads/x.png',
    )
  })

  it('confirms where an upload landed: its own name, the host and the typed path', async () => {
    const pasteInput = vi.fn()
    const terminalRefs = {
      current: new Map<string, TerminalHandle | null>([
        ['remote-session', { pasteInput } as unknown as TerminalHandle],
      ]),
    }
    mocks.uploadFile.mockResolvedValue({
      path: '/home/kasadis/.cache/aico/uploads/0b1c.txt',
      filename: '0b1c.txt',
      size: 4,
      mime_type: 'text/plain',
      host: 'agent-work',
    })
    const { result } = renderHook(() =>
      useTerminalActionHandlers({
        terminalRefs,
        activeSessionId: 'remote-session',
      }),
    )
    expect(result.current.uploadDone).toBeNull()
    await act(async () => {
      await result.current.handleFileSelect(new File(['data'], 'notes.txt'))
    })
    expect(result.current.uploadDone).toEqual({
      name: 'notes.txt',
      path: '/home/kasadis/.cache/aico/uploads/0b1c.txt',
      host: 'agent-work',
      typed: true,
    })
    act(() => result.current.clearUploadDone())
    expect(result.current.uploadDone).toBeNull()
    // A failed upload confirms nothing.
    mocks.uploadFile.mockResolvedValue(null)
    await act(async () => {
      await result.current.handleFileSelect(new File(['data'], 'bad.txt'))
    })
    expect(result.current.uploadDone).toBeNull()
  })

  it('pastes clipboard image upload paths into the pane where paste happened', async () => {
    const nativePasteInput = vi.fn()
    const externalPasteInput = vi.fn()
    const terminalRefs = {
      current: new Map<string, TerminalHandle | null>([
        [
          'native-session',
          {
            pasteInput: nativePasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as TerminalHandle,
        ],
        [
          'external-session',
          {
            pasteInput: externalPasteInput,
            search: vi.fn(),
            clearSearch: vi.fn(),
          } as unknown as TerminalHandle,
        ],
      ]),
    }

    mocks.uploadFile.mockResolvedValue({
      path: '/tmp/pasted.png',
      filename: 'pasted.png',
      size: 32,
      mime_type: 'image/png',
    })

    const { result } = renderHook(() =>
      useTerminalActionHandlers({
        terminalRefs,
        activeSessionId: 'native-session',
      }),
    )

    await act(async () => {
      await result.current.handleFileSelect(
        new File(['image'], 'pasted.png', { type: 'image/png' }),
        'external-session',
      )
    })

    expect(externalPasteInput).toHaveBeenCalledWith('/tmp/pasted.png')
    expect(nativePasteInput).not.toHaveBeenCalled()
  })
})
