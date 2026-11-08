import { apiFetch } from '../api-fetch'
import type { RenderKind } from '../render'

/** A design an agent added (`st mockup add`): a file for the owner to look at and choose from. */
export interface Design {
  id: string
  project: string
  title: string
  note: string
  kind: RenderKind
  size: number
  session: string | null
  askId: string
  createdAt: string
  /** Moves when the agent adds the same design again; the view reloads on it. */
  updatedAt: string
  selectedAt: string | null
  state: 'pending' | 'selected' | 'passed'
  /** The server's rendered page of it, for a frame. */
  viewUrl: string
}

export interface DesignList {
  items: Design[]
  /** Project files the server couldn't read: the list is partial. */
  unreadable: number
}

export const fetchDesigns = (signal?: AbortSignal): Promise<DesignList> =>
  apiFetch<DesignList>(
    '/api/mockups',
    { cache: 'no-store', signal },
    'Designs could not load',
  )

const base = (design: Design) => `/api/mockups/${design.id}`

const query = (design: Design) =>
  `?project=${encodeURIComponent(design.project)}`

export async function saveDesignNote(
  design: Design,
  note: string,
): Promise<Design> {
  const result = await apiFetch<{ mockup: Design }>(
    `${base(design)}${query(design)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
    'The note could not be saved',
  )
  return result.mockup
}

/** Use this one: answers the session that asked, with the note. */
export async function chooseDesign(
  design: Design,
  note: string,
): Promise<Design> {
  const result = await apiFetch<{ mockup: Design }>(
    `${base(design)}/select${query(design)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note }),
    },
    'The choice could not be sent',
  )
  return result.mockup
}

/** A frame's address for a design: it changes when the agent adds the design again. */
export const designFrameUrl = (design: Design) =>
  `${design.viewUrl}${design.viewUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(design.updatedAt)}`
