import { describe, expect, it } from 'vitest'
import type { TmuxServerRow } from './store'
import { classifyTmuxServerState, type TmuxServerRuntimeEvidence } from './tmux-server-state'

const server: TmuxServerRow = {
  id: '11111111111111111111111111111111',
  kind: 'managed',
  phase: 'active',
  socketPath: '/tmp/aico-test/server.sock',
  scopeUnit: 'aico-tmux-server-11111111111111111111111111111111.scope',
  controlGroup:
    '/user.slice/user-1000.slice/user@1000.service/app.slice/aico-tmux-server-11111111111111111111111111111111.scope',
  invocationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  serverPid: 1234,
  procStartTime: '987654',
  createdAt: 100,
  deadAt: null,
}

const exactEvidence: TmuxServerRuntimeEvidence = {
  process: {
    status: 'present',
    pid: 1234,
    procStartTime: '987654',
    controlGroup: server.controlGroup as string,
  },
  unit: {
    status: 'active',
    scopeUnit: server.scopeUnit,
    controlGroup: server.controlGroup as string,
    invocationId: server.invocationId as string,
  },
  roster: { status: 'reachable', serverPid: 1234 },
}

describe('tmux server runtime state', () => {
  it('requires the complete exact tuple for reachable', () => {
    expect(classifyTmuxServerState(server, exactEvidence)).toBe('reachable')
  })

  it('keeps an exact live process on transport failure as live-unreachable', () => {
    expect(
      classifyTmuxServerState(server, {
        ...exactEvidence,
        roster: { status: 'transport-failure' },
      }),
    ).toBe('live-unreachable')
  })

  it.each([
    {
      label: 'missing exact pid',
      process: { status: 'missing' as const, pid: 1234 },
    },
    {
      label: 'reused exact pid',
      process: {
        status: 'present' as const,
        pid: 1234,
        procStartTime: '987655',
        controlGroup: server.controlGroup as string,
      },
    },
  ])('proves dead only from a $label tuple', ({ process }) => {
    expect(
      classifyTmuxServerState(server, {
        ...exactEvidence,
        process,
        roster: { status: 'transport-failure' },
      }),
    ).toBe('dead')
  })

  it.each([
    {
      label: 'wrong observed pid',
      evidence: {
        ...exactEvidence,
        process: { status: 'missing' as const, pid: 4321 },
      },
    },
    {
      label: 'unavailable proc',
      evidence: {
        ...exactEvidence,
        process: { status: 'unavailable' as const, pid: 1234 },
      },
    },
    {
      label: 'wrong proc cgroup',
      evidence: {
        ...exactEvidence,
        process: {
          status: 'present' as const,
          pid: 1234,
          procStartTime: '987654',
          controlGroup: '/user.slice/wrong.scope',
        },
      },
    },
    {
      label: 'inactive unit',
      evidence: {
        ...exactEvidence,
        unit: { status: 'inactive' as const, scopeUnit: server.scopeUnit },
      },
    },
    {
      label: 'wrong unit name',
      evidence: {
        ...exactEvidence,
        unit: {
          ...(exactEvidence.unit as Extract<
            TmuxServerRuntimeEvidence['unit'],
            { status: 'active' }
          >),
          scopeUnit: 'aico-tmux-server-22222222.scope',
        },
      },
    },
    {
      label: 'wrong unit control group',
      evidence: {
        ...exactEvidence,
        unit: {
          ...(exactEvidence.unit as Extract<
            TmuxServerRuntimeEvidence['unit'],
            { status: 'active' }
          >),
          controlGroup: '/user.slice/wrong.scope',
        },
      },
    },
    {
      label: 'reused unit invocation',
      evidence: {
        ...exactEvidence,
        unit: {
          ...(exactEvidence.unit as Extract<
            TmuxServerRuntimeEvidence['unit'],
            { status: 'active' }
          >),
          invocationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    },
    {
      label: 'unavailable roster',
      evidence: { ...exactEvidence, roster: { status: 'unavailable' as const } },
    },
  ])('fails closed as ambiguous for $label', ({ evidence }) => {
    expect(classifyTmuxServerState(server, evidence)).toBe('ambiguous')
  })

  it('classifies a reachable different PID as a socket collision', () => {
    expect(
      classifyTmuxServerState(server, {
        ...exactEvidence,
        roster: { status: 'reachable', serverPid: 4321 },
      }),
    ).toBe('socket-collision')
  })

  it('retains immutable dead tombstones and refuses incomplete provisioning identity', () => {
    expect(classifyTmuxServerState({ ...server, phase: 'dead', deadAt: 200 }, exactEvidence)).toBe(
      'dead',
    )
    expect(
      classifyTmuxServerState(
        {
          ...server,
          phase: 'provisioning',
          controlGroup: null,
          invocationId: null,
          serverPid: null,
          procStartTime: null,
        },
        exactEvidence,
      ),
    ).toBe('ambiguous')
  })
})
