import { apiFetch } from '../api-fetch'
import type {
  AttachPaneRequest,
  ATermPane,
  BulkLayoutUpdateRequest,
  CreatePaneRequest,
  PaneCountResponse,
  PaneListResponse,
  SwapPanesRequest,
  UpdatePaneRequest,
} from './a-term-panes-types'

export async function fetchPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/a-term/panes')
}

export async function fetchDetachedPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/a-term/panes/detached')
}

export async function fetchPaneCount(): Promise<PaneCountResponse> {
  return apiFetch('/api/a-term/panes/count')
}

export async function createPane(
  request: CreatePaneRequest,
): Promise<ATermPane> {
  return apiFetch('/api/a-term/panes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function updatePane(
  paneId: string,
  request: UpdatePaneRequest,
): Promise<ATermPane> {
  return apiFetch(`/api/a-term/panes/${paneId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function deletePane(paneId: string): Promise<void> {
  await apiFetch(
    `/api/a-term/panes/${paneId}`,
    { method: 'DELETE' },
    'Failed to delete pane',
  )
}

export async function detachPane(paneId: string): Promise<ATermPane> {
  return apiFetch(`/api/a-term/panes/${paneId}/detach`, { method: 'POST' })
}

export async function attachPane(
  paneId: string,
  request?: AttachPaneRequest,
): Promise<ATermPane> {
  return apiFetch(`/api/a-term/panes/${paneId}/attach`, {
    method: 'POST',
    headers: request ? { 'Content-Type': 'application/json' } : undefined,
    body: request ? JSON.stringify(request) : undefined,
  })
}

export async function swapPanes(request: SwapPanesRequest): Promise<void> {
  await apiFetch(
    '/api/a-term/panes/swap',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Failed to swap panes',
  )
}

export async function updateAllLayouts(
  request: BulkLayoutUpdateRequest,
): Promise<ATermPane[]> {
  return apiFetch('/api/a-term/layout', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}
