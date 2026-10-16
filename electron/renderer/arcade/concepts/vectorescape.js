;(() => {
  // Cinematic vector escape, big edition. The figures are built once at load
  // from a tiny pose skeleton rasterised into flat-shaded polygons, in the style
  // of early-90s rotoscoped polygon games: the stranded scientist, the black
  // beast, his tall alien friend and the alien guards.

  // ---- palette --------------------------------------------------------------
  const P = {
    // the hero
    H: '#c4421d', h: '#7c2612', S: '#ecc0a0', s: '#b07f66', W: '#e6e4da', w: '#a9aaa6', v: '#82858a',
    P: '#2c3346', Q: '#1a1f2c', E: '#0e0e10', g: '#8f98a6', G: '#d6dde6',
    // the friend and the guards
    B: '#9aa79c', b: '#6a776e', d: '#46504b', L: '#4c3a2a', l: '#32261b', C: '#e2dcc0', c: '#9c967e',
    U: '#4a3f5e', u: '#2c2639', K: '#c45a3c',
    // the beast
    X: '#08080b', Y: '#1b1c26', x: '#2c3046', e: '#ff5a2a',
    V: '#ffffff',
  }
  const LASER = '#fff3b0'
  const SH = ['#e8fbff', '#8fe6ff', '#4a8cff', '#b8f2ff', '#6a5cff']
  const GLOW = 'rgba(104,98,170,.6)'

  // ---- a little polygon rasteriser (load time only) -------------------------
  const grid = (w, h) => Array.from({ length: h }, () => new Array(w).fill('.'))
  const put = (g, x, y, ch) => {
    if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch
  }
  function seg(g, a, b, r, ch) {
    const [ax, ay] = a
    const [bx, by] = b
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy || 1e-6
    for (let y = Math.floor(Math.min(ay, by) - r - 1); y <= Math.ceil(Math.max(ay, by) + r + 1); y++)
      for (let x = Math.floor(Math.min(ax, bx) - r - 1); x <= Math.ceil(Math.max(ax, bx) + r + 1); x++) {
        const px = x + 0.5
        const py = y + 0.5
        const t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1)
        if (Math.hypot(px - ax - t * dx, py - ay - t * dy) <= r) put(g, x, y, ch)
      }
  }
  function ell(g, c, rx, ry, ch) {
    for (let y = Math.floor(c[1] - ry - 1); y <= Math.ceil(c[1] + ry + 1); y++)
      for (let x = Math.floor(c[0] - rx - 1); x <= Math.ceil(c[0] + rx + 1); x++) {
        const qx = (x + 0.5 - c[0]) / rx
        const qy = (y + 0.5 - c[1]) / ry
        if (qx * qx + qy * qy <= 1) put(g, x, y, ch)
      }
  }
  function poly(g, pts, ch) {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const px = x + 0.5
        const py = y + 0.5
        let inside = false
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i]
          const [xj, yj] = pts[j]
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
        }
        if (inside) put(g, x, y, ch)
      }
  }
  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k]
  // limb direction: angle from straight down, positive leans forward (facing right)
  const dir = (a, l = 1) => [Math.sin(a) * l, Math.cos(a) * l]
  const rows = (g) => g.map((r) => r.join(''))

  /** Shift a joint set so the lowest foot rests on `floor`, minus `lift`. */
  function ground(pts, floor, lift) {
    const low = Math.max(...pts.map((p) => p[1]))
    return floor - low - lift
  }

  // ---- the hero -------------------------------------------------------------
  const LW = 28
  const LH = 24
  const LCX = 12
  /** o: t torso lean, legs [thigh, shin] near/far, arms [upper, fore] near/far,
   *  gun, lift, hy (fixed hip y instead of grounding), head nod. */
  function hero(o) {
    const g = grid(LW, LH)
    const t = o.t ?? 0
    const u = [Math.sin(t), -Math.cos(t)]
    const f = [Math.cos(t), Math.sin(t)]
    const leg = (th, sh, hip) => {
      const k = add(hip, dir(th, 5.4))
      const a = add(k, dir(sh, 5.3))
      const toe = add(a, [Math.cos(sh) * 2.1, -Math.sin(sh) * 2.1])
      return [hip, k, a, toe]
    }
    let hip = [LCX + (o.hx ?? 0), 0]
    let nl = leg(...o.nl, hip)
    let fl = leg(...o.fl, hip)
    const hy = o.hy ?? ground([nl[2], nl[3], fl[2], fl[3]], LH - 0.9, o.lift ?? 0)
    hip = [hip[0], hy]
    nl = leg(...o.nl, hip)
    fl = leg(...o.fl, hip)
    const sh = add(hip, u, 6.1)
    const arm = (ua, fa) => {
      const j = add(sh, u, -0.7)
      const e = add(j, dir(ua, 3.9))
      const w = add(e, dir(fa, 3.4))
      return [j, e, w]
    }
    const na = arm(...o.na)
    const fa = arm(...o.fa)
    // far arm, far leg
    seg(g, fa[0], fa[1], 0.85, 'v')
    seg(g, fa[1], fa[2], 0.8, 'v')
    ell(g, add(fa[2], dir(o.fa[1], 0.5)), 0.8, 0.8, 's')
    seg(g, fl[0], fl[1], 1.15, 'Q')
    seg(g, fl[1], fl[2], 0.95, 'Q')
    seg(g, fl[2], fl[3], 0.7, 'E')
    // hips, near leg
    poly(g, [add(add(hip, f, -1.6), u, 1.2), add(add(hip, f, 1.5), u, 1.2), add(add(hip, f, 1.4), u, -0.9), add(add(hip, f, -1.5), u, -0.9)], 'P')
    seg(g, nl[0], nl[1], 1.2, 'P')
    seg(g, nl[1], nl[2], 1.0, 'P')
    seg(g, nl[2], nl[3], 0.75, 'E')
    // torso: lit front, shaded back
    const bs = add(add(sh, f, -1.7), u, 0.1)
    const fs = add(sh, f, 1.7)
    const fw = add(add(hip, f, 1.3), u, 0.9)
    const bw = add(add(hip, f, -1.5), u, 0.9)
    poly(g, [bs, fs, fw, bw], 'W')
    poly(g, [bs, add(sh, f, -0.4), add(add(hip, f, -0.4), u, 0.9), bw], 'w')
    // neck and head
    const hc = add(add(sh, u, 2.9 + (o.nod ?? 0) * -0.4), f, 0.55 + (o.nod ?? 0) * 0.4)
    seg(g, add(sh, u, 0.3), add(hc, u, -1.2), 0.75, 's')
    ell(g, hc, 2.1, 2.4, 'S')
    ell(g, add(add(hc, f, -0.3), u, -1.5), 1.3, 0.8, 's')
    ell(g, add(add(hc, f, -1.05), u, 1.15), 2.0, 1.55, 'H')
    ell(g, add(add(hc, f, 0.6), u, 1.7), 1.1, 0.75, 'H')
    ell(g, add(add(hc, f, -1.6), u, 0.0), 1.1, 1.8, 'h')
    put(g, Math.floor(hc[0] - 2.5 * f[0]), Math.floor(hc[1] + 1.0), 'h')
    put(g, Math.round(hc[0] + f[0] * 0.9 - 0.5), Math.round(hc[1] - 0.6), 'E')
    // near arm, with a shaded rim so it reads against the shirt
    seg(g, na[0], na[1], 1.25, 'w')
    seg(g, na[1], na[2], 1.15, 'w')
    seg(g, na[0], na[1], 0.8, 'W')
    seg(g, na[1], na[2], 0.72, 'W')
    const hand = add(na[2], dir(o.na[1], 0.5))
    if (o.gun) {
      const fw2 = dir(o.na[1], 1)
      seg(g, hand, add(hand, fw2, 2.4), 0.6, 'g')
      put(g, Math.floor(hand[0] + fw2[0] * 2.4), Math.floor(hand[1] + fw2[1] * 2.4 - 0.6), 'G')
    }
    ell(g, hand, 0.85, 0.85, 'S')
    const sp = pairOutlined(rows(g), P)
    sp.cx = LCX + 1
    sp.gun = o.gun ? [hand[0] + dir(o.na[1], 3.4)[0] - LCX, hand[1] + dir(o.na[1], 3.4)[1] - LH] : [3, -16]
    return sp
  }
  const TAU = Math.PI * 2
  const cycle = (n, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * TAU, i))
  const LES = {
    stand: hero({ nl: [0.06, 0.02], fl: [-0.1, -0.12], na: [0.08, 0.22], fa: [-0.12, 0.05] }),
    breath: hero({ nl: [0.06, 0.02], fl: [-0.1, -0.12], na: [0.12, 0.3], fa: [-0.08, 0.1], nod: 0.6, lift: -0.4 }),
    walk: cycle(8, (p) => {
      const leg = (q) => {
        const th = 0.04 + 0.44 * Math.sin(q)
        return [th, th - (0.08 + 0.75 * Math.max(0, Math.cos(q - 0.7)))]
      }
      return hero({ t: 0.05, nl: leg(p), fl: leg(p + Math.PI), na: [-0.32 * Math.sin(p), -0.32 * Math.sin(p) + 0.3], fa: [0.32 * Math.sin(p), 0.32 * Math.sin(p) + 0.3] })
    }),
    run: cycle(8, (p) => {
      const leg = (q) => {
        const th = 0.18 + 0.82 * Math.sin(q)
        return [th, th - (0.25 + 1.45 * Math.max(0, Math.cos(q - 0.35)) ** 0.8)]
      }
      return hero({ t: 0.3, nl: leg(p), fl: leg(p + Math.PI), na: [-0.85 * Math.sin(p) + 0.1, -0.85 * Math.sin(p) + 1.55], fa: [0.85 * Math.sin(p) + 0.1, 0.85 * Math.sin(p) + 1.55], lift: 1.1 * Math.abs(Math.cos(p)) })
    }),
    aim: hero({ nl: [0.25, 0.1], fl: [-0.22, -0.18], na: [1.5, 1.57], fa: [-0.1, 0.1], gun: true }),
    kneel: hero({ nl: [1.45, -0.05], fl: [-0.25, -1.45], na: [0.4, 1.0], fa: [0.2, 0.9], t: 0.05 }),
    kneelAim: hero({ nl: [1.45, -0.05], fl: [-0.25, -1.45], na: [1.52, 1.57], fa: [0.2, 0.9], gun: true }),
    sit: hero({ nl: [2.35, 0.15], fl: [2.15, 0.1], na: [0.7, 1.75], fa: [0.6, 1.7], t: -0.2, hy: LH - 2.2 }),
    // feet shoot out from under him, arms flail, then he lands on his back
    slip: hero({ t: -0.4, nl: [1.15, 0.95], fl: [0.15, -0.15], na: [-2.6, -2.9], fa: [2.3, 2.7] }),
    slip2: hero({ t: -0.85, nl: [1.75, 1.5], fl: [1.45, 1.2], na: [-0.9, -0.5], fa: [-0.6, -0.4], hy: LH - 3.6 }),
    down: hero({ t: -1.45, nl: [1.75, 1.55], fl: [1.3, 1.6], na: [-2.7, -2.5], fa: [-1.2, -1.7], hy: LH - 2.4 }),
    downAim: hero({ t: -1.2, nl: [1.75, 1.0], fl: [1.3, 1.6], na: [2.0, 2.0], fa: [-1.2, -1.7], gun: true, hy: LH - 2.6 }),
    // the leech kick: weight back, the near leg snapping out low
    kick: hero({ t: -0.22, nl: [1.2, 1.45], fl: [-0.08, -0.06], na: [-0.6, -0.2], fa: [0.5, 0.9] }),
    kick2: hero({ t: -0.1, nl: [0.75, 0.2], fl: [-0.05, -0.05], na: [-0.3, 0.1], fa: [0.3, 0.7], lift: 0.6 }),
  }
  // the black leeches that drop from the cave roof (inching: stretched, then humped)
  const LP = { o: '#9c8cc0', O: '#5c4c78', D: '#34283f', r: '#ff5a2a' }
  const LEECH = [
    pairOutlined(['.....ooooo...', '..ooOOOOOOOo.', '.oOOOOOOOOOOr', 'DDDDDDDDDDDD.'], LP),
    pairOutlined(['.....ooo.....', '....oOOOo....', '...oOODOOo...', '..oOD...DOo..', '.DDD.....DDDr'], LP),
  ]

  // ---- the friend and the guards --------------------------------------------
  const BW = 32
  const BH = 28
  const BCX = 14
  function alien(o, map = null) {
    const g = grid(BW, BH)
    const kit = !!map
    const T1 = kit ? 'U' : 'B'
    const T2 = kit ? 'u' : 'b'
    const T3 = kit ? 'u' : 'd'
    const t = o.t ?? 0
    const u = [Math.sin(t), -Math.cos(t)]
    const f = [Math.cos(t), Math.sin(t)]
    const leg = (th, sh, hip) => {
      const k = add(hip, dir(th, 6.3))
      const a = add(k, dir(sh, 6.2))
      const toe = add(a, [Math.cos(sh) * 2.3, -Math.sin(sh) * 2.3])
      return [hip, k, a, toe]
    }
    let hip = [BCX + (o.hx ?? 0), 0]
    let nl = leg(...o.nl, hip)
    let fl = leg(...o.fl, hip)
    const hy = o.hy ?? ground([nl[2], nl[3], fl[2], fl[3]], BH - 1, o.lift ?? 0)
    hip = [hip[0], hy]
    nl = leg(...o.nl, hip)
    fl = leg(...o.fl, hip)
    const sh = add(hip, u, 7.4)
    const arm = (ua, fa) => {
      const j = add(sh, u, -0.9)
      const e = add(j, dir(ua, 4.8))
      const w = add(e, dir(fa, 4.4))
      return [j, e, w]
    }
    const na = arm(...o.na)
    const fa = arm(...o.fa)
    seg(g, fa[0], fa[1], 1.15, T3)
    seg(g, fa[1], fa[2], 1.0, T3)
    ell(g, add(fa[2], dir(o.fa[1], 0.7)), 1.15, 1.15, 'd')
    seg(g, fl[0], fl[1], 1.4, T3)
    seg(g, fl[1], fl[2], 1.05, T3)
    seg(g, fl[2], fl[3], 0.8, kit ? 'E' : 'd')
    seg(g, nl[0], nl[1], 1.75, T1)
    seg(g, nl[1], nl[2], 1.1, T1)
    seg(g, nl[1], nl[2], 0.45, T2)
    seg(g, nl[2], nl[3], 0.85, kit ? 'E' : 'b')
    // V-shaped torso, shaded back
    const bs = add(add(sh, f, -2.9), u, 0.4)
    const fs = add(sh, f, 2.9)
    const fw = add(add(hip, f, 1.1), u, 1.0)
    const bw = add(add(hip, f, -1.3), u, 1.0)
    poly(g, [bs, fs, fw, bw], T1)
    // deep chest pushed forward, shaded back and under the pecs
    ell(g, add(add(sh, f, 0.9), u, -1.9), 2.5, 2.3, T1)
    poly(g, [bs, add(sh, f, -0.9), add(add(hip, f, -0.5), u, 1.0), bw], T2)
    seg(g, add(add(sh, f, 0.6), u, -4.0), add(add(sh, f, 2.6), u, -3.3), 0.5, T2)
    // loincloth with a flap
    poly(g, [add(add(hip, f, -1.8), u, 1.6), add(add(hip, f, 1.7), u, 1.6), add(add(hip, f, 1.7), u, -0.9), add(add(hip, f, -1.8), u, -0.9)], 'L')
    poly(g, [add(add(hip, f, 0.2), u, -0.6), add(add(hip, f, 1.8), u, -0.6), add(add(hip, f, 1.4 + (o.flap ?? 0)), u, -3.6)], 'l')
    // tall bald head: long skull, heavy brow, jaw
    const hc = add(add(sh, u, 3.9), f, 1.2)
    seg(g, add(sh, u, 0.2), add(hc, u, -1.4), 1.3, 'b')
    ell(g, add(add(hc, f, -1.1), u, 0.9), 2.3, 2.4, 'B')
    ell(g, hc, 2.1, 2.9, 'B')
    seg(g, add(hc, u, -1.6), add(add(hc, f, 1.9), u, -1.5), 0.95, 'B')
    seg(g, add(add(hc, f, 0.4), u, 0.9), add(add(hc, f, 2.3), u, 0.6), 0.6, 'B')
    ell(g, add(add(hc, f, -1.9), u, 0.4), 1.0, 2.0, 'b')
    put(g, Math.floor(hc[0] + f[0] * 1.3), Math.floor(hc[1] + u[1] * 0.1), 'E')
    put(g, Math.floor(hc[0] + f[0] * 0.7), Math.floor(hc[1] + u[1] * -2.1), 'b')
    put(g, Math.floor(hc[0] + f[0] * 1.4), Math.floor(hc[1] + u[1] * -0.9), 'b')
    // near arm with a rim, big hand, the chain bracelet
    seg(g, na[0], na[1], 1.85, kit ? 'X' : 'd')
    seg(g, na[1], na[2], 1.55, kit ? 'X' : 'd')
    seg(g, na[0], na[1], 1.35, T1)
    seg(g, na[1], na[2], 1.1, T1)
    const hand = add(na[2], dir(o.na[1], 0.7))
    if (o.gun) {
      const fw2 = dir(o.na[1], 1)
      seg(g, hand, add(hand, fw2, 3.0), 0.7, 'g')
    }
    ell(g, hand, 1.35, 1.35, 'B')
    const wr = add(na[2], dir(o.na[1], -0.9))
    seg(g, add(wr, dir(o.na[1] + 1.57, 1)), add(wr, dir(o.na[1] - 1.57, 1)), 0.6, 'C')
    if (o.chain !== false) {
      put(g, Math.floor(wr[0]) - 1, Math.floor(wr[1]) + 1, 'c')
      put(g, Math.floor(wr[0]) - 1, Math.floor(wr[1]) + 2, 'C')
    }
    const sp = pairOutlined(map ? recolor(rows(g), map) : rows(g), P)
    sp.cx = BCX + 1
    sp.gun = [hand[0] + dir(o.na[1], 3.6)[0] - BCX, hand[1] + dir(o.na[1], 3.6)[1] - BH]
    return sp
  }
  const alienSet = (map, gun) => ({
    stand: alien({ nl: [0.08, 0.03], fl: [-0.12, -0.12], na: [0.3, 0.55], fa: [-0.15, 0.1], gun }, map),
    breath: alien({ nl: [0.08, 0.03], fl: [-0.12, -0.12], na: [0.34, 0.65], fa: [-0.1, 0.15], lift: -0.4, gun }, map),
    walk: cycle(8, (p) => {
      const leg = (q) => {
        const th = 0.04 + 0.4 * Math.sin(q)
        return [th, th - (0.06 + 0.7 * Math.max(0, Math.cos(q - 0.7)))]
      }
      return alien({ t: 0.04, nl: leg(p), fl: leg(p + Math.PI), na: [-0.3 * Math.sin(p), -0.3 * Math.sin(p) + 0.25], fa: [0.3 * Math.sin(p), 0.3 * Math.sin(p) + 0.25], flap: 0.6 * Math.sin(p), gun }, map)
    }),
    run: cycle(8, (p) => {
      const leg = (q) => {
        const th = 0.16 + 0.78 * Math.sin(q)
        return [th, th - (0.2 + 1.35 * Math.max(0, Math.cos(q - 0.35)) ** 0.8)]
      }
      return alien({ t: 0.26, nl: leg(p), fl: leg(p + Math.PI), na: [-0.8 * Math.sin(p) + 0.1, -0.8 * Math.sin(p) + 1.4], fa: [0.8 * Math.sin(p) + 0.1, 0.8 * Math.sin(p) + 1.4], lift: 1.2 * Math.abs(Math.cos(p)), flap: -1.2, gun }, map)
    }),
    aim: alien({ nl: [0.25, 0.1], fl: [-0.22, -0.18], na: [1.5, 1.57], fa: [-0.1, 0.1], gun: true }, map),
    punch: alien({ t: 0.18, nl: [0.45, 0.15], fl: [-0.4, -0.3], na: [1.45, 1.6], fa: [-0.5, 0.4], flap: -0.8, gun }, map),
    wind: alien({ t: -0.1, nl: [0.25, 0.1], fl: [-0.3, -0.25], na: [-0.9, 0.6], fa: [0.3, 0.6], gun }, map),
    point: alien({ nl: [0.08, 0.03], fl: [-0.12, -0.12], na: [2.0, 2.2], fa: [-0.1, 0.05], gun }, map),
    sit: alien({ nl: [2.05, 0.05], fl: [1.9, 0.0], na: [1.0, 1.9], fa: [0.8, 1.7], t: 0.08, hy: BH - 2.6, gun }, map),
    fall: alien({ t: -0.9, nl: [1.3, 0.9], fl: [0.7, 0.4], na: [-2.2, -2.6], fa: [-1.2, -1.8], hy: BH - 8, gun }, map),
    dead: alien({ t: -1.52, nl: [1.6, 1.5], fl: [1.5, 1.6], na: [-1.75, -1.65], fa: [-1.4, -1.6], hy: BH - 2.6, chain: false, gun }, map),
  })
  const BUD = alienSet(null, false)
  // guards: the same tall race in dark uniforms, gun in hand, no chain
  const GUARD = alienSet({ L: 'X', l: 'K', C: 'u', c: '.' }, true)

  // ---- the beast ------------------------------------------------------------
  const KW = 36
  const KH = 17
  const KCX = 17
  /** o: legs as [thigh, shin] for back near/far and front near/far, pitch,
   *  head drop, tail curl, stretch, lift, crouch. */
  function beast(o, mapTo = null) {
    const g = grid(KW, KH)
    const st = o.stretch ?? 0
    const back = [KCX - 6 - st, 0]
    const front = [KCX + 5 + st, 0]
    const legB = (th, sh, at) => {
      const k = add(at, dir(th, 4.4))
      const a = add(k, dir(sh, 4.6))
      return [at, k, a, add(a, [1.4, 0])]
    }
    const legF = (th, sh, at) => {
      const k = add(at, dir(th, 4.6))
      const a = add(k, dir(sh, 4.4))
      return [at, k, a, add(a, [1.5, 0])]
    }
    const pitch = o.pitch ?? 0
    const build = (by) => {
      const b = [back[0], by - pitch]
      const fr = [front[0], by + pitch]
      return { b, fr, bn: legB(...o.bn, add(b, [0, 1.6])), bf: legB(...o.bf, add(b, [0.6, 1.6])), fn: legF(...o.fn, add(fr, [0, 1.5])), ff: legF(...o.ff, add(fr, [-0.6, 1.5])) }
    }
    let j = build(0)
    const by = o.by ?? ground([j.bn[2], j.bf[2], j.fn[2], j.ff[2]], KH - 0.8, o.lift ?? 0)
    j = build(by)
    const far = 'Y'
    const near = 'X'
    // far legs, tail
    for (const L of [j.bf, j.ff]) {
      seg(g, L[0], L[1], L === j.bf ? 1.5 : 1.1, far)
      seg(g, L[1], L[2], 0.8, far)
      seg(g, L[2], L[3], 0.7, far)
    }
    const curl = o.tail ?? 0
    let tp = add(j.b, [-2.2, -1.2])
    for (let i = 0; i < 7; i++) {
      const a = -1.9 + i * (0.12 + curl * 0.07) - curl * 0.3
      const n = add(tp, [-Math.cos(a + 1.57) * 1.5 - 0.6, Math.sin(a + 1.2) * 1.0 - 0.2 + i * 0.12 * (1 - curl)])
      seg(g, tp, n, i < 3 ? 0.75 : 0.6, near)
      tp = n
    }
    // body: haunch, deep chest, belly
    ell(g, add(j.b, [0.2, 0.4]), 3.0, 2.8, near)
    ell(g, add(j.fr, [-0.4, 0.6]), 3.2, 3.3, near)
    seg(g, j.b, j.fr, 2.4, near)
    seg(g, add(j.b, [1.5, 1.0]), add(j.fr, [-1.5, 1.6]), 1.7, near)
    // neck, maned head, jaw
    const drop = o.drop ?? 0
    const hc = add(j.fr, [4.6, -1.6 + drop])
    seg(g, add(j.fr, [0.8, -0.6]), hc, 2.6, near)
    ell(g, hc, 2.7, 2.3, near)
    seg(g, add(hc, [0.8, 0.4]), add(hc, [3.6, 1.3]), 1.25, near)
    seg(g, add(hc, [0.5, 1.4]), add(hc, [2.8, 2.4]), 0.8, o.roar ? far : near)
    put(g, Math.floor(hc[0] - 1.3), Math.floor(hc[1] - 2.8), near)
    put(g, Math.floor(hc[0] - 0.4), Math.floor(hc[1] - 2.5), near)
    // near legs
    for (const L of [j.bn, j.fn]) {
      seg(g, L[0], L[1], L === j.bn ? 1.75 : 1.25, near)
      seg(g, L[1], L[2], 0.85, near)
      seg(g, L[2], L[3], 0.75, near)
    }
    // dim rim of light along the back, and the eye
    for (let x = 0; x < KW; x++)
      for (let y = 0; y < KH; y++)
        if (g[y][x] === near) {
          if (y > 0 && g[y - 1][x] === '.' && x < hc[0] + 1) g[y][x] = 'x'
          break
        }
    put(g, Math.floor(hc[0] + 1.2), Math.floor(hc[1] - 0.5), 'e')
    const r = mapTo ? recolor(rows(g), mapTo) : rows(g)
    const sp = pairOutlined(r, P, GLOW)
    sp.cx = KCX + 1
    sp.head = hc[0] - KCX
    return sp
  }
  const KB = {
    prowl: cycle(8, (p) => {
      const L = (q, ext) => {
        const th = 0.05 + 0.42 * Math.sin(q)
        return ext ? [th + 0.35, th - 0.4 - 0.5 * Math.max(0, Math.cos(q - 0.6))] : [th - 0.15, th + 0.1 - 0.7 * Math.max(0, Math.cos(q - 0.6))]
      }
      return beast({ bn: L(p, true), bf: L(p + Math.PI, true), fn: L(p + Math.PI / 2, false), ff: L(p + Math.PI * 1.5, false), drop: 1.2, tail: 0.2 + 0.2 * Math.sin(p), pitch: 0.2 })
    }),
    run: cycle(6, (p) => {
      const s = Math.sin(p)
      return beast({
        bn: [0.2 - 0.95 * s, -0.4 - 0.9 * s],
        bf: [0.0 - 0.95 * Math.sin(p - 0.5), -0.6 - 0.9 * Math.sin(p - 0.5)],
        fn: [0.1 + 1.05 * s, -0.2 + 0.8 * Math.max(0, s) - 0.9 * Math.max(0, -s)],
        ff: [0.1 + 1.05 * Math.sin(p - 0.5), -0.3 + 0.8 * Math.max(0, Math.sin(p - 0.5))],
        stretch: 1.4 * s,
        pitch: 0.6 * Math.cos(p),
        lift: 1.4 * Math.max(0, s),
        drop: 0.4,
        tail: 0.6 + 0.3 * Math.cos(p),
      })
    }),
    crouch: beast({ bn: [1.2, -1.35], bf: [1.1, -1.3], fn: [-0.9, 0.95], ff: [-0.8, 0.85], by: 7.6, pitch: -0.8, drop: 2.2, tail: 1 }),
    leap: beast({ bn: [-1.3, -1.6], bf: [-1.1, -1.5], fn: [2.1, 1.7], ff: [1.9, 1.5], stretch: 1.8, by: 4.5, pitch: 0.4, drop: -0.6, roar: true, tail: -0.4 }),
    stand: beast({ bn: [0.35, -0.3], bf: [0.15, -0.35], fn: [-0.05, 0.05], ff: [0.08, 0.1], drop: 0.6, tail: 0.5 }),
    roar: beast({ bn: [0.35, -0.3], bf: [0.15, -0.35], fn: [-0.25, 0.1], ff: [-0.1, 0.1], drop: -1.2, pitch: 0.5, roar: true, tail: 0.9 }),
  }
  KB.hit = beast({ bn: [0.35, -0.3], bf: [0.15, -0.35], fn: [0.5, 0.4], ff: [0.6, 0.5], drop: -0.8, pitch: 0.8, roar: true, tail: 1.2 }, { X: 'V', Y: 'V', x: 'V', e: 'V' })
  KB.hurt = beast({ bn: [0.35, -0.3], bf: [0.15, -0.35], fn: [0.5, 0.4], ff: [0.6, 0.5], drop: -0.8, pitch: 0.8, roar: true, tail: 1.2 })


  // glows for the three charge levels, built once
  function glowSprite(r, stops) {
    const pal = {}
    stops.forEach((st, i) => (pal[String(i)] = st[1]))
    const g = []
    for (let y = 0; y <= r * 2; y++) {
      let row = ''
      for (let i = 0; i <= r * 2; i++) {
        const q = Math.hypot(i - r, y - r) / (r + 0.5)
        const k = stops.findIndex((st) => q <= st[0])
        row += k < 0 ? '.' : String(k)
      }
      g.push(row)
    }
    return sprite(g, pal)
  }
  const CHARGE = [
    null,
    glowSprite(1, [[0.4, '#ffffff'], [1, 'rgba(255,240,170,.7)']]),
    glowSprite(2, [[0.3, '#ffffff'], [0.65, '#9fe9ff'], [1, 'rgba(74,140,255,.55)']]),
    glowSprite(4, [[0.25, '#ffffff'], [0.5, '#ffe28a'], [0.75, 'rgba(255,120,60,.75)'], [1, 'rgba(120,60,200,.45)']]),
  ]
  const CH_HOLD = [0, 0, 380, 1100] // press time that reaches each level

  // ---- stage helpers ----------------------------------------------------------
  const blit = (c, sp, x, dir, yOff = 0) => {
    const left = dir > 0 ? x - sp.cx : x - (sp.w - 1 - sp.cx)
    c.drawImage(sp[dir], Math.round(left), FLOOR - sp.h + 1 + Math.round(yOff))
  }
  const HALF = 12
  const isOpen = (s, x, half = HALF) => x >= half && x <= s.W - half && !s.fixtureOver(x - half, x + half)
  /** Nearest x near `want` where a figure can stand clear of the furniture. */
  function openSpot(s, want, avoid = null, gap = 20) {
    let best = Math.round(clamp(want, HALF, s.W - HALF))
    let bd = 1e9
    for (let x = HALF; x <= s.W - HALF; x += 2) {
      if (!isOpen(s, x)) continue
      if (avoid !== null && Math.abs(x - avoid) < gap) continue
      const dd = Math.abs(x - want)
      if (dd < bd) {
        bd = dd
        best = x
      }
    }
    return best
  }
  /** Room for two figures side by side: [hero, friend]. */
  function pairSpot(s, want) {
    let best = null
    let bd = 1e9
    for (let x = HALF; x <= s.W - HALF; x += 2) {
      if (!isOpen(s, x)) continue
      const side = isOpen(s, x + 18) ? 18 : isOpen(s, x - 18) ? -18 : 0
      if (!side) continue
      const dd = Math.abs(x - want)
      if (dd < bd) {
        bd = dd
        best = [x, x + side]
      }
    }
    return best || [openSpot(s, want), openSpot(s, want + 18, openSpot(s, want))]
  }
  const period = (s) => s.W + 40
  const wrapX = (s, x) => (x > s.W + 20 ? x - period(s) : x < -20 ? x + period(s) : x)
  /** How far a runner heading right at `a` is ahead of `b` (wrapping). */
  const ahead = (s, a, b) => {
    const p = period(s)
    return (((a - b) % p) + p) % p
  }
  /** Someone is playing: a click or drag in the last 9 s, or the cursor moving over the bar. */
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0
  const engaged = (s, now) => now - (s.keyAt ?? -1e9) < 9000 || now - (s.data.clickAt ?? -1e9) < 9000 || now - (s.data.grabAt ?? -1e9) < 9000 || (!!s.cursor && now - s.cursor.since < 2500)
  const FRIEND_SAYS = ['Monal ti?', 'Ash! Ash!', 'Huu-ma.', 'Eh-leh?', 'Pista, pista!', 'Na kara.']
  const bubble = (s, k, x) => s.particle({ img: BUBBLE[k], x: x - 2, y: Math.max(1, FLOOR - 34), life: 0.9, vy: -2 })

  // ---- figures ------------------------------------------------------------------
  class Walker {
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = FLOOR
      this.dir = 1
      this.tx = null
      this.cb = null
      this.speed = 24
      this.runSpeed = 60
      this.running = false
      this.dist = 0
      this.turnAt = 0
    }
    get moving() {
      return this.tx !== null || this.running || !!this.kmove
    }
    goto(x, speed, cb = null) {
      this.tx = Math.round(x)
      this.speed = speed
      this.cb = cb
    }
    face(x, now = 0, cool = 0) {
      const want = x > this.x ? 1 : -1
      if (want !== this.dir && (!cool || now - this.turnAt >= cool)) {
        this.dir = want
        this.turnAt = now
      }
    }
    step(dt) {
      if (this.running) {
        this.x = wrapX(this.s, this.x + this.dir * this.runSpeed * dt)
        this.dist += this.runSpeed * dt
        return true
      }
      if (this.tx === null) return false
      const d = this.tx - this.x
      const sp = this.speed
      if (Math.abs(d) <= sp * dt + 0.01) {
        this.x = this.tx
        this.tx = null
        const cb = this.cb
        this.cb = null
        if (cb) cb()
        return true
      }
      this.dir = d > 0 ? 1 : -1
      this.x += this.dir * sp * dt
      this.dist += sp * dt
      return true
    }
  }

  class Hero extends Walker {
    constructor(s, x) {
      super(s, x)
      this.z = 3
      this.aimUntil = 0
      this.kneel = false
      this.sitting = false
      this.anim = null
      this.animUntil = 0
      this.animNext = null
      this.breath = false
    }
    get asleep() {
      return this.sitting
    }
    get grabbable() {
      const m = this.s.data.mode
      return !this.hidden && (m === 'idle' || m === 'rest' || m === 'fight')
    }
    low() {
      return this.kneel || this.sitting || !!this.anim
    }
    hit(x, y) {
      return !this.hidden && Math.abs(x - this.x) <= 9 && y >= FLOOR - (this.low() ? 17 : 28) && y <= FLOOR + 1
    }
    /** Play poses in turn: play(['slip', 180], ['slip2', 200], ['down', 1e9]). */
    play(...seq) {
      this.seq = seq
      this.anim = seq[0][0]
      this.animUntil = performance.now() + seq[0][1]
      this.seq.shift()
    }
    sprite(now) {
      if (this.anim) return LES[this.anim]
      if (this.running || this.kmove) return LES.run[Math.floor(this.dist / 5.5) % 8]
      if (this.tx !== null) return this.speed > 40 ? LES.run[Math.floor(this.dist / 5.5) % 8] : LES.walk[Math.floor(this.dist / 3) % 8]
      const aim = now < this.aimUntil || this.s.data.press
      if (this.sitting) return LES.sit
      if (this.kneel) return aim ? LES.kneelAim : LES.kneel
      if (aim) return LES.aim
      return this.breath ? LES.breath : LES.stand
    }
    gun() {
      const sp = this.sprite(performance.now())
      return { x: this.x + this.dir * sp.gun[0], y: FLOOR + sp.gun[1] }
    }
    onClick() {
      const s = this.s
      const d = s.data
      const now = performance.now()
      d.clickAt = now
      if (this.hidden) return
      this.clicks = (this.clicks || []).filter((t) => now - t < 2500)
      this.clicks.push(now)
      if (d.mode === 'chase') return chaseStand(s)
      if (d.mode === 'fight') {
        if (!d.shields.some((sh) => sh.owner === 'L')) {
          this.kneel = true
          raiseShield(s, d.guard && d.guard.x < this.x ? -1 : 1, undefined, 'L', 1e9)
        } else if (d.guard) fireAt(s, d.guard.x, FLOOR - 15)
        return
      }
      if (d.mode !== 'idle' && d.mode !== 'rest') return
      this.sitting = false
      if (this.clicks.length >= 5) {
        // easter egg: the experiment goes wrong again
        this.clicks.length = 0
        return teleport(s)
      }
      const b = d.beast
      const lc = d.leeches.find((l) => l.alive && Math.abs(l.x - this.x) < 26)
      if (lc && lc.state === 'crawl' && !this.anim) return kick(s, lc)
      const c = s.cursor
      raiseShield(s, b.present ? (b.x > this.x ? 1 : -1) : c && Math.abs(c.x - this.x) > 12 ? (c.x > this.x ? 1 : -1) : this.dir)
    }
    onDblClick() {
      this.s.data.clickAt = performance.now()
      if (!this.hidden) bigShot(this.s)
    }
    // the pistol the way the game played it: press, hold to charge, let go.
    // Drag from the hero toward the target; a short pull fires, a longer one
    // throws the shield, a long one lets go the big blast.
    grab(p) {
      const d = this.s.data
      const now = performance.now()
      d.grabAt = now
      this.sling = this.grabbable
      if (!this.sling) return
      this.sitting = false
      this.tx = this.cb = null
      d.press = { t: now, x: p.x, y: p.y }
      this.aimUntil = now + 4000
    }
    drag(p) {
      const d = this.s.data
      d.grabAt = performance.now()
      if (!this.sling || !d.press) return
      d.press.x = p.x
      d.press.y = p.y
      if (Math.abs(p.x - this.x) > 4 && !this.running && !this.anim) this.dir = p.x > this.x ? 1 : -1
    }
    drop(p) {
      const s = this.s
      const d = s.data
      const now = performance.now()
      d.grabAt = now
      const pr = d.press
      d.press = null
      if (!this.sling || !pr) return
      this.sling = false
      const held = now - pr.t
      this.aimUntil = now + 700
      let tx = p.x
      let ty = p.y
      if (Math.abs(p.x - this.x) < 14) {
        tx = this.x + this.dir * 140
        ty = FLOOR - 15
      }
      if (d.mode === 'fight') return fireAt(s, tx, ty, held >= CH_HOLD[3])
      if (d.mode !== 'idle' && d.mode !== 'rest') return
      d.lastShot = 0
      if (held >= CH_HOLD[3]) fireAt(s, tx, FLOOR - 15, true)
      else if (held >= CH_HOLD[2]) raiseShield(s, tx >= this.x ? 1 : -1)
      else fireAt(s, tx, ty)
    }
    update(dt, now) {
      if (this.anim && now >= this.animUntil) {
        const nx = this.seq && this.seq.shift()
        this.anim = nx ? nx[0] : null
        this.animUntil = nx ? now + nx[1] : 0
        return FAST
      }
      if (this.step(dt)) return FAST
      if (this.anim && this.animUntil < now + 1e8) return this.animUntil - now
      return Infinity
    }
    draw(c) {
      if (this.hidden) return
      blit(c, this.sprite(performance.now()), this.x, this.dir)
    }
  }

  class Friend extends Walker {
    constructor(s, x) {
      super(s, x)
      this.z = 2
      this.pose = null
      this.poseUntil = 0
      this.sitting = false
      this.runSpeed = 62
      this.breath = false
    }
    get asleep() {
      return this.sitting
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 10 && y >= FLOOR - (this.sitting ? 17 : 31) && y <= FLOOR + 1
    }
    strike(pose, ms) {
      this.pose = pose
      this.poseUntil = performance.now() + ms
    }
    onClick() {
      const s = this.s
      const d = s.data
      const now = performance.now()
      d.clickAt = now
      if (now < this.poseUntil + 400 || this.moving) return
      const b = d.beast
      if (d.mode === 'idle' && b.present && ['prowl', 'blocked', 'startle', 'stunned'].includes(b.state)) return friendSwat(s, true)
      this.sitting = false
      // he points somewhere and says something in his own tongue; the hero looks
      const c = s.cursor
      this.face(c && Math.abs(c.x - this.x) > 8 ? c.x : d.les.x)
      this.strike('point', 1100)
      s.say(pick(FRIEND_SAYS), this.x, 1, { color: '#bcd8b4', life: 2.2 })
      const L = d.les
      if ((d.mode === 'idle' || d.mode === 'rest') && !L.moving && !L.anim && !L.hidden) {
        L.sitting = false
        L.face(this.x + this.dir * 60)
        bubble(s, '?', L.x)
      }
    }
    update(dt, now) {
      if (this.step(dt)) return FAST
      if (now < this.poseUntil) return this.poseUntil - now
      if (this.pose) {
        this.pose = null
        return FAST
      }
      return Infinity
    }
    draw(c) {
      const now = performance.now()
      let sp
      if (this.running || (this.tx !== null && this.speed > 40)) sp = BUD.run[Math.floor(this.dist / 6) % 8]
      else if (this.tx !== null) sp = BUD.walk[Math.floor(this.dist / 3.3) % 8]
      else if (now < this.poseUntil && this.pose) sp = BUD[this.pose]
      else if (this.sitting) sp = BUD.sit
      else sp = this.breath ? BUD.breath : BUD.stand
      blit(c, sp, this.x, this.dir)
    }
  }

  class Guard {
    constructor(s, x, dir, tx) {
      this.s = s
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.tx = tx
      this.state = 'enter'
      this.dist = 0
      this.z = 2
      this.aimUntil = 0
      this.since = performance.now()
    }
    get moving() {
      return this.state === 'enter' || this.state === 'flee'
    }
    hit(x, y) {
      return this.state !== 'fall' && this.state !== 'dead' && Math.abs(x - this.x) <= 10 && y >= FLOOR - 31 && y <= FLOOR + 1
    }
    onClick() {
      this.s.data.clickAt = performance.now()
      fireAt(this.s, this.x, FLOOR - 15)
    }
    onDblClick() {
      this.s.data.clickAt = performance.now()
      bigShot(this.s)
    }
    gun() {
      const sp = GUARD.aim
      return { x: this.x + this.dir * sp.gun[0], y: FLOOR + sp.gun[1] }
    }
    shot() {
      const now = performance.now()
      this.state = 'fall'
      this.since = now
      this.s.burst(this.x, FLOOR - 15, 8, ['w', 'y', 'O'])
    }
    update(dt, now, s) {
      if (this.state === 'enter') {
        const d = this.tx - this.x
        const sp = 58
        if (Math.abs(d) <= sp * dt) {
          this.x = this.tx
          this.state = 'stand'
          this.dir = s.data.les.x > this.x ? 1 : -1
          return FAST
        }
        this.dir = d > 0 ? 1 : -1
        this.x += this.dir * sp * dt
        this.dist += sp * dt
        return FAST
      }
      if (this.state === 'flee') {
        this.x += this.dir * 60 * dt
        this.dist += 60 * dt
        if (this.x < -20 || this.x > s.W + 20) this.dead = true
        return FAST
      }
      if (this.state === 'fall') {
        if (now - this.since > 380) {
          this.state = 'dead'
          this.since = now
        }
        return FAST
      }
      if (this.state === 'dead') {
        if (now - this.since > 2600) this.dead = true
        return now - this.since > 1500 ? FAST : 1500 - (now - this.since)
      }
      return now < this.aimUntil ? this.aimUntil - now : Infinity
    }
    draw(c) {
      const now = performance.now()
      let sp
      if (this.state === 'enter') sp = GUARD.run[Math.floor(this.dist / 6) % 8]
      else if (this.state === 'flee') sp = GUARD.run[Math.floor(this.dist / 6) % 8]
      else if (this.state === 'fall') sp = GUARD.fall
      else if (this.state === 'dead') {
        // the body breaks up and fades, the way the game's dead dissolve
        const t = now - this.since
        if (t > 1500 && this.s.data.fr % (t > 2100 ? 2 : 3) === 0) return
        sp = GUARD.dead
      } else sp = now < this.aimUntil || this.s.data.mode === 'fight' ? GUARD.aim : GUARD.stand
      blit(c, sp, this.x, this.dir)
    }
  }

  class Beast {
    constructor(s) {
      this.s = s
      this.present = false
      this.x = -30
      this.dir = 1
      this.state = 'away'
      this.nextAt = performance.now() + rand(3000, 6000)
      this.until = 0
      this.dist = 0
      this.walking = false
      this.z = 1
      this.since = 0
      this.yOff = 0
      this.vy = 0
      this.vx = 0
    }
    get moving() {
      return this.present && (this.walking || this.state === 'leap' || this.state === 'chase' || this.state === 'flee')
    }
    hit(x, y) {
      return this.present && this.state !== 'hit' && Math.abs(x - this.x) <= 17 && y >= FLOOR - 21 + this.yOff && y <= FLOOR + 1 + this.yOff
    }
    onClick() {
      this.s.data.clickAt = performance.now()
      fireAt(this.s, this.x + this.dir * 6, FLOOR - 9 + this.yOff)
    }
    onDblClick() {
      this.s.data.clickAt = performance.now()
      bigShot(this.s)
    }
    enter(x, state) {
      this.present = true
      this.x = x
      this.dir = x < this.s.W / 2 ? 1 : -1
      this.state = state
      this.since = performance.now()
      this.until = this.since + rand(1200, 1800)
      this.walking = true
      this.yOff = 0
      this.vy = 0
      const d = this.s.data
      d.actCool = Math.max(d.actCool ?? 0, this.since + rand(3500, 6000))
    }
    go(state, ms = 0) {
      this.state = state
      this.since = performance.now()
      this.until = this.since + ms
    }
    struck(by, after) {
      const away = this.x > by ? 1 : -1
      this.x = clamp(this.x + away * 9, -16, this.s.W + 16)
      this.vx = away * 30
      if (this.yOff < 0) this.vy = Math.min(this.vy, -30)
      this.walking = false
      this.after = after
      this.atCursor = false
      this.s.data.duskWant = 0
      this.go('hit', 320)
      this.s.burst(this.x + this.dir * 8, FLOOR - 9 + this.yOff, 8, ['w', 'y', 'c'])
    }
    gone(now) {
      this.present = false
      this.state = 'away'
      this.walking = false
      this.fleeEdge = null
      this.atCursor = false
      // the director calls it back as one of its episodes
      this.nextAt = Infinity
    }
    pounce(target) {
      this.target = target
      this.dir = target > this.x ? 1 : -1
      this.walking = false
      this.go('crouch', 750)
      this.s.data.duskWant = 1
    }
    /** Move toward x, stopping at a shield in the way. Returns true if blocked. */
    advance(tx, speed, dt) {
      const d = tx - this.x
      if (Math.abs(d) < 1) {
        this.walking = false
        return false
      }
      this.dir = d > 0 ? 1 : -1
      let nx = this.x + this.dir * Math.min(Math.abs(d), speed * dt)
      for (const sh of this.s.data.shields) {
        if (sh.owner !== 'L') continue
        const stop = sh.x - this.dir * 16
        if ((this.dir > 0 && this.x <= stop + 0.5 && nx > stop) || (this.dir < 0 && this.x >= stop - 0.5 && nx < stop)) {
          this.x = stop
          this.walking = false
          return true
        }
      }
      this.x = nx
      this.walking = true
      this.dist += speed * dt
      return false
    }
    physics(dt) {
      if (this.yOff < 0 || this.vy < 0) {
        this.vy += 300 * dt
        this.yOff = Math.min(0, this.yOff + this.vy * dt)
        if (this.yOff === 0) this.vy = 0
      }
      if (this.vx) {
        this.x += this.vx * dt
        this.vx *= 0.8
        if (Math.abs(this.vx) < 2) this.vx = 0
      }
    }
    update(dt, now, s) {
      const d = s.data
      const L = d.les
      if (!this.present) {
        if (d.mode === 'idle' && s.lively(now) && !s.busy) {
          if (now >= this.nextAt) {
            // in from the nearer edge, unless that would put it right on top of him
            const nearLeft = L.x < s.W / 2
            const left = nearLeft ? L.x > 110 : s.W - L.x < 110
            this.enter(left ? -16 : s.W + 16, 'prowl')
            return FAST
          }
          return this.nextAt - now
        }
        return Infinity
      }
      this.physics(dt)
      if (this.state === 'hit') {
        if (now >= this.until && this.yOff === 0) this.go(this.after, 900)
        return FAST
      }
      if (this.state === 'flee' || this.state === 'leave') {
        const edge = this.fleeEdge ?? (this.x < L.x ? -20 : s.W + 20)
        this.fleeEdge = edge
        this.dir = edge < 0 ? -1 : 1
        const sp = this.state === 'flee' ? 100 : 30
        this.x += this.dir * sp * dt
        this.dist += sp * dt
        this.walking = true
        if (this.x < -20 || this.x > s.W + 20) {
          this.gone(now)
          return Infinity
        }
        return FAST
      }
      if (!s.lively(now) || !['idle', 'chase'].includes(d.mode)) {
        this.go('leave')
        return FAST
      }
      if (this.state === 'stunned') {
        this.walking = false
        if (now >= this.until) this.go(d.mode === 'chase' ? 'chase' : 'flee')
        return FAST
      }
      if (this.state === 'crouch') {
        this.walking = false
        if (now >= this.until) {
          // the leap: a long low arc at its prey
          this.go('leap', 1200)
          this.dir = this.target > this.x ? 1 : -1
          // at the cursor it springs high, up off the top of the bar
          this.vy = this.atCursor ? -112 : -78
          this.yOff = -0.1
          this.leapVx = clamp((this.target - this.x) * (this.atCursor ? 1.35 : 1.9), -160, 160)
        }
        return FAST
      }
      if (this.state === 'leap') {
        this.x += this.leapVx * dt
        for (const sh of d.shields)
          if (sh.owner === 'L' && Math.abs(this.x + this.dir * 12 - sh.x) < 3) {
            // slams into the force field and drops
            shieldFlash(s, sh)
            this.struck(sh.x, d.mode === 'chase' ? 'stunned' : 'flee')
            return FAST
          }
        if (this.yOff === 0 && now - this.since > 150) {
          d.duskWant = 0
          if (this.atCursor) {
            // it lands where the pointer was, snarling
            this.atCursor = false
            this.go('startle', 900)
            return FAST
          }
          if (d.mode === 'idle' && Math.abs(this.x - L.x) < 20 && !L.anim && !L.hidden) {
            // nobody shot it: it bowls the hero over and he scrambles back up
            L.tx = L.cb = null
            L.kneel = false
            L.play(['slip', 170], ['slip2', 190], ['down', 1300], ['kneel', 350])
            s.burst(L.x, FLOOR - 8, 8, ['w', 'H', 'x'])
            this.x = clamp(this.x + this.dir * 16, -16, s.W + 16)
          }
          this.go(d.mode === 'chase' ? 'chase' : 'blocked', 1400)
        }
        return FAST
      }
      if (this.state === 'chase') {
        this.dir = 1
        const behind = ahead(s, L.x, this.x)
        let nx = this.x + (68 + clamp((behind - 50) * 0.7, 0, 60)) * dt
        for (const sh of d.shields) if (sh.owner === 'L' && this.x < sh.x && nx > sh.x - 16) nx = Math.max(this.x, sh.x - 16)
        this.walking = nx !== this.x
        this.dist += nx - this.x
        this.x = wrapX(s, nx)
        const minGap = L.anim ? 46 : d.bud && !d.bud.lead ? 40 : 20
        if (ahead(s, L.x, this.x) < minGap) {
          this.x = wrapX(s, L.x - minGap)
          this.walking = false
        }
        return FAST
      }
      if (this.state === 'startle') {
        // a shot at its feet: it rears and snarls, then keeps stalking
        this.walking = false
        if (now >= this.until) this.go('prowl', 0)
        return FAST
      }
      if (this.state === 'blocked') {
        this.walking = false
        if (now >= this.until) this.go('leave')
        return FAST
      }
      // prowl: stalk the cursor if it's on the bar, else creep up on the hero
      if (now - this.since > 18000 && !s.cursor) {
        this.go('leave')
        return FAST
      }
      const far = Math.abs(L.x - this.x) > 150
      if (now >= this.until) {
        // far off it trots in without stopping; close up it creeps and freezes
        this.walking = far || !this.walking
        this.until = now + (this.walking ? rand(1200, 2000) : rand(700, 1300))
      }
      const cu = s.cursor
      // a quick swipe of the pointer across it: it rears and snarls
      if (cu && cu.speed > 450 && Math.abs(cu.x - this.x) < 24 && now > (this.startleCd || 0)) {
        this.startleCd = now + 4000
        this.walking = false
        this.go('startle', 800)
        return FAST
      }
      // tease it with the pointer and it springs at it
      if (cu && engaged(s, now) && d.mode === 'idle' && !d.shields.length && Math.abs(cu.x - this.x) > 26 && Math.abs(cu.x - this.x) < 80 && now > (this.cursorLeapAt || 0)) {
        this.cursorLeapAt = now + rand(5000, 8000)
        this.atCursor = true
        this.pounce(clamp(cu.x, 10, s.W - 10))
        return FAST
      }
      const gap = Math.abs(L.x - this.x)
      if (gap > 32 && gap < 80 && now > d.leapCool && !L.moving && !d.shields.length && d.mode === 'idle') {
        d.leapCool = now + rand(14000, 22000)
        this.pounce(L.x)
        bubble(s, '!', L.x)
        return FAST
      }
      if (this.walking) {
        const c = s.cursor
        let goal
        if (c && c.y >= 0 && c.y <= H + 4) goal = c.x + (c.x > this.x ? -14 : 14)
        else goal = L.x + (this.x > L.x ? 46 : -46)
        if (this.advance(clamp(goal, -10, s.W + 10), far ? 64 : 22, dt)) {
          this.go('blocked', 2000)
          bubble(s, '!', L.x)
        }
      }
      return FAST
    }
    draw(c) {
      if (!this.present) return
      const fr = this.s.data.fr
      let sp
      switch (this.state) {
        case 'hit':
          sp = fr % 2 ? KB.hit : KB.hurt
          break
        case 'crouch':
          sp = KB.crouch
          break
        case 'leap':
          sp = KB.leap
          break
        case 'blocked':
        case 'startle':
        case 'stunned':
          sp = fr % 8 < 4 ? KB.roar : KB.stand
          break
        case 'flee':
        case 'chase':
          sp = this.walking ? KB.run[Math.floor(this.dist / 7) % 6] : KB.stand
          break
        default:
          sp = this.walking ? KB.prowl[Math.floor(this.dist / 2.6) % 8] : KB.stand
      }
      blit(c, sp, this.x, this.dir, this.yOff)
      if (this.state === 'stunned' && fr % 4 < 2) {
        c.fillStyle = '#ffd040'
        c.fillRect(Math.round(this.x + this.dir * 8), FLOOR - 17, 1, 1)
        c.fillRect(Math.round(this.x + this.dir * 4), FLOOR - 18, 1, 1)
      }
    }
  }

  // ---- the leeches ---------------------------------------------------------------
  class Leech {
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = -2
      this.vx = 0
      this.vy = 0
      this.state = 'drop'
      this.dir = 1
      this.ph = Math.random()
      this.z = 4
      this.moving = true
      this.grabbable = true
      this.kicked = false
      this.turnAt = 0
    }
    get alive() {
      return this.state === 'drop' || this.state === 'crawl'
    }
    hit(x, y) {
      return this.state !== 'fly' && Math.abs(x - this.x) <= 10 && y >= this.y - 11 && y <= this.y + 2
    }
    onClick() {
      const s = this.s
      const d = s.data
      d.clickAt = performance.now()
      const L = d.les
      if (!this.alive || L.hidden) return
      if (this.state === 'crawl' && d.mode === 'idle' && Math.abs(this.x - L.x) < 26 && !L.anim) kick(s, this)
      else fireAt(s, this.x, FLOOR - 2)
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      if (!this.alive) return
      this.state = 'held'
      this.hvx = 0
      this.drag(p)
    }
    drag(p) {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      const nx = clamp(p.x, 3, this.s.W - 3)
      this.hvx = this.hvx * 0.5 + (nx - this.x) * 6
      if (Math.abs(nx - this.x) > 1) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.y = clamp(p.y + 3, 4, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      this.state = 'fly'
      this.vx = clamp(this.hvx, -150, 150)
      this.vy = -25
      this.kicked = false
    }
    kickOff(dir) {
      this.state = 'fly'
      this.dir = dir
      this.vx = dir * rand(95, 135)
      this.vy = -rand(95, 120) // up off the top of the bar
      this.kicked = true
    }
    zap() {
      this.dead = true
      this.s.burst(this.x, FLOOR - 2, 6, ['w', 'y', 'm'])
    }
    update(dt, now, s) {
      const d = s.data
      const L = d.les
      if (this.state === 'held') return FAST
      if (!s.lively(now) && this.state !== 'fly') {
        // they slither off into the cracks when nothing is going on
        this.dead = true
        s.burst(this.x, FLOOR - 1, 3, ['a', 'n'])
        return Infinity
      }
      if (this.state === 'drop') {
        this.vy += 260 * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          this.state = 'crawl'
          this.dir = L.x > this.x ? 1 : -1
          s.burst(this.x, FLOOR - 1, 3, ['a', 'n'])
        }
        return FAST
      }
      if (this.state === 'fly') {
        this.vy += 300 * dt
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.x < -14 || this.x > s.W + 14) {
          this.dead = true
          return Infinity
        }
        if (this.y >= FLOOR) {
          this.y = FLOOR
          const b = d.beast
          if (b.present && b.state === 'prowl' && Math.abs(b.x - this.x) < 18) b.go('startle', 900)
          if (this.kicked || this.vy > 150) {
            this.dead = true
            s.burst(this.x, FLOOR - 1, 5, ['x', 'a', 'm'])
            return Infinity
          }
          this.state = 'crawl'
          this.vx = 0
        }
        return FAST
      }
      // crawl: inch toward the hero, moving only on the stretch
      this.ph += dt * 3
      const want = L.x > this.x ? 1 : -1
      if (want !== this.dir && now > this.turnAt) {
        this.dir = want
        this.turnAt = now + 1200
      }
      if (Math.floor(this.ph) % 2 === 0) this.x += this.dir * 16 * dt
      if (!L.hidden && d.mode === 'idle' && Math.abs(L.x - this.x) < 4 && !L.anim) kick(s, this, true)
      return FAST
    }
    draw(c) {
      const sp = LEECH[this.state === 'crawl' ? Math.floor(this.ph) % 2 : this.state === 'fly' ? 1 : 0]
      c.drawImage(sp[this.dir], Math.round(this.x - sp.w / 2), Math.round(this.y - sp.h + 1))
    }
  }
  function spawnLeech(s) {
    const d = s.data
    if (d.leeches.length >= 4) return
    const L = d.les
    const side = Math.random() < 0.5 ? -1 : 1
    let x = L.x + side * rand(45, 110)
    if (x < 10 || x > s.W - 10) x = L.x - side * rand(45, 110)
    const lc = new Leech(s, clamp(x, 10, s.W - 10))
    d.leeches.push(lc)
    s.spawn(lc)
  }
  /** The hero boots a leech away (a frantic shake if it has already latched on). */
  function kick(s, lc, bitten = false) {
    const d = s.data
    const L = d.les
    L.tx = L.cb = null
    L.kneel = false
    L.sitting = false
    if (Math.abs(lc.x - L.x) > 1) L.dir = lc.x > L.x ? 1 : -1
    if (bitten) {
      bubble(s, '!', L.x)
      L.play(['kick2', 140], ['kick', 200], ['kick2', 140], ['kick', 220])
    } else L.play(['kick', 300])
    lc.kickOff(L.dir)
    d.kickCool = performance.now() + 500
  }

  // ---- weapons ----------------------------------------------------------------
  function raiseShield(s, side, at, owner = 'L', ms = 3200) {
    const d = s.data
    const now = performance.now()
    let x
    if (owner === 'L') {
      const L = d.les
      L.dir = side
      L.tx = null
      L.aimUntil = now + 700
      x = Math.round(at ?? L.x + side * 9)
    } else x = Math.round(at)
    d.shields = d.shields.filter((sh) => sh.owner !== owner)
    const sh = { x, owner, born: now, until: now + ms, flash: 0 }
    d.shields.push(sh)
    s.burst(x, FLOOR - 12, 5, ['c', 'w', 'b'])
    s.poke()
    return sh
  }
  function shieldFlash(s, sh) {
    sh.flash = performance.now() + 140
    s.burst(sh.x, FLOOR - 13 + rand(-4, 4), 4, ['w', 'c'])
  }
  function shatter(s, sh) {
    const d = s.data
    d.shields = d.shields.filter((x) => x !== sh)
    for (let y = FLOOR - 26; y < FLOOR; y += 2)
      s.particle({ img: pix(pick(['c', 'w', 'b', 'm'])), x: sh.x + rand(-1, 1), y, vx: rand(-25, 25), vy: rand(-20, 5), g: 120, life: rand(0.5, 0.9), fade: true })
  }
  function beam(s, x0, y0, x1, y1, big = false) {
    s.data.beams.push({ x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1), until: performance.now() + (big ? 320 : 140), big })
    s.poke()
  }
  /** The first enemy shield between x0 and x1, if any. */
  function shieldBetween(d, x0, x1, owner) {
    let best = null
    for (const sh of d.shields)
      if (sh.owner !== owner && sh.x > Math.min(x0, x1) && sh.x < Math.max(x0, x1)) if (!best || Math.abs(sh.x - x0) < Math.abs(best.x - x0)) best = sh
    return best
  }
  /** The hero fires at (x, y): a thin laser, or the big blast that breaks shields. */
  function fireAt(s, x, y, big = false) {
    const d = s.data
    const L = d.les
    const now = performance.now()
    if (now - (d.lastShot ?? 0) < 200) return
    d.lastShot = now
    if (!L.running && !L.anim) {
      L.dir = x >= L.x ? 1 : -1
      L.tx = null
    }
    if (!L.anim) L.aimUntil = now + 800
    const g = L.gun()
    y = big ? g.y : clamp(y, 2, FLOOR - 1)
    const sh = shieldBetween(d, g.x, x, 'L')
    if (sh) {
      beam(s, g.x, g.y, sh.x, big ? g.y : y, big)
      if (big) shatter(s, sh)
      else shieldFlash(s, sh)
      return
    }
    const b = d.beast
    const gd = d.guard
    const lc = y >= FLOOR - 7 && d.leeches.find((l) => l.alive && Math.abs(x - l.x) <= 9)
    if (lc) {
      beam(s, g.x, g.y, lc.x, FLOOR - 2, big)
      lc.zap()
    } else if (b.present && b.state !== 'hit' && Math.abs(x - b.x) <= 15 && y >= FLOOR - 18 + b.yOff) {
      beam(s, g.x, g.y, b.x - Math.sign(b.x - g.x) * 4, FLOOR - 9 + b.yOff, big)
      b.struck(L.x, big || d.mode !== 'chase' ? 'flee' : 'stunned')
    } else if (gd && !gd.dead && gd.hit(x, y)) {
      beam(s, g.x, g.y, gd.x, FLOOR - 15, big)
      gd.shot()
      fightWon(s)
    } else {
      beam(s, g.x, g.y, x, y, big)
      s.burst(x, y, big ? 10 : 4, big ? ['w', 'y', 'O', 'm'] : ['w', 'y'])
    }
  }
  function guardFire(s, gd) {
    const d = s.data
    const L = d.les
    const g = gd.gun()
    gd.aimUntil = performance.now() + 600
    const sh = shieldBetween(d, g.x, L.x, 'G')
    if (sh) {
      beam(s, g.x, g.y, sh.x, g.y)
      shieldFlash(s, sh)
    } else {
      // no shield in the way: it singes the floor at his feet
      beam(s, g.x, g.y, L.x + gd.dir * -8, FLOOR - 2)
      s.burst(L.x + gd.dir * -8, FLOOR - 2, 5, ['O', 'y'])
    }
  }

  /** What the hero would shoot at straight ahead: the nearest threat on his side, or empty air. */
  function aheadTarget(s) {
    const d = s.data
    const L = d.les
    const b = d.beast
    const gd = d.guard
    const opts = []
    if (gd && gd.state === 'stand') opts.push({ x: gd.x, y: FLOOR - 15 })
    if (b.present && b.state !== 'hit') opts.push({ x: b.x, y: FLOOR - 9 + b.yOff })
    for (const lc of d.leeches) if (lc.alive) opts.push({ x: lc.x, y: FLOOR - 2 })
    let best = null
    for (const o of opts) if ((o.x - L.x) * L.dir > 0 && (!best || Math.abs(o.x - L.x) < Math.abs(best.x - L.x))) best = o
    return best || { x: L.x + L.dir * 150, y: FLOOR - 15 }
  }
  /** Keys held this frame: A/D run, S kneels. */
  function keyTick(s, dt, now) {
    const d = s.data
    const L = d.les
    L.kmove = false
    if (!s.keys || !s.keys.size || L.hidden) return false
    if (d.mode === 'idle' || d.mode === 'rest') {
      const mx = keyDir(s)
      if (mx && !L.anim) {
        L.sitting = false
        L.kneel = false
        L.tx = L.cb = null
        L.breath = false
        L.dir = mx
        const st = 58 * dt
        L.x = clamp(L.x + mx * st, 6, s.W - 6)
        L.dist += st
        L.kmove = true
      } else if (s.keys.has('down') && !L.anim) {
        L.tx = L.cb = null
        L.sitting = false
        L.kneel = true
        L.aimUntil = Math.max(L.aimUntil, now + 300)
      }
    }
    return true
  }
  function keyPress(s, key, down) {
    const d = s.data
    const L = d.les
    const now = performance.now()
    if (L.hidden) return
    if (key === 'fire') {
      if (down) {
        if (d.mode === 'chase') {
          const b = d.beast
          if (b.present) fireAt(s, b.x, FLOOR - 9 + b.yOff)
          return
        }
        if (d.mode !== 'idle' && d.mode !== 'rest' && d.mode !== 'fight') return
        L.sitting = false
        // a leech at his feet gets the boot instead
        const lc = d.mode !== 'fight' && d.leeches.find((l) => l.state === 'crawl' && Math.abs(l.x - L.x) < 22 && (l.x - L.x) * L.dir >= -4)
        if (lc && !L.anim) return kick(s, lc)
        // press and hold to charge, the way the pistol worked
        d.press = { t: now, key: true }
        L.aimUntil = now + 4000
        return
      }
      const pr = d.press
      if (!pr || !pr.key) return
      d.press = null
      if (!s.armed) return // disarmed mid-charge: let it go quietly
      const held = now - pr.t
      L.aimUntil = now + 700
      const t = aheadTarget(s)
      d.lastShot = 0
      if (d.mode === 'fight') return fireAt(s, t.x, t.y, held >= CH_HOLD[3])
      if (d.mode !== 'idle' && d.mode !== 'rest') return
      if (held >= CH_HOLD[3]) fireAt(s, t.x, t.y, true)
      else if (held >= CH_HOLD[2]) raiseShield(s, L.dir)
      else fireAt(s, t.x, t.y)
      return
    }
    if (!down) return
    if (key === 'up') {
      if (d.mode === 'chase') return chaseStand(s)
      if (d.mode === 'fight') {
        if (!d.shields.some((sh) => sh.owner === 'L')) {
          L.kneel = true
          raiseShield(s, d.guard && d.guard.x < L.x ? -1 : 1, undefined, 'L', 1e9)
        }
        return
      }
      if (d.mode === 'idle' || d.mode === 'rest') {
        L.sitting = false
        raiseShield(s, L.dir)
      }
    }
  }

  /** The double-click: a quick charge and the big blast at whatever is the threat. */
  function bigShot(s) {
    const d = s.data
    const L = d.les
    if (d.mode === 'done' || d.mode === 'rest' || L.hidden || d.charge) return
    const now = performance.now()
    const T = d.chaseToken
    d.charge = { t0: now - CH_HOLD[2], scripted: true }
    L.aimUntil = now + 1200
    at(d, 450, () => {
      d.charge = null
      if (d.chaseToken !== T) return
      const b = d.beast
      const gd = d.guard
      d.lastShot = 0
      if (gd && gd.state === 'stand') fireAt(s, gd.x, FLOOR - 15, true)
      else if (b.present && b.state !== 'hit') fireAt(s, b.x, FLOOR - 9 + b.yOff, true)
      else fireAt(s, L.x + L.dir * 150, FLOOR - 15, true)
    })
  }
  /** Easter egg: lightning, and he is thrown somewhere else, as on the night of the experiment. */
  function teleport(s) {
    const d = s.data
    const L = d.les
    if (d.mode !== 'idle' || L.hidden) return
    const now = performance.now()
    L.tx = L.cb = null
    L.anim = null
    L.kneel = false
    d.bolt = { x: Math.round(L.x), until: now + 380 }
    d.flashUntil = now + 140
    s.burst(L.x, FLOOR - 14, 14, ['w', 'c', 'm', 'y'])
    L.hidden = true
    if (d.bud) bubble(s, '!', d.bud.x)
    const b = d.beast
    if (b.present && b.state === 'prowl') b.go('leave')
    at(d, 1300, () => {
      L.hidden = false
      const t = performance.now()
      L.x = openSpot(s, L.x < s.W / 2 ? s.W * 0.75 : s.W * 0.25)
      d.bolt = { x: Math.round(L.x), until: t + 250 }
      d.flashUntil = t + 100
      // he lands in a splash, the way he arrived
      s.burst(L.x, FLOOR - 3, 12, ['c', 'b', 'w'])
      L.play(['down', 600], ['slip2', 220], ['kneel', 450])
    })
  }
  /** The friend steps in and swats the beast away. */
  function friendSwat(s, sent = false) {
    const d = s.data
    const u = d.bud
    const b = d.beast
    const now = performance.now()
    if (!u || u.moving || (!sent && now < d.helpCool)) return
    d.helpCool = now + 9000
    u.sitting = false
    u.face(b.x)
    if (sent) s.say(pick(FRIEND_SAYS), u.x, 1, { color: '#bcd8b4', life: 1.8 })
    u.goto(clamp(b.x - (b.x > u.x ? 18 : -18), 8, s.W - 8), sent ? 64 : 56, () => {
      u.face(b.x)
      u.strike('wind', 240)
      at(d, 240, () => {
        u.strike('punch', 450)
        if (b.present && ['prowl', 'blocked', 'startle', 'stunned'].includes(b.state)) b.struck(u.x, 'flee')
      })
    })
  }
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  /** Watch mode: one little episode at a time, in a shuffled order. */
  function runEpisode(s, now) {
    const d = s.data
    const L = d.les
    const u = d.bud
    if (!d.bag.length) d.bag = shuffle(['beast', 'beast', 'leech', 'patrol', 'explore', 'stroll', ...(u ? ['buddy'] : [])])
    const ep = d.bag.pop()
    const far = () => {
      let x = openSpot(s, rand(10, s.W - 10))
      if (Math.abs(x - L.x) < 50) x = openSpot(s, L.x + (L.x < s.W / 2 ? 100 : -100))
      return x
    }
    if (ep === 'beast') d.beast.nextAt = now
    else if (ep === 'leech') {
      // they drop from the cave roof, one after another
      const n = s.W < 500 ? 2 : 3
      for (let i = 0; i < n; i++) at(d, i * rand(700, 1500), () => d.mode === 'idle' && s.lively() && spawnLeech(s))
    } else if (ep === 'patrol') startFight(s)
    else if (ep === 'explore') {
      L.breath = false
      L.goto(far(), 24, () => {
        if (d.mode !== 'idle') return
        L.play(['kneel', 1900])
        bubble(s, '?', L.x)
      })
    } else if (ep === 'buddy' && u) {
      u.sitting = false
      L.face(u.x)
      u.face(L.x)
      at(d, 300, () => {
        if (d.mode !== 'idle' || u.moving) return
        u.strike('point', 1200)
        s.say(pick(FRIEND_SAYS), u.x, 1, { color: '#bcd8b4', life: 2.2 })
      })
      at(d, 1700, () => d.mode === 'idle' && bubble(s, '…', L.x))
      at(d, 2600, () => d.mode === 'idle' && !L.moving && L.goto(far(), 24))
    } else {
      L.breath = false
      L.goto(far(), 24)
    }
  }

  // ---- director -----------------------------------------------------------------
  function at(d, ms, fn) {
    d.q.push({ t: performance.now() + ms, fn })
  }

  function startChase(s) {
    const d = s.data
    const now = performance.now()
    d.q.length = 0
    d.mode = 'chase'
    d.chaseToken++
    d.beastBack = 0
    d.round = 0
    d.turnCool = now + 2500
    d.chaseSince = now
    d.press = null
    d.fight = null
    d.bolt = null
    for (const lc of d.leeches) if (!lc.dead) lc.kickOff(Math.random() < 0.5 ? -1 : 1)
    const L = d.les
    L.hidden = false
    L.tx = null
    L.kneel = L.sitting = false
    L.anim = null
    L.dir = 1
    if (d.bud) {
      d.bud.tx = null
      d.bud.sitting = false
    }
    const b = d.beast
    if (!b.present) b.enter(L.x > 110 ? L.x - 110 : -16, 'chase')
    b.go('chase')
    b.fleeEdge = null
    bubble(s, '!', L.x)
    launch(s, 450)
  }

  /** Set the pair running right, staggered so they never overlap: whoever is
   *  behind waits until there's a gap, and the friend keeps his side (lead or rear). */
  function launch(s, base) {
    const d = s.data
    const L = d.les
    const u = d.bud
    let lDelay = base
    let uDelay = base
    if (u) {
      let off = ahead(s, u.x, L.x)
      if (off > period(s) / 2) off -= period(s)
      u.lead = off > 0
      if (u.lead) lDelay += (Math.max(0, 18 - off) / 60) * 1000
      else uDelay += (Math.max(0, 16 + off) / 60) * 1000
      u.dir = 1
      u.pose = null
    }
    const T = d.chaseToken
    L.dir = 1
    at(d, lDelay, () => d.mode === 'chase' && d.chaseToken === T && (L.running = true))
    if (u) at(d, uDelay, () => d.mode === 'chase' && d.chaseToken === T && (u.running = true))
  }

  function resumeRun(s) {
    const d = s.data
    const L = d.les
    L.kneel = false
    L.anim = null
    L.dir = 1
    launch(s, 0)
  }


  function chaseTick(s, now) {
    const d = s.data
    const L = d.les
    const b = d.beast
    const u = d.bud
    if (u && u.running && L.running) {
      // the friend keeps close behind, between the hero and the beast
      // signed: positive while he trails the hero
      let gap = ahead(s, L.x, u.x)
      if (gap > period(s) / 2) gap -= period(s)
      u.runSpeed = 60 + clamp((gap - (u.lead ? -18 : 16)) * 2, -14, 14)
      u.dir = 1
    }
    if (!b.present && L.running && now > d.beastBack) {
      b.enter(wrapX(s, L.x - 120), 'chase')
      b.go('chase')
    }
    const user = engaged(s, now)
    // the hero fires at the beast mid-leap (unless you are doing the shooting)
    if (!user && b.state === 'leap' && !d.leapShot && Math.abs(b.x - L.x) < 46) {
      d.leapShot = true
      fireAt(s, b.x, FLOOR - 10 + b.yOff)
    }
    // while you play, the turns are yours: click the hero to stand and fight
    if (user) return
    if (!L.running || b.state !== 'chase' || now < d.turnCool) return
    const gap = ahead(s, L.x, b.x)
    if (gap > (u && !u.lead ? 46 : 34)) return
    // only turn to fight where the beast is on screen behind them
    if (L.x < (u && !u.lead ? 80 : 60) || L.x > s.W - (u && u.lead ? 30 : 12)) return
    d.turnCool = now + 3800
    const r = d.round++
    const T = d.chaseToken
    if ((r >= 3 || (r >= 2 && !u)) && now - d.chaseSince > 9000) {
      // turn, charge the big blast, send it packing — then the guards come
      L.running = false
      if (u) u.running = false
      L.dir = -1
      L.kneel = true
      d.charge = { t0: now - CH_HOLD[2], scripted: true }
      raiseShield(s, -1, Math.min(L.x, u ? u.x : L.x) - 10, 'L', 1800)
      at(d, 800, () => {
        if (d.mode !== 'chase' || d.chaseToken !== T) return
        d.charge = null
        fireAt(s, b.x, FLOOR - 9, true)
        b.after = 'flee'
        d.beastBack = performance.now() + 1e9
        at(d, 900, () => d.mode === 'chase' && d.chaseToken === T && startFight(s))
      })
      return
    }
    if (r === 1 && (d.cycles ?? 0) % 2 === 0) {
      // the slip: he goes down, the beast closes in and leaps
      L.running = false
      L.play(['slip', 170], ['slip2', 190], ['down', 1e9])
      s.burst(L.x + 6, FLOOR - 1, 6, ['a', 'A', 'n'])
      d.leapShot = false
      if (u) {
        u.running = false
        u.dir = -1
      }
      at(d, 500, () => {
        if (d.mode !== 'chase' || d.chaseToken !== T) return
        L.dir = -1
        L.play(['downAim', 1e9])
        b.x = wrapX(s, L.x - 48)
        b.pounce(L.x)
        b.until = performance.now() + 600
      })
      at(d, 2600, () => {
        if (d.mode !== 'chase' || d.chaseToken !== T) return
        d.duskWant = 0
        L.play(['kneel', 300])
        at(d, 350, () => d.mode === 'chase' && d.chaseToken === T && resumeRun(s))
      })
      return
    }
    const helper = u && r === 2 && !u.lead
    if (!helper) return chaseStand(s)
    // the friend turns and floors it with one swing
    L.running = false
    L.dir = -1
    u.running = false
    u.dir = -1
    u.strike('wind', 260)
    at(d, 260, () => {
      u.strike('punch', 450)
      if (b.present && b.state === 'chase') b.struck(u.x, 'stunned')
    })
    at(d, 1100, () => d.mode === 'chase' && d.chaseToken === T && resumeRun(s))
  }
  /** Mid-chase: he skids, kneels behind a shield and fires back, then runs on. */
  function chaseStand(s) {
    const d = s.data
    const L = d.les
    const u = d.bud
    const b = d.beast
    if (d.mode !== 'chase' || !L.running) return
    const T = d.chaseToken
    L.running = false
    if (u) {
      u.running = false
      u.dir = -1
    }
    L.dir = -1
    L.kneel = true
    raiseShield(s, -1, Math.min(L.x, u ? u.x : L.x) - 10, 'L', 2400)
    at(d, 300, () => d.chaseToken === T && b.present && b.state === 'chase' && fireAt(s, b.x, FLOOR - 9))
    at(d, 1100, () => d.mode === 'chase' && d.chaseToken === T && resumeRun(s))
  }

  // ---- the gunfight across shields ---------------------------------------
  function startFight(s) {
    const d = s.data
    const L = d.les
    const u = d.bud
    const now = performance.now()
    d.q.length = 0
    d.mode = 'fight'
    const T = ++d.chaseToken
    L.running = false
    L.anim = null
    L.kneel = false
    L.hidden = false
    L.sitting = false
    if (u) {
      u.running = false
      u.tx = null
      u.sitting = false
    }
    const side = L.x < s.W * 0.55 ? 1 : -1
    const range = Math.min(150, s.W * 0.38)
    const gx = clamp(L.x + side * range, 20, s.W - 20)
    const gd = (d.guard = new Guard(s, side > 0 ? s.W + 16 : -16, -side, gx))
    s.spawn(gd)
    L.dir = side
    if (u) u.goto(clamp(L.x - side * 16, 8, s.W - 8), 60, () => (u.dir = side))
    bubble(s, '!', L.x)
    d.duskWant = 1
    d.fights = (d.fights ?? 0) + 1
    d.fight = { T, gd, side, step: 0, next: 0, gNext: 0, armed: false, since: now }
    const ok = () => d.mode === 'fight' && d.chaseToken === T && d.guard === gd && gd.state === 'stand'
    const arrive = (Math.abs(gx - gd.x) / 58) * 1000
    // a beat of stillness, then both shields go up
    at(d, arrive + 350, () => {
      if (!ok()) return
      raiseShield(s, side, gx - side * 11, 'G', 1e9)
      gd.aimUntil = performance.now() + 500
    })
    at(d, arrive + 650, () => {
      if (!ok()) return
      L.kneel = true
      raiseShield(s, side, undefined, 'L', 1e9)
      const t = performance.now()
      d.fight.armed = true
      d.fight.next = t + 600
      d.fight.gNext = t + 250
    })
  }

  /** The gunfight across shields, a step at a time. The guard keeps firing; the hero's
   *  side is the autopilot's only while nobody is playing (then the shots are yours). */
  function fightTick(s, now) {
    const d = s.data
    const f = d.fight
    if (!f || !f.armed) return
    const gd = f.gd
    const L = d.les
    const u = d.bud
    if (d.guard !== gd || gd.state !== 'stand') return
    if (now > f.gNext) {
      guardFire(s, gd)
      f.gNext = now + rand(1100, 1700)
    }
    if (now - f.since > 40000) {
      // a stand-off nobody finishes: he backs off
      gd.state = 'flee'
      gd.dir = gd.x > s.W / 2 ? 1 : -1
      return fightWon(s)
    }
    if (engaged(s, now)) {
      f.next = Math.max(f.next, now + 800)
      return
    }
    if (now < f.next) return
    const gShield = d.shields.some((sh) => sh.owner === 'G')
    const step = f.step++
    if (step < 3 && gShield) {
      fireAt(s, gd.x, FLOOR - 15)
      f.next = now + rand(700, 1100)
    } else if (step === 3 && gShield) {
      // charge up the big one to break his shield
      d.charge = { t0: now, scripted: true }
      L.aimUntil = now + 2000
      f.next = now + 1250
    } else if (step === 4 && gShield) {
      d.charge = null
      d.lastShot = 0
      fireAt(s, gd.x, FLOOR - 15, true)
      f.next = now + 300
    } else if (u && d.fights % 2 === 0 && !f.buddy) {
      // the friend's turn: he charges through the gap and floors the guard
      f.buddy = true
      f.next = now + 6000
      const T = f.T
      const ok = () => d.mode === 'fight' && d.chaseToken === T && d.guard === gd && gd.state === 'stand'
      u.goto(gd.x - f.side * 12, 72, () => {
        if (!ok()) return
        u.dir = f.side
        u.strike('wind', 220)
        at(d, 220, () => {
          if (!ok()) return
          u.strike('punch', 500)
          gd.shot()
          fightWon(s)
        })
      })
    } else {
      d.charge = null
      d.lastShot = 0
      fireAt(s, gd.x, FLOOR - 15)
      f.next = now + 900
    }
  }

  function fightWon(s) {
    const d = s.data
    if (d.mode !== 'fight') return
    const L = d.les
    const u = d.bud
    const T = ++d.chaseToken
    d.q.length = 0
    d.charge = null
    d.duskWant = 0
    d.shields = []
    d.fight = null
    at(d, 700, () => {
      if (d.mode !== 'fight' || d.chaseToken !== T) return
      L.kneel = false
      if (u) u.strike('point', 800)
    })
    at(d, 1700, () => {
      if (d.mode !== 'fight' || d.chaseToken !== T) return
      if (!s.busy) {
        // a patrol seen off: back to the quiet
        d.mode = 'idle'
        L.kneel = false
        d.epAt = 0
        return
      }
      d.mode = 'chase'
      d.cycles = (d.cycles ?? 0) + 1
      d.chaseSince = performance.now()
      d.round = 0
      d.turnCool = performance.now() + 3000
      d.beastBack = performance.now() + rand(2500, 4500)
      d.beast.after = null
      resumeRun(s)
    })
  }

  function endFight(s) {
    const d = s.data
    const gd = d.guard
    if (gd && !gd.dead && gd.state !== 'fall' && gd.state !== 'dead') {
      gd.state = 'flee'
      gd.dir = gd.x > s.W / 2 ? 1 : -1
    }
    d.shields = []
    d.charge = null
    d.duskWant = 0
    d.fight = null
  }

  function finale(s) {
    const d = s.data
    d.q.length = 0
    endFight(s)
    d.mode = 'done'
    const T = ++d.chaseToken
    const L = d.les
    L.running = false
    L.tx = null
    L.kneel = false
    L.anim = null
    L.hidden = false
    d.bolt = null
    if (d.bud) d.bud.running = false
    const b = d.beast
    if (b.present && b.state !== 'hit') {
      b.go('flee')
      b.fleeEdge = null
    }
    const ok = () => d.mode === 'done' && d.chaseToken === T
    const [spot, spot2] = pairSpot(s, clamp(L.x, 0, s.W))
    L.x = clamp(L.x, -2, s.W + 2)
    L.goto(spot, 40, () => {
      if (!ok()) return
      let u = d.bud
      const meet = () => {
        if (!ok()) return
        L.face(u.x)
        u.face(L.x)
        bubble(s, '!', L.x)
        // the friend points the way out, then they run for it together
        at(d, 700, () => ok() && u.strike('point', 1100))
        const edge = L.x > s.W / 2 ? s.W + 20 : -20
        at(d, 1900, () => {
          if (!ok()) return
          u.goto(edge, 64)
          at(d, 180, () =>
            L.goto(edge, 60, () => {
              at(d, 1300, () => {
                if (!ok()) return
                // flip screen: they come back in from the other side
                const back = edge > 0 ? -20 : s.W + 20
                L.x = back
                u.x = back - (edge > 0 ? 16 : -16)
                const [home, home2] = pairSpot(s, edge > 0 ? s.W * 0.22 : s.W * 0.72)
                L.goto(home, 50, () => L.face(u.x))
                u.goto(home2, 54, () => {
                  u.face(L.x)
                  d.mode = 'idle'
                  d.beast.nextAt = performance.now() + rand(8000, 14000)
                  d.epAt = 0
                })
              })
            }),
          )
        })
      }
      if (!u || u.dead) {
        // he comes in from the nearer edge, at a run on a wide bar
        const fromRight = L.x > s.W / 2
        u = d.bud = new Friend(s, fromRight ? s.W + 20 : -20)
        s.spawn(u)
        u.goto(spot2, Math.abs(spot2 - u.x) > 200 ? 64 : 44, meet)
      } else u.goto(spot2, Math.abs(spot2 - u.x) > 200 ? 64 : 44, meet)
    })
  }

  function setup(s) {
    const d = s.data
    d.W = s.W
    d.q = []
    d.fr = 0
    d.mode = 'idle'
    d.shields = []
    d.beams = []
    d.dusk = 0
    d.duskWant = 0
    d.chaseToken = 0
    d.leapCool = performance.now() + 6000
    d.actCool = 0
    d.actN = 0
    d.les = new Hero(s, openSpot(s, s.W * 0.3))
    d.beast = new Beast(s)
    d.leeches = []
    d.bag = []
    d.epAt = 0
    d.fight = null
    d.bolt = null
    d.flashUntil = 0
    d.kickCool = 0
    d.clickAt = -1e9
    d.grabAt = -1e9
    d.breathAt = performance.now() + 1800
    d.shieldCool = 0
    d.helpCool = 0
    s.actors.push(d.beast, d.les)
  }

  function update(s, dt, now) {
    const d = s.data
    d.fr++
    const L = d.les
    const b = d.beast
    const u = d.bud
    let wait = Infinity
    if (d.q.length) {
      const due = d.q.filter((e) => e.t <= now)
      if (due.length) {
        d.q = d.q.filter((e) => e.t > now)
        for (const e of due) e.fn()
      }
      for (const e of d.q) wait = Math.min(wait, e.t - now)
    }
    if (d.beams.length) d.beams = d.beams.filter((x) => now < x.until)
    if (d.shields.length) d.shields = d.shields.filter((x) => now < x.until)
    if (d.guard && d.guard.dead) d.guard = null
    if (d.dusk !== d.duskWant) {
      d.dusk = d.duskWant > d.dusk ? Math.min(d.duskWant, d.dusk + dt * 2.5) : Math.max(d.duskWant, d.dusk - dt * 1.5)
      wait = FAST
    }
    if (d.beams.length || d.shields.length || d.press || d.charge) wait = FAST

    if (!s.lively(now)) {
      if (d.mode !== 'rest') {
        endFight(s)
        d.chaseToken++
        if (u) u.running = false
        L.x = clamp(L.x, 0, s.W)
        if (u) u.x = clamp(u.x, 0, s.W)
        // Rest: the hero sits down in the open, the friend beside him, the beast slinks off.
        d.mode = 'rest'
        d.q.length = 0
        d.press = null
        d.charge = null
        d.shields = []
        d.duskWant = 0
        L.running = false
        L.kneel = false
        L.anim = null
        L.breath = false
        L.hidden = false
        L.sling = false
        L.tx = L.cb = null
        d.bolt = null
        d.epAt = 0
        for (const lc of d.leeches) if (lc.state === 'held') lc.state = 'crawl'
        if (u) u.tx = u.cb = null
        const [spot, spot2] = u ? pairSpot(s, L.x) : [openSpot(s, L.x), 0]
        const sitL = () => {
          L.sitting = true
          if (u) L.face(u.x)
        }
        if (Math.abs(spot - L.x) > 1) L.goto(spot, 26, sitL)
        else sitL()
        if (u) {
          u.running = false
          u.breath = false
          u.pose = null
          const sitU = () => {
            u.sitting = true
            u.face(spot)
          }
          if (Math.abs(spot2 - u.x) > 1) u.goto(spot2, 28, sitU)
          else sitU()
        }
        if (b.present && b.state !== 'hit') b.go('leave')
        if (d.guard) d.guard.dead = true
      }
      return wait
    }
    if (d.mode === 'rest') {
      d.mode = 'idle'
      L.sitting = false
      if (u) u.sitting = false
      d.epAt = 0
    }
    if (d.leeches.length) d.leeches = d.leeches.filter((l) => !l.dead)
    if ((d.bolt && now < d.bolt.until) || now < d.flashUntil) wait = FAST
    if (keyTick(s, dt, now)) wait = FAST
    if (d.mode === 'chase') {
      chaseTick(s, now)
      return wait
    }
    if (d.mode === 'fight') {
      fightTick(s, now)
      return Math.min(wait, FAST)
    }
    if (d.mode === 'done') return wait
    if (L.hidden) return Math.min(wait, FAST)

    // idle: the autopilot watches the beast, defends, deals with leeches and
    // runs little episodes; while someone is playing it holds back and the hero
    // just keeps an eye on the cursor.
    const user = engaged(s, now)
    const c = s.cursor
    const cOn = c && c.y >= -SPILL && c.y <= H
    if (!user && b.state === 'leap' && !d.leapShot && Math.abs(b.x - L.x) < 46) {
      d.leapShot = true
      fireAt(s, b.x, FLOOR - 10 + b.yOff)
    }
    if (b.present && ['prowl', 'blocked', 'crouch', 'leap', 'startle'].includes(b.state)) {
      if (b.state === 'crouch') {
        d.leapShot = false
        if (!user && !L.anim) {
          L.tx = null
          L.kneel = true
        }
      } else if (b.state !== 'leap' && !d.charge && !L.anim && now > L.aimUntil - 300) L.kneel = false
      const keys = keyMode(s, now)
      if (!L.moving && !L.anim && !keys) {
        if (user && cOn && Math.abs(c.x - L.x) > 10) L.face(c.x, now, 500)
        else if (!user) L.face(b.x, now, 600)
      }
      L.aimUntil = Math.max(L.aimUntil, now + 400)
      const dist = Math.abs(b.x - L.x)
      if (!user && b.state === 'prowl' && dist < 40 && !d.shields.length && now > d.shieldCool && !L.anim) {
        d.shieldCool = now + 6000
        raiseShield(s, b.x > L.x ? 1 : -1)
      }
      // he uses the pistol's three charges on his own: a warning shot at its
      // feet, an aimed shot, or a long charge into the big blast
      if (!user && b.state === 'prowl' && !L.moving && !L.anim && !d.charge && now > d.actCool && dist >= 40 && dist < Math.min(170, s.W * 0.45)) {
        d.actCool = now + rand(4500, 8000)
        const act = d.actN++ % 3
        const T = d.chaseToken
        d.charge = { t0: now, scripted: true }
        L.kneel = act !== 0
        at(d, act === 1 ? CH_HOLD[3] + 150 : 300, () => {
          d.charge = null
          if (d.mode !== 'idle' || d.chaseToken !== T || !b.present || b.state !== 'prowl') return
          d.lastShot = 0
          if (act === 0) {
            fireAt(s, b.x + b.dir * 21, FLOOR - 1)
            b.walking = false
            b.go('startle', 1000)
          } else fireAt(s, b.x, FLOOR - 9, act === 1)
        })
      }
      if (u && !u.moving && b.state === 'prowl' && Math.abs(b.x - u.x) < 44) friendSwat(s)
      wait = Math.min(wait, FAST)
    } else if (b.present && ['hit', 'stunned'].includes(b.state)) {
      // hold the pose while it recoils
      L.tx = null
      wait = Math.min(wait, FAST)
    } else if (!L.moving) {
      if (L.kneel && now > L.aimUntil) L.kneel = false
      if (!L.anim && !keyMode(s, now)) {
        if (cOn && Math.abs(c.x - L.x) > 10) L.face(c.x, now, user ? 500 : 900)
        else if (!c && u && Math.abs(u.x - L.x) > 5) L.face(u.x, now, 2000)
      }
      // idle breathing, a slow two-frame rise and fall
      if (now >= d.breathAt) {
        d.breathAt = now + rand(1400, 2200)
        L.breath = !L.breath
        if (u && !u.moving) u.breath = !L.breath
      }
      wait = Math.min(wait, Math.max(50, d.breathAt - now))
    }
    // leeches: he keeps an eye on them and boots them away when they get close
    for (const lc of d.leeches) {
      if (lc.state !== 'crawl') continue
      const gap = Math.abs(lc.x - L.x)
      if (!L.moving && !L.anim && gap < 60 && gap > 3 && !user) L.face(lc.x, now, 700)
      if (!user && gap < 16 && !L.anim && !L.moving && now > d.kickCool) kick(s, lc)
    }
    if (d.leeches.length) wait = Math.min(wait, FAST)
    // the friend tags along when the hero wanders off (with slack, no thrashing)
    if (u && !u.moving && now > u.poseUntil && Math.abs(u.x - L.x) > 44 && !L.moving) {
      u.goto(openSpot(s, L.x + (u.x > L.x ? 18 : -18), L.x, 16), 30, () => u.face(L.x))
    }
    // and he turns to look at the pointer when it comes near him
    if (u && cOn && !u.moving && now > u.poseUntil && Math.abs(c.x - u.x) < 40 && Math.abs(c.x - u.x) > 4) u.face(c.x, now, 1500)
    // watch mode: one episode at a time, a breather between them
    const quiet = !b.present && !d.leeches.length && !d.guard && !L.moving && !L.anim && !d.q.length && !user && !(u && u.moving) && !s.busy
    if (quiet) {
      if (!d.epAt) d.epAt = now + rand(2500, 5000)
      if (now >= d.epAt) {
        d.epAt = 0
        runEpisode(s, now)
        wait = Math.min(wait, FAST)
      } else wait = Math.min(wait, d.epAt - now)
    } else d.epAt = 0
    if (!b.present && b.nextAt < Infinity) wait = Math.min(wait, Math.max(50, b.nextAt - now))
    if (!s.busy) wait = Math.min(wait, Math.max(50, s.lastTouch + 30000 + 20 - now))
    return wait
  }

  function line(c, x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let i = 0; i < 2000; i++) {
      c.fillRect(x0, y0, 1, 1)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }

  registerConcept({
    key: 'vectorescape',
    title: 'Vector escape',
    blurb:
      "The red-haired physicist gets by on his own on an alien world. A black beast stalks him, crouches and leaps; he answers with the three charges of his laser pistol: a quick shot, the shimmering force shield it cannot pass, and the big blast. Leeches drop from the roof and he boots them away, a lone guard comes by for a gunfight across shields, and he goes off to look at things. While the agent works it becomes the chase: the hero slips, the beast leaps, and guards step in. On done the tall alien friend arrives and stays; he swats the beast, talks in his own tongue and at rest sits beside him. Play along and the autopilot steps back: the hero faces your <b>cursor</b> and the beast springs at it. Click the hero for the shield (in the chase, to stand and fight), double-click anything for the big blast, or drag from the hero and let go to fire the way the game did: a short pull shoots, a longer one throws the shield, a long one is the blast. Click the beast, guards or leeches to shoot, grab a leech and throw it, click the friend to send him at the beast. Click any character and the keys are yours too: A/D run, W the shield (in the chase, stand and fight), S kneel, Space fires, and holding Space charges it into the shield and then the big blast, as in the game; Space next to a leech kicks it. Click the hero five times quickly and see what the experiment does.",
    setup,
    update,
    onBusy(s) {
      if (s.data.mode !== 'fight') startChase(s)
    },
    onDone(s) {
      finale(s)
    },
    relayout(s) {
      const d = s.data
      const k = d.W ? s.W / d.W : 1
      d.W = s.W
      if (d.mode === 'idle' || d.mode === 'rest') {
        for (const a of [d.les, d.bud]) if (a && !a.moving) a.x = openSpot(s, a.x * k)
        if (d.bud && !d.bud.moving && Math.abs(d.bud.x - d.les.x) < 16) d.bud.x = openSpot(s, d.les.x + 18, d.les.x, 16)
      }
      // after a shrink, keep everyone (and every target) on the bar
      const keep = (x) => clamp(x, -20, s.W + 20)
      for (const a of [d.les, d.bud, d.beast, d.guard]) {
        if (!a) continue
        a.x = keep(a.x)
        if (a.tx !== null && a.tx !== undefined) a.tx = clamp(a.tx, -20, s.W + 20)
      }
      for (const sh of d.shields) sh.x = clamp(sh.x, 2, s.W - 2)
      for (const lc of d.leeches) lc.x = clamp(lc.x, 4, s.W - 4)
      s.poke()
    },
    onKey(s, key, down) {
      keyPress(s, key, down)
      s.poke()
    },
    onPress(s, p) {
      const d = s.data
      if (d.mode === 'idle' || d.mode === 'rest' || d.mode === 'fight') {
        d.press = { t: performance.now(), x: p.x, y: p.y }
        d.les.aimUntil = performance.now() + 4000
        d.les.dir = p.x >= d.les.x ? 1 : -1
      }
    },
    onRelease(s, p) {
      const d = s.data
      const pr = d.press
      d.press = null
      if (!pr) return
      const held = performance.now() - pr.t
      d.les.aimUntil = performance.now() + 700
      if (d.mode === 'fight') return fireAt(s, p.x, p.y, held >= CH_HOLD[3])
      if (d.mode !== 'idle') return
      if (held >= CH_HOLD[3]) {
        d.lastShot = 0
        fireAt(s, p.x, FLOOR - 15, true)
      } else if (held >= CH_HOLD[2]) raiseShield(s, p.x >= d.les.x ? 1 : -1)
      else fireAt(s, p.x, p.y)
    },
    drawBehind(s, c) {
      const d = s.data
      if (d.dusk <= 0.01) return
      // the dusk drops over the scene for a dramatic beat, letterboxed
      const a = d.dusk
      for (let y = 0; y < H; y++) {
        const q = y / H
        c.fillStyle = q < 0.5 ? `rgba(18,14,38,${(0.55 - q) * 0.5 * a})` : `rgba(96,42,64,${(q - 0.45) * 0.45 * a})`
        c.fillRect(0, y, s.W, 1)
      }
      c.fillStyle = `rgba(4,4,8,${0.85 * a})`
      c.fillRect(0, 0, s.W, Math.round(3 * a))
    },
    drawFront(s, c) {
      const d = s.data
      const now = performance.now()
      for (const sh of d.shields) {
        const left = sh.until - now
        if (left < 500 && d.fr % 2) continue
        const flash = now < sh.flash
        const top = FLOOR - 26
        c.globalAlpha = 0.28
        c.fillStyle = flash ? '#ffffff' : SH[2]
        c.fillRect(sh.x - 2, top + 2, 5, FLOOR - top - 2)
        c.globalAlpha = 1
        for (let y = top; y < FLOOR; y++) {
          const k = (y * 7 + d.fr * 3 + sh.x) % SH.length
          c.fillStyle = flash ? '#ffffff' : SH[k]
          const wob = (y + d.fr) % 4 === 0 ? 1 : (y + d.fr) % 5 === 0 ? -1 : 0
          c.fillRect(sh.x + wob, y, 1, 1)
          if (flash || (y + d.fr) % 3 === 0) c.fillRect(sh.x - wob, y, 1, 1)
        }
      }
      for (const bm of d.beams) {
        if (bm.big) {
          const fl = d.fr % 2
          c.globalAlpha = 0.35
          c.fillStyle = '#7a3aff'
          line(c, bm.x0, bm.y0 - 2, bm.x1, bm.y1 - 2)
          line(c, bm.x0, bm.y0 + 2, bm.x1, bm.y1 + 2)
          c.globalAlpha = 0.85
          c.fillStyle = fl ? '#ff8a3a' : '#ffb04a'
          line(c, bm.x0, bm.y0 - 1, bm.x1, bm.y1 - 1)
          line(c, bm.x0, bm.y0 + 1, bm.x1, bm.y1 + 1)
          c.globalAlpha = 1
          c.fillStyle = '#ffffff'
          line(c, bm.x0, bm.y0, bm.x1, bm.y1)
          c.drawImage(CHARGE[3], bm.x1 - 4, bm.y1 - 4)
        } else {
          c.fillStyle = LASER
          line(c, bm.x0, bm.y0, bm.x1, bm.y1)
          c.fillStyle = '#ffffff'
          c.fillRect(bm.x1 - 1, bm.y1, 3, 1)
          c.fillRect(bm.x1, bm.y1 - 1, 1, 3)
        }
      }
      // the easter egg's lightning, and the white flash
      if (d.bolt && now < d.bolt.until) {
        let x = d.bolt.x
        let y = -SPILL
        for (let i = 0; i < 7; i++) {
          const ny = Math.round(-SPILL + ((i + 1) * (FLOOR - 6 + SPILL)) / 7)
          const nx = d.bolt.x + ((i * 5 + d.fr * 3) % 7) - 3
          c.fillStyle = 'rgba(176,140,255,.6)'
          line(c, x + 1, y, nx + 1, ny)
          c.fillStyle = '#ffffff'
          line(c, x, y, nx, ny)
          x = nx
          y = ny
        }
      }
      if (now < d.flashUntil) {
        c.fillStyle = 'rgba(255,255,255,.3)'
        c.fillRect(0, -SPILL, s.W, H + SPILL)
      }
      // the charge gathering at the pistol's muzzle
      const ch = d.press ? { t0: d.press.t } : d.charge
      if (ch && now - ch.t0 > 90) {
        const held = now - ch.t0
        const lv = held >= CH_HOLD[3] ? 3 : held >= CH_HOLD[2] ? 2 : 1
        const g = d.les.gun()
        const img = CHARGE[lv]
        if (lv < 3 || d.fr % 3) c.drawImage(img, Math.round(g.x - (img.width >> 1)), Math.round(g.y - (img.height >> 1)))
      }
    },
  })
})()
