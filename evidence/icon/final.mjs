// The chosen Aico icon (option 1, Lantern, quieter): writes the SVG sources into packages/web-frontend/public/icons
// and the Android vector drawables. PNGs and favicon.ico are rendered from these SVGs (headless Chromium).
import { writeFileSync } from 'node:fs'
const root = new URL('../../', import.meta.url).pathname
const ICONS = `${root}packages/web-frontend/public/icons/`
const RES = `${root}native/android/app/src/main/res/drawable/`
const INK = '#0B0D11', A = '#E5A647', B = '#B47A2A', G = '#FFE3A3'

// Marks in a 100x100 box. full: ring, cap, dome with glow, base. small: heavier, no base, for 16-48px and the tray.
const DOME_FULL = 'M20 80V64a30 30 0 0 1 60 0V80a7 7 0 0 1-7 7H27a7 7 0 0 1-7-7ZM50 50a12 12 0 1 0 0 24a12 12 0 1 0 0-24Z'
const DOME_SMALL = 'M14 84V70a36 36 0 0 1 72 0V84a10 10 0 0 1-10 10H24a10 10 0 0 1-10-10ZM50 55a15 15 0 1 0 0 30a15 15 0 1 0 0-30Z'
const full = (c = { ring: A, body: A, glow: G, base: B }) =>
  `<circle cx="50" cy="12" r="7" fill="none" stroke="${c.ring}" stroke-width="6"/><rect x="31" y="24" width="38" height="7" rx="3.5" fill="${c.ring}"/><path fill-rule="evenodd" fill="${c.body}" d="${DOME_FULL}"/>${c.glow ? `<circle cx="50" cy="62" r="12" fill="${c.glow}"/>` : ''}<rect x="34" y="90" width="32" height="6" rx="3" fill="${c.base}"/>`
const small = (c = { ring: A, body: A, glow: G }) =>
  `<circle cx="50" cy="13" r="8.5" fill="none" stroke="${c.ring}" stroke-width="9"/><rect x="25" y="26" width="50" height="9" rx="4.5" fill="${c.ring}"/><path fill-rule="evenodd" fill="${c.body}" d="${DOME_SMALL}"/>${c.glow ? `<circle cx="50" cy="70" r="15" fill="${c.glow}"/>` : ''}`

const svg = (t, d, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-labelledby="t d">\n  <title id="t">${t}</title>\n  <desc id="d">${d}</desc>\n${body}</svg>\n`
const tile = (rx, mark, s, off) => `  <rect width="512" height="512"${rx ? ` rx="${rx}"` : ''} fill="${INK}"/>\n  <g transform="translate(${off} ${off}) scale(${s})">${mark}</g>\n`
const DESC = 'An amber lantern, a ring, a cap and a dome with its light cut out, on a dark rounded square.'
writeFileSync(`${ICONS}icon.svg`, svg('Aico lantern icon', DESC, tile(112, full(), 3.8, 66)))
writeFileSync(`${ICONS}icon-maskable.svg`, svg('Aico lantern icon, maskable', `${DESC} Full-bleed; the lantern sits inside the central 60%.`, tile(0, full(), 3, 106)))
writeFileSync(`${ICONS}icon-small.svg`, svg('Aico lantern icon, small sizes', 'A heavier lantern without its base, for 16 to 48 px.', tile(112, small(), 4.2, 46)))
writeFileSync(`${ICONS}icon-apple.svg`, svg('Aico lantern icon, full-bleed', 'Square tile for apple-touch; iOS rounds it.', tile(0, full(), 3.6, 76)))

// Android vectors (100-unit box scaled into the 108dp adaptive canvas: safe zone is the central 66dp).
const R = (x, y, w, h, r) => `M${x + r},${y}H${x + w - r}a${r},${r} 0 0 1 ${r},${r}V${y + h - r}a${r},${r} 0 0 1 -${r},${r}H${x + r}a${r},${r} 0 0 1 -${r},-${r}V${y + r}a${r},${r} 0 0 1 ${r},-${r}z`
const C = (cx, cy, r) => `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 -${2 * r},0z`
const path = (extra, d) => `        <path ${extra} android:pathData="${d}" />`
const ring = (col, cy, r, w) => `        <path android:strokeColor="${col}" android:strokeWidth="${w}" android:pathData="${C(50, cy, r)}" />`
const ZOOM = 0.6 // 100 units -> 60dp, centred in 108dp
const groupOpen = (s, tx) => `    <group android:scaleX="${s}" android:scaleY="${s}" android:translateX="${tx}" android:translateY="${tx}">`
const vec = (w, vp, comment, inner) => `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${comment} -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="${w}dp" android:height="${w}dp" android:viewportWidth="${vp}" android:viewportHeight="${vp}">\n${inner}\n</vector>\n`
const dome = (col, d) => path(`android:fillColor="${col}" android:fillType="evenOdd"`, d)
const domeFull = 'M20,80V64a30,30 0 0,1 60,0V80a7,7 0 0,1 -7,7H27a7,7 0 0,1 -7,-7zM50,50a12,12 0 1,0 0,24a12,12 0 1,0 0,-24z'
const domeSmall = 'M14,84V70a36,36 0 0,1 72,0V84a10,10 0 0,1 -10,10H24a10,10 0 0,1 -10,-10zM50,55a15,15 0 1,0 0,30a15,15 0 1,0 0,-30z'
const fg = [
  groupOpen(0.66, 21),
  ring(A, 12, 7, 6),
  path(`android:fillColor="${A}"`, R(31, 24, 38, 7, 3.5)),
  dome(A, domeFull),
  path(`android:fillColor="${G}"`, C(50, 62, 12)),
  path(`android:fillColor="${B}"`, R(34, 90, 32, 6, 3)),
  '    </group>',
].join('\n')
writeFileSync(`${RES}ic_launcher_fg.xml`, vec(108, 108, 'The Aico lantern (packages/web-frontend/public/icons/icon.svg), scaled into the adaptive icon\'s safe zone. Source: evidence/icon/final.mjs.', fg))
const monoShapes = (cy) => [ring('#FFFFFF', 13, 8.5, 9), path('android:fillColor="#FFFFFF"', R(25, 26, 50, 9, 4.5)), dome('#FFFFFF', domeSmall)].join('\n')
writeFileSync(`${RES}ic_launcher_mono.xml`, vec(108, 108, 'The lantern as one shape for themed launcher icons (Android tints the alpha).', `${groupOpen(0.66, 21)}\n${monoShapes()}\n    </group>`))
writeFileSync(`${RES}ic_stat.xml`, vec(24, 24, 'Notification small icon: the Aico lantern, white on transparent (Android tints it).', `${groupOpen(0.2, 2)}\n${monoShapes()}\n    </group>`))
