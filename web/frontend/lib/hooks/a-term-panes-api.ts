import { apiFetch } from '../api-fetch'
import type {
  ATermPane,
  CreatePaneRequest,
  PaneListResponse,
  UpdatePaneRequest,
} from './a-term-panes-types'

export async function fetchPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/panes')
}

export async function fetchDetachedPanes(): Promise<PaneListResponse> {
  return apiFetch('/api/panes/detached')
}

export async function createPane(
  request: CreatePaneRequest,
): Promise<ATermPane> {
  return apiFetch('/api/panes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function updatePane(
  paneId: string,
  request: UpdatePaneRequest,
): Promise<ATermPane> {
  return apiFetch(`/api/panes/${paneId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
}

export async function deletePane(paneId: string): Promise<void> {
  await apiFetch(
    `/api/panes/${paneId}`,
    { method: 'DELETE' },
    'Failed to delete pane',
  )
}
