import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { shownProject, watchShownProject } from './shown-project'
import { publishShownSession } from './shown-session'

describe('shownProject', () => {
  afterEach(() => publishShownSession(null))

  it('is the project of the session on screen, else null', () => {
    const client = new QueryClient()
    client.setQueryData(
      ['terminal-sessions', false],
      [
        { id: 's1', project_id: 'aico' },
        { id: 's2', project_id: null },
      ],
    )
    const stop = watchShownProject(client)
    expect(shownProject()).toBeNull() // no session open
    publishShownSession('s1')
    expect(shownProject()).toBe('aico')
    publishShownSession('s2')
    expect(shownProject()).toBeNull() // a session with no project
    publishShownSession('gone')
    expect(shownProject()).toBeNull()
    stop()
    publishShownSession('s1')
    expect(shownProject()).toBeNull() // nothing to read from
  })
})
