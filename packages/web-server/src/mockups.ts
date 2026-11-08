// Designs (the mockups an agent adds with `st mockup add`) are files owned by the web server: HTML,
// SVG, images, PDF, Markdown and Mermaid. Tether owns the question and delivers the owner's choice
// to the session that supplied them. Adding a design again with the same title (from the same
// session, before one was chosen) replaces it in place, so a view that is open refreshes.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TetherClient } from '@aico/tether-client'
import {
  DESIGN_KINDS,
  type DesignKind,
  designKindOf,
  IMAGE_CSP,
  isBinaryKind,
  MOCKUP_CSP,
  PDF_CSP,
  sniffMedia,
  viewDocument,
  WRAPPED_CSP,
} from './design-render'
import { objectBody, optionalString, RAW, type Router, requiredString } from './http'
import { HttpError, toHttpError } from './tether'

export { MOCKUP_CSP }

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/** A text design is at most this long; an image or PDF this many bytes. */
const MAX_TEXT = 5 * 1024 * 1024
const MAX_BINARY = 8 * 1024 * 1024
/** Base64 of the biggest file, with its JSON around it. */
const MAX_BODY = 12 * 1024 * 1024

interface StoredMockup {
  id: string
  project: string
  title: string
  note: string
  kind: DesignKind
  /** The text of a text design (named for the HTML it first held); empty for an image or PDF, whose bytes are in files/ID. */
  html: string
  /** What the bytes of an image or PDF are. */
  mime: string | null
  size: number
  session: string | null
  /** The owner's question this design answers; null for a design added without one (a test, a plain add). */
  askId: string | null
  createdAt: string
  /** Last time an agent added this design again (the time it was created, at first). */
  updatedAt: string
  selectedAt: string | null
}

interface MockupAsk {
  id: string
  session: string | null
  requester: string | null
  state: 'open' | 'answered' | 'done' | 'withdrawn'
  answer: string | null
  note: string | null
  delivery?: 'wake' | 'pull' | null
  answerTo?: string | null
}

function line(text: string, field: string): string {
  const value = text.trim()
  if (!value || ONE_LINE_BAD.test(value)) throw new HttpError(422, `${field} must be one line`)
  return value
}

function projectOf(value: string | null): string {
  if (value === null) throw new HttpError(422, 'project is required')
  return line(value, 'project')
}

function noteOf(body: Record<string, unknown>): string {
  // Tether's answer-note contract is at most 1000 characters.
  const note = (optionalString(body, 'note', { max: 1000 }) ?? '').replace(/\r\n?/g, '\n')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls Tether cannot deliver
  if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Cs}\u2028\u2029]/u.test(note))
    throw new HttpError(422, 'note contains unsupported characters')
  return note.trim()
}

/** Where the owner reviews a project's designs: the Designs tab of the Workbench. */
function pageUrl(project: string, id?: string): string {
  const query = new URLSearchParams({ tab: 'designs', project })
  if (id) query.set('design', id)
  return `/workbench?${query}`
}

/** The design that settled this design's question, if one did. A design with no question settles itself. */
function choiceOf(items: StoredMockup[], mockup: StoredMockup): StoredMockup | undefined {
  if (mockup.askId === null) return mockup.selectedAt ? mockup : undefined
  return items.find((item) => item.askId === mockup.askId && item.selectedAt !== null)
}

function itemUrl(mockup: Pick<StoredMockup, 'project' | 'id'>): string {
  return `/api/mockups/${mockup.id}?project=${encodeURIComponent(mockup.project)}`
}

function present(mockup: StoredMockup, items: StoredMockup[]) {
  const { html: _html, ...fields } = mockup
  const chosen = choiceOf(items, mockup)
  return {
    ...fields,
    state: mockup.selectedAt ? 'selected' : chosen ? 'passed' : 'pending',
    viewUrl: itemUrl(mockup).replace('?', '/view?'),
  }
}

/** The row as the file holds it, with what older files lack filled in; null when it doesn't check out. */
function readStored(value: unknown, project?: string): StoredMockup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const kind = row.kind === undefined ? 'html' : row.kind
  const valid =
    typeof row.id === 'string' &&
    ID.test(row.id) &&
    typeof row.project === 'string' &&
    (project === undefined || row.project === project) &&
    typeof row.title === 'string' &&
    typeof row.note === 'string' &&
    typeof row.html === 'string' &&
    DESIGN_KINDS.includes(kind as DesignKind) &&
    (row.mime === undefined || row.mime === null || typeof row.mime === 'string') &&
    (row.session === null || (typeof row.session === 'string' && SESSION.test(row.session))) &&
    (row.askId === null || (typeof row.askId === 'string' && ID.test(row.askId))) &&
    typeof row.createdAt === 'string' &&
    Number.isFinite(Date.parse(row.createdAt)) &&
    (row.updatedAt === undefined ||
      (typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)))) &&
    (row.selectedAt === null ||
      (typeof row.selectedAt === 'string' && Number.isFinite(Date.parse(row.selectedAt))))
  if (!valid) return null
  const text = row as unknown as StoredMockup
  return {
    ...text,
    kind: kind as DesignKind,
    mime: text.mime ?? null,
    size: typeof row.size === 'number' ? row.size : Buffer.byteLength(text.html),
    updatedAt: text.updatedAt ?? text.createdAt,
  }
}

function askOf(value: unknown): MockupAsk {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(502, 'The mockup question could not be read')
  const ask = value as Record<string, unknown>
  if (
    typeof ask.id !== 'string' ||
    !ID.test(ask.id) ||
    !(ask.session === null || (typeof ask.session === 'string' && SESSION.test(ask.session))) ||
    !(ask.requester === null || typeof ask.requester === 'string') ||
    !['open', 'answered', 'done', 'withdrawn'].includes(String(ask.state)) ||
    !(ask.answer === null || typeof ask.answer === 'string') ||
    !(ask.note === null || typeof ask.note === 'string')
  )
    throw new HttpError(502, 'The mockup question could not be read')
  return ask as unknown as MockupAsk
}

function requester(project: string): string {
  // A short, stable requester for a CLI invocation outside a session.
  return `mockups:${createHash('sha256').update(project).digest('hex').slice(0, 12)}`
}

function checkOrigin(
  ask: MockupAsk,
  mockup: Pick<StoredMockup, 'session' | 'project' | 'askId'>,
): void {
  if (
    ask.id !== mockup.askId ||
    ask.session !== mockup.session ||
    (ask.session === null && ask.requester !== requester(mockup.project))
  )
    throw new HttpError(409, 'The mockup question belongs to another session')
}

function answerText(mockup: StoredMockup): string {
  const suffix = ` (${mockup.id})`
  const prefix = 'Use this one: '
  // Tether's text-answer contract is at most 100 characters.
  return (
    prefix +
    Array.from(mockup.title)
      .slice(0, 100 - prefix.length - suffix.length)
      .join('') +
    suffix
  )
}

/** What a POST names as the design: its kind and bytes, checked. `html` alone is the older form. */
function designOf(body: Record<string, unknown>): {
  kind: DesignKind
  html: string
  bytes: Buffer | null
  mime: string | null
  size: number
} {
  const legacy = optionalString(body, 'html')
  const name = optionalString(body, 'name')
  const kind = optionalString(body, 'kind') ?? (name ? designKindOf(name) : null) ?? 'html'
  if (!DESIGN_KINDS.includes(kind as DesignKind))
    throw new HttpError(
      422,
      name && !optionalString(body, 'kind')
        ? `Aico can't show ${name}: use HTML, SVG, PNG, JPEG, GIF, WebP, PDF, Markdown (.md) or Mermaid (.mmd)`
        : `kind must be one of ${DESIGN_KINDS.join(', ')}`,
    )
  if (isBinaryKind(kind as DesignKind)) {
    const data = requiredString(body, 'data')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) throw new HttpError(422, 'data is required')
    if (bytes.length > MAX_BINARY) throw new HttpError(422, 'The file is over 8 MB')
    const media = sniffMedia(bytes)
    if (!media || media.kind !== kind)
      throw new HttpError(
        422,
        `The file is not ${kind === 'pdf' ? 'a PDF' : 'a PNG, JPEG, GIF or WebP image'}`,
      )
    return { kind: media.kind, html: '', bytes, mime: media.type, size: bytes.length }
  }
  // A text file may come as its base64 too (`st mockup add` sends every file that way).
  const data = optionalString(body, 'data')
  const text =
    legacy ??
    (data === undefined
      ? requiredString(body, 'content')
      : Buffer.from(data, 'base64').toString('utf8'))
  if (!text.trim()) throw new HttpError(422, 'content is required')
  const size = Buffer.byteLength(text)
  if (size > MAX_TEXT) throw new HttpError(422, 'The file is over 5 MB')
  return { kind: kind as DesignKind, html: text, bytes: null, mime: null, size }
}

/** The web server is the only writer. Atomic project files keep the text and its review note
 * together (an image or PDF is a file of its own); a project name never becomes a filesystem path. */
export function registerMockupRoutes(
  router: Router,
  options: {
    dataDir: string
    tether: Pick<TetherClient, 'request'>
    /** Where the owner reaches Aico from outside, so a design's question can link to it. */
    publicHost?: string | null
  },
): void {
  const directory = join(options.dataDir, 'mockups')
  const files = join(directory, 'files')
  const file = (project: string) =>
    join(directory, `${createHash('sha256').update(project).digest('hex')}.json`)
  let pending: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = pending.then(run)
    pending = result.catch(() => {})
    return result
  }
  const read = async (path: string): Promise<unknown[] | null> => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? value : []
  }
  const load = async (project: string): Promise<StoredMockup[]> => {
    const rows = await read(file(project))
    if (!rows) return []
    const items = rows.map((row) => readStored(row, project))
    if (items.some((item) => !item)) throw new HttpError(500, 'Saved designs could not be read')
    return items as StoredMockup[]
  }
  /** Every project's designs. A project file that can't be read is counted, not fatal. */
  const loadAll = async (): Promise<{ items: StoredMockup[][]; unreadable: number }> => {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], unreadable: 0 }
      throw error
    }
    const groups: StoredMockup[][] = []
    let unreadable = 0
    for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))) {
      try {
        const rows = (await read(join(directory, name))) ?? []
        const items = rows.map((row) => readStored(row))
        if (items.some((item) => !item)) throw new Error('unreadable')
        if (items.length) groups.push(items as StoredMockup[])
      } catch {
        unreadable += 1
      }
    }
    return { items: groups, unreadable }
  }
  const save = async (project: string, items: StoredMockup[]) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file(project)}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(items), { mode: 0o600 })
    await rename(temporary, file(project))
  }
  const saveBytes = async (id: string, bytes: Buffer) => {
    await mkdir(files, { recursive: true, mode: 0o700 })
    const temporary = join(files, `${id}.${randomBytes(6).toString('hex')}.tmp`)
    await writeFile(temporary, bytes, { mode: 0o600 })
    await rename(temporary, join(files, id))
  }
  const request = async (method: string, path: string, body?: unknown): Promise<MockupAsk> => {
    try {
      return askOf((await options.tether.request<unknown>(method, path, body)).body)
    } catch (error) {
      throw toHttpError(error, 'The mockup question is no longer available')
    }
  }
  const find = async (project: string, id: string) => {
    const items = await load(project)
    const mockup = ID.test(id) && items.find((item) => item.id === id)
    if (!mockup) throw new HttpError(404, 'Design not found')
    return { items, mockup }
  }
  /** The open question a design is waiting on; undefined when it was pruned, closed or is another's. */
  const openAsk = async (mockup: StoredMockup): Promise<MockupAsk | undefined> => {
    if (mockup.askId === null) return undefined
    try {
      const ask = await request('GET', `/v1/asks/${mockup.askId}`)
      checkOrigin(ask, mockup)
      return ask.state === 'open' ? ask : undefined
    } catch (error) {
      // Tether can prune an old question; the saved designs still remain.
      if (error instanceof HttpError && error.status === 404) return undefined
      throw error
    }
  }
  const settled = (items: StoredMockup[], mockup: StoredMockup) => !!choiceOf(items, mockup)

  // Without a project: every project's designs, for the Designs tab.
  router.on('GET', '/api/mockups', async (ctx) => {
    if (ctx.query.get('project') === null) {
      const { items, unreadable } = await loadAll()
      return {
        items: items.flatMap((group) => group.map((item) => present(item, group))),
        unreadable,
      }
    }
    const project = projectOf(ctx.query.get('project'))
    const items = await load(project)
    return { project, items: items.map((item) => present(item, items)) }
  })

  router.on(
    'POST',
    '/api/mockups',
    async (ctx) => {
      const body = objectBody(await ctx.body())
      const project = projectOf(requiredString(body, 'project'))
      const title = line(requiredString(body, 'title'), 'title')
      const design = designOf(body)
      const note = noteOf(body)
      const session = optionalString(body, 'session', { pattern: SESSION }) ?? null
      // `ask: false` adds the design without a question to the owner (a test, or a design nobody has to pick).
      const asked = body.ask !== false
      return serial(async () => {
        const items = await load(project)
        const now = new Date().toISOString()
        // The same design again, before anyone chose: replace it where it is.
        const same = items.findLast(
          (item) => item.title === title && item.session === session && !settled(items, item),
        )
        if (same && (same.askId === null || (await openAsk(same)))) {
          if (design.bytes) await saveBytes(same.id, design.bytes)
          else await rm(join(files, same.id), { force: true })
          Object.assign(same, {
            kind: design.kind,
            html: design.html,
            mime: design.mime,
            size: design.size,
            updatedAt: now,
            note: note || same.note,
          })
          await save(project, items)
          return {
            mockup: present(same, items),
            pageUrl: pageUrl(project, same.id),
            replaced: true,
          }
        }
        const id = randomBytes(6).toString('hex')
        const last = items.findLast((item) => item.session === session && item.askId !== null)
        let ask: MockupAsk | undefined
        if (asked && last && !settled(items, last)) ask = await openAsk(last)
        // The title is plain words (Tether merges asks with the same asker and question, which is what a
        // session's next design should do); the card's Open design button leads to this design.
        if (asked)
          ask ??= await request('POST', '/v1/asks', {
            session,
            requester: session ? null : requester(project),
            question: 'Which design should we use?',
            body: `Project: ${project}`,
            ...(options.publicHost
              ? { open: `https://${options.publicHost}${pageUrl(project, id)}` }
              : {}),
            blocking: false,
          })
        const mockup: StoredMockup = {
          id,
          project,
          title,
          note,
          kind: design.kind,
          html: design.html,
          mime: design.mime,
          size: design.size,
          session,
          askId: ask?.id ?? null,
          createdAt: now,
          updatedAt: now,
          selectedAt: null,
        }
        if (ask) checkOrigin(ask, mockup)
        if (design.bytes) await saveBytes(id, design.bytes)
        items.push(mockup)
        await save(project, items)
        return { mockup: present(mockup, items), pageUrl: pageUrl(project, id), replaced: false }
      })
    },
    { maxBodyBytes: MAX_BODY },
  )

  router.on('PATCH', '/api/mockups/:id', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    const note = noteOf(objectBody(await ctx.body()))
    return serial(async () => {
      const { items, mockup } = await find(project, ctx.params.id)
      if (settled(items, mockup)) throw new HttpError(409, 'This choice has already been sent')
      mockup.note = note
      await save(project, items)
      return { mockup: present(mockup, items) }
    })
  })

  router.on('DELETE', '/api/mockups/:id', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    return serial(async () => {
      const { items, mockup } = await find(project, ctx.params.id)
      const rest = items.filter((item) => item.id !== mockup.id)
      if (rest.length) await save(project, rest)
      else await rm(file(project), { force: true })
      await rm(join(files, mockup.id), { force: true })
      // Nothing is left to choose from: the question goes too (best effort; it may be gone already).
      if (mockup.askId !== null && !rest.some((item) => item.askId === mockup.askId)) {
        try {
          if (await openAsk(mockup)) await request('POST', `/v1/asks/${mockup.askId}/withdraw`)
        } catch {}
      }
      return { removed: mockup.id }
    })
  })

  router.on('POST', '/api/mockups/:id/select', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    const body = objectBody(await ctx.body())
    const note = body.note === undefined ? undefined : noteOf(body)
    return serial(async () => {
      const { items, mockup } = await find(project, ctx.params.id)
      const selected = choiceOf(items, mockup)
      if (selected && selected.id !== mockup.id)
        throw new HttpError(409, 'Another design was already chosen')
      if (selected) return { mockup: present(mockup, items) }
      if (mockup.askId === null) {
        // Nobody asked: the choice is only kept here.
        if (note !== undefined) mockup.note = note
        mockup.selectedAt = new Date().toISOString()
        await save(project, items)
        return { mockup: present(mockup, items), delivery: 'pull' as const, answerTo: null }
      }
      const ask = await request('GET', `/v1/asks/${mockup.askId}`)
      checkOrigin(ask, mockup)
      if (note !== undefined) mockup.note = note
      const text = answerText(mockup)
      if (
        ask.state !== 'open' &&
        !(ask.state === 'answered' && ask.answer === text && (ask.note ?? '') === mockup.note)
      )
        throw new HttpError(409, 'This question was already answered or closed')
      // Save the exact note before delivery. A retry can reconcile an answer
      // already delivered if the final file write failed.
      await save(project, items)
      const answered =
        ask.state === 'answered'
          ? ask
          : await request('POST', `/v1/asks/${mockup.askId}/answer`, {
              text,
              note: mockup.note || null,
            })
      checkOrigin(answered, mockup)
      mockup.selectedAt = new Date().toISOString()
      await save(project, items)
      return {
        mockup: present(mockup, items),
        delivery: answered.delivery ?? 'pull',
        answerTo: answered.answerTo ?? null,
      }
    })
  })

  /** The design as a page to put in a frame: HTML as it is, other text wrapped, images and PDFs as themselves. */
  router.on('GET', '/api/mockups/:id/view', async (ctx) => {
    const { mockup } = await find(projectOf(ctx.query.get('project')), ctx.params.id)
    const { res } = ctx
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (mockup.kind === 'image' || mockup.kind === 'pdf') {
      let bytes: Buffer
      try {
        bytes = await readFile(join(files, mockup.id))
      } catch {
        throw new HttpError(404, 'The file for this design is gone')
      }
      res.setHeader('Content-Type', mockup.mime ?? 'application/octet-stream')
      res.setHeader('Content-Security-Policy', mockup.kind === 'pdf' ? PDF_CSP : IMAGE_CSP)
      res.setHeader('Content-Disposition', 'inline')
      res.end(bytes)
      return RAW
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (mockup.kind === 'html') {
      res.setHeader('Content-Security-Policy', MOCKUP_CSP)
      res.end(mockup.html)
    } else {
      res.setHeader('Content-Security-Policy', WRAPPED_CSP)
      res.end(viewDocument(mockup.kind, mockup.html, mockup.title))
    }
    return RAW
  })
}
