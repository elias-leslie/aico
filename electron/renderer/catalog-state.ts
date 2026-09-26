import { setProjectActions, setTmuxSessionActions, setTuiActions } from './actions'

export type TuiInfo = { slug: string; displayName: string; accent: string }
export type ProjectInfo = { id: string; name: string; current: boolean }
export type TmuxSessionInfo = { id: string; label: string; source: string }
export type TmuxSessionStatus = 'ready' | 'empty' | 'unavailable'

type CatalogLoaders = {
  listTuis: () => Promise<TuiInfo[]>
  listProjects: () => Promise<ProjectInfo[]>
  listTmuxSessions: () => Promise<TmuxSessionInfo[]>
}

/** Owns the picker catalogs and their dynamic actions. Initial loading finishes
 * only after every catalog has registered its actions, so callers may sanitize
 * persisted pins immediately afterward. A newer tmux refresh wins any race. */
export function createCatalogState(loaders: CatalogLoaders) {
  let tuis: TuiInfo[] = []
  let projects: ProjectInfo[] = []
  let tmuxSessions: TmuxSessionInfo[] = []
  let tmuxSessionStatus: TmuxSessionStatus = 'empty'
  let tmuxRefreshId = 0

  async function refreshTmuxSessions(): Promise<{ status: TmuxSessionStatus }> {
    const requestId = ++tmuxRefreshId
    try {
      const sessions = await loaders.listTmuxSessions()
      if (requestId === tmuxRefreshId) {
        tmuxSessions = sessions
        tmuxSessionStatus = sessions.length ? 'ready' : 'empty'
        setTmuxSessionActions(sessions)
      }
    } catch {
      if (requestId === tmuxRefreshId) {
        tmuxSessions = []
        tmuxSessionStatus = 'unavailable'
        setTmuxSessionActions([])
      }
    }
    return { status: tmuxSessionStatus }
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
      refreshTmuxSessions(),
    ])
  }

  return {
    loadInitial,
    refreshTmuxSessions,
    get tuis() {
      return tuis
    },
    get projects() {
      return projects
    },
    get tmuxSessions() {
      return tmuxSessions
    },
    get tmuxSessionStatus() {
      return tmuxSessionStatus
    },
  }
}
