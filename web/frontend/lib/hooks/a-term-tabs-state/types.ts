import type { ATermHandle, ConnectionStatus } from '@/components/ATerm'
import type {
  KeyboardSizePreset,
  KeyboardSpacingPreset,
  MobileKeyboardMode,
} from '@/components/keyboard/types'
import type { LayoutMode } from '@/lib/constants/a-term'

export interface UseATermTabsStateProps {
  projectId?: string
  projectPath?: string
  detachedPaneId?: string
  isDetachedPaneWindow?: boolean
  detachedWindowPaneIds?: string[]
  storageScopeId?: string | null
  addDetachedWindowPane?: (paneId: string, sessionId?: string | null) => void
  setDetachedWindowPaneIds?: (
    paneIds: string[],
    sessionId?: string | null,
  ) => void
}

export interface ATermRefsMap {
  aTermRefs: React.MutableRefObject<Map<string, ATermHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}

export interface ATermStatusState {
  aTermStatuses: Map<string, ConnectionStatus>
  setATermStatuses: React.Dispatch<
    React.SetStateAction<Map<string, ConnectionStatus>>
  >
}

export interface LayoutState {
  layoutMode: LayoutMode
  setLayoutMode: React.Dispatch<React.SetStateAction<LayoutMode>>
}

export interface SettingsState {
  showSettings: boolean
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>
  keyboardMode: MobileKeyboardMode
  setKeyboardMode: React.Dispatch<React.SetStateAction<MobileKeyboardMode>>
  keyboardSize: KeyboardSizePreset
  keyboardSpacing: KeyboardSpacingPreset
  setKeyboardSize: React.Dispatch<React.SetStateAction<KeyboardSizePreset>>
  setKeyboardSpacing: React.Dispatch<
    React.SetStateAction<KeyboardSpacingPreset>
  >
  showATermManager: boolean
  setShowATermManager: React.Dispatch<React.SetStateAction<boolean>>
}
