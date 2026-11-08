import { describe, expect, it } from 'vitest'
import {
  AgentAdmissionDenied,
  admissionLimitsFromEnv,
  DEFAULT_AGENT_ADMISSION_LIMITS,
  parseMemAvailable,
  parseMemoryPressure,
} from './host-pressure'

const GiB = 1024 ** 3
const meminfo = (gib: number) =>
  `MemTotal:       31421792 kB\nMemFree:          500000 kB\nMemAvailable:   ${Math.round(gib * 1024 * 1024)} kB\n`
const psi = (someAvg60 = 0, fullAvg60 = 0, fullAvg10 = 0) =>
  `some avg10=0.00 avg60=${someAvg60.toFixed(2)} avg300=0.00 total=12264006\n` +
  `full avg10=${fullAvg10.toFixed(2)} avg60=${fullAvg60.toFixed(2)} avg300=0.00 total=12225083\n`

describe('parseMemAvailable', () => {
  it('reads kB as bytes', () => {
    expect(parseMemAvailable(meminfo(6))).toBe(6 * GiB)
  })

  it.each([
    ['missing', 'MemTotal: 1 kB\n'],
    ['duplicated', 'MemAvailable: 1 kB\nMemAvailable: 2 kB\n'],
    ['wrong unit', 'MemAvailable: 1 MB\n'],
    ['negative', 'MemAvailable: -1 kB\n'],
    ['fractional', 'MemAvailable: 1.5 kB\n'],
    ['empty', ''],
  ])('fails closed when %s', (_label, text) => {
    expect(() => parseMemAvailable(text)).toThrow(AgentAdmissionDenied)
  })
})

describe('parseMemoryPressure', () => {
  it('reads the kernel format', () => {
    expect(parseMemoryPressure(psi(10.5, 2.25, 5))).toEqual({
      someAvg60: 10.5,
      fullAvg60: 2.25,
      fullAvg10: 5,
    })
  })

  it.each([
    ['empty', ''],
    ['missing full', 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n'],
    ['duplicate some', `${psi()}some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`],
    [
      'non-numeric',
      'some avg10=x avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    [
      'over 100',
      'some avg10=0.00 avg60=100.01 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    [
      'extra field',
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=1 x=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n',
    ],
    ['blank line', `${psi()}\n`],
  ])('fails closed when %s', (_label, text) => {
    expect(() => parseMemoryPressure(text)).toThrow(AgentAdmissionDenied)
  })
})

describe('admission configuration', () => {
  it('is pressure-only by default with no static ceiling', () => {
    expect(admissionLimitsFromEnv({})).toEqual(DEFAULT_AGENT_ADMISSION_LIMITS)
    expect(DEFAULT_AGENT_ADMISSION_LIMITS.maxActiveAgents).toBeNull()
  })

  it('parses documented overrides', () => {
    expect(
      admissionLimitsFromEnv({
        AICO_AGENT_MAX_ACTIVE: '24',
        AICO_AGENT_MIN_AVAILABLE_GIB: '4',
        AICO_AGENT_MAX_PSI_SOME_AVG60: '15.5',
        AICO_AGENT_MAX_PSI_FULL_AVG60: '3',
        AICO_AGENT_MAX_PSI_FULL_AVG10: '7',
      }),
    ).toEqual({
      maxActiveAgents: 24,
      minAvailableBytes: 4 * GiB,
      maxSomeAvg60: 15.5,
      maxFullAvg60: 3,
      maxFullAvg10: 7,
    })
  })

  it.each([
    ['AICO_AGENT_MAX_ACTIVE', '0'],
    ['AICO_AGENT_MAX_ACTIVE', '6.5'],
    ['AICO_AGENT_MIN_AVAILABLE_GIB', '-1'],
    ['AICO_AGENT_MAX_PSI_SOME_AVG60', 'high'],
    ['AICO_AGENT_MAX_PSI_FULL_AVG10', '101'],
  ])('rejects malformed %s=%s', (name, value) => {
    expect(() => admissionLimitsFromEnv({ [name]: value })).toThrow(AgentAdmissionDenied)
  })
})
