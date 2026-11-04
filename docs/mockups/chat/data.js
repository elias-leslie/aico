// Made-up chats for the mockup. Nothing here is a real transcript. "Now" is fixed at
// Wed Nov 4, 2:44 PM. Model ids are the ones `aico models route` names for these roles.
window.MOCK = (() => {
  const CHAIN = {
    implementation: ['gpt-6.1-sol', 'deepseek-v4.1-flash', 'glm-5.3'],
    review: ['gpt-6.1-sol', 'deepseek-v4.1-flash', 'glm-5.3'],
    research: ['gpt-6.1-sol', 'deepseek-v4.1-flash', 'glm-5.3'],
    hunting: ['gpt-6-sol', 'deepseek-v4.1-flash', 'glm-5.3'],
  }
  const ROLES = [
    { id: 'implementation', name: 'Implementation', effort: 'xhigh', what: 'Changes code in the folder and runs its checks.' },
    { id: 'review', name: 'Review', effort: 'xhigh', what: 'Reads a change and reports problems. No edits.' },
    { id: 'research', name: 'Research', effort: 'xhigh', what: 'Reads and gathers facts, then answers.' },
    { id: 'hunting', name: 'Hunting', effort: 'xhigh', what: 'Security hunting. No Claude; limited network.' },
  ]
  const PROJECTS = ['aico', 'summitflow', 'nightshift']

  // state: needs | working | idle | stopped | failed | finished
  const CHATS = [
    { id: 'c2', title: 'Which retention for capture uploads?', role: 'research', model: 'gpt-6.1-sol', project: 'aico', state: 'needs', at: '2:37 PM', last: 'Asked you: keep original photos 30 or 90 days?' },
    { id: 'c1', title: 'Notes sync drops edits made offline', role: 'implementation', model: 'glm-5.3', project: 'aico', state: 'working', at: '2:41 PM', last: 'Writing: both edits now survive…' },
    { id: 'c3', title: 'Review: backup restore drill script', role: 'review', model: 'gpt-6.1-sol', project: 'aico', state: 'idle', at: '1:58 PM', last: 'Two problems, one nit. The restore folder isn’t cleaned up when…' },
    { id: 'c4', title: 'Notes sync, branch at turn 3', role: 'implementation', model: 'deepseek-v4.1-flash', project: 'aico', state: 'stopped', at: '11:05 AM', last: 'Stopped mid-reply when Aico restarted.', branchOf: 'Notes sync drops edits made offline' },
    { id: 'c5', title: 'Why is the nightly check slow?', role: 'research', model: 'deepseek-v4.1-flash', project: 'summitflow', state: 'failed', at: 'Yesterday 9:12 PM', last: 'No model answered: all three returned provider errors.' },
    { id: 'c6', title: 'Firewall rule audit on the router', role: 'hunting', model: 'gpt-6-sol', project: 'nightshift', state: 'finished', at: 'Mon 4:20 PM', last: 'Ended. 3 findings written to the report.' },
  ]

  // The open chat (c1). Each assistant turn names the model that answered it.
  const TURNS = [
    { who: 'you', at: '2:12 PM', text: 'Edits I make on the phone while it’s offline sometimes vanish after it reconnects. Find out why and fix it. The sync code is in packages/notes.' },
    {
      who: 'model', turn: 1, model: 'gpt-6.1-sol', at: '2:13 PM', tokens: 'In 18.2K (11.0K from cache) · out 1.4K',
      tools: [
        { kind: 'read', line: 'Read packages/notes/src/sync.ts', note: '312 lines', body: '  88  export async function flushQueue(queue: QueuedEdit[]) {\n  89    for (const edit of queue) {\n  90      const server = await fetchNote(edit.noteId)\n  91      const merged = merge(server, edit)\n  92      if (!merged) continue          // ← a dropped edit leaves no trace\n  93      await saveNote(merged)\n  94    }\n  95  }' },
        { kind: 'read', line: 'Read packages/notes/src/merge.ts', note: '140 lines', body: '  31  export function merge(server: Note, edit: QueuedEdit): Note | null {\n  32    if (edit.baseRev < server.rev) return null\n  33    return { ...server, body: edit.body, rev: server.rev + 1 }\n  34  }' },
        { kind: 'bash', line: 'Ran rg -n "baseRev" packages/notes/src', note: '6 matches', body: 'packages/notes/src/merge.ts:32:  if (edit.baseRev < server.rev) return null\npackages/notes/src/queue.ts:14:  baseRev: number\npackages/notes/src/queue.ts:41:    baseRev: note.rev,\n…' },
      ],
      text: 'Found it. `merge()` drops a queued edit when the note changed on another device while the phone was offline (`edit.baseRev < server.rev`), and `flushQueue()` skips it without a word. So any offline edit to a note you also touched elsewhere is thrown away.\n\nThe fix is to merge the two bodies instead of dropping one, and to keep a revision when they conflict.',
    },
    { who: 'you', at: '2:20 PM', text: 'Before you fix it: could someone replay an old queued edit to overwrite a note? Try building one against the dev server.' },
    {
      who: 'model', turn: 2, model: 'gpt-6.1-sol', at: '2:20 PM', tokens: 'In 21.0K (17.9K from cache) · out 90', refused: true,
      handoff: { kind: 'refusal', from: 'gpt-6.1-sol', to: 'deepseek-v4.1-flash', category: 'cyber policy', detail: 'cyber_policy: The request asks for an exploit payload against a live service.' },
    },
    {
      who: 'model', turn: 3, model: 'deepseek-v4.1-flash', at: '2:22 PM', tokens: 'In 23.4K (0 from cache) · out 980',
      tools: [
        { kind: 'bash', line: 'Ran cat ~/.local/state/aico/secrets/notes-dev.env', withheld: true },
        { kind: 'bash', line: 'Ran curl -X POST localhost:8742/api/notes/n41/edits -d @old-edit.json', note: 'HTTP 409', body: '{"error":"stale_device_key","detail":"edit signed by a device key revoked at 2026-11-01T09:00Z"}' },
      ],
      text: 'A replayed edit is refused. The server checks the device key each edit is signed with, and a revoked phone’s key gets a 409. An edit from a phone that still has a valid key would be accepted, but that is the same as you typing on it.',
    },
    { who: 'you', at: '2:31 PM', text: 'Good. Now fix the merge and add a test.' },
    {
      who: 'model', turn: 4, model: 'deepseek-v4.1-flash', at: '2:31 PM', noAnswer: true,
      handoff: { kind: 'fallback', from: 'deepseek-v4.1-flash', to: 'glm-5.3', category: 'provider error', detail: '502 Bad Gateway from opencode-go after 41 s' },
    },
    {
      who: 'model', turn: 5, model: 'glm-5.3', at: '2:33 PM', tokens: 'In 26.8K (22.1K from cache) · out 2.2K', streaming: true,
      tools: [
        { kind: 'edit', line: 'Edited packages/notes/src/merge.ts', note: '+18 −6', body: '- if (edit.baseRev < server.rev) return null\n- return { ...server, body: edit.body, rev: server.rev + 1 }\n+ if (edit.baseRev === server.rev)\n+   return { ...server, body: edit.body, rev: server.rev + 1 }\n+ const body = mergeText(edit.baseBody, server.body, edit.body)\n+ return {\n+   ...server,\n+   body: body.text,\n+   rev: server.rev + 1,\n+   revisions: body.conflict ? [...server.revisions, edit.body] : server.revisions,\n+ }' },
        { kind: 'write', line: 'Wrote packages/notes/src/merge.test.ts', note: '64 lines', body: 'it(\'keeps an offline edit made while another device saved\', () => {\n  const server = note({ rev: 3, body: \'a\\nb\\nc\' })\n  const edit = queued({ baseRev: 2, baseBody: \'a\\nb\', body: \'a\\nB\' })\n  expect(merge(server, edit).body).toBe(\'a\\nB\\nc\')\n})' },
        { kind: 'bash', line: 'Ran pnpm vitest run merge', note: '1 failed, 11 passed · 4.2 s', body: '✗ merge > keeps a revision when both sides changed the same line\n  expected [] to have length 1' },
        { kind: 'edit', line: 'Edited packages/notes/src/merge.ts', note: '+1 −1', body: '- revisions: body.conflict ? [...server.revisions, edit.body] : server.revisions,\n+ revisions: body.conflict ? [...(server.revisions ?? []), edit.body] : server.revisions,' },
        { kind: 'bash', line: 'Ran pnpm vitest run merge', note: '12 passed · 3.9 s', body: '✓ 12 tests passed' },
      ],
      text: 'Both edits now survive. A queued edit made on an older revision is merged line by line onto the server copy instead of being dropped. When both sides changed the same line, the server copy wins and the phone’s text is kept as a revision you can restore from the note’s history. The new test covers both cases, and all 12 merge tests pass. Next I’ll run the whole notes package and show you the diff.',
    },
  ]

  const DETAILS = {
    run: '7f3c9a12',
    folder: '/srv/workspaces/projects/aico',
    started: '2:12 PM',
    tokens: { input: '89.4K', cache: '51.0K', cacheWrite: '6.2K', output: '4.7K' },
    byModel: [
      ['gpt-6.1-sol', 'turns 1–2', '39.2K', '1.5K'],
      ['deepseek-v4.1-flash', 'turns 3–4', '23.4K', '980'],
      ['glm-5.3', 'turn 5', '26.8K', '2.2K'],
    ],
    toolCalls: '10 (1 output not saved)',
    handoffs: '2: refusal at turn 2, provider error at turn 4',
    compactions: 'none',
  }

  return { CHAIN, ROLES, PROJECTS, CHATS, TURNS, DETAILS }
})()
