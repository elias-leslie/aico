import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import type { KeyboardSizePreset } from '@/components/keyboard/types'
import type { LayoutMode } from '@/lib/constants/terminal'

export interface UseTerminalTabsStateProps {
  projectId?: string
  projectPath?: string
}

export interface TerminalRefsMap {
  terminalRefs: React.MutableRefObject<Map<string, TerminalHandle>>
  projectTabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
}

export interface TerminalStatusState {
  terminalStatuses: Map<string, ConnectionStatus>
  setTerminalStatuses: React.Dispatch<React.SetStateAction<Map<string, ConnectionStatus>>>
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
  showTerminalManager: boolean
  setShowTerminalManager: React.Dispatch<React.SetStateAction<boolean>>
}
