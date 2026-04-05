import type { ConnectionStatus, ATermHandle } from '@/components/ATerm'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { LayoutMode } from '@/lib/constants/aterm'

export interface UseATermTabsStateProps {
  projectId?: string
  projectPath?: string
}

export interface ATermRefsMap {
  atermRefs: React.MutableRefObject<Map<string, ATermHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}

export interface ATermStatusState {
  atermStatuses: Map<string, ConnectionStatus>
  setATermStatuses: React.Dispatch<React.SetStateAction<Map<string, ConnectionStatus>>>
}

export interface LayoutState {
  layoutMode: LayoutMode
  setLayoutMode: React.Dispatch<React.SetStateAction<LayoutMode>>
}

export interface SettingsState {
  showSettings: boolean
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>
  keyboardSize: KeyboardSizePreset
  setKeyboardSize: React.Dispatch<React.SetStateAction<KeyboardSizePreset>>
  showATermManager: boolean
  setShowATermManager: React.Dispatch<React.SetStateAction<boolean>>
}
