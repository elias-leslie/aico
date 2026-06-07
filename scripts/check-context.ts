// Headless mandate-injection check — the no-UI way to verify what the titlebar
// mandate badge WOULD show, without launching aico or driving its window.
//
// It runs the SAME `ensureContext()` the running app uses (imported, never
// duplicated, so it can't drift from the badge) for each requested TUI and
// prints the resolved state + detail. Exit 0 iff every checked TUI is `ok`.
//
//   npm run check:context            # claude-code + codex (the ones that matter)
//   npm run check:context -- codex   # just one
//   npm run check:context -- gemini hermes opencode pi shell
//
// `ok`   → mandates WILL inject; the badge stays hidden for that TUI.
// `MISS` → mandates will NOT inject; the badge would show. The detail says why.

import { ensureContext } from '../electron/main/tui/context'
import { getTui, registerBuiltinTuis } from '../electron/main/tui/registry'

async function main(): Promise<void> {
  registerBuiltinTuis()
  const args = process.argv.slice(2)
  const targets = args.length ? args : ['claude-code', 'codex']

  let bad = 0
  for (const slug of targets) {
    const tui = getTui(slug)
    if (!tui) {
      console.log(`??   ${slug.padEnd(12)} unknown TUI (try: claude-code codex gemini hermes opencode pi shell)`)
      bad++
      continue
    }
    const status = await ensureContext(tui)
    if (status.state !== 'ok') bad++
    const tag = status.state === 'ok' ? 'ok  ' : 'MISS'
    console.log(`${tag} ${slug.padEnd(12)} ${status.detail}`)
  }

  console.log(
    bad
      ? `\n${bad} TUI(s) would show the mandate badge — mandates will NOT inject. See detail above.`
      : '\nAll checked TUIs inject mandates — the badge stays hidden. ✅',
  )
  process.exit(bad ? 1 : 0)
}

void main()
