// Rewinding a Claude Code session to before a prompt (`st aico root rewind`,
// `POST /v1/sessions/:id/rewind`; docs/api-v1.md "Model switches"). Claude
// Code has no command for it outside its window (`/rewind` is gone where
// slash commands are off), so Tether drives the window's own rewind menu as
// the owner would: Escape twice opens it, Up picks the prompt, Enter, the
// "Restore conversation" option (never the code: a coordinator decides about
// files), Enter; the prompt's text comes back in the input and is cleared
// with C-u. Every screen is read back before the next key, and anything that
// does not match stops the rewind (Escape closes the menu).
//
// Codex and Pi have no supported rewind here (Codex's backtrack and Pi's
// tree are window features with no stable screen contract yet): the route
// refuses them with `rewind_unsupported`.

import type { PaneKey } from './lifecycle/tmux'

export interface RewindOperations {
  capture(): Promise<string>
  press(key: PaneKey): Promise<void>
  sleep(ms: number): Promise<void>
}

export type RewindStep = 'prompt' | 'menu' | 'pick' | 'confirm' | 'option' | 'restored' | 'cleared'

export class RewindRefused extends Error {
  constructor(
    readonly step: RewindStep,
    readonly reason: string,
  ) {
    super(`${step}: ${reason}`)
  }
}

const RULE = /^─{8,}/
const MENU_HEADER = 'Restore the code and/or conversation to the point before'
const CONFIRM_HEADER = 'Confirm you want to restore to the point before you sent this message:'
const RESTORE_CONVERSATION = 'Restore conversation'
/** Screens read per step before giving up (each after `POLL_MS`). */
const POLLS = 15
const POLL_MS = 200
/** The most prompts a rewind walks up. */
const MAX_UP = 200

/** Text as compared: whitespace collapsed, a trailing ellipsis dropped. */
export function screenText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/…$/, '').trim()
}

/** The prompt's first line as Claude Code's menu shows it. */
export function promptLine(prompt: string): string {
  return screenText(prompt.split('\n').find((line) => line.trim()) ?? '')
}

/** A menu entry shows the prompt (cut to the window's width). */
export function sameEntry(shown: string, prompt: string): boolean {
  const a = screenText(shown)
  const b = promptLine(prompt)
  if (!a || !b) return false
  return a === b || (a.length >= 16 && b.startsWith(a)) || (b.length >= 16 && a.startsWith(b))
}

function lines(screen: string): string[] {
  return screen.split('\n').map((line) => line.replace(/\s+$/, ''))
}

/** The rewind list: its entries (prompts and `(current)`) and the picked one. */
export function readMenu(screen: string): { entries: string[]; picked: number } | null {
  const all = lines(screen)
  const header = all.findIndex((line) => line.trim().startsWith(MENU_HEADER))
  if (header < 0) return null
  const entries: string[] = []
  let picked = -1
  for (const line of all.slice(header + 1)) {
    if (line.trim().startsWith('Enter to continue')) break
    // Entries sit at 4 columns ("  ❯ " when picked); their code note under
    // them at 4 too, after an entry: a prompt, then its note, in pairs.
    const match = /^ {2}(❯| ) (\S.*)$/.exec(line)
    if (!match) continue
    entries.push(match[2] ?? '')
    if (match[1] === '❯') picked = entries.length - 1
  }
  // Prompts alternate with their code notes ("No code changes", "probe.txt +1");
  // `(current)` closes the list.
  const items: string[] = []
  let pickedItem = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    if (entry === '(current)') {
      if (picked === i) pickedItem = items.length
      items.push(entry)
      break
    }
    if (picked === i) pickedItem = items.length
    items.push(entry)
    i++ // its note
  }
  return pickedItem < 0 ? null : { entries: items, picked: pickedItem }
}

/** The confirm screen: the quoted prompt and the numbered options. */
export function readConfirm(
  screen: string,
): { message: string; options: string[]; picked: number } | null {
  const all = lines(screen)
  const header = all.findIndex((line) => line.trim() === CONFIRM_HEADER)
  if (header < 0) return null
  // The quoted prompt is the first line under the header (after a blank).
  const at = all.findIndex((line, i) => i > header && line.trim() !== '')
  const quoted = at < 0 ? null : /^\s*│ (.*)$/.exec(all[at] ?? '')
  const options: string[] = []
  let picked = -1
  for (const line of all.slice(at + 1)) {
    const match = /^\s*(❯|↓|↑)?\s*(\d+)\. (.+)$/.exec(line)
    if (!match) continue
    if (Number(match[2]) !== options.length + 1) break
    if (match[1] === '❯') picked = options.length
    options.push((match[3] ?? '').trim())
  }
  if (!quoted || picked < 0) return null
  return { message: quoted[1] ?? '', options, picked }
}

/** The input box's text (between the last two rules), or null when the
 * screen has none (a menu is open). */
export function readInput(screen: string): string | null {
  const all = lines(screen)
  const rules = all.flatMap((line, i) => (RULE.test(line) ? [i] : []))
  if (rules.length < 2) return null
  const top = rules[rules.length - 2] as number
  const bottom = rules[rules.length - 1] as number
  const box = all.slice(top + 1, bottom)
  const first = box[0] ?? ''
  if (!first.startsWith('❯')) return null
  return [first.replace(/^❯ ?/, ''), ...box.slice(1).map((line) => line.trim())].join(' ').trim()
}

/** Rewind to before `prompt`, the `skip`-th newest entry showing its text
 * (0: the newest). Resolves when the input is empty again. */
export async function rewindClaude(
  ops: RewindOperations,
  prompt: string,
  skip = 0,
): Promise<{ up: number }> {
  if (!promptLine(prompt)) throw new RewindRefused('prompt', 'no prompt text to find')
  const read = async <T>(step: RewindStep, parse: (screen: string) => T | null): Promise<T> => {
    for (let i = 0; i < POLLS; i++) {
      const found = parse(await ops.capture())
      if (found !== null) return found
      await ops.sleep(POLL_MS)
    }
    throw new RewindRefused(step, 'the screen did not show what this step needs')
  }
  const input = readInput(await ops.capture())
  if (input === null) throw new RewindRefused('prompt', 'no empty input box on screen')
  if (input !== '') throw new RewindRefused('prompt', 'the input box holds a draft')
  let open = false
  try {
    await ops.press('Escape')
    await ops.sleep(POLL_MS)
    await ops.press('Escape')
    open = true
    let menu = await read('menu', readMenu)
    if (menu.entries[menu.picked] !== '(current)')
      throw new RewindRefused('menu', 'the list did not open on (current)')
    let up = 0
    let seen = 0
    for (;;) {
      if (up >= MAX_UP || menu.picked === 0)
        throw new RewindRefused('pick', 'prompt not in the list')
      await ops.press('Up')
      up++
      const want = menu.picked - 1
      menu = await read('pick', (screen) => {
        const next = readMenu(screen)
        return next && next.picked === want ? next : null
      })
      if (sameEntry(menu.entries[menu.picked] ?? '', prompt)) {
        if (seen === skip) break
        seen++
      }
    }
    await ops.press('Enter')
    let confirm = await read('confirm', readConfirm)
    if (!sameEntry(confirm.message, prompt))
      throw new RewindRefused('confirm', 'the confirm screen names another prompt')
    const target = confirm.options.indexOf(RESTORE_CONVERSATION)
    if (target < 0) throw new RewindRefused('option', `no "${RESTORE_CONVERSATION}" option`)
    while (confirm.picked !== target) {
      const key: PaneKey = confirm.picked < target ? 'Down' : 'Up'
      const want = confirm.picked + (key === 'Down' ? 1 : -1)
      await ops.press(key)
      confirm = await read('option', (screen) => {
        const next = readConfirm(screen)
        return next && next.picked === want ? next : null
      })
    }
    if (confirm.options[confirm.picked] !== RESTORE_CONVERSATION)
      throw new RewindRefused('option', 'another option is picked')
    await ops.press('Enter')
    open = false
    await read('restored', (screen) => {
      const text = readInput(screen)
      return text !== null && sameEntry(text, prompt) ? text : null
    })
    await ops.press('C-u')
    await read('cleared', (screen) => (readInput(screen) === '' ? true : null))
    return { up }
  } catch (error) {
    // Close the menu (the confirm screen goes back to the list, then out).
    if (open)
      for (let i = 0; i < 2; i++) {
        if (readInput(await ops.capture().catch(() => '')) !== null) break
        await ops.press('Escape').catch(() => {})
        await ops.sleep(POLL_MS)
      }
    throw error
  }
}
