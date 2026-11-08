import type { StatusRow } from '@aico/status'
import { describe, expect, it } from 'vitest'
import type { Device, PhoneSender, SendResult } from './fcm'
import { type AskPort, type AskRequest, NeedsYou, THAT_WAS_ME } from './needs-you'
import { parseNotice } from './notice'
import { Notifier } from './notifier'
import { backoff, FIRST_BACKOFF_MS, GIVE_UP_MS, Outbox } from './outbox'
import { NotifyStore } from './store'

const device: Device = { id: 'dev1', fcmToken: 't', encPub: 'k', auth: 'a' }

function fakeSender(results: SendResult[], devices: Device[] | null = [device]) {
  const sent: string[] = []
  const sender: PhoneSender = {
    devices: () => devices,
    send: async (_device, plaintext) => {
      sent.push(JSON.parse(plaintext.toString()).id)
      return results.shift() ?? 'sent'
    },
  }
  return { sender, sent }
}

const warning = parseNotice({
  v: 1,
  source: 'aico',
  severity: 'warning',
  title: 'Disk almost full',
  body: '/srv is 95% full.',
  key: 'disk:/srv',
})

function setup(results: SendResult[] = [], devices: Device[] | null = [device]) {
  let now = 1_000_000
  const store = new NotifyStore(':memory:')
  const { sender, sent } = fakeSender(results, devices)
  const outbox = new Outbox({ store, sender, publicHost: 'aico.example', now: () => now })
  return {
    store,
    outbox,
    sent,
    at: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('the outbox', () => {
  it('sends each notice once per phone; a repeat inside the cooldown is logged, not queued', async () => {
    const { store, outbox, sent, advance, at } = setup()
    const first = store.accept(warning, 'local', ['dev1'], at())
    expect(first.repeat).toBe(false)
    expect(await outbox.kick()).toBe(1)
    advance(60_000)
    expect(store.accept(warning, 'local', ['dev1'], at())).toEqual({ id: first.id, repeat: true })
    expect(await outbox.kick()).toBe(0)
    expect(sent).toEqual([first.id])
    expect(store.get(first.id)).toMatchObject({
      repeats: 1,
      deliveries: [{ device: 'dev1', state: 'sent', attempts: 1, result: 'sent' }],
    })
    advance(3600_000)
    expect(store.accept(warning, 'local', ['dev1'], at()).repeat).toBe(false)
  })

  it('a problem that comes back after its recovery is stored and queued again', async () => {
    const { store, outbox, sent, advance, at } = setup()
    const first = store.accept(warning, 'local', ['dev1'], at())
    advance(1_000)
    const ok = store.accept(
      { ...warning, severity: 'ok', title: 'Disk fine' },
      'local',
      ['dev1'],
      at(),
    )
    expect(ok.repeat).toBe(false)
    advance(1_000)
    const back = store.accept(warning, 'local', ['dev1'], at())
    expect(back.repeat).toBe(false)
    expect(back.id).not.toBe(first.id)
    expect(store.get(ok.id)?.repeats).toBe(0)
    expect(store.list().map((n) => n.id)).toContain(back.id)
    await outbox.kick()
    expect(sent).toEqual([first.id, ok.id, back.id])
    // and one more of the same inside the cooldown is a repeat of the new one
    advance(1_000)
    expect(store.accept(warning, 'local', ['dev1'], at())).toEqual({ id: back.id, repeat: true })
  })

  it('retries with a growing wait, then gives up after a day', async () => {
    const { store, outbox, sent, advance, at } = setup(Array(100).fill('retry'))
    const { id } = store.accept(warning, 'local', ['dev1'], at())
    await outbox.kick()
    expect(store.get(id)?.deliveries[0]).toMatchObject({ state: 'pending', attempts: 1 })
    advance(FIRST_BACKOFF_MS - 1)
    await outbox.kick()
    expect(sent).toHaveLength(1)
    advance(1)
    await outbox.kick()
    expect(sent).toHaveLength(2)
    expect(backoff(1)).toBe(2 * FIRST_BACKOFF_MS)
    expect(backoff(30)).toBe(15 * 60_000)
    advance(GIVE_UP_MS)
    await outbox.kick()
    expect(store.get(id)?.deliveries[0]).toMatchObject({ state: 'failed', result: 'retry' })
  })

  it('never resends a row a stopped process left mid-send', async () => {
    const { store, outbox, sent, at } = setup()
    const { id } = store.accept(warning, 'local', ['dev1'], at())
    expect(store.claimDue(at())).toHaveLength(1)
    // The process stops here; the next one recovers first.
    expect(outbox.recover()).toBe(1)
    await outbox.kick()
    expect(sent).toEqual([])
    expect(store.get(id)?.deliveries[0]?.state).toBe('unsure')
    expect(outbox.statusRow('host', 30_000)).toMatchObject({
      id: 'host/notify-outbox',
      state: 'failed',
    })
  })

  it('gives up on a gone phone and says so in its Status row', async () => {
    const { store, outbox, at } = setup(['gone'])
    store.accept(warning, 'local', ['dev1'], at())
    await outbox.kick()
    const row = outbox.statusRow('host', 30_000)
    expect(row.state).toBe('failed')
    expect(row.meaning).toContain('1 alert not delivered')
    expect(row.meaning).toContain('Last: gone')
    expect(row.next_run).toBe(new Date(at() + 60_000).toISOString())
  })

  it('marks a send that may have gone out unsure and never sends it again', async () => {
    const { store, outbox, sent, advance, at } = setup(['unsure'])
    const { id } = store.accept(warning, 'local', ['dev1'], at())
    await outbox.kick()
    advance(GIVE_UP_MS / 2)
    await outbox.kick()
    expect(sent).toEqual([id])
    expect(store.get(id)?.deliveries[0]).toMatchObject({ state: 'unsure', result: 'unsure' })
  })

  it('keeps alerts waiting while the phones file is unreadable, then sends them', async () => {
    let devices: Device[] | null = null
    let now = 1_000_000
    const store = new NotifyStore(':memory:')
    const sent: string[] = []
    const sender: PhoneSender = {
      devices: () => devices,
      send: async (_device, plaintext) => {
        sent.push(JSON.parse(plaintext.toString()).id)
        return 'sent'
      },
    }
    const outbox = new Outbox({ store, sender, publicHost: null, now: () => now })
    const needsYou = new NeedsYou({ store, asks: new FakeAsks() })
    const notifier = new Notifier({
      store,
      sender,
      outbox,
      needsYou,
      now: () => now,
      log: () => {},
    })
    const raw = {
      v: 1,
      source: 'aico',
      severity: 'warning',
      title: 'T',
      body: 'B',
      push: 'phone',
      interrupt: 'needs-you',
    }
    const queued = notifier.receive(raw, 'local')
    const early = notifier.receive({ ...raw, title: 'T2' }, 'local')
    await outbox.kick()
    expect(store.get(queued.id)?.deliveries).toEqual([
      { device: '*', state: 'pending', attempts: 1, result: "can't read the paired phones" },
    ])
    // One unreadable read is not yet a problem; still unreadable a pass later warns.
    expect(outbox.statusRow('host', 30_000).state).toBe('ok')
    now += 11 * 60_000
    const row = outbox.statusRow('host', 30_000)
    expect(row).toMatchObject({ state: 'warn' })
    expect(row.meaning).toContain("Can't read the paired phones, so alerts wait until it can.")
    devices = [device, { ...device, id: 'dev2' }]
    await outbox.kick()
    expect(sent.sort()).toEqual([early.id, early.id, queued.id, queued.id].sort())
    expect(store.get(queued.id)?.deliveries.map((d) => [d.device, d.state])).toEqual([
      ['dev1', 'sent'],
      ['dev2', 'sent'],
    ])
    expect(outbox.statusRow('host', 30_000).state).toBe('ok')
  })

  it('is ok when everything went out, and warns with no paired phone', async () => {
    const ok = setup()
    ok.store.accept(warning, 'local', ['dev1'], ok.at())
    await ok.outbox.kick()
    expect(ok.outbox.statusRow('host', 30_000)).toMatchObject({
      state: 'ok',
      meaning: 'Sent 1 alert to the phone in the last day.',
    })
    expect(setup([], []).outbox.statusRow('host', 30_000).state).toBe('warn')
  })
})

class FakeAsks implements AskPort {
  created: AskRequest[] = []
  closed: [string, string][] = []
  async create(ask: AskRequest): Promise<string> {
    this.created.push(ask)
    return `ask${this.created.length}`
  }
  async close(id: string, how: 'done' | 'withdraw'): Promise<void> {
    this.closed.push([id, how])
  }
}

const row = (state: StatusRow['state']): StatusRow => ({
  id: 'davion-sidarli/backup',
  what: 'Nightly backup',
  kind: 'backup',
  machine: 'davion-sidarli',
  state,
  meaning: state === 'failed' ? 'Drive refused the upload.' : 'Copied.',
  actions: [{ kind: 'run', ref: 'aico jobs run backup' }],
})

describe('Needs you', () => {
  it('leaves ordinary failed rows to Status instead of asking the owner', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    await new NeedsYou({ store, asks }).rowsWritten([row('failed')])
    expect(asks.created).toEqual([])
    expect(store.rowAsk(row('failed').id)).toBeNull()
    store.close()
  })

  it('uses only the explicitly owner-only action in a failed row ask', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const owner = { kind: 'run' as const, ref: 'owner-approved action', owner_only: true }
    await new NeedsYou({ store, asks }).rowsWritten([
      { ...row('failed'), actions: [...(row('failed').actions ?? []), owner] },
    ])
    expect(asks.created).toMatchObject([{ command: 'owner-approved action' }])
    store.close()
  })

  it('withdraws an old failed-row ask when the row has no owner-only action', async () => {
    const store = new NotifyStore(':memory:')
    store.setRowAsk(row('failed').id, 'legacy-ask', 0)
    const asks = new FakeAsks()
    await new NeedsYou({ store, asks }).rowsWritten([row('failed')])
    expect(asks.created).toEqual([])
    expect(asks.closed).toEqual([['legacy-ask', 'withdraw']])
    expect(store.rowAsk(row('failed').id)).toBeNull()
    store.close()
  })

  it('raises one ask for a failing owner-only action and withdraws it when the row recovers', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const needsYou = new NeedsYou({ store, asks })
    const action = { kind: 'run' as const, ref: 'aico jobs run backup', owner_only: true }
    const failed = { ...row('failed'), actions: [action] }
    await needsYou.rowsWritten([failed])
    await needsYou.rowsWritten([failed])
    expect(asks.created).toEqual([
      {
        requester: 'Aico Status',
        question: 'Nightly backup failed on davion-sidarli',
        options: [],
        body: 'Drive refused the upload.',
        command: 'aico jobs run backup',
        open: null,
        origin: 'status',
      },
    ])
    await needsYou.rowsWritten([row('ok')])
    expect(asks.closed).toEqual([['ask1', 'withdraw']])
    await needsYou.rowsWritten([failed])
    expect(asks.created).toHaveLength(2)
    await needsYou.rowRemoved('davion-sidarli/backup')
    expect(asks.closed).toEqual([
      ['ask1', 'withdraw'],
      ['ask2', 'withdraw'],
    ])
  })

  it('sends "That was me" on an OmniNull alert to the hub once, then closes the ask', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const confirmed: string[][] = []
    const needsYou = new NeedsYou({
      store,
      asks,
      verdict: {
        confirmBenign: async (ids) => {
          confirmed.push(ids)
          return 'OmniNull confirmed 2 alerts benign.'
        },
      },
    })
    const alert = parseNotice({
      v: 1,
      source: 'ominull',
      severity: 'critical',
      title: 'New outbound connection from codex',
      body: 'codex reached 203.0.113.9:443.',
      key: 'alerts:a1,a2,a1',
      actions: ['expected', 'not-expected'],
    })
    const { id } = store.accept(alert, 'ominull', [], 0)
    await needsYou.noticeAccepted(id, alert)
    expect(asks.created[0]).toMatchObject({
      requester: 'ominull',
      question: `Was this you? New outbound connection from codex (#${id.slice(0, 6)})`,
      options: ['That was me', 'Not me'],
    })
    const answered = { id: 'ask1', state: 'answered', answer: THAT_WAS_ME }
    await needsYou.askChanged(answered)
    await needsYou.askChanged(answered)
    expect(confirmed).toEqual([['a1', 'a2']])
    expect(store.get(id)).toMatchObject({
      askId: 'ask1',
      answer: THAT_WAS_ME,
      outcome: 'OmniNull confirmed 2 alerts benign.',
    })
    expect(asks.closed).toEqual([['ask1', 'done']])
  })

  it('gives two alerts with the same title their own asks, so "That was me" confirms only its own', async () => {
    const store = new NotifyStore(':memory:')
    // Like Tether: an open ask with the same requester and question is the same ask.
    const byQuestion = new Map<string, string>()
    const asks: AskPort = {
      create: async (ask) => {
        const key = `${ask.requester}\n${ask.question}`
        if (!byQuestion.has(key)) byQuestion.set(key, `ask${byQuestion.size + 1}`)
        return byQuestion.get(key) as string
      },
      close: async () => {},
    }
    const confirmed: string[][] = []
    const needsYou = new NeedsYou({
      store,
      asks,
      verdict: {
        confirmBenign: async (ids) => {
          confirmed.push(ids)
          return 'confirmed'
        },
      },
    })
    const alert = (key: string) =>
      parseNotice({
        v: 1,
        source: 'ominull',
        title: 'New outbound connection',
        body: 'B',
        key,
        actions: ['expected', 'not-expected'],
      })
    const a = store.accept(alert('alerts:a1'), 'ominull', [], 0)
    await needsYou.noticeAccepted(a.id, alert('alerts:a1'))
    const b = store.accept(alert('alerts:b1'), 'ominull', [], 1)
    await needsYou.noticeAccepted(b.id, alert('alerts:b1'))
    expect(store.get(a.id)?.askId).toBe('ask1')
    expect(store.get(b.id)?.askId).toBe('ask2')
    await needsYou.askChanged({ id: 'ask2', state: 'answered', answer: THAT_WAS_ME })
    expect(confirmed).toEqual([['b1']])
  })

  it('carries the item a to-do notice opens into its ask', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const todo = parseNotice({
      v: 1,
      source: 'jobinator',
      kind: 'todo',
      title: 'Follow-ups due',
      body: 'Open Jobinator to see who.',
      open: 'https://jobinator.example/followups',
      actions: ['open', 'done'],
    })
    const { id } = store.accept(todo, 'local', [], 0)
    await new NeedsYou({ store, asks }).noticeAccepted(id, todo)
    expect(asks.created).toEqual([
      {
        requester: 'jobinator',
        question: `Follow-ups due (#${id.slice(0, 6)})`,
        options: ['Done'],
        body: 'Open Jobinator to see who.',
        command: null,
        open: 'https://jobinator.example/followups',
        origin: 'notice',
      },
    ])
    store.close()
  })

  it('gives a todo no Done choice unless its sender offered done (the card is its title and Open link)', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const todo = parseNotice({
      v: 1,
      source: 'aico',
      kind: 'todo',
      title: 'A receipt is waiting for your tap',
      body: 'Open it to send it on.',
      open: 'https://aico.example/captures?id=abc',
      actions: ['open'],
    })
    const { id } = store.accept(todo, 'local', [], 0)
    await new NeedsYou({ store, asks }).noticeAccepted(id, todo)
    expect(asks.created).toHaveLength(1)
    expect(asks.created[0]).toMatchObject({
      options: [],
      open: 'https://aico.example/captures?id=abc',
    })
    store.close()
  })

  it('files no ask for a session waiting notice: the session is already in Needs you, with Open', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    // Exactly what Tether sends (packages/tether/src/aico-notice.ts): an alert to the phone.
    const waiting = parseNotice({
      v: 1,
      source: 'aico',
      kind: 'alert',
      severity: 'warning',
      title: 'Claude Code waiting in Aico codebase cleanup handoff',
      body: 'Open it in Aico to answer.',
      key: 'aico-waiting:fa41c0c8',
      open: 'https://aico.summitflow.dev/?session=fa41c0c8',
      actions: ['open'],
      primary: 'open',
      push: 'phone',
      interrupt: 'needs-you',
    })
    expect(waiting.push).toBe('phone')
    const { id } = store.accept(waiting, 'local', [], 0)
    await new NeedsYou({ store, asks }).noticeAccepted(id, waiting)
    expect(asks.created).toEqual([])
    store.close()
  })

  it('leaves "Not me" open on the hub and files no ask for a plain alert', async () => {
    const store = new NotifyStore(':memory:')
    const asks = new FakeAsks()
    const confirmed: string[][] = []
    const needsYou = new NeedsYou({
      store,
      asks,
      verdict: {
        confirmBenign: async (ids) => {
          confirmed.push(ids)
          return 'sent'
        },
      },
    })
    const alert = parseNotice({
      v: 1,
      source: 'ominull',
      title: 'Sweep',
      body: 'B',
      key: 'alerts:x',
      actions: ['expected', 'not-expected'],
    })
    const { id } = store.accept(alert, 'ominull', [], 0)
    await needsYou.noticeAccepted(id, alert)
    await needsYou.askChanged({ id: 'ask1', state: 'answered', answer: 'Not me' })
    expect(confirmed).toEqual([])
    expect(store.get(id)?.outcome).toBe('Not you: left open on OmniNull.')
    const plain = parseNotice({ v: 1, source: 'aico', title: 'Info', body: 'B' })
    await needsYou.noticeAccepted(store.accept(plain, 'local', [], 0).id, plain)
    expect(asks.created).toHaveLength(1)
  })
})

describe('phone route for info notices', () => {
  const base = {
    v: 1,
    kind: 'info',
    severity: 'info',
    push: 'phone',
    title: 'While you were away',
    body: 'x',
  }
  it('keeps info off the phone', () => {
    // A phone request with no reason stays in the tray; with a reason, info is refused.
    expect(parseNotice({ ...base, source: 'aico', key: 'other:1' }).push).toBe('tray')
    const reason = { ...base, interrupt: 'needs-you' }
    expect(() => parseNotice({ ...reason, source: 'aico', key: 'other:1' })).toThrow(
      /stay on the desktop/,
    )
    expect(parseNotice({ ...base, source: 'jobs', key: 'digest:2026-11-07' }).push).toBe('tray')
  })
  it("lets Aico's morning digest reach the phone", () => {
    expect(parseNotice({ ...base, source: 'aico', key: 'digest:2026-11-07' }).push).toBe('phone')
  })
})
