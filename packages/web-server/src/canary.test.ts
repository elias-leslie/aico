import { expect, it } from 'vitest'
import { describeCanary } from './canary'

it('uses the private registry placement without exposing token management data', () => {
  const result = describeCanary({ token: 'fixture', src_ip: '192.0.2.10' }, [
    { token: 'fixture', name: 'Decoy', path: 'fixture placement', type: 'dns' },
  ])
  expect(result).toEqual({
    title: 'Canary tripped: Decoy',
    body: 'dns at fixture placement. Source 192.0.2.10.',
  })
  expect(() => describeCanary({ token: 'unknown' }, [])).toThrow('not registered')
})
it('handles honeypot messages and ignores startup events', () => {
  expect(describeCanary({ message: { logtype: 1001 } }, [])).toBeNull()
  expect(
    describeCanary(
      {
        message: JSON.stringify({
          logtype: 4002,
          node_id: 'lab',
          src_host: '192.0.2.20',
          dst_port: 22,
        }),
      },
      [],
    )?.title,
  ).toBe('Honeypot tripped: lab')
})
