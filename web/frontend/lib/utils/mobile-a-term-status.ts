import type { ConnectionStatus } from '@/components/a-term.types'

export interface MobileATermBannerState {
  label: string
  detail: string
  tone: 'neutral' | 'success' | 'warning' | 'danger'
  actionLabel?: 'Reconnect'
}

interface MobileATermStatusOptions {
  connectionStatus?: ConnectionStatus
  activeMode?: string
  voiceActive?: boolean
  minimized?: boolean
  canReconnect?: boolean
}

const RECONNECTABLE_STATUSES: ConnectionStatus[] = ['disconnected', 'error', 'timeout']

export function isReconnectableStatus(status?: ConnectionStatus): boolean {
  return status !== undefined && RECONNECTABLE_STATUSES.includes(status)
}

function getModeLabel(activeMode?: string): string {
  if (!activeMode || activeMode === 'shell') {
    return 'Shell'
  }

  return 'Agent'
}

export function getMobileATermBannerState({
  connectionStatus,
  activeMode,
  voiceActive = false,
  minimized = false,
  canReconnect = false,
}: MobileATermStatusOptions): MobileATermBannerState {
  const modeLabel = getModeLabel(activeMode)

  switch (connectionStatus) {
    case 'connecting':
      return {
        label: 'Connecting',
        detail: `${modeLabel} session is waking up`,
        tone: 'warning',
      }
    case 'disconnected':
      return {
        label: 'Disconnected',
        detail: 'Reconnect to resume this A-Term',
        tone: 'danger',
        actionLabel: canReconnect ? 'Reconnect' : undefined,
      }
    case 'error':
      return {
        label: 'Connection error',
        detail: 'Reconnect to rejoin the A-Term',
        tone: 'danger',
        actionLabel: canReconnect ? 'Reconnect' : undefined,
      }
    case 'timeout':
      return {
        label: 'Timed out',
        detail: 'Reconnect to continue working',
        tone: 'danger',
        actionLabel: canReconnect ? 'Reconnect' : undefined,
      }
    case 'session_dead':
      return {
        label: 'Session ended',
        detail: 'Open or reset a pane to continue',
        tone: 'warning',
      }
    default:
      if (voiceActive) {
        return {
          label: 'Voice active',
          detail: `${modeLabel} input is using the mic`,
          tone: 'success',
        }
      }

      if (minimized) {
        return {
          label: 'Live',
          detail: 'Keyboard hidden',
          tone: 'neutral',
        }
      }

      return {
        label: 'Live',
        detail: modeLabel,
        tone: 'success',
      }
  }
}
