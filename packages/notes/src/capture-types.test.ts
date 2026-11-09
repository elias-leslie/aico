import { describe, expect, it } from 'vitest'
import { buildTable } from './capture-types'

describe('capture owner links', () => {
  it('only accepts HTTPS links without credentials', () => {
    const table = buildTable({
      owners: {
        secure: { label: 'Secure', url: 'https://example.com/shopping' },
        insecure: { label: 'Insecure', url: 'http://example.com' },
        script: { label: 'Script', url: 'javascript:alert(1)' },
        invalid: { label: 'Invalid', url: 'not a url' },
        credentials: { label: 'Credentials', url: 'https://user:pass@example.com' },
      },
    })
    expect(table.owner('secure').url).toBe('https://example.com/shopping')
    for (const owner of ['insecure', 'script', 'invalid', 'credentials'])
      expect(table.owner(owner).url).toBeUndefined()
  })

  it('defaults new grocery captures to an unconnected Shopping suggestion', () => {
    const table = buildTable(null)
    expect(table.type('grocery_list')).toMatchObject({
      owner: 'dadbot-shopping',
      auto: false,
      keep_copy: true,
    })
    expect(table.owner('dadbot-shopping').url).toBe('https://dadbot.summitflow.dev/shopping')
    expect(table.type('receipt')?.owner).toBe('portfolio-ai')
  })
})
