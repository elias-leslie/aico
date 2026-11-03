import { describe, expect, it } from 'vitest'
import { paneMarkers, rootMarkers } from './markers'

describe('paneMarkers', () => {
  it('sets the Aico compatibility markers and AICO_OWNER=aico on every session', () => {
    const env = paneMarkers({
      id: '0a1b2c3d',
      ownershipId: 'aico-widget-0a1b2c3d',
      tmuxServerId: '06e633492f792ad10439f675491801ee',
      projectId: null,
      tool: 'codex',
      aTermSessionId: 'f3f0c1d2-0000-4000-8000-000000000000',
    })
    expect(env).toEqual({
      AICO_WORKLOAD_CLASS: 'durable-session',
      AICO_OWNER: 'aico',
      AICO_WIDGET_ID: '0a1b2c3d',
      AICO_SESSION_ID: 'aico-widget-0a1b2c3d',
      AICO_TMUX_SERVER_ID: '06e633492f792ad10439f675491801ee',
      AICO_PROJECT_ID: '',
      AICO_AGENT_SLUG: 'codex',
      AICO_LIFECYCLE_VERSION: '1',
      A_TERM_SESSION_ID: 'f3f0c1d2-0000-4000-8000-000000000000',
    })
    expect(env).not.toHaveProperty('AICO_TMUX_SOCKET')
  })

  it('carries root launch intent without storing it', () => {
    expect(
      rootMarkers({ logicalSessionId: 'root-1', initialPrompt: null, resumeSessionId: null }),
    ).toEqual({
      ST_SESSION_ID: 'root-1',
      AICO_ROOT_INITIAL_LAUNCH: '0',
      AICO_ROOT_INITIAL_PROMPT: '',
      AICO_ROOT_RESUME_SESSION_ID: '',
    })
  })
})
