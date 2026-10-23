import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBoundedTerminalText } from './lifecycle/tmux'
import { decideRecovery, LOOP_WINDOW_MS, RECOVERY_WINDOW_MS } from './recovery'
import {
  CRASH_RESULTS,
  type CrashFacts,
  claudeTranscriptFacts,
  type FileReader,
  kernelOomVictims,
  likelyCulprit,
  nodeFileReader,
  PANE_KILLED,
  parseGitState,
  parseJournal,
  renderDetail,
  renderSynopsis,
  SERVER_LOST,
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

describe('loop protection', () => {
  const now = DIED + 3600_000
  it('allows the first recovery after the admission settle', () => {
    expect(decideRecovery([], { diedAt: DIED, agentWasHog: false }, now)).toEqual({
      notBefore: now + 60_000,
      attempt: 1,
    })
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
    expect(text).toContain('Also killed mid-run: wf_f671639d-9ad AS-S1')
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
