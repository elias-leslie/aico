import { writeFileSync } from 'node:fs'
const OUT = new URL('./', import.meta.url).pathname
const INK = '#0B0D11', A = '#E5A647', B = '#B47A2A', G = '#FFE3A3'
const f = (n) => +n.toFixed(2)

// Satellite geometry: big disc minus a gap ring around the small one.
function companion() {
  const a = [41, 42], R = 36, b = [74, 74], r = 15, gap = 5, rc = r + gap
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy), th = Math.atan2(dy, dx)
  const phi = Math.acos((R * R + d * d - rc * rc) / (2 * R * d))
  const P = (t) => [a[0] + R * Math.cos(t), a[1] + R * Math.sin(t)]
  const p1 = P(th - phi), p2 = P(th + phi)
  const big = `M${f(p2[0])} ${f(p2[1])}A${R} ${R} 0 1 1 ${f(p1[0])} ${f(p1[1])}A${rc} ${rc} 0 0 0 ${f(p2[0])} ${f(p2[1])}Z`
  return { big, sat: `<circle cx="${b[0]}" cy="${b[1]}" r="${r}"/>` }
}
const C3 = companion()

// Each mark is drawn in a 100x100 box, bounded by a circle of radius 50 around (50,50).
// mono=true: a single fill, true holes, no glow shapes.
const marks = {
  1: {
    slug: 'lantern', name: 'Lantern, quieter',
    idea: 'The lantern boiled down to a ring, a cap, a dome with its light cut out, and a base.',
    mark: (m) => {
      const body = 'M20 80V64a30 30 0 0 1 60 0V80a7 7 0 0 1-7 7H27a7 7 0 0 1-7-7ZM50 50a12 12 0 1 0 0 24a12 12 0 1 0 0-24Z'
      const top = (c) => `<circle cx="50" cy="12" r="7" fill="none" stroke="${c}" stroke-width="6"/><rect x="31" y="24" width="38" height="7" rx="3.5" fill="${c}"/>`
      return m
        ? `${top('#fff')}<path fill-rule="evenodd" fill="#fff" d="${body}"/><rect x="34" y="90" width="32" height="6" rx="3" fill="#fff"/>`
        : `${top(A)}<path fill-rule="evenodd" fill="${A}" d="${body}"/><circle cx="50" cy="62" r="12" fill="${G}"/><rect x="34" y="90" width="32" height="6" rx="3" fill="${B}"/>`
    },
  },
  2: {
    slug: 'doorway', name: 'Doorway',
    idea: 'An open arch with a light standing in it: a place the sessions come home to.',
    mark: (m) => m
      ? `<path d="M22 92V40a28 28 0 0 1 56 0V92" fill="none" stroke="#fff" stroke-width="15"/><circle cx="50" cy="72" r="13" fill="#fff"/>`
      : `<path d="M22 92V40a28 28 0 0 1 56 0V92" fill="none" stroke="${A}" stroke-width="15"/><circle cx="50" cy="72" r="13" fill="${G}"/>`,
  },
  3: {
    slug: 'companion', name: 'Companion',
    idea: 'No lantern: one large light with a small one that stays at its side, the agent and you.',
    mark: (m) => m
      ? `<path fill="#fff" d="${C3.big}"/>${C3.sat.replace('/>', ' fill="#fff"/>')}`
      : `<path fill="${A}" d="${C3.big}"/>${C3.sat.replace('/>', ` fill="${G}"/>`)}`,
  },
  4: {
    slug: 'core', name: 'Core',
    idea: 'No lantern: a bright core held inside a frame, a rounded diamond within a diamond.',
    mark: (m) => m
      ? `<path d="M50 13L87 50L50 87L13 50Z" fill="none" stroke="#fff" stroke-width="13" stroke-linejoin="round"/><path d="M50 36L64 50L50 64L36 50Z" fill="#fff" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`
      : `<path d="M50 13L87 50L50 87L13 50Z" fill="none" stroke="${A}" stroke-width="13" stroke-linejoin="round"/><path d="M50 36L64 50L50 64L36 50Z" fill="${G}" stroke="${G}" stroke-width="5" stroke-linejoin="round"/>`,
  },
}
const head = (vb, t, d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}" role="img" aria-labelledby="t d">\n  <title id="t">${t}</title>\n  <desc id="d">${d}</desc>\n`
for (const [n, o] of Object.entries(marks)) {
  const base = `${OUT}option-${n}-${o.slug}`
  writeFileSync(`${base}-color.svg`, head(512, `Aico icon option ${n}: ${o.name}`, o.idea) +
    `  <rect width="512" height="512" rx="112" fill="${INK}"/>\n  <g transform="translate(66 66) scale(3.8)">${o.mark(false)}</g>\n</svg>\n`)
  writeFileSync(`${base}-maskable.svg`, head(512, `Aico icon option ${n}: ${o.name}, maskable`, `${o.idea} Full-bleed background; the mark sits inside the central 60% safe zone.`) +
    `  <rect width="512" height="512" fill="${INK}"/>\n  <g transform="translate(106 106) scale(3)">${o.mark(false)}</g>\n</svg>\n`)
  writeFileSync(`${base}-mono.svg`, head(24, `Aico icon option ${n}: ${o.name}, monochrome`, 'White on transparent: the Android notification small icon and the themed launcher layer.') +
    `  <g transform="translate(2 2) scale(.2)">${o.mark(true)}</g>\n</svg>\n`)
}
