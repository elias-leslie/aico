// Host memory readings and the launch-admission limits: the pure parsers for /proc/meminfo
// and /proc/pressure/memory, the limits (and their AICO_AGENT_* env), and the denial error
// they throw. Tether's launch admission and the hub's placement read the same host the same
// way, so they live here (layer 0) and differ only in what they do with the numbers. Every
// parser fails closed: a malformed reading throws AgentAdmissionDenied.

export interface AgentAdmissionLimits {
  /** Optional emergency ceiling on active agents; null disables the ceiling. */
  maxActiveAgents: number | null
  minAvailableBytes: number
  maxSomeAvg60: number
  maxFullAvg60: number
  maxFullAvg10: number
}

export const DEFAULT_AGENT_ADMISSION_LIMITS: AgentAdmissionLimits = {
  maxActiveAgents: null,
  minAvailableBytes: 6 * 1024 ** 3,
  maxSomeAvg60: 10,
  maxFullAvg60: 2,
  maxFullAvg10: 5,
}

export class AgentAdmissionDenied extends Error {
  readonly retryable = true

  constructor(readonly reason: string) {
    super(
      `Aico deferred this agent launch: ${reason} ` +
        'Nothing was started; retry when host memory pressure falls.',
    )
    this.name = 'AgentAdmissionDenied'
  }
}

export interface MemoryPressure {
  someAvg60: number
  fullAvg60: number
  fullAvg10: number
}

export function malformedAdmission(label: string): AgentAdmissionDenied {
  return new AgentAdmissionDenied(`${label} is unavailable or malformed.`)
}

function integer(value: string | undefined, label: string, minimum: number): number {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw malformedAdmission(label)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) throw malformedAdmission(label)
  return number
}

function percentage(value: string | undefined, label: string): number {
  if (value === undefined || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) throw malformedAdmission(label)
  const number = Number(value)
  if (!Number.isFinite(number) || number > 100) throw malformedAdmission(label)
  return number
}

function optional<T>(value: string | undefined, fallback: T, parse: (value: string) => T): T {
  return value === undefined || value === '' ? fallback : parse(value)
}

export function admissionLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): AgentAdmissionLimits {
  const defaults = DEFAULT_AGENT_ADMISSION_LIMITS
  return {
    maxActiveAgents: optional(env.AICO_AGENT_MAX_ACTIVE, defaults.maxActiveAgents, (value) =>
      integer(value, 'AICO_AGENT_MAX_ACTIVE', 1),
    ),
    minAvailableBytes: optional(
      env.AICO_AGENT_MIN_AVAILABLE_GIB,
      defaults.minAvailableBytes,
      (value) => integer(value, 'AICO_AGENT_MIN_AVAILABLE_GIB', 0) * 1024 ** 3,
    ),
    maxSomeAvg60: optional(env.AICO_AGENT_MAX_PSI_SOME_AVG60, defaults.maxSomeAvg60, (value) =>
      percentage(value, 'AICO_AGENT_MAX_PSI_SOME_AVG60'),
    ),
    maxFullAvg60: optional(env.AICO_AGENT_MAX_PSI_FULL_AVG60, defaults.maxFullAvg60, (value) =>
      percentage(value, 'AICO_AGENT_MAX_PSI_FULL_AVG60'),
    ),
    maxFullAvg10: optional(env.AICO_AGENT_MAX_PSI_FULL_AVG10, defaults.maxFullAvg10, (value) =>
      percentage(value, 'AICO_AGENT_MAX_PSI_FULL_AVG10'),
    ),
  }
}

const MEM_AVAILABLE_RE = /^MemAvailable:[ \t]+([0-9]+) kB[ \t]*$/gm

export function parseMemAvailable(text: string): number {
  const matches = [...text.matchAll(MEM_AVAILABLE_RE)]
  if (matches.length !== 1) throw malformedAdmission('/proc/meminfo MemAvailable')
  const bytes = integer(matches[0][1], '/proc/meminfo MemAvailable', 0) * 1024
  if (!Number.isSafeInteger(bytes)) throw malformedAdmission('/proc/meminfo MemAvailable')
  return bytes
}

const PSI_LINE_RE =
  /^(some|full) avg10=([0-9]+\.[0-9]+) avg60=([0-9]+\.[0-9]+) avg300=([0-9]+\.[0-9]+) total=([0-9]+)$/

export function parseMemoryPressure(text: string): MemoryPressure {
  const label = '/proc/pressure/memory'
  const rows = new Map<string, { avg10: number; avg60: number }>()
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  for (const line of lines) {
    const match = PSI_LINE_RE.exec(line)
    if (!match || rows.has(match[1])) throw malformedAdmission(label)
    percentage(match[4], label)
    integer(match[5], label, 0)
    rows.set(match[1], { avg10: percentage(match[2], label), avg60: percentage(match[3], label) })
  }
  const some = rows.get('some')
  const full = rows.get('full')
  if (!some || !full || rows.size !== 2) throw malformedAdmission(label)
  return { someAvg60: some.avg60, fullAvg60: full.avg60, fullAvg10: full.avg10 }
}
