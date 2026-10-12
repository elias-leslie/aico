// Generates the tray icons + the app/launcher icon from the selected Aico
// lantern-orb SVG source.
//
//   node scripts/gen-tray-icons.mjs
//
// Output:
//   assets/tray/idle.png    44px, muted lantern orb  (no widget active)
//   assets/tray/active.png  44px, amber lantern orb  (a widget is thinking)
//   assets/tray/needs-you.png 44px, amber orb with a red badge (a session is
//                           blocked on the owner and its window is unfocused)
//   assets/icon.png        256px, amber lantern orb  (desktop/app icon)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceIcon = readFileSync(resolve(root, 'assets/icon-options/aico-lantern-orb.svg'), 'utf8')

function muted(svg) {
  return svg
    .replaceAll('#FFE3A3', '#B8C0C8')
    .replaceAll('#FFE1A0', '#AEB7C0')
    .replaceAll('#FFF0C5', '#C8CED4')
    .replaceAll('#FFF1C8', '#D6DADF')
    .replaceAll('#E5A647', '#79818A')
    .replaceAll('#B87725', '#5F6872')
    .replaceAll('#9E6121', '#4F5963')
    .replaceAll('#8A551F', '#3F4954')
}

// A notification badge in the top-right corner, ringed in the icon's ink so it
// stays separate from the orb at 22 px.
function badged(svg) {
  return svg.replace(
    '</svg>',
    '  <circle cx="400" cy="112" r="96" fill="#F0524A" stroke="#0B0D11" stroke-width="28" />\n</svg>',
  )
}

const icons = [
  ['tray/idle.png', 44, muted(sourceIcon)],
  ['tray/active.png', 44, sourceIcon],
  ['tray/needs-you.png', 44, badged(sourceIcon)],
  ['icon.png', 256, sourceIcon],
]

for (const [rel, size, markup] of icons) {
  const out = resolve(root, 'assets', rel)
  mkdirSync(dirname(out), { recursive: true })
  const png = new Resvg(markup, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(out, png)
  console.log(`wrote ${out} (${png.length} bytes)`)
}
