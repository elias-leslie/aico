import { apiFetch } from '../api-fetch'
import type {
  PaneListResponse,
  PaneCountResponse,
  CreatePaneRequest,
  UpdatePaneRequest,
  SwapPanesRequest,
  BulkLayoutUpdateRequest,
  TerminalPane,
} from './terminal-panes-types'

export async function fetchPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/terminal/panes')
}

export async function fetchDetachedPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/terminal/panes/detached')
}

export async function fetchPaneCount(): Promise<PaneCountResponse> {
  return apiFetch('/api/terminal/panes/count')
}

export async function createPane(request: CreatePaneRequest): Promise<TerminalPane> {
  return apiFetch('/api/terminal/panes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function updatePane(paneId: string, request: UpdatePaneRequest): Promise<TerminalPane> {
  return apiFetch(`/api/terminal/panes/${paneId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function deletePane(paneId: string): Promise<void> {
  await apiFetch(`/api/terminal/panes/${paneId}`, { method: 'DELETE' }, 'Failed to delete pane')
}

export async function detachPane(paneId: string): Promise<TerminalPane> {
  return apiFetch(`/api/terminal/panes/${paneId}/detach`, { method: 'POST' })
}

export async function attachPane(paneId: string): Promise<TerminalPane> {
  return apiFetch(`/api/terminal/panes/${paneId}/attach`, { method: 'POST' })
}

export async function swapPanes(request: SwapPanesRequest): Promise<void> {
  await apiFetch('/api/terminal/panes/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }, 'Failed to swap panes')
}

export async function updateAllLayouts(request: BulkLayoutUpdateRequest): Promise<TerminalPane[]> {
  return apiFetch('/api/terminal/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}
