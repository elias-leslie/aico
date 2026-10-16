import type { OpenableSession } from '../types'
import { setProjectActions, setTuiActions } from './actions'

export type TuiInfo = { slug: string; displayName: string; accent: string; icon: string }
export type ProjectInfo = { id: string; name: string; current: boolean }
export type SessionCatalogStatus = 'ready' | 'empty' | 'unavailable'

type CatalogLoaders = {
  listTuis: () => Promise<TuiInfo[]>
  listProjects: () => Promise<ProjectInfo[]>
  listOpenableSessions: () => Promise<OpenableSession[]>
}

/** Owns the picker catalogs and the TUI and project launcher actions. Initial
 * loading finishes only after every catalog has registered its actions, so the
 * first render shows persisted launcher pins. Sessions are listed, not
 * registered as actions. A newer session refresh wins any race. */
export function createCatalogState(loaders: CatalogLoaders) {
  let tuis: TuiInfo[] = []
  let projects: ProjectInfo[] = []
  let sessions: OpenableSession[] = []
  let sessionStatus: SessionCatalogStatus = 'empty'
  let sessionRefreshId = 0

  async function refreshSessions(): Promise<{ status: SessionCatalogStatus }> {
    const requestId = ++sessionRefreshId
    try {
      const latest = await loaders.listOpenableSessions()
      if (requestId === sessionRefreshId) {
        sessions = latest
        sessionStatus = latest.length ? 'ready' : 'empty'
      }
    } catch {
      if (requestId === sessionRefreshId) {
        sessions = []
        sessionStatus = 'unavailable'
      }
    }
    return { status: sessionStatus }
  }

  async function loadInitial(): Promise<void> {
    await Promise.all([
      (async () => {
        try {
          tuis = await loaders.listTuis()
        } catch {
          tuis = []
        }
        setTuiActions(tuis)
      })(),
      (async () => {
        try {
          projects = await loaders.listProjects()
        } catch {
          projects = []
        }
        setProjectActions(projects)
      })(),
      refreshSessions(),
    ])
  }

  return {
    loadInitial,
    refreshSessions,
    get tuis() {
      return tuis
    },
    get projects() {
      return projects
    },
    get sessions() {
      return sessions
    },
    get sessionStatus() {
      return sessionStatus
    },
  }
}
