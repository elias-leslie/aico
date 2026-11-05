// HTML mockups are files owned by the web server. Tether owns the question
// and delivers the owner's choice to the session that supplied the mockups.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TetherClient } from '@aico/tether-client'
import { objectBody, optionalString, RAW, type Router, requiredString } from './http'
import { HttpError, toHttpError } from './tether'

const ID = /^[0-9a-f]{12}$/
const SESSION = /^[0-9a-f]{8}$/
const ONE_LINE_BAD = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u

/** No origin privileges, external resources, forms, or nested frames. Inline
 * scripts can demonstrate a design's interactions inside the sandbox. */
export const MOCKUP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ')

interface StoredMockup {
  id: string
  project: string
  title: string
  note: string
  html: string
  session: string | null
  askId: string
  createdAt: string
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

function pageUrl(project: string): string {
  return `/mockups?project=${encodeURIComponent(project)}`
}

function itemUrl(mockup: Pick<StoredMockup, 'project' | 'id'>): string {
  return `/api/mockups/${mockup.id}?project=${encodeURIComponent(mockup.project)}`
}

function present(mockup: StoredMockup, items: StoredMockup[]) {
  const { html: _html, ...fields } = mockup
  const chosen = items.find((item) => item.askId === mockup.askId && item.selectedAt !== null)
  return {
    ...fields,
    state: mockup.selectedAt ? 'selected' : chosen ? 'passed' : 'pending',
    htmlUrl: itemUrl(mockup).replace('?', '/html?'),
  }
}

function validStored(value: unknown, project: string): value is StoredMockup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    ID.test(row.id) &&
    row.project === project &&
    typeof row.title === 'string' &&
    typeof row.note === 'string' &&
    typeof row.html === 'string' &&
    (row.session === null || (typeof row.session === 'string' && SESSION.test(row.session))) &&
    typeof row.askId === 'string' &&
    ID.test(row.askId) &&
    typeof row.createdAt === 'string' &&
    Number.isFinite(Date.parse(row.createdAt)) &&
    (row.selectedAt === null ||
      (typeof row.selectedAt === 'string' && Number.isFinite(Date.parse(row.selectedAt))))
  )
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

/** The web server is the only writer. Atomic project files keep HTML and its
 * review note together; a project name never becomes a filesystem path. */
export function registerMockupRoutes(
  router: Router,
  options: { dataDir: string; tether: Pick<TetherClient, 'request'> },
): void {
  const directory = join(options.dataDir, 'mockups')
  const file = (project: string) =>
    join(directory, `${createHash('sha256').update(project).digest('hex')}.json`)
  let pending: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = pending.then(run)
    pending = result.catch(() => {})
    return result
  }
  const load = async (project: string): Promise<StoredMockup[]> => {
    let text: string
    try {
      text = await readFile(file(project), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value) || !value.every((item) => validStored(item, project)))
      throw new HttpError(500, 'Saved mockups could not be read')
    return value
  }
  const save = async (project: string, items: StoredMockup[]) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file(project)}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(items), { mode: 0o600 })
    await rename(temporary, file(project))
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
    if (!mockup) throw new HttpError(404, 'Mockup not found')
    return { items, mockup }
  }

  router.on('GET', '/api/mockups', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    const items = await load(project)
    return { project, items: items.map((item) => present(item, items)) }
  })

  router.on('POST', '/api/mockups', async (ctx) => {
    const body = objectBody(await ctx.body())
    const project = projectOf(requiredString(body, 'project'))
    const title = line(requiredString(body, 'title'), 'title')
    const html = requiredString(body, 'html')
    if (!html.trim()) throw new HttpError(422, 'html is required')
    const note = noteOf(body)
    const session = optionalString(body, 'session', { pattern: SESSION }) ?? null
    return serial(async () => {
      const items = await load(project)
      const id = randomBytes(6).toString('hex')
      const last = items.findLast((item) => item.session === session)
      let ask: MockupAsk | undefined
      if (last && !items.some((item) => item.askId === last.askId && item.selectedAt)) {
        try {
          ask = await request('GET', `/v1/asks/${last.askId}`)
          checkOrigin(ask, last)
          if (ask.state !== 'open') ask = undefined
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error
          // Tether can prune an old question; the saved designs still remain.
        }
      }
      ask ??= await request('POST', '/v1/asks', {
        session,
        requester: session ? null : requester(project),
        question: `Which mockup should we use? (${id})`,
        body: `Project: ${project}\nReview the mockups: ${pageUrl(project)}`,
        blocking: false,
      })
      const mockup: StoredMockup = {
        id,
        project,
        title,
        note,
        html,
        session,
        askId: ask.id,
        createdAt: new Date().toISOString(),
        selectedAt: null,
      }
      checkOrigin(ask, mockup)
      items.push(mockup)
      await save(project, items)
      return { mockup: present(mockup, items), pageUrl: pageUrl(project) }
    })
  })

  router.on('PATCH', '/api/mockups/:id', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    const note = noteOf(objectBody(await ctx.body()))
    return serial(async () => {
      const { items, mockup } = await find(project, ctx.params.id)
      if (items.some((item) => item.askId === mockup.askId && item.selectedAt))
        throw new HttpError(409, 'This choice has already been sent')
      mockup.note = note
      await save(project, items)
      return { mockup: present(mockup, items) }
    })
  })

  router.on('POST', '/api/mockups/:id/select', async (ctx) => {
    const project = projectOf(ctx.query.get('project'))
    const body = objectBody(await ctx.body())
    const note = body.note === undefined ? undefined : noteOf(body)
    return serial(async () => {
      const { items, mockup } = await find(project, ctx.params.id)
      const selected = items.find((item) => item.askId === mockup.askId && item.selectedAt)
      if (selected && selected.id !== mockup.id)
        throw new HttpError(409, 'Another mockup was already chosen')
      if (selected) return { mockup: present(mockup, items) }
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

  router.on('GET', '/api/mockups/:id/html', async (ctx) => {
    const { mockup } = await find(projectOf(ctx.query.get('project')), ctx.params.id)
    ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8')
    ctx.res.setHeader('Content-Security-Policy', MOCKUP_CSP)
    ctx.res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    ctx.res.setHeader('Cache-Control', 'no-store')
    ctx.res.setHeader('Referrer-Policy', 'no-referrer')
    ctx.res.end(mockup.html)
    return RAW
  })
}
