import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isBoundedTerminalText } from '@aico/session-engine/tmux'
import { describe, expect, it } from 'vitest'
import { decideRecovery, LOOP_WINDOW_MS, RECOVERY_WINDOW_MS } from './recovery'
import {
  CRASH_RESULTS,
  type CrashFacts,
  claudeTranscriptFacts,
  codexTranscriptFacts,
  type FileReader,
  gapCommits,
  kernelOomVictims,
  likelyCulprit,
  MACHINE_DOWN,
  nodeFileReader,
  PANE_KILLED,
  parseGitState,
  parseJournal,
  piTranscriptFacts,
  recentFiles,
  renderDetail,
  renderSynopsis,
  SERVER_LOST,
  scopeMemoryEvents,
  statusPaths,
  unitOutcome,
  victimsInScope,
} from './recovery-facts'

const SCOPE = 'tmux-spawn-37d6b6ef-1864-4121-bf60-2d34e91a33be.scope'
const INVOCATION = 'e8ad5fa9add94a04b1a314176ffa73d7'
const DIED = Date.parse('2026-10-16T03:27:58.651Z')
const us = (ms: number) => String(ms * 1000)

// The 2026-10-15 23:28 incident, as journalctl -o json printed it.
const userJournal = [
  {
    MESSAGE: `${SCOPE}: A process of this unit has been killed by the OOM killer.`,
    MESSAGE_ID: 'fe6faa94e7774663a0da52717891d8ef',
    USER_UNIT: SCOPE,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: us(DIED),
  },
  {
    MESSAGE: `${SCOPE}: Failed with result 'oom-kill'.`,
    MESSAGE_ID: 'd9b373ed55a64feb8242e02dbe79a49c',
    UNIT_RESULT: 'oom-kill',
    USER_UNIT: SCOPE,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: us(DIED + 2000),
  },
  {
    MESSAGE: `Stopped ${SCOPE} - tmux child pane.`,
    USER_UNIT: SCOPE,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: us(DIED + 2001),
  },
]
  .map((entry) => JSON.stringify(entry))
  .join('\n')

const kernelJournal = [
  'docker invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0',
  `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=nightshift-docker-shadow.service,mems_allowed=0,global_oom,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/${SCOPE},task=python,pid=192829,uid=1000`,
  'Out of memory: Killed process 192829 (python) total-vm:21260184kB, anon-rss:13880052kB, file-rss:128kB, shmem-rss:0kB, UID:1000 pgtables:28248kB oom_score_adj:200',
  'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-other.scope,task_memcg=/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-other.scope,task=node,pid=500,uid=1000',
  'Memory cgroup out of memory: Killed process 500 (node) total-vm:1kB, anon-rss:204800kB, file-rss:0kB',
]
  .map((MESSAGE, index) => JSON.stringify({ MESSAGE, __REALTIME_TIMESTAMP: us(DIED + index) }))
  .join('\n')

describe('journal evidence', () => {
  it('reads the exact unit invocation outcome', () => {
    const outcome = unitOutcome(parseJournal(userJournal), SCOPE, INVOCATION)
    expect(outcome.result).toBe('oom-kill')
    expect(outcome.oomKilledProcess).toBe(true)
    expect(outcome.at).toBe(DIED + 2000)
    expect(outcome.lines).toHaveLength(3)
    // Another invocation of a reused unit name is not evidence.
    expect(unitOutcome(parseJournal(userJournal), SCOPE, 'f'.repeat(32)).result).toBeNull()
    // A result logged after the pane was seen gone belongs to a later stop.
    expect(unitOutcome(parseJournal(userJournal), SCOPE, INVOCATION, DIED + 1999).result).toBeNull()
    expect(unitOutcome(parseJournal(userJournal), SCOPE, INVOCATION, DIED + 2000).result).toBe(
      'oom-kill',
    )
  })

  it('dates a unit that ended with no failure by its end record', () => {
    const entries = [
      {
        MESSAGE: `Started ${SCOPE}.`,
        MESSAGE_ID: '39f53479d3a045ac8e11786248231fbf',
        at: DIED - 3600_000,
      },
      {
        MESSAGE: `${SCOPE}: Consumed 3.1s CPU time.`,
        MESSAGE_ID: 'ae8f7b866b0347b9af31fe1c80b127c0',
        at: DIED,
      },
    ].map(({ at, ...entry }) =>
      JSON.stringify({
        ...entry,
        USER_UNIT: SCOPE,
        USER_INVOCATION_ID: INVOCATION,
        __REALTIME_TIMESTAMP: us(at),
      }),
    )
    const outcome = unitOutcome(parseJournal(entries.join('\n')), SCOPE, INVOCATION, DIED + 10_000)
    expect(outcome.result).toBeNull()
    expect(outcome.endedAt).toBe(DIED)
    // Only the start record so far: no end time yet.
    expect(unitOutcome(parseJournal(entries[0] as string), SCOPE, INVOCATION).endedAt).toBeNull()
    // An end logged after the grace belongs to a later stop.
    expect(
      unitOutcome(parseJournal(entries.join('\n')), SCOPE, INVOCATION, DIED - 1).endedAt,
    ).toBeNull()
    expect(unitOutcome(parseJournal(userJournal), SCOPE, INVOCATION).endedAt).toBe(DIED + 2000)
  })

  it('reads the signals systemctl kill sent to the unit', () => {
    const line = JSON.stringify({
      MESSAGE: `${SCOPE}: Sending signal SIGKILL to process 2754637 (bash) on client request.`,
      USER_UNIT: SCOPE,
      USER_INVOCATION_ID: INVOCATION,
      __REALTIME_TIMESTAMP: us(DIED),
    })
    expect(unitOutcome(parseJournal(line), SCOPE, INVOCATION).kills).toEqual([
      { signal: 'SIGKILL', pid: 2754637, at: DIED },
    ])
    expect(unitOutcome(parseJournal(userJournal), SCOPE, INVOCATION).kills).toEqual([])
  })

  it('never counts a stop timeout as a crash', () => {
    expect(CRASH_RESULTS.has('timeout')).toBe(false)
    expect(CRASH_RESULTS.has('oom-kill')).toBe(true)
  })

  it('reads only the tail of a large transcript, from a whole line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tether-tail-'))
    try {
      const path = join(dir, 'big.jsonl')
      writeFileSync(path, `${'x'.repeat(100)}\n{"a":1}\n{"b":2}\n`)
      expect(nodeFileReader.read(path, 12)).toBe('{"b":2}\n')
      expect(nodeFileReader.read(path, 10_000)).toBe(nodeFileReader.read(path))
      expect(nodeFileReader.read(join(dir, 'missing'), 12)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the kernel victim, its memory and whether the host or a cap ran out', () => {
    const victims = kernelOomVictims(parseJournal(kernelJournal))
    expect(victims).toHaveLength(2)
    const [incident] = victimsInScope(victims, SCOPE)
    expect(incident).toMatchObject({
      pid: 192829,
      comm: 'python',
      rssBytes: 13880052 * 1024,
      constraint: 'global',
    })
    expect(incident?.lines).toHaveLength(2)
    expect(victimsInScope(victims, 'tmux-spawn-other.scope')[0]).toMatchObject({
      pid: 500,
      comm: 'node',
      constraint: 'memcg',
    })
  })
})

describe('memory events for a pane scope', () => {
  it('reads the record file directly: only that scope, nothing when absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tether-events-'))
    try {
      const file = join(tmp, 'memory-events.jsonl')
      const other = 'tmux-spawn-other.scope'
      writeFileSync(
        file,
        [
          JSON.stringify({ v: 1, kind: 'kill', scope: SCOPE, killer: 'tether' }),
          JSON.stringify({ v: 1, kind: 'warning', scope: other }),
          `not json but mentions ${SCOPE}`,
          JSON.stringify({ v: 1, kind: 'agent-hog', scope: SCOPE }),
        ].join('\n'),
      )
      const lines = scopeMemoryEvents([join(tmp, 'missing.jsonl'), file], SCOPE)?.split('\n') ?? []
      expect(lines.map((line) => JSON.parse(line).kind)).toEqual(['kill', 'agent-hog'])
      expect(scopeMemoryEvents([file], 'tmux-spawn-none.scope')).toBeNull()
      expect(scopeMemoryEvents([join(tmp, 'missing.jsonl')], SCOPE)).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('loop protection', () => {
  const now = DIED + 3600_000
  it('allows the first recovery after the admission settle', () => {
    expect(decideRecovery([], { diedAt: DIED, agentWasHog: false }, now)).toEqual({
      notBefore: now + 60_000,
      attempt: 1,
    })
  })

  it('does not settle after a tmux server death that left no memory to settle', () => {
    expect(
      decideRecovery([], { diedAt: DIED, agentWasHog: false, nothingToSettle: true }, now),
    ).toEqual({ notBefore: now, attempt: 1 })
  })

  it('spaces the second recovery at least 10 minutes after the first', () => {
    const history = [
      { id: 'a', diedAt: DIED - 3600_000, recoveredAt: now - 11 * 60_000, agentWasHog: false },
    ]
    expect(decideRecovery(history, { diedAt: now - 60_000, agentWasHog: false }, now)).toEqual({
      notBefore: now + 60_000,
      attempt: 2,
    })
  })

  it('holds a crash within 10 minutes of a recovery, a third in 6 hours, and a second agent hog', () => {
    const recent = { id: 'a', diedAt: DIED, recoveredAt: now - 5 * 60_000, agentWasHog: false }
    expect(decideRecovery([recent], { diedAt: now, agentWasHog: false }, now)).toHaveProperty(
      'hold',
    )
    const twice = [
      { id: 'a', diedAt: DIED, recoveredAt: now - 5 * 3600_000, agentWasHog: false },
      { id: 'a', diedAt: DIED, recoveredAt: now - 2 * 3600_000, agentWasHog: false },
    ]
    expect(decideRecovery(twice, { diedAt: now, agentWasHog: false }, now)).toEqual({
      hold: 'it was already recovered automatically twice in the last 6 hours',
    })
    const hog = [{ id: 'a', diedAt: DIED, recoveredAt: now - 3600_000, agentWasHog: true }]
    expect(decideRecovery(hog, { diedAt: now, agentWasHog: true }, now)).toEqual({
      hold: 'its own process was the memory hog again',
    })
    expect(decideRecovery(hog, { diedAt: now, agentWasHog: false }, now)).toHaveProperty(
      'attempt',
      2,
    )
    // An owner resume still counts for the 10-minute rule, not for the cap.
    const manual = [{ ...recent, manual: true }]
    expect(decideRecovery(manual, { diedAt: now, agentWasHog: false }, now)).toHaveProperty('hold')
    expect(
      decideRecovery(
        [...twice.slice(0, 1), { ...twice[1], manual: true }] as typeof twice,
        { diedAt: now, agentWasHog: false },
        now,
      ),
    ).toHaveProperty('attempt', 2)
    // Attempts older than the window no longer count.
    const old = twice.map((attempt) => ({
      ...attempt,
      recoveredAt: now - RECOVERY_WINDOW_MS - LOOP_WINDOW_MS,
    }))
    expect(decideRecovery(old, { diedAt: now, agentWasHog: false }, now)).toHaveProperty(
      'attempt',
      1,
    )
  })
})

const SESSION = '3e0161b0-9591-4f68-a80a-656951537274'
const PROJECT = '/h/.claude/projects/-srv-workspaces-projects-cinderwake'
const MAIN = `${PROJECT}/${SESSION}.jsonl`
const DIR = `${PROJECT}/${SESSION}`
const iso = (ms: number) => new Date(ms).toISOString()
const line = (entry: Record<string, unknown>) => JSON.stringify(entry)
const use = (id: string, at: number, input: Record<string, unknown>) =>
  line({
    type: 'assistant',
    timestamp: iso(at),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  })
const result = (id: string, at: number, content: string) =>
  line({
    type: 'user',
    timestamp: iso(at),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  })

function reader(files: Record<string, string>): FileReader {
  return {
    read: (path) => files[path] ?? null,
    list: (path) => {
      const names = new Set<string>()
      for (const file of Object.keys(files))
        if (file.startsWith(`${path}/`))
          names.add(file.slice(path.length + 1).split('/')[0] as string)
      return [...names]
    },
    mtime: (path) =>
      path in files || Object.keys(files).some((file) => file.startsWith(`${path}/`)) ? DIED : null,
  }
}

const transcriptFiles = {
  [MAIN]: [
    line({
      type: 'user',
      timestamp: iso(DIED - 30 * 60_000),
      origin: { kind: 'human' },
      message: { content: 'keep going autonomously until done' },
    }),
    line({
      type: 'user',
      timestamp: iso(DIED - 25 * 60_000),
      origin: { kind: 'human' },
      message: {
        content: 'Recovery: this session crashed at 02:50 and Tether resumed it at 02:51.',
      },
    }),
    use('toolu_bg', DIED - 3600_000, { command: 'sleep 9999', run_in_background: true }),
    result('toolu_bg', DIED - 3600_000, 'Command running in background with ID: b02cmex35'),
    use('toolu_bg2', DIED - 1800_000, { command: 'watch thing', run_in_background: true }),
    result('toolu_bg2', DIED - 1800_000, 'Command running in background with ID: bw9n91ahz'),
    line({
      type: 'user',
      timestamp: iso(DIED - 1000_000),
      message: {
        content: '<task-notification>\n<task-id>b02cmex35</task-id>\n<status>completed</status>',
      },
    }),
  ].join('\n'),
  [`${DIR}/subagents/workflows/wf_f671639d-9ad/journal.jsonl`]: [
    line({ type: 'launched' }),
    line({ type: 'started', key: 'k1', agentId: 'a7641549d1168add9', label: 'AS-P0' }),
    line({ type: 'started', key: 'k2', agentId: 'a473f9508cd41a420', label: 'AS-S1' }),
  ].join('\n'),
  [`${DIR}/subagents/workflows/wf_f671639d-9ad/agent-a7641549d1168add9.jsonl`]: [
    use('toolu_p0', DIED - 248_000, {
      command: '/srv/scratch/tools/imagegen-venv/bin/python -I mtest.py birefnet-portrait',
    }),
    result('toolu_p0', DIED + 250, 'Exit code 137'),
  ].join('\n'),
  [`${DIR}/subagents/workflows/wf_f671639d-9ad/agent-a473f9508cd41a420.jsonl`]: [
    use('toolu_s1', DIED - 100_000, { command: 'blender -b shipgen.py' }),
    result('toolu_s1', DIED + 300, 'Exit code 137'),
    use('toolu_old', DIED - 9 * 3600_000, { command: 'ancient' }),
  ].join('\n'),
  [`${DIR}/subagents/workflows/wf_91528cfa-873/journal.jsonl`]: [
    line({ type: 'started', key: 'm1', agentId: 'x1', label: 'M0-01' }),
    line({ type: 'result', key: 'm1', agentId: 'x1' }),
    line({ type: 'started', key: 'm4', agentId: 'x4', label: 'M0-04' }),
  ].join('\n'),
  [`${DIR}/workflows/scripts/cinderwake-assets-w1-wf_f671639d-9ad.js`]: '',
  [`${DIR}/workflows/scripts/cinderwake-m0-wf_91528cfa-873.js`]: '',
  // A finished run has its summary file and is not listed.
  [`${DIR}/subagents/workflows/wf_6b64d19c-f07/journal.jsonl`]: line({ type: 'launched' }),
  [`${DIR}/workflows/wf_6b64d19c-f07.json`]: '{}',
}

describe('Claude Code transcript adapter', () => {
  const facts = claudeTranscriptFacts(reader(transcriptFiles), MAIN, DIED, 1000)

  it('finds the killed calls, their lanes, and the likely culprit', () => {
    expect(facts?.killed.map((call) => [call.where, call.outcome])).toEqual([
      ['wf_f671639d-9ad AS-P0', 'exit 137'],
      ['wf_f671639d-9ad AS-S1', 'exit 137'],
    ])
    expect(likelyCulprit(facts?.killed ?? [], 'python')?.where).toBe('wf_f671639d-9ad AS-P0')
    expect(likelyCulprit(facts?.killed ?? [], null)?.where).toBe('wf_f671639d-9ad AS-S1')
  })

  it('lists unfinished workflows, lost background jobs and the last owner instruction', () => {
    expect(facts?.workflows).toEqual([
      {
        runId: 'wf_91528cfa-873',
        name: 'cinderwake-m0',
        scriptPath: `${DIR}/workflows/scripts/cinderwake-m0-wf_91528cfa-873.js`,
        done: 1,
        inFlight: ['M0-04'],
      },
      {
        runId: 'wf_f671639d-9ad',
        name: 'cinderwake-assets-w1',
        scriptPath: `${DIR}/workflows/scripts/cinderwake-assets-w1-wf_f671639d-9ad.js`,
        done: 0,
        inFlight: ['AS-P0', 'AS-S1'],
      },
    ])
    expect(facts?.lostBackground.map((job) => job.id)).toEqual(['bw9n91ahz'])
    expect(facts?.lastOwner?.text).toBe('keep going autonomously until done')
    expect(facts?.openMainCalls).toEqual([])
  })
})

describe('synopsis', () => {
  const victim = victimsInScope(kernelOomVictims(parseJournal(kernelJournal)), SCOPE)[0] ?? null
  const base: CrashFacts = {
    kind: 'pane-stopped',
    cause: 'oom-kill',
    signal: null,
    victim,
    agentWasHog: false,
    diedAt: DIED,
    resumedAt: DIED + 8 * 3600_000,
    attempt: 1,
    maxAttempts: 2,
    detailFile: '/h/.local/state/tether/default/recovery/236eb8e2-2026-10-16T03-27-58-651Z.md',
    git: parseGitState(
      'defade4\t1792120620\tM0-03: world streaming\n',
      ' M game/autoload/a.gd\n M game/world/b.gd\n M tools/x.py\n?? tools/imagegen/out/\n?? docs/n.md\n',
    ),
    transcript: claudeTranscriptFacts(reader(transcriptFiles), MAIN, DIED, 1000),
    leases: ['cinderwake: tools/imagegen/** leased by cc:3e0161 (idle 25s)'],
  }

  it('states cause, culprit, state and the first steps within 2000 bytes', () => {
    const text = renderSynopsis(base)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000)
    expect(isBoundedTerminalText(text)).toBe(true)
    expect(text).toContain('down 8h')
    expect(text).toContain('the kernel killed python pid 192829 at 13.2 GB')
    expect(text).toContain(
      'Likely culprit: wf_f671639d-9ad AS-P0 ran `/srv/scratch/tools/imagegen-venv/bin/python',
    )
    expect(text).toContain('Killed: wf_f671639d-9ad AS-S1')
    expect(text).toContain('HEAD defade4')
    expect(text).toContain('3 modified, 2 untracked')
    expect(text).toContain('Your leases are still held.')
    expect(text).toContain('wf_91528cfa-873 (cinderwake-m0: 1 done, in flight M0-04)')
    expect(text).toContain('automatic recovery 1 of 2')
    expect(text).toContain('Workflow({scriptPath, resumeFromRunId})')
    expect(text).toContain('keep going autonomously until done')
    expect(text).not.toContain('memory hog')
  })

  it('warns an agent that was itself the hog, and drops the workflow step for Codex', () => {
    const hog = renderSynopsis({
      ...base,
      kind: 'agent-exited',
      cause: 'oom-kill',
      signal: 9,
      agentWasHog: true,
      victim: victim && { ...victim, comm: 'codex', pid: 42 },
      transcript: null,
    })
    expect(hog).toContain('the kernel killed your own process (codex pid 42')
    expect(hog).toContain('Warning: your own process was the memory hog.')
    expect(hog).not.toContain('Workflow(')
    expect(hog).not.toContain('Open main-thread calls')
  })

  it('says the tmux server vanished while the agent ran', () => {
    const lost = renderSynopsis({ ...base, kind: 'server-died', cause: SERVER_LOST, victim: null })
    expect(lost).toContain('the tmux server holding your pane died while you were running')
    expect(lost).not.toContain('(lost)')
  })

  it('says every process in the pane was killed from outside', () => {
    const killed = renderSynopsis({ ...base, cause: PANE_KILLED, victim: null, transcript: null })
    expect(killed).toContain('every process in your pane was killed from outside')
    expect(killed).not.toContain('result killed')
    // When the kernel OOM-killed a process as the pane went, that is the cause.
    const oom = renderSynopsis({ ...base, cause: PANE_KILLED, transcript: null })
    expect(oom).not.toContain('no memory kill')
    expect(oom).toMatch(
      /the kernel killed \S+ pid \d+ at .* in your pane and every process in it ended/,
    )
  })

  it('says about when only the detection time is known', () => {
    const exact = renderSynopsis(base)
    expect(exact).toMatch(/^Recovery: this session crashed at [0-9][0-9 :-]+ and /)
    expect(exact).toContain('(down 8h)')
    const approx = renderSynopsis({ ...base, diedAtApprox: true })
    expect(approx).toMatch(/^Recovery: this session crashed at about [0-9][0-9 :-]+ and /)
    expect(approx).toContain('(down about 8h)')
    const detail = renderDetail(
      { ...base, diedAtApprox: true },
      {
        synopsis: approx,
        unitLines: [],
        kernelLines: [],
        memctlLines: [],
        memoryEvents: null,
        leases: [],
      },
    )
    expect(detail).toMatch(/^# Crash recovery, about 2026-10-1[56] /)
  })

  it('says the owner resumed a held crash instead of counting it', () => {
    const manual = renderSynopsis({ ...base, attempt: 0, manual: true })
    expect(manual).toContain('Tether held this crash and the owner resumed it.')
    expect(manual).not.toContain('automatic recovery')
  })

  it('stays within the limit when every list is long', () => {
    const transcript = base.transcript && {
      ...base.transcript,
      killed: Array.from({ length: 40 }, (_, index) => ({
        where: `wf_x lane-${index}-${'z'.repeat(40)}`,
        agentId: null,
        runId: 'wf_x',
        command: 'python '.repeat(60),
        startedAt: DIED - index,
        outcome: 'exit 137',
        background: false,
        transcript: MAIN,
      })),
      workflows: Array.from({ length: 10 }, (_, index) => ({
        runId: `wf_${index}`,
        name: 'n'.repeat(80),
        scriptPath: null,
        done: 3,
        inFlight: Array.from({ length: 20 }, (__, lane) => `lane-${lane}`),
      })),
      lastOwner: { at: DIED, text: 'x'.repeat(5000) },
    }
    const text = renderSynopsis({ ...base, transcript })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000)
    expect(isBoundedTerminalText(text)).toBe(true)
  })

  it('writes the detail file with the raw evidence', () => {
    const detail = renderDetail(base, {
      synopsis: 'S',
      unitLines: ['u1'],
      kernelLines: victim?.lines ?? [],
      memctlLines: ['memctl: red'],
      memoryEvents: null,
      leases: base.leases,
    })
    expect(detail).toContain('## Kernel OOM records')
    expect(detail).toContain('Killed process 192829 (python)')
    expect(detail).toContain('agent a7641549d1168add9')
    expect(detail).toContain('bw9n91ahz')
    expect(detail).toContain(' M game/autoload/a.gd')
  })
})

describe('a resumed prompt stays one the launch accepts', () => {
  const base = {
    id: 'aaaa1111',
    tool: 'claude-code',
    kind: 'server-died',
    cause: 'server-lost',
    signal: null,
    victim: null,
    agentWasHog: false,
    diedAt: 1_000_000,
    diedAtApprox: false,
    resumedAt: 1_060_000,
    attempt: 1,
    maxAttempts: 2,
    windowHours: 6,
    transcript: null,
    git: null,
    leases: [],
    detailFile: '/x/detail.md',
  } as unknown as CrashFacts

  it('holds to the byte limit with long wide text, and never cuts a character in half', () => {
    const lost = Array.from({ length: 8 }, (_, index) => ({
      at: 1_000_000 + index,
      text: '\u6f22\u5b57'.repeat(400) + '\u{1f600}'.repeat(50),
    }))
    const prompt = renderSynopsis({ ...base, lost, lostFile: '/x/lost.txt' })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(2000)
    expect(Buffer.from(prompt).toString('utf8')).toBe(prompt)
    expect(prompt).not.toContain('\uFFFD')
  })

  it('marks text rebuilt from moved keys as rough', () => {
    const prompt = renderSynopsis({
      ...base,
      lost: [{ at: 1_000_000, text: 'moved keys', approx: true }],
    })
    expect(prompt).toMatch(/\(roughly\): moved keys/)
  })
})

describe('a call the turn left unanswered', () => {
  it('is not in flight once a Codex turn ended', () => {
    const rows = [
      {
        timestamp: new Date(1000).toISOString(),
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'c1', name: 'exec', arguments: 'x' },
      },
      {
        timestamp: new Date(2000).toISOString(),
        type: 'event_msg',
        payload: { type: 'turn_aborted' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')
    const read = codexTranscriptFacts(reader({ '/r.jsonl': `${rows}\n` }), '/r.jsonl', 5000)
    expect(read?.killed).toEqual([])
    expect(read?.turnOver).toBe(true)
  })

  it('is no culprit when only a subagent mid-reply was running', () => {
    const call = {
      where: 'x',
      command: 'mid-reply',
      startedAt: null,
      outcome: 'in flight',
      background: true,
    }
    expect(likelyCulprit([call] as never, null)).toBeNull()
  })
})

describe('what a crash took, and what it did not', () => {
  const row = (value: unknown) => `${JSON.stringify(value)}\n`
  const at = (ms: number) => new Date(ms).toISOString()
  const said = (text: string, when: number) =>
    row({
      type: 'user',
      timestamp: at(when),
      origin: { kind: 'human' },
      message: { content: text },
    })
  const turnEnd = (when: number) =>
    row({ type: 'system', subtype: 'turn_duration', timestamp: at(when) })
  const reply = (when: number) =>
    row({
      type: 'assistant',
      timestamp: at(when),
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    })
  const facts = (text: string) => claudeTranscriptFacts(reader({ [MAIN]: text }), MAIN, DIED, 1000)
  const crash = (overrides: Partial<CrashFacts>): CrashFacts => ({
    kind: 'server-died',
    cause: SERVER_LOST,
    signal: null,
    victim: null,
    agentWasHog: false,
    diedAt: DIED,
    resumedAt: DIED + 120_000,
    attempt: 1,
    maxAttempts: 2,
    detailFile: '/s/recovery/d.md',
    git: null,
    transcript: null,
    leases: [],
    ...overrides,
  })

  it('finds a queued message that never reached the agent, as at 11:29', () => {
    const lost = facts(
      said('earlier', DIED - 60_000) +
        row({
          type: 'queue-operation',
          operation: 'enqueue',
          content: 'the one that was lost',
          timestamp: at(DIED - 5_000),
        }) +
        row({ type: 'queue-operation', operation: 'dequeue', timestamp: at(DIED - 4_000) }),
    )
    expect(lost?.unread.map((item) => item.text)).toEqual(['the one that was lost'])
    expect(lost?.turnOver).toBe(false)
  })

  it('does not call a queued message lost once it reached the agent', () => {
    const queued = (content: string, operation = 'enqueue', reason?: string) =>
      row({
        type: 'queue-operation',
        operation,
        content,
        timestamp: at(DIED - 9_000),
        ...(reason ? { reason } : {}),
      })
    const read = facts(
      queued('as a prompt') +
        said('as a prompt', DIED - 8_000) +
        queued('mid-turn') +
        queued('mid-turn', 'remove', 'absorbed_mid_turn') +
        queued('/compact') +
        queued('after a resume'),
    )
    expect(read?.unread.map((item) => item.text)).toEqual(['after a resume'])
    const resumed = facts(
      queued('shown in a resume') + said('Recovery: this session crashed at 11:29', DIED - 1_000),
    )
    expect(resumed?.unread).toEqual([])
  })

  it('names a report that finished and never arrived, not as still running', () => {
    const report =
      '<task-notification><task-id>abc123</task-id><status>completed</status><summary>Agent "Seeker" finished</summary></task-notification>'
    const read = facts(
      row({
        type: 'queue-operation',
        operation: 'enqueue',
        content: report,
        timestamp: at(DIED - 5_000),
      }),
    )
    expect(read?.finishedUnread).toEqual([{ id: 'abc123', summary: 'Agent "Seeker" finished' }])
    expect(read?.unread).toEqual([])
    const text = renderSynopsis(crash({ transcript: read }))
    expect(text).toContain('the report never reached you: Agent "Seeker" finished (abc123)')
  })

  it('tells an idle session it was idle and invents no work', () => {
    const read = facts(
      said('thanks', DIED - 3600_000) + reply(DIED - 3590_000) + turnEnd(DIED - 3590_000),
    )
    expect(read?.turnOver).toBe(true)
    const text = renderSynopsis(crash({ transcript: read }))
    expect(text).toContain('You were idle')
    expect(text).toContain("Don't start anything")
    expect(text).not.toContain('Continue')
    expect(text).not.toContain('Do first')
    expect(Buffer.byteLength(text)).toBeLessThan(500)
  })

  it('an idle session that lost text gets the text, not an order to wait', () => {
    const read = facts(said('thanks', DIED - 3600_000) + turnEnd(DIED - 3590_000))
    const text = renderSynopsis(
      crash({
        transcript: read,
        lost: [{ at: DIED - 1_000, text: 'do this next' }],
      }),
    )
    expect(text).toContain('You were idle')
    expect(text).toContain('do this next')
    expect(text).toContain('do not act on any of it twice')
    expect(text).not.toContain("Don't start anything")
  })

  it('a turn in progress is not idle, and a later row reopens an ended turn', () => {
    expect(facts(turnEnd(DIED - 9_000) + said('more', DIED - 8_000))?.turnOver).toBe(false)
  })

  it('states what was in flight and the rule for live facts, without tool ids', () => {
    const read = facts(
      said('go', DIED - 60_000) +
        row({
          type: 'assistant',
          timestamp: at(DIED - 10_000),
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'Write',
                input: { file_path: '/p/half.py', content: 'x' },
              },
            ],
          },
        }),
    )
    expect(read?.killed[0]?.file).toBe('/p/half.py')
    const text = renderSynopsis(
      crash({
        transcript: read,
        recentFiles: recentFiles(read, [], () => null, DIED),
        since: ['2 commits (a / b)', 'deploy abc1234 ok'],
      }),
    )
    expect(text).toContain('Killed: your main thread')
    expect(text).toContain('May be half-written')
    expect(text).toContain('/p/half.py')
    expect(text).toContain('Since it went down: 2 commits (a / b); deploy abc1234 ok.')
    expect(text).toContain('Re-verify anything live')
    expect(text).toContain('Commit only your own paths')
    expect(text).toContain('Continue the owner')
    expect(text).not.toContain('toolu_')
    expect(text).not.toContain('Find out what ended')
  })

  it('names killed subagents so the parent resumes them', () => {
    const sub = `${dirname(MAIN)}/${basename(MAIN, '.jsonl')}/subagents/agent-a1.jsonl`
    const read = claudeTranscriptFacts(
      reader({
        [MAIN]: said('go', DIED - 60_000),
        [sub]: row({
          type: 'assistant',
          timestamp: at(DIED - 10_000),
          message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'thinking' }] },
        }),
        [sub.replace(/\.jsonl$/, '.meta.json')]: JSON.stringify({ description: 'Check logs' }),
      }),
      MAIN,
      DIED,
      1000,
    )
    expect(read?.turnOver).toBe(false)
    const text = renderSynopsis(crash({ transcript: read }))
    expect(text).toContain('resume each you still need with SendMessage')
    expect(text).toContain('Check logs (a1)')
  })

  it('stays within a prompt, with long lost text left in its file', () => {
    const read = facts(said('go', DIED - 60_000))
    const text = renderSynopsis(
      crash({
        transcript: read,
        lost: [
          { at: DIED - 2_000, text: 'first line\nsecond line '.repeat(300), from: 'aaaa1111' },
          { at: DIED - 1_000, text: 'half typed', typed: true },
        ],
        lostFile: '/s/recovery/x-lost.txt',
      }),
    )
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000)
    expect(isBoundedTerminalText(text)).toBe(true)
    expect(text).toContain('All of it: /s/recovery/x-lost.txt')
    expect(text).toContain('from session aaaa1111')
    expect(text).toContain('still being typed, never sent')
    expect(text).toContain('Continue the owner')
  })

  it('leaves lost text out of the detail file', () => {
    const synopsis = renderSynopsis(crash({ lost: [{ at: DIED, text: 'private words' }] }))
    expect(synopsis).toContain('private words')
    const detail = renderDetail(crash({ lost: [{ at: DIED, text: 'private words' }] }), {
      synopsis,
      unitLines: [],
      kernelLines: [],
      memctlLines: [],
      memoryEvents: null,
      leases: [],
    })
    expect(detail).not.toContain('private words')
  })

  it('says the machine went down, and restores carry no attempt count', () => {
    const text = renderSynopsis(crash({ cause: MACHINE_DOWN, boot: true, attempt: 0 }))
    expect(text).toContain('the machine went down')
    expect(text).not.toContain('automatic recovery')
    expect(text).not.toContain('If your last command')
  })

  it('files: what a killed call wrote, then recent changes; none with nothing in flight', () => {
    const read = facts(
      said('go', DIED - 60_000) +
        row({
          type: 'assistant',
          timestamp: at(DIED - 10_000),
          message: {
            content: [
              { type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/p/edited' } },
            ],
          },
        }),
    )
    const times: Record<string, number> = {
      fresh: DIED - 60_000,
      old: DIED - 600_000,
      late: DIED + 60_000,
    }
    const mtime = (path: string) => times[path] ?? null
    expect(recentFiles(read, ['fresh', 'old', 'late', 'gone'], mtime, DIED)).toEqual([
      '/p/edited',
      'fresh',
    ])
    expect(recentFiles(facts(turnEnd(DIED - 9_000)), ['fresh'], mtime, DIED)).toEqual([])
    expect(statusPaths(' M a/b\n?? c\nR  d -> e\n')).toEqual(['a/b', 'c', 'e'])
    expect(gapCommits('')).toEqual([])
    expect(gapCommits('abc one\ndef two\n')).toEqual(['2 commits (one / two)'])
  })

  describe('Codex rollouts', () => {
    const item = (when: number, payload: unknown) =>
      row({ timestamp: at(when), type: 'response_item', payload })
    const event = (when: number, type: string) =>
      row({ timestamp: at(when), type: 'event_msg', payload: { type } })
    const read = (text: string) =>
      codexTranscriptFacts(reader({ '/r.jsonl': text }), '/r.jsonl', DIED)
    const user = (text: string, when: number) =>
      item(when, { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

    it('sees an open call and a patch it was writing', () => {
      const facts = read(
        event(DIED - 20_000, 'task_started') +
          user('<environment_context>x</environment_context>', DIED - 20_000) +
          user('fix it', DIED - 19_000) +
          item(DIED - 9_000, {
            type: 'function_call',
            call_id: 'done',
            name: 'exec',
            arguments: 'ls',
          }) +
          item(DIED - 8_000, { type: 'function_call_output', call_id: 'done', output: 'ok' }) +
          item(DIED - 5_000, {
            type: 'custom_tool_call',
            call_id: 'open',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n',
          }) +
          '{"timestamp":"torn',
      )
      expect(facts?.lastOwner?.text).toBe('fix it')
      expect(facts?.turnOver).toBe(false)
      expect(facts?.killed.map((call) => call.file)).toEqual(['src/a.ts'])
      const text = renderSynopsis(crash({ transcript: facts, kind: 'server-died' }))
      expect(text).toContain('Killed: your main thread')
      expect(text).toContain('"fix it"')
    })

    it('sees an idle session as idle', () => {
      const facts = read(
        event(DIED - 20_000, 'task_started') +
          user('fix it', DIED - 19_000) +
          event(DIED - 9_000, 'task_complete'),
      )
      expect(facts?.turnOver).toBe(true)
      expect(renderSynopsis(crash({ transcript: facts }))).toContain('You were idle')
    })
  })

  describe('Pi session files', () => {
    const message = (when: number, value: unknown) =>
      row({ type: 'message', timestamp: at(when), message: value })
    const read = (text: string) => piTranscriptFacts(reader({ '/p.jsonl': text }), '/p.jsonl', DIED)

    it('sees an open call', () => {
      const facts = read(
        message(DIED - 20_000, { role: 'user', content: [{ type: 'text', text: 'fix it' }] }) +
          message(DIED - 9_000, {
            role: 'assistant',
            stopReason: 'toolUse',
            content: [
              {
                type: 'toolCall',
                id: 'c1',
                name: 'write',
                arguments: { path: 'src/a.ts', content: 'x' },
              },
            ],
          }),
      )
      expect(facts?.lastOwner?.text).toBe('fix it')
      expect(facts?.turnOver).toBe(false)
      expect(facts?.killed.map((call) => call.file)).toEqual(['src/a.ts'])
    })

    it('an answered call and a finished reply read as idle', () => {
      const facts = read(
        message(DIED - 20_000, { role: 'user', content: 'fix it' }) +
          message(DIED - 19_000, {
            role: 'assistant',
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
          }) +
          message(DIED - 18_000, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash' }) +
          message(DIED - 17_000, {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'done' }],
          }),
      )
      expect(facts?.killed).toEqual([])
      expect(facts?.turnOver).toBe(true)
    })
  })
})
