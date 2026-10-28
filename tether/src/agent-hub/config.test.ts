import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_HUB_URL,
  DEFAULT_REQUEST_SOURCE,
  parseEnvFile,
  resolveAgentHubConfig,
} from './config'

describe('Agent Hub config', () => {
  it('reads KEY=value lines with export prefixes, quotes and comments', () => {
    expect(
      parseEnvFile(
        ['# note', 'export A="one"', "B='two'", 'C=three ', '', 'bad line', 'D=a=b'].join('\n'),
      ),
    ).toEqual({ A: 'one', B: 'two', C: 'three', D: 'a=b' })
  })

  it('takes the client id and token file from ~/.env.local, and lets Tether variables win', () => {
    const files: Record<string, string> = {
      '/home/x/.env.local':
        'SUMMITFLOW_CLIENT_ID="client-local"\nAGENT_HUB_OWNER_TOKEN_FILE=/secrets/token\n',
    }
    const read = (path: string) => {
      if (!(path in files)) throw new Error('ENOENT')
      return files[path]
    }
    expect(resolveAgentHubConfig({}, '/home/x', read)).toEqual({
      baseUrl: DEFAULT_AGENT_HUB_URL,
      clientId: 'client-local',
      requestSource: DEFAULT_REQUEST_SOURCE,
      ownerTokenFile: '/secrets/token',
    })
    expect(
      resolveAgentHubConfig(
        {
          TETHER_AGENT_HUB_URL: 'http://hub:1',
          TETHER_AGENT_HUB_CLIENT_ID: 'client-env',
          TETHER_AGENT_HUB_REQUEST_SOURCE: 'src',
          TETHER_AGENT_HUB_OWNER_TOKEN_FILE: '/other',
        },
        '/home/x',
        read,
      ),
    ).toEqual({
      baseUrl: 'http://hub:1',
      clientId: 'client-env',
      requestSource: 'src',
      ownerTokenFile: '/other',
    })
  })

  it('works without an env file', () => {
    expect(
      resolveAgentHubConfig({}, '/nowhere', () => {
        throw new Error('ENOENT')
      }),
    ).toMatchObject({ clientId: null, ownerTokenFile: null })
  })
})
