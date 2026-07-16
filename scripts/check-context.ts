// Headless Agent Hub adapter check — the no-UI way to verify what the titlebar
// context badge WOULD show, without launching Aico or driving its window.
//
// It runs the SAME `ensureContext()` the running app uses (imported, never
// duplicated, so it can't drift from the badge) for each requested TUI and
// prints the resolved state + detail. Exit 0 iff every checked TUI is `ok`.
//
//   npm run check:context            # every supported canonical adapter
//   npm run check:context -- codex   # just one
//   npm run check:context -- gemini hermes opencode pi shell
//
// `ok`   → canonical adapter installation and launcher chain verified.
// `MISS` → native TUI still launches, but supplemental Agent Hub context is unavailable.

import { ensureContext } from '../electron/main/tui/context'
import { getTui, registerBuiltinTuis } from '../electron/main/tui/registry'

async function main(): Promise<void> {
  registerBuiltinTuis()
  const args = process.argv.slice(2)
  const targets = args.length ? args : ['claude-code', 'claude-gpt', 'codex', 'gemini', 'pi']

  let bad = 0
  for (const slug of targets) {
    const tui = getTui(slug)
    if (!tui) {
      console.log(`??   ${slug.padEnd(12)} unknown TUI (try: claude-code claude-gpt codex gemini pi)`)
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
      ? `\n${bad} TUI(s) would show degraded status; native models still launch without supplemental Agent Hub context. See detail above.`
      : '\nAll checked Agent Hub adapter chains are verified. ✅',
  )
  process.exit(bad ? 1 : 0)
}

void main()
