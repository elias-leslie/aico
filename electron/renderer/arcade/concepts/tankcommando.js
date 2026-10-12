;(() => {
  // Run-and-gun commando, big: a soldier in a red vest and bandana fights
  // an army of rebel troops along the bar. Rebels chat, cook, sunbathe
  // and patrol until they spot him, jump in shock, slide back on their heels
  // and either fight or flee screaming. Bearded POWs salute and hand over the
  // heavy machine gun, rockets, bombs or food; a small armored tank drops in
  // by parachute and the hero hops in. Busy brings rebel waves and a boss (a
  // big boss tank or a burly shirtless sergeant); done is MISSION COMPLETE;
  // quiet leaves the hero sitting on the parked tank or by a campfire.

  // ---- palette -----------------------------------------------------------------------------
  const P = {
    E: '#16121a', W: '#ffffff', w: '#ebe5d4', // ink, white, shirt
    S: '#f6c48e', s: '#c8844e', d: '#86492a', // skin
    Y: '#f9d84a', y: '#c79a22', // blond, gold
    R: '#e2382c', r: '#8f1c17', // red vest, bandana
    T: '#d8c896', t: '#a08b5c', // khaki
    K: '#77482a', k: '#3f2518', // boots
    g: '#4d525b', G: '#8f97a2', h: '#d2d8de', Z: '#30353f', // steel
    O: '#7f913a', o: '#4d5a22', Q: '#b4c260', // rebel olive
    a: '#2c2624', // black hair
    V: '#5f8b4a', v: '#355a2a', // the partner's vest, the rocket tube
    B: '#5a6aa6', b: '#343e6c', // the partner's trousers
    L: '#fff07a', F: '#ff9a22', f: '#dc4818', x: '#7a1e0e', // fire
    M: '#8f8b88', m: '#55524f', X: '#c6c2bc', // smoke
    n: '#8c5a2c', N: '#cb965a', // wood, rope
    A: '#aab5c3', I: '#e0e8f0', i: '#6c7787', // the tank's hull
    c: '#8fd8ff', C: '#3f7fd0', p: '#ff8aa0', // glint, fish, mouth
  }
  const OUT = 'rgba(12,9,10,.92)'
  const UP = [0, -1]
  const ad = (a, v, k = 1) => [a[0] + v[0] * k, a[1] + v[1] * k]
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1]) || 1
    return [v[0] / l, v[1] / l]
  }
  const LIGHT = norm([0.55, -0.85])

  // ---- pixel painter -----------------------------------------------------------------------
  // Coordinates are relative to an anchor at column GX of the grid's bottom row (y = 0 is
  // the bottom row, up is negative), so every frame of a character shares its feet point.
  let G = null
  let GW = 0
  let GH = 0
  let GX = 0
  function begin(w, h, cx) {
    GW = w
    GH = h
    GX = cx
    G = Array.from({ length: h }, () => Array(w).fill('.'))
  }
  function end() {
    const rows = G.map((r) => r.join(''))
    G = null
    return rows
  }
  function put(x, y, ch) {
    const i = Math.round(GX + x)
    const j = Math.round(GH - 1 + y)
    if (ch && i >= 0 && j >= 0 && i < GW && j < GH) G[j][i] = ch
  }
  const dot = (p, ch) => put(p[0], p[1], ch)
  /** A capsule from a to b; the side turned away from the light gets the shade. */
  function seg(a, b, r, ch, sh, k = 0.3) {
    const [ax, ay] = a
    const [bx, by] = b
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy || 1e-9
    for (let y = Math.floor(Math.min(ay, by) - r - 1); y <= Math.ceil(Math.max(ay, by) + r + 1); y++)
      for (let x = Math.floor(Math.min(ax, bx) - r - 1); x <= Math.ceil(Math.max(ax, bx) + r + 1); x++) {
        const t = clamp(((x - ax) * dx + (y - ay) * dy) / L2, 0, 1)
        const ex = x - (ax + dx * t)
        const ey = y - (ay + dy * t)
        if (ex * ex + ey * ey > r * r) continue
        put(x, y, sh && ex * LIGHT[0] + ey * LIGHT[1] < -r * k ? sh : ch)
      }
  }
  /** An ellipse; fn is a letter or (dx, dy, u, v) => letter. */
  function ell(c, rx, ry, fn) {
    for (let y = Math.floor(c[1] - ry - 1); y <= Math.ceil(c[1] + ry + 1); y++)
      for (let x = Math.floor(c[0] - rx - 1); x <= Math.ceil(c[0] + rx + 1); x++) {
        const u = (x - c[0]) / rx
        const v = (y - c[1]) / ry
        if (u * u + v * v > 1) continue
        put(x, y, typeof fn === 'string' ? fn : fn(x - c[0], y - c[1], u, v))
      }
  }
  /** A lit ellipse: highlight toward the light, shade away from it. */
  function ball(c, rx, ry, ch, sh, hi) {
    ell(c, rx, ry, (dx, dy, u, v) => {
      const l = u * LIGHT[0] + v * LIGHT[1]
      return hi && l > 0.55 ? hi : sh && l < -0.25 ? sh : ch
    })
  }
  function box(x0, y0, x1, y1, ch) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, ch)
  }
  const fr = (rows, extra) => ({ sp: pairOutlined(rows, P, OUT), w: rows[0].length, h: rows.length, ...extra })
  /** Draw a frame record whose anchor is column cx of its last row. */
  function drawFr(c, f, cx, x, y, dir) {
    const ax = dir === 1 ? cx : f.w - 1 - cx
    c.drawImage(f.sp[dir], Math.round(x) - ax - 1, Math.round(y) - f.h - 1)
  }

  // pose helpers
  const JOINTS = ['hip', 'neck', 'head', 'fk', 'ff', 'bk', 'bf', 'fe', 'fh', 'be', 'bh', 'gb', 'gf', 'tb', 'tf', 'rb', 'rf', 'ladle']
  const VECS = ['U', 'gd', 'kd']
  function rot(o, ang, pivot) {
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const R = (p) => [pivot[0] + (p[0] - pivot[0]) * c - (p[1] - pivot[1]) * s, pivot[1] + (p[0] - pivot[0]) * s + (p[1] - pivot[1]) * c]
    const out = { ...o }
    for (const k of JOINTS) if (o[k]) out[k] = R(o[k])
    for (const k of VECS) {
      const v = o[k] || (k === 'U' ? UP : null)
      if (v) out[k] = [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
    }
    return out
  }
  function shift(o, v) {
    const out = { ...o }
    for (const k of JOINTS) if (o[k]) out[k] = ad(o[k], v)
    return out
  }
  /** Rest a rotated pose on the floor (its lowest joint just above y = 0). */
  function ground(o, pad = 2.2) {
    let low = -1e9
    for (const k of JOINTS) if (o[k]) low = Math.max(low, o[k][1] + (k === 'head' ? 4 : pad))
    return shift(o, [0, -low])
  }

  // ---- people ----------------------------------------------------------------------------------
  // One painter for every person; a spec supplies colours and the head/torso style.
  function arm(sho, e, hnd, r, ch, sh, hand) {
    seg(sho, e, r, ch, sh)
    seg(e, hnd, r - 0.15, ch, sh)
    seg(hnd, hnd, r + 0.1, hand)
  }
  function leg(hip, k, f, sp, back, Fw, U, fat) {
    const pc = back ? sp.pantsS : sp.pants
    const ps = back ? sp.pantsD || 'k' : sp.pantsS
    seg(hip, k, sp.thigh + fat * 1.3, pc, ps)
    if (sp.shins) seg(k, f, sp.shin, back ? sp.shinsS : sp.shins, back ? 'd' : sp.shinsS)
    else seg(k, f, sp.shin, pc, ps)
    if (sp.bare) {
      seg(f, ad(ad(f, Fw, 1.8), U, -0.4), 1.1, back ? 's' : 'S', 's')
      return
    }
    const bc = back ? 'k' : sp.boot
    seg(lerp(k, f, 0.5), f, sp.bootR, bc, 'k')
    seg(f, ad(ad(f, Fw, sp.toe), U, -0.6), sp.bootR - 0.6, bc, 'k')
  }
  function person(o) {
    const sp = o.sp
    const U = o.U || UP
    const Fw = [-U[1], U[0]]
    const fat = o.fat || 0
    const n = o.neck
    const hip = o.hip
    const sho = lerp(n, hip, 0.16)
    if (o.slung) seg(o.slung[0], o.slung[1], 0.8, 'g', 'Z') // a rifle across the back
    if (o.be) arm(ad(sho, Fw, -0.8), o.be, o.bh, sp.armR, sp.armB, 'd', sp.handB)
    if (o.rb && o.rifleBack) rifle(o.rb, o.rf)
    leg(hip, o.bk, o.bf, sp, true, Fw, U, fat)
    sp.torso(o, Fw, U, fat)
    leg(hip, o.fk, o.ff, sp, false, Fw, U, fat)
    sp.head(o, Fw, U, fat)
    if (o.rb && !o.rifleBack) rifle(o.rb, o.rf)
    if (o.gun) gun(o)
    if (o.tb) tube(o.tb, o.tf)
    if (o.ladle) seg(o.fh, o.ladle, 0.55, 'G', 'g')
    if (o.fe) arm(ad(sho, Fw, 0.6), o.fe, o.fh, sp.armR + 0.1, sp.arm, sp.armS, sp.hand)
    if (o.kd) {
      seg(o.fh, ad(o.fh, o.kd, 1.2), 0.7, 'k')
      seg(ad(o.fh, o.kd, 1.6), ad(o.fh, o.kd, 5.4), 0.6, 'h', 'G')
    }
    if (o.nade) ball(ad(o.fh, [0.4, -1.4]), 1.4, 1.7, 'o', 'E', 'Q')
    if (o.extra) o.extra()
  }
  function rifle(a, b) {
    seg(a, lerp(a, b, 0.3), 1.15, 'n', 'k')
    seg(lerp(a, b, 0.28), lerp(a, b, 0.8), 0.85, 'g', 'Z')
    seg(lerp(a, b, 0.8), b, 0.5, 'Z')
    dot(ad(lerp(a, b, 0.5), [0, 1.2]), 'Z')
  }
  function gun(o) {
    const d = o.gd || [1, 0]
    const nrm = [d[1], -d[0]]
    if (o.gun === 'pistol') {
      const a = ad(ad(o.fh, d, 0.2), nrm, 0.7)
      seg(a, ad(a, d, 3.6), 0.85, 'G', 'g')
      dot(ad(a, nrm, -1.2), 'g')
      return
    }
    // the heavy machine gun: a long dark body, top rail, magazine and barrel
    seg(o.gb, o.gf, 1.5, 'g', 'Z')
    seg(ad(o.gb, nrm, 1.1), ad(o.gf, nrm, 1.1), 0.5, 'G')
    seg(o.gf, ad(o.gf, d, 3), 0.75, 'Z')
    const m = lerp(o.gb, o.gf, 0.5)
    seg(m, ad(m, nrm, -3.2), 1.0, 'K', 'k')
  }
  function tube(a, b) {
    seg(a, b, 1.9, 'V', 'v')
    seg(a, ad(a, norm([b[0] - a[0], b[1] - a[1]]), 1), 2.1, 'g')
    seg(b, ad(b, norm([a[0] - b[0], a[1] - b[1]]), 1), 2.1, 'g')
    dot(ad(lerp(a, b, 0.62), [0, -2.4]), 'g')
  }
  function eyes(h, Fw, U, face, big) {
    const e = ad(ad(h, Fw, 2.3), U, 0.1)
    if (face === 'x') {
      dot(e, 'E')
      dot(ad(e, Fw, 1), 'E')
      return
    }
    if (face === 'c') {
      dot(ad(e, U, -0.5), 'E')
      dot(ad(ad(e, U, -0.5), Fw, 1), 'E')
      return
    }
    if (face === 'o' || big) {
      dot(e, 'W')
      dot(ad(e, U, -1), 'W')
      dot(ad(e, Fw, 1), 'E')
      dot(ad(ad(e, Fw, 1), U, -1), 'E')
      return
    }
    dot(e, 'E')
    dot(ad(e, U, -1), 'E')
  }
  function mouth(h, Fw, U, face, r) {
    const m = ad(ad(h, Fw, r * 0.7), U, -r * 0.6)
    if (face === 'o') {
      ell(m, 1.1, 1.3, 'E')
      dot(ad(m, U, -0.6), 'p')
    } else if (face === 'c') {
      dot(m, 'd')
      dot(ad(m, Fw, -1), 'd')
    } else dot(m, 'd')
  }

  // the hero and his partner
  function heroHead(o, Fw, U, fat) {
    const sp = o.sp
    const h = o.head
    const r = 4.5 + fat * 0.5
    const band = sp.band
    ell(h, r, r, (dx, dy) => {
      const a = dx * U[0] + dy * U[1]
      const f = dx * Fw[0] + dy * Fw[1]
      if (band && a > 0.5 && a < 1.8) return f < -2 ? 'r' : 'R'
      if (a >= (band ? 1.8 : 1.3)) return f < -1.5 || a > 3.4 ? sp.hairS : sp.hair
      if (f < -1.9 && a > -1.6) return sp.hair
      if (a < -2.5 && f < 1.2) return 's'
      return 'S'
    })
    // spikes of hair, nose, ear, the bandana's loose ends
    dot(ad(ad(h, U, r + 0.4), Fw, -0.8), sp.hair)
    dot(ad(ad(h, U, r), Fw, 1.4), sp.hair)
    dot(ad(ad(h, U, r - 1), Fw, -r), sp.hairS)
    dot(ad(ad(h, Fw, r + 0.3), U, -0.6), 'S')
    dot(ad(ad(h, Fw, r), U, -1.3), 's')
    dot(ad(ad(h, Fw, -0.4), U, -0.4), 's')
    if (band) {
      const t0 = ad(ad(h, Fw, -r + 0.2), U, 1.2)
      const sw = o.tail || 0
      seg(t0, ad(ad(t0, Fw, -2.4), U, -0.8 + sw), 0.6, 'R')
      seg(t0, ad(ad(t0, Fw, -1.8), U, -2.0 + sw * 0.5), 0.55, 'r')
    }
    if (sp.shades) {
      seg(ad(ad(h, Fw, 0.6), U, 0.3), ad(ad(h, Fw, 4.2), U, 0.3), 0.75, 'E')
      dot(ad(ad(h, Fw, 3.2), U, 0.6), 'c')
    } else eyes(h, Fw, U, o.face)
    mouth(h, Fw, U, o.face, r)
    if (fat) ell(ad(ad(h, U, -2.4), Fw, 1.6), 2.4, 1.6, 'S')
  }
  function heroTorso(o, Fw, U, fat) {
    const sp = o.sp
    const n = o.neck
    const hp = o.hip
    const r = 3.4 + fat * 2.4
    seg(n, hp, r, sp.vest, sp.vestS)
    if (fat) ball(ad(lerp(n, hp, 0.66), Fw, 3.4), 5.0, 4.6, sp.shirt, 't')
    else seg(ad(n, Fw, r - 1), ad(lerp(n, hp, 0.86), Fw, r - 1.1), 0.85, sp.shirt)
    dot(ad(ad(n, Fw, 1.3), U, -0.4), sp.shirt)
    const b = ad(hp, U, 0.9)
    seg(ad(b, Fw, -r + 0.3), ad(b, Fw, r - 0.2 + fat * 1.6), 0.7, 'k')
    dot(ad(b, Fw, r - 0.9 + fat * 1.6), 'Y')
    seg(ad(lerp(n, hp, 0.5), Fw, -r + 0.5), ad(lerp(n, hp, 0.72), Fw, -r + 0.5), 0.9, 'K')
  }
  const HERO = {
    thigh: 2.1, shin: 1.9, bootR: 2.15, toe: 2.6, boot: 'K', armR: 1.45,
    arm: 'S', armS: 's', armB: 's', hand: 'S', handB: 's',
    head: heroHead, torso: heroTorso,
  }
  const LEAD = { ...HERO, hair: 'Y', hairS: 'y', band: true, vest: 'R', vestS: 'r', shirt: 'w', pants: 'T', pantsS: 't' }
  const PARTNER = { ...HERO, hair: 'a', hairS: 'E', band: false, shades: true, vest: 'V', vestS: 'v', shirt: 'T', pants: 'B', pantsS: 'b', pantsD: 'E' }

  // leg pairs for a stride phase, relative to the hip
  function stride(ph, swing, L) {
    const one = (p) => {
      const th = swing * Math.sin(p)
      const lift = Math.max(0, Math.cos(p))
      const bend = 0.25 + 1.25 * lift
      const k = [L * Math.sin(th), L * Math.cos(th)]
      const f = [k[0] + L * Math.sin(th - bend), k[1] + L * Math.cos(th - bend) - lift * 1.2]
      return [k, f]
    }
    return [one(ph), one(ph + Math.PI)]
  }
  /** Arms (and the weapon) for each weapon, relative to the neck. */
  function armsFor(wp, n, k = 0) {
    const N = (x, y) => [n[0] + x - k, n[1] + y]
    if (wp === 'pistol') return { fe: N(3, 3.6), fh: N(6.8, 3), be: N(-2.2, 4.4), bh: N(-0.8, 7.4), gun: 'pistol', gd: [1, 0], mz: N(11.4, 2.2) }
    if (wp === 'H') return { fe: N(3.2, 5.4), fh: N(6.2, 5.6), be: N(-1.8, 5), bh: N(1.6, 6.6), gun: 'H', gb: N(-1.5, 6.2), gf: N(9.5, 5.8), gd: [1, 0], mz: N(13.5, 5.8) }
    return { fe: N(3.6, 2.6), fh: N(5.4, 0.8), be: N(-1.2, 3.6), bh: N(1.4, 1.4), tb: N(-7, -1.2), tf: N(9.5, -1.6), mz: N(11.5, -1.6) }
  }

  const HW = 44
  const HH = 34
  const HX = 20
  function heroFrames(sp, fat) {
    const paint = (o) => {
      begin(HW, HH, HX)
      person({ sp, fat, ...o })
      const rows = end()
      return fr(rows, { mx: o.mz ? o.mz[0] : 0, my: o.mz ? o.mz[1] : 0 })
    }
    const base = { hip: [0, -10], neck: [0.6, -16.8], head: [1.6, -21.5], fk: [2.6, -6.2], ff: [3.4, -2], bk: [-2, -6.2], bf: [-2.8, -2] }
    const set = {}
    for (const wp of ['pistol', 'H', 'R']) {
      const S = (set[wp] = {})
      S.stand = [0, 1].map((i) => {
        const b = i ? { ...base, hip: [0, -9.7], neck: [0.6, -16.4], head: [1.6, -21.1] } : base
        return paint({ ...b, ...armsFor(wp, b.neck), tail: i * 0.6 })
      })
      S.fire = [0, 1].map((i) => {
        const b = { ...base, neck: [0.6 - i * 0.5, -16.8], head: [1.6 - i * 0.6, -21.5] }
        return paint({ ...b, ...armsFor(wp, b.neck, i * 1.3), face: i ? 'o' : 'n' })
      })
      S.run = []
      for (let i = 0; i < 6; i++) {
        const ph = (i / 6) * Math.PI * 2
        const [[k1, f1], [k2, f2]] = stride(ph, 0.75, 4.3)
        const hy = -2 - Math.max(f1[1], f2[1])
        const hip = [0, hy]
        const neck = [1.6, hy - 6.6]
        S.run.push(paint({ hip, neck, head: [2.8, hy - 11.2], fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2), ...armsFor(wp, neck), tail: 1 + Math.sin(ph) * 0.6 }))
      }
      const jn = [0.8, -20]
      S.jump = paint({ hip: [0, -13], neck: jn, head: [1.8, -24.6], fk: [3.4, -11], ff: [2.4, -6.4], bk: [-1.4, -9.6], bf: [-3.6, -6.4], ...armsFor(wp, jn), tail: 1.4 })
    }
    const lunge = { hip: [0, -9.4], neck: [1.6, -16.2], head: [2.8, -20.8], fk: [3.6, -6], ff: [6, -2], bk: [-2.6, -5.6], bf: [-5, -2] }
    const N = (x, y) => [lunge.neck[0] + x, lunge.neck[1] + y]
    set.knife = [
      paint({ ...base, fe: [-0.6, -17.4], fh: [-3.4, -22.4], kd: norm([-0.45, -1]), be: [2, -13], bh: [4.4, -12.4] }),
      paint({ ...lunge, fe: N(4.4, 1.6), fh: N(8, 1.4), kd: norm([0.9, 0.45]), be: N(-2.6, 3.4), bh: N(-3, 6), face: 'o' }),
      paint({ ...lunge, fe: N(3.4, 4.2), fh: N(5.6, 7.4), kd: norm([0.3, 1]), be: N(-2.6, 3.4), bh: N(-3, 6) }),
    ]
    const bn = base.neck
    const B = (x, y) => [bn[0] + x, bn[1] + y]
    set.throw = [
      paint({ ...base, fe: B(-3, 1.6), fh: B(-6.2, -0.6), nade: true, be: B(2.6, 3.8), bh: B(5, 5) }),
      paint({ ...base, fe: B(0.6, -3.4), fh: B(1.8, -8.6), nade: true, be: B(2.6, 3.8), bh: B(4.4, 6) }),
      paint({ ...lunge, fe: N(4.4, 1), fh: N(8, 0.2), be: N(-2, 4), bh: N(-3.6, 6.4), face: 'o' }),
    ]
    const d0 = {
      ...base, neck: [-2.2, -16.4], head: [-3.6, -20.8], U: norm([-0.35, -1]), face: 'o',
      fe: [0.4, -19.6], fh: [1.4, -23], be: [-4.6, -18.6], bh: [-7.2, -20.4], tail: 1.6,
    }
    set.dead = [
      paint(d0),
      paint(ground(rot({ ...d0, face: 'x' }, -0.75, [0, -1]), 2)),
      paint(ground(rot({ ...d0, face: 'x', fe: [2.4, -15], fh: [4.6, -12.6], be: [-4.4, -14], bh: [-6.6, -11.6] }, -1.5, [0, -10]), 2)),
    ]
    const sit = {
      hip: [0, -7], neck: [0.6, -14], head: [1.8, -18.6], fk: [4.8, -7.4], ff: [5.6, -2], bk: [3.8, -7.2], bf: [4.4, -2],
      fe: [3.2, -9.6], fh: [5.4, -7.6], be: [1.2, -9.2], bh: [3.6, -7],
    }
    set.sit = [
      paint({ ...sit, gun: 'pistol', gd: norm([1, 0.25]) }),
      paint({ ...sit, neck: [1, -13.6], head: [2.6, -17.8], U: norm([0.3, -1]), face: 'c', tail: -0.6, gun: 'pistol', gd: norm([1, 0.25]) }),
    ]
    set.win = [0, 1].map((i) =>
      paint({
        hip: [0, -10.4 - i], neck: [0.4, -17.2 - i], head: [1.2, -21.9 - i], fk: [3.2, -6.4 - i * 0.6], ff: [4.6, -2 - i * 0.4], bk: [-3, -6.4 - i * 0.6], bf: [-4.6, -2 - i * 0.4],
        fe: [5.4, -17.4 - i], fh: [7.6 + i * 0.4, -22 - i * 1.2], be: [-1.8, -12.6 - i], bh: [-2.6, -9 - i], face: 'c', tail: i * 1.2, gun: 'pistol', gd: norm([0.3, 1])
      }),
    )
    set.held = [0, 1].map((i) =>
      paint({
        hip: [0, -11], neck: [0.4, -17.8], head: [1.2, -22.4], fk: [1.4 + i, -6.6], ff: [1 + i * 2, -2.4], bk: [-1.4 - i, -6.8], bf: [-2.2 - i, -2.6],
        fe: [4.4, -19.2], fh: [7, -23 + i], be: [-2.6, -19.2], bh: [-5.4, -23 + i], face: 'o', tail: 1.5 - i,
      }),
    )
    return set
  }
  const HM = heroFrames(LEAD, 0)
  const HF = heroFrames(LEAD, 1)
  const HT = heroFrames(PARTNER, 0)
  /** The pilot's head, for the tank's hatch. */
  function pilotHead(sp) {
    begin(14, 12, 6)
    person({ sp, hip: [0, 4], neck: [0, -3], head: [0.6, -6.2], fk: [0, 6], ff: [0, 8], bk: [0, 6], bf: [0, 8] })
    return fr(end())
  }
  const PILOT = { lead: pilotHead(LEAD), partner: pilotHead(PARTNER) }

  // ---- the rebel army --------------------------------------------------------------------------
  function rebelHead(o, Fw, U) {
    const h = o.head
    const hat = o.hat || 'helmet'
    ell(h, 4.0, 4.0, (dx, dy) => {
      const a = dx * U[0] + dy * U[1]
      const f = dx * Fw[0] + dy * Fw[1]
      if (hat === 'bare' && (a > 1.4 || (f < -2 && a > -1.4))) return 'a'
      if (a < -2.3 && f < 1.2) return 's'
      return 'S'
    })
    dot(ad(ad(h, Fw, 4.2), U, -0.6), 'S')
    dot(ad(ad(h, Fw, 4.0), U, -1.3), 's')
    dot(ad(ad(h, Fw, -0.6), U, -0.4), 's')
    if (hat === 'helmet') {
      const c = ad(h, U, 1.0)
      ell(c, 4.8, 3.9, (dx, dy) => {
        const a = dx * U[0] + dy * U[1]
        const f = dx * Fw[0] + dy * Fw[1]
        if (a < -0.3) return null
        if (a < 0.7) return 'o'
        return a > 2.2 && f > -0.5 && f < 2.5 ? 'Q' : f < -2.6 ? 'o' : 'O'
      })
      seg(ad(ad(h, U, 1.0), Fw, 3), ad(ad(h, U, 0.7), Fw, 5.2), 0.6, 'o')
    } else if (hat === 'chef') {
      seg(ad(ad(h, U, 1.2), Fw, -3.6), ad(ad(h, U, 1.2), Fw, 3.6), 0.9, 'w')
      ball(ad(h, U, 4.4), 3.8, 2.8, 'W', 'w')
    }
    if (o.shades) {
      seg(ad(ad(h, Fw, 0.8), U, 0.2), ad(ad(h, Fw, 3.8), U, 0.2), 0.7, 'E')
      dot(ad(ad(h, Fw, 2.8), U, 0.5), 'c')
    } else eyes(h, Fw, U, o.face, o.face === 'o')
    mouth(h, Fw, U, o.face, 4)
  }
  function rebelTorso(o, Fw, U) {
    const n = o.neck
    const hp = o.hip
    if (o.bare) {
      seg(n, hp, 3.1, 'S', 's')
      seg(ad(hp, Fw, -3), ad(hp, Fw, 3), 1.1, 'O', 'o')
      return
    }
    seg(n, hp, 3.2, 'O', 'o')
    dot(ad(ad(n, Fw, 1.4), U, -1.4), 'Q')
    dot(ad(ad(n, Fw, 1.6), U, -3.2), 'o')
    const b = ad(hp, U, 0.9)
    seg(ad(b, Fw, -3), ad(b, Fw, 3), 0.7, 'n')
    dot(ad(b, Fw, 2.4), 'L')
    if (o.apron) seg(ad(lerp(n, hp, 0.25), Fw, 2.2), ad(hp, Fw, 2.6), 1.3, 'W', 'w')
  }
  const REBEL = {
    thigh: 2.0, shin: 1.8, bootR: 2.05, toe: 2.3, boot: 'k', armR: 1.4, pants: 'O', pantsS: 'o', pantsD: 'k',
    arm: 'O', armS: 'o', armB: 'o', hand: 'S', handB: 's', head: rebelHead, torso: rebelTorso,
  }
  const SUNNY = { ...REBEL, arm: 'S', armS: 's', armB: 's', shins: 'S', shinsS: 's', bare: true }
  const RW = 44
  const RH = 34
  const RX = 20
  function rebelFrames(sp, extra) {
    const paint = (o) => {
      begin(RW, RH, RX)
      const q = { sp, ...o, ...extra }
      if (extra.noRifle) {
        delete q.rb
        delete q.rf
        delete q.slung
      }
      person(q)
      return fr(end(), { mx: o.mz ? o.mz[0] : 0, my: o.mz ? o.mz[1] : 0 })
    }
    const base = { hip: [0, -9.5], neck: [0.4, -16], head: [1.2, -20.2], fk: [2.4, -5.8], ff: [3, -2], bk: [-2, -5.8], bf: [-2.6, -2] }
    const N = (n, x, y) => [n[0] + x, n[1] + y]
    const F = {}
    const n0 = base.neck
    F.stand = [0, 1].map((i) => {
      const b = i ? { ...base, hip: [0, -9.2], neck: [0.4, -15.7], head: [1.2, -19.9] } : base
      const n = b.neck
      return paint({ ...b, fe: N(n, 3, 4.6), fh: N(n, 4.6, 7), be: N(n, -1.4, 4.4), bh: N(n, 1, 8), rb: N(n, -1, 9.5), rf: N(n, 8.4, 0.6) })
    })
    F.walk = []
    F.run = []
    for (let i = 0; i < 6; i++) {
      const ph = (i / 6) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.75, 4.1)
      const hy = -2 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      const n = [1.8, hy - 6.4]
      const legs = { hip, neck: n, head: [3, hy - 10.6], fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2) }
      F.run.push(paint({ ...legs, fe: N(n, 3, 4.4), fh: N(n, 6.2, 5.2), be: N(n, -1, 4.6), bh: N(n, 2.2, 6.4), rb: N(n, -1, 7), rf: N(n, 11, 4.6) }))
      // flee: no rifle, arms flailing over the head, mouth wide open
      const sw = Math.sin(ph)
      F.flee = F.flee || []
      F.flee.push(paint({ ...legs, neck: [2.4, hy - 6.2], head: [3.6, hy - 10.4], face: 'o', fe: N(n, 4.6, -1), fh: N(n, 7.6, -4.4 + sw * 2), be: N(n, -3.4, -1.6), bh: N(n, -6.6, -5 - sw * 2) }))
    }
    for (let i = 0; i < 4; i++) {
      const ph = (i / 4) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.5, 4.1)
      const hy = -2 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      const n = [0.6, hy - 6.6]
      const sw = Math.sin(ph)
      F.walk.push(
        paint({
          hip, neck: n, head: [1.4, hy - 10.8], fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2),
          fe: N(n, 2.4, 3.6), fh: N(n, 3.4, 1.2), be: N(n, -1.2 - sw, 4), bh: N(n, -1 - sw * 2.2, 7.6), rb: N(n, 3.6, 1.8), rf: N(n, -7.6, -5.6), rifleBack: true,
        }),
      )
    }
    const aimArms = (n, k) => ({ fe: N(n, 3.6 - k, 4.4), fh: N(n, 6.6 - k, 2.8), be: N(n, -0.6 - k, 4.6), bh: N(n, 1.2 - k, 2.8), rb: N(n, -1.6 - k, 2.4), rf: N(n, 11.5 - k, 2), mz: N(n, 12.5 - k, 2) })
    F.aim = paint({ ...base, ...aimArms(n0, 0) })
    F.fire = paint({ ...base, neck: [-0.2, -16], head: [0.6, -20.2], ...aimArms([-0.2, -16], 1.2), face: 'o' })
    const B = (x, y) => N(n0, x, y)
    F.throw = [
      paint({ ...base, fe: B(-3, 1.6), fh: B(-6.2, -0.6), nade: true, be: B(2.6, 3.8), bh: B(5, 5), slung: [B(-3.6, -2), B(-2.6, 9)] }),
      paint({ ...base, fe: B(0.6, -3.4), fh: B(1.8, -8.6), nade: true, be: B(2.6, 3.8), bh: B(4.4, 6), slung: [B(-3.6, -2), B(-2.6, 9)] }),
      paint({ ...base, neck: [1.4, -15.8], head: [2.6, -19.8], fe: B(4.4, 1.4), fh: B(8, 0.6), be: B(-2, 4), bh: B(-3.4, 6.4), slung: [B(-3.6, -2), B(-2.6, 9)] }),
    ]
    F.chat = [0, 1].map((i) =>
      paint({ ...base, face: i ? 'o' : 'n', slung: [B(-3.6, -2.4), B(-2.4, 9.4)], fe: B(3, 4), fh: i ? B(5.4, -0.4) : B(5.6, 2.4), be: B(-3, 4.2), bh: B(-1.2, 7) }),
    )
    F.shock = paint({
      hip: [0, -11], neck: [0.2, -17.4], head: [0.8, -21.6], fk: [3.6, -7.4], ff: [6, -4], bk: [-3, -7.4], bf: [-5.6, -4], face: 'o',
      fe: [4.6, -18.6], fh: [7.4, -22.6], be: [-2.6, -18.4], bh: [-5.6, -22.2],
    })
    F.slide = paint({
      hip: [-1, -9], neck: [-3.4, -15.4], head: [-4.4, -19.6], U: norm([-0.3, -1]), fk: [2.6, -5.6], ff: [5, -2], bk: [1, -5.8], bf: [2.8, -2], face: 'o',
      fe: [0.2, -13.8], fh: [3, -16.4], be: [-1, -14], bh: [1.6, -17.6],
    })
    const d0 = { ...base, neck: [-2, -15.6], head: [-3.4, -19.8], U: norm([-0.35, -1]), face: 'o', fe: [0.6, -18.6], fh: [1.6, -22], be: [-4.4, -17.6], bh: [-7, -19.4] }
    F.dead = [paint(d0), paint(ground(rot({ ...d0, face: 'x' }, -0.75, [0, -1]), 2)), paint(ground(rot({ ...d0, face: 'x', fe: [2.4, -14], fh: [4.6, -12], be: [-4.4, -13.6], bh: [-6.6, -11.4] }, -1.5, [0, -10]), 2))]
    F.spin = [0, 1, 2, 3].map((k) => {
      const o = rot({ ...base, face: 'o', fe: [4.6, -17.6], fh: [7.4, -21.4], be: [-2.6, -17.4], bh: [-5.6, -21], fk: [3, -6], ff: [5, -3], bk: [-2.6, -6], bf: [-4.6, -3] }, (k * Math.PI) / 2, [0, -12])
      return paint(shift(o, [0, -1]))
    })
    F.held = [0, 1].map((i) =>
      paint({ hip: [0, -11], neck: [0.4, -17.4], head: [1.2, -21.6], fk: [1.6 + i * 1.4, -6.8], ff: [1.2 + i * 2.6, -2.6], bk: [-1.4 - i, -6.8], bf: [-2.4 - i * 1.6, -2.8], face: 'o', fe: [4.6, -18.6], fh: [7.4, -22.4 + i], be: [-2.6, -18.4], bh: [-5.6, -22.2 + i] }),
    )
    F.sleep = paint({
      hip: [0, -4.6], neck: [1.2, -11.2], head: [2.8, -14.6], U: norm([0.45, -1]), fk: [4, -7.4], ff: [7.6, -2], bk: [3.6, -6.4], bf: [6.8, -2], face: 'c',
      fe: [3.4, -7.6], fh: [5.6, -8.4], be: [2.6, -7.8], bh: [4.6, -9], rb: [-3.6, -2], rf: [-0.4, -16], rifleBack: true,
    })
    F.cook = [0, 1].map((i) =>
      paint({ ...base, hat: 'chef', apron: true, fe: B(3.4, 4.4), fh: B(6.4 - i * 1.2, 7.6), ladle: B(8.4 - i * 2.2, 13.4), be: B(-2.8, 4.2), bh: B(-1, 7) }),
    )
    // sunbathing: on his back, hands behind his head, one knee up
    {
      const lay = rot(
        { hip: [0, -9.5], neck: [0.4, -16], head: [1.2, -20.2], fk: [3.6, -7.4], ff: [1.4, -3], bk: [-1, -5.8], bf: [-1.4, -1.6], fe: [-2.4, -18.6], fh: [-0.6, -21.6], be: [-2.6, -18.4], bh: [-1.2, -21.2], hat: 'bare', shades: true, face: 'c' },
        -Math.PI / 2,
        [0, -10],
      )
      begin(RW, RH, RX)
      person({ sp: SUNNY, ...ground(lay, 1.4) })
      F.sun = fr(end())
    }
    F.chef = paint({ ...base, hat: 'chef', apron: true, fe: B(3, 4.6), fh: B(4.4, 7.4), be: B(-2.8, 4.2), bh: B(-1, 7) })
    return F
  }
  const RF = rebelFrames(REBEL, {})
  const RFC = rebelFrames(REBEL, { hat: 'chef', apron: true, noRifle: true })
  const RFS = rebelFrames(SUNNY, { hat: 'bare', shades: true, noRifle: true, bare: true })

  // ---- POWs ---------------------------------------------------------------------------------------
  function powHead(o, Fw, U) {
    const h = o.head
    ell(h, 4.1, 4.1, (dx, dy) => {
      const a = dx * U[0] + dy * U[1]
      const f = dx * Fw[0] + dy * Fw[1]
      if (f < -1.4 && a > -1.4) return a > 2.6 ? 'S' : 'n'
      if (a < -1.7 && f > -2.6) return 'n'
      return a > 2.6 && f < 0.5 ? 'w' : 'S'
    })
    // the big beard and moustache
    ell(ad(ad(h, U, -3.4), Fw, 1.4), 3.0, 2.2, (dx, dy, u, v) => (v > 0.2 ? 'K' : 'n'))
    seg(ad(ad(h, Fw, 1.6), U, -1.0), ad(ad(h, Fw, 4.4), U, -1.4), 0.6, 'K')
    dot(ad(ad(h, Fw, 4.3), U, -0.2), 'S')
    eyes(h, Fw, U, o.face)
    if (o.face === 'o') ell(ad(ad(h, Fw, 3), U, -2.4), 1, 1.1, 'E')
  }
  function powTorso(o, Fw, U) {
    const n = o.neck
    const hp = o.hip
    seg(n, hp, 3.1, 'w', 't')
    dot(ad(ad(n, Fw, 1.2), U, -2.6), 'S')
    dot(ad(ad(hp, Fw, -2), U, 2.6), 't')
    seg(ad(hp, Fw, -3), ad(hp, Fw, 3), 0.7, 'N')
    if (o.tied) {
      seg(ad(lerp(n, hp, 0.3), Fw, -3.4), ad(lerp(n, hp, 0.3), Fw, 3.4), 0.6, 'N')
      seg(ad(lerp(n, hp, 0.62), Fw, -3.4), ad(lerp(n, hp, 0.62), Fw, 3.4), 0.6, 'N')
    }
  }
  const POWSP = { thigh: 1.9, shin: 1.7, bootR: 1.6, toe: 2, pants: 'n', pantsS: 'k', pantsD: 'E', bare: true, arm: 'S', armS: 's', armB: 's', hand: 'S', handB: 's', armR: 1.3, head: powHead, torso: powTorso }
  const PW = 40
  const PH = 32
  const PX = 18
  const PF = (() => {
    const paint = (o) => {
      begin(PW, PH, PX)
      person({ sp: POWSP, ...o })
      return fr(end())
    }
    const base = { hip: [0, -9], neck: [0.4, -15.4], head: [1.2, -19.6], fk: [2.2, -5.4], ff: [2.6, -1.8], bk: [-2, -5.4], bf: [-2.4, -1.8] }
    const n = base.neck
    const B = (x, y) => [n[0] + x, n[1] + y]
    const F = {}
    const sitT = { hip: [0, -4], fk: [4.2, -5.4], ff: [1.6, -1.6], bk: [-2.4, -5], bf: [1, -1.4], be: [-2.6, -8], bh: [-3.4, -4.6], tied: true }
    F.tied = [0, 1].map((i) => paint({ ...sitT, neck: [0.2 + i * 0.8, -10.6], head: [1 + i * 1.4, -14.6 + i * 0.2], U: norm([i * 0.25, -1]), face: i ? 'c' : 'n' }))
    F.stand = paint({ ...base, fe: B(1.6, 4.6), fh: B(2, 8.6), be: B(-1.6, 4.6), bh: B(-1.6, 8.6) })
    F.salute = paint({ ...base, fe: B(3.4, 1.8), fh: B(3.4, -4.4), be: B(-1.2, 4.6), bh: B(-1, 8.6) })
    F.dig = [0, 1].map((i) => paint({ ...base, neck: [1.2, -15], head: [2.6, -18.8], U: norm([0.3, -1]), fe: B(3, 4.8), fh: B(2.4 - i * 0.6, 8 + i * 1.6), be: B(-1.6, 4.6), bh: B(-1.6, 8.6) }))
    F.run = []
    for (let i = 0; i < 6; i++) {
      const ph = (i / 6) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.85, 3.9)
      const hy = -2 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      const nk = [2.4, hy - 6]
      const sw = Math.sin(ph)
      F.run.push(paint({ hip, neck: nk, head: [3.8, hy - 10], fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2), face: 'o', fe: ad(nk, [2 + sw * 2, 3]), fh: ad(nk, [4 + sw * 3, 1.6]), be: ad(nk, [-1 - sw * 2, 3.4]), bh: ad(nk, [-2 - sw * 3, 2]) }))
    }
    F.walk = []
    for (let i = 0; i < 4; i++) {
      const ph = (i / 4) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.4, 3.9)
      const hy = -2 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      const nk = [0.8, hy - 6.4]
      F.walk.push(paint({ hip, neck: nk, head: [1.8, hy - 10.4], U: norm([0.2, -1]), fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2), tied: true, be: ad(nk, [-2.6, 3.6]), bh: ad(nk, [-3.2, 7]) }))
    }
    return F
  })()

  // ---- the sergeant --------------------------------------------------------------------------------
  function bruteHead(o, Fw, U) {
    const h = o.head
    ell(h, 3.9, 4.1, (dx, dy) => {
      const a = dx * U[0] + dy * U[1]
      const f = dx * Fw[0] + dy * Fw[1]
      if (a > 2.2) return 'a'
      if (f < -2.4 && a > 0.4) return 'a'
      if (a < -2 && f < 1.6) return 's'
      return 'S'
    })
    seg(ad(ad(h, U, 3.6), Fw, -3), ad(ad(h, U, 3.6), Fw, 3), 0.8, 'a') // the flat-top
    seg(ad(ad(h, U, -2.6), Fw, 0), ad(ad(h, U, -3.1), Fw, 3.6), 1.0, 's') // the jaw
    seg(ad(ad(h, U, 1.2), Fw, 1.6), ad(ad(h, U, 1.2), Fw, 3.8), 0.5, 'a') // brow
    dot(ad(ad(h, Fw, 4.1), U, -0.5), 'S')
    if (o.face === 'o') {
      ell(ad(ad(h, Fw, 2.6), U, -2), 1.1, 1.3, 'E')
      dot(ad(ad(h, Fw, 2.6), U, -2.4), 'p')
      dot(ad(ad(h, Fw, 2.5), U, 0.2), 'E')
    } else {
      dot(ad(ad(h, Fw, 2.5), U, 0.2), 'E')
      seg(ad(ad(h, Fw, 2.2), U, -2), ad(ad(h, Fw, 3.4), U, -2), 0.5, 'd')
    }
  }
  function bruteTorso(o, Fw, U) {
    const n = o.neck
    const hp = o.hip
    seg(n, hp, 5.2, 'S', 's')
    seg(lerp(n, hp, 0.2), hp, 4.7, 'O', 'o')
    seg(ad(lerp(n, hp, 0.25), Fw, -3.6), ad(lerp(n, hp, 0.8), Fw, 3.8), 0.7, 'Y', 'y') // the ammo belt
    const b = ad(hp, U, 1)
    seg(ad(b, Fw, -4.4), ad(b, Fw, 4.6), 0.8, 'k')
    dot(ad(b, Fw, 3.8), 'G')
  }
  const BRUTE = { thigh: 2.6, shin: 2.3, bootR: 2.4, toe: 2.6, boot: 'k', pants: 'O', pantsS: 'o', pantsD: 'E', armR: 2.2, arm: 'S', armS: 's', armB: 's', hand: 'S', handB: 's', head: bruteHead, torso: bruteTorso }
  const AW = 50
  const AH = 34
  const AX = 22
  const AF = (() => {
    const paint = (o) => {
      begin(AW, AH, AX)
      person({ sp: BRUTE, ...o })
      return fr(end(), { mx: o.mz ? o.mz[0] : 0, my: o.mz ? o.mz[1] : 0 })
    }
    const base = { hip: [0, -12], neck: [0.6, -22], head: [1.8, -26.8], fk: [3, -7.4], ff: [4, -2.4], bk: [-2.8, -7.4], bf: [-3.6, -2.4] }
    const m60 = (n, k = 0) => ({ fe: ad(n, [4.6 - k, 6.6]), fh: ad(n, [8 - k, 8.6]), be: ad(n, [-1.6 - k, 6.6]), bh: ad(n, [2.4 - k, 10]), gun: 'H', gb: ad(n, [-1.8 - k, 10.4]), gf: ad(n, [13 - k, 8.8]), gd: [1, -0.1], mz: ad(n, [16.5 - k, 8.6]) })
    const F = {}
    F.stand = [0, 1].map((i) => {
      const b = i ? { ...base, hip: [0, -11.7], neck: [0.6, -21.6], head: [1.8, -26.4] } : base
      return paint({ ...b, ...m60(b.neck) })
    })
    F.fire = [0, 1].map((i) => paint({ ...base, neck: [0.6 - i * 0.6, -22], head: [1.8 - i * 0.8, -26.8], face: 'o', ...m60([0.6 - i * 0.6, -22], i * 1.2) }))
    F.walk = []
    for (let i = 0; i < 4; i++) {
      const ph = (i / 4) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.5, 5)
      const hy = -2.4 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      const n = [1, hy - 10]
      F.walk.push(paint({ hip, neck: n, head: [2.2, hy - 14.8], fk: ad(hip, k1), ff: ad(hip, f1), bk: ad(hip, k2), bf: ad(hip, f2), ...m60(n) }))
    }
    const n = base.neck
    F.laugh = [0, 1].map((i) => paint({ ...base, neck: [-0.6, -22], head: [-0.6, -26.6 - i * 0.4], U: norm([-0.45, -1]), face: 'o', ...m60([-0.6, -22]) }))
    F.throw = [
      paint({ ...base, fe: ad(n, [-3, 0.6]), fh: ad(n, [-5, -3]), nade: true, be: ad(n, [1.6, 6.6]), bh: ad(n, [4, 9.6]), gun: 'H', gb: ad(n, [-2, 11]), gf: ad(n, [10, 10.4]), gd: [1, 0] }),
      paint({ ...base, neck: [2, -21.6], head: [3.4, -26.2], fe: ad(n, [5, 0]), fh: ad(n, [9, -1]), be: ad(n, [1.6, 6.6]), bh: ad(n, [4, 9.6]), gun: 'H', gb: ad(n, [-2, 11]), gf: ad(n, [10, 10.4]), gd: [1, 0], face: 'o' }),
    ]
    F.hurt = paint({ ...base, neck: [-2.4, -21.6], head: [-3.6, -26], U: norm([-0.4, -1]), face: 'o', fe: ad(n, [1, -2]), fh: ad(n, [2, -6]), be: ad(n, [-4, -1]), bh: ad(n, [-6.6, -4]) })
    F.dead = paint(ground(rot({ ...base, face: 'o', fe: [2, -16], fh: [5, -14], be: [-3, -16], bh: [-6, -13] }, -1.5, [0, -12]), 2.6))
    return F
  })()

  // ---- the small tank --------------------------------------------------------------------------
  const SW = 50
  const SH = 32
  const SX = 22
  const VEHICLE = (() => {
    const out = {}
    out.tracks = [0, 1, 2].map((k) => {
      begin(SW, SH, SX)
      ell([-1, -4.2], 18.5, 4.4, 'Z')
      box(-17, -8, 15, -1, 'Z')
      for (const wx of [-14, -7, 0, 7, 13]) ball([wx, -4], 2.7, 2.7, 'G', 'g', 'h')
      for (let x = -18 + k; x <= 16; x += 3) {
        put(x, -9, 'g')
        put(x, 0, 'g')
      }
      return fr(end())
    })
    const body = (hurt) => {
      begin(SW, SH, SX)
      const A = hurt ? 'R' : 'A'
      const I = hurt ? 'p' : 'I'
      const i = hurt ? 'r' : 'i'
      // lower hull, sloped at the front
      for (let y = -15; y <= -8; y++) for (let x = -19; x <= 17 - Math.max(0, -11 - y); x++) put(x, y, y === -15 ? I : y >= -9 ? i : A)
      box(-18, -12, 12, -11, 'R')
      // the cabin dome and its open hatch
      ell([-2, -16.5], 12, 7.5, (dx, dy, u, v) => (v > 0.15 ? null : u * LIGHT[0] + v * LIGHT[1] > 0.55 ? I : u * LIGHT[0] + v * LIGHT[1] < -0.3 ? i : A))
      ell([-3, -23.6], 3.8, 1.1, 'E')
      seg([-8.4, -23.4], [-7.6, -27.2], 1.0, i, 'Z')
      // twin vulcan
      ball([5, -20.6], 2.4, 2.2, i, 'Z', 'A')
      seg([6, -21.6], [13.5, -21.6], 0.6, 'g')
      seg([6, -19.6], [13.5, -19.6], 0.6, 'g')
      // headlight, exhaust, rivets
      dot([16, -13], 'L')
      seg([-19, -14], [-21, -17], 0.8, 'g')
      for (const x of [-15, -9, -3, 3, 9]) put(x, -9, 'Z')
      return fr(end())
    }
    out.body = body(false)
    out.hurt = body(true)
    // the cannon, one sprite per angle, pivot at the grid centre
    out.cannon = []
    for (let k = 0; k <= 10; k++) {
      const a = -0.7 + k * 0.1
      begin(36, 36, 18)
      const p = [0, -17]
      const d = [Math.cos(a), Math.sin(a)]
      seg(p, ad(p, d, 13), 1.5, 'g', 'Z')
      seg(ad(p, d, 12), ad(p, d, 15), 1.9, 'G', 'g')
      seg(p, ad(p, d, 13), 0.4, 'G')
      out.cannon.push(fr(end()))
    }
    // the parachute it arrives under
    begin(44, 18, 22)
    ell([0, -11], 15, 6.5, (dx, dy, u, v) => (v > 0.2 ? null : Math.floor((dx + 15) / 5) % 2 ? 'R' : 'W'))
    for (const [x0, x1] of [[-14, -10], [-5, -4], [5, 4], [14, 10]]) {
      for (let t = 0; t <= 1; t += 0.08) put(x0 + (x1 - x0) * t, -10 + 10 * t, 'h')
    }
    out.chute = fr(end())
    return out
  })()

  // ---- the boss tank --------------------------------------------------------------------------------
  const GW_ = 66
  const GH_ = 34
  const GX_ = 30
  const BOSS_TANK = (() => {
    const out = {}
    out.tracks = [0, 1, 2].map((k) => {
      begin(GW_, GH_, GX_)
      ell([-1, -5], 26, 5, 'E')
      box(-25, -10, 23, -1, 'Z')
      for (const wx of [-21, -13, -5, 3, 11, 19]) ball([wx, -5], 3.3, 3.3, 'G', 'g', 'h')
      for (let x = -26 + k; x <= 24; x += 3) {
        put(x, -10, 'g')
        put(x, 0, 'g')
      }
      return fr(end())
    })
    const body = (hurt, recoil) => {
      begin(GW_, GH_, GX_)
      const O = hurt ? 'R' : 'O'
      const o = hurt ? 'r' : 'o'
      const Q = hurt ? 'p' : 'Q'
      for (let y = -18; y <= -10; y++) {
        const k = -10 - y
        for (let x = -27 + k * 0.5; x <= 26 - k * 0.6; x++) put(x, y, y === -18 ? Q : y > -13 ? o : O)
      }
      for (const x of [-20, -12, -4, 4, 12, 20]) put(x, -12, 'E')
      // turret, a rebel peeking from the hatch
      ell([-4, -25.6], 3.6, 3.6, (dx, dy) => (dy < -0.6 ? 'O' : 'S'))
      dot([-2.4, -24.8], 'E')
      ell([-3, -21.6], 11, 5.4, (dx, dy, u, v) => (u * LIGHT[0] + v * LIGHT[1] > 0.5 ? Q : u * LIGHT[0] + v * LIGHT[1] < -0.3 ? o : O))
      // the long gun
      const r = recoil ? -3 : 0
      seg([6 + r, -22], [28 + r, -24.2], 1.6, 'o', 'E')
      seg([26 + r, -24], [31 + r, -24.5], 2.3, 'g', 'Z')
      // a red insignia, smoke stacks
      ball([-14, -14.4], 1.8, 1.8, 'R', 'r')
      seg([-24, -19], [-25, -22], 1.0, 'g')
      return fr(end(), { mx: 32 + r, my: -24.5 })
    }
    out.body = body(false, false)
    out.recoil = body(false, true)
    out.hurt = body(true, false)
    return out
  })()

  // ---- effects and small things ---------------------------------------------------------------
  /** Chunky fireballs and smoke puffs by radius. */
  const FIRE = []
  const SMOKE = []
  const FLASH = []
  for (let r = 1; r <= 10; r++) {
    const n = r * 2 + 3
    const c0 = r + 1
    const mk = (fn) => {
      begin(n, n, c0)
      for (let y = -n + 1; y <= 0; y++)
        for (let x = -c0; x <= n - c0 - 1; x++) {
          const dx = x
          const dy = y + c0 + 0.5 - 1
          const q = Math.hypot(dx, dy) / r
          const th = Math.atan2(dy, dx)
          if (q > 0.86 + 0.14 * Math.sin(th * 5 + r)) continue
          put(x, y, fn(q, dx / r, dy / r))
        }
      return outline(sprite(end(), P), 'rgba(40,10,6,.55)')
    }
    FIRE.push(mk((q, u, v) => (q < 0.32 && v < 0.2 ? 'W' : q < 0.58 ? (v < 0.3 ? 'L' : 'F') : v > 0.3 || q > 0.8 ? 'f' : 'F')))
    SMOKE.push(mk((q, u, v) => (u * LIGHT[0] + v * LIGHT[1] > 0.35 ? 'X' : q > 0.7 && v > 0 ? 'm' : 'M')))
    FLASH.push(mk((q) => (q < 0.6 ? 'W' : 'L')))
  }
  const S = (rows) => outline(sprite(rows, P), OUT)
  const MUZ = [S(['..L..', '.LWL.', 'LWWWL', '.LWL.', '..L..']), S(['.L.L...', 'LWWWLL.', 'WWWWWWL', 'LWWWLL.', '.L.L...'])]
  const MUZL = MUZ.map((c) => mirror(c))
  const BUL = {
    pistol: S(['LLW', 'LLW']),
    hmg: S(['FLLLWW', 'FLLLWW']),
    vulcan: S(['LLW']),
    rebel: S(['.F.', 'FLF', '.F.']),
    m60: S(['FLW']),
    shell: S(['gGGL', 'ZgGL']),
    gshell: S(['.gg.', 'gGGg', 'gGGg', '.gg.']),
  }
  const ROCKET = pair(['....', 'R.gggGh', 'RRVVVVhh', 'R.gggGh'], P)
  const ROCKETO = { 1: outline(ROCKET[1], OUT), '-1': outline(ROCKET['-1'], OUT) }
  const NADE = [S(['.k.', 'ooo', 'oQo', 'ooo']), S(['..k', 'ooo', 'oQo', 'ooo.']), S(['ooo', 'oQo', 'ooo', '.k.']), S(['k..', 'ooo', 'oQo', 'ooo'])]
  const SLASH = pair(['.......hh', '........hW', '.........W', '.........W', '........hW', '.......hh.', '......h...'], P)
  const HELMET = S(['..QQO..', '.QOOOo.', 'oOOOOOo', 'ooooooo'])
  const RIFLE = S(['nnngggggZZ', 'nn..Z.....'])
  const ROPE = [sprite(['N'], P), sprite(['n'], P)]
  const SWEAT = S(['c', 'c'])
  const TOWEL = S(['RRwwRRwwRRwwRRwwRRwwRR', 'RRwwRRwwRRwwRRwwRRwwRR'])
  const POT = (() => {
    begin(16, 14, 8)
    seg([-6, -13], [-1, 0], 0.5, 'k')
    seg([6, -13], [1, 0], 0.5, 'k')
    seg([-6, -13], [6, -13], 0.5, 'k')
    ball([0, -8], 5, 3.6, 'g', 'Z', 'G')
    seg([-4.6, -10.6], [4.6, -10.6], 0.7, 'n')
    seg([-5.4, -11.6], [5.4, -11.6], 0.6, 'G')
    return S(end())
  })()
  const LOGS = S(['..nnNNnnnNnn..', '.nNNnnnnNNnnn.', 'nnnn.nnn..nnnn'])
  const SEAT = S(['.nnNNNNNNNnn.', 'nNNNnnnnNNNnn', 'nnnnnnnnnnnnn', 'k.nnnnnnnnn.k', '..k.......k..'])
  const FLAME = [
    S(['...L.....', '..LL..L..', '..LWL.LL.', '.FLWLLLF.', '.FFLWLFF.', 'fFFLLLFFf', '.fFFFFFf.']),
    S(['.....L...', '..L..LL..', '.LL.LWL..', '.FLLLWLF.', '.FFLWLFF.', 'fFFLLLFFf', '.fFFFFFf.']),
    S(['....L....', '...LL.L..', '..LWLLL..', '.FLWWLLF.', '.FFLWLFF.', 'fFFLLLFFf', '.fFFFFFf.']),
  ]
  const EMBER = S(['..f.F..f.', '.fxfxfxf.'])
  const STEAM = [S(['X.', '.X', 'X.']), S(['.X', 'X.', '.X'])]

  // the item crates and food, in the 5×7 font where they carry a letter
  const FONT = {
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'], D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.####'], H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'], J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'], X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    '!': ['.##..', '.##..', '.##..', '.##..', '.#...', '.....', '.##..'], "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
    ',': ['.....', '.....', '.....', '.....', '.....', '..#..', '.#...'], '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    '?': ['.###.', '#...#', '....#', '..##.', '..#..', '.....', '..#..'],
  }
  function glyph(ch, scale, color) {
    const rows = FONT[ch]
    const c = document.createElement('canvas')
    c.width = 5 * scale
    c.height = 7 * scale
    const x = c.getContext('2d')
    rows.forEach((r, j) =>
      [...r].forEach((b, i) => {
        if (b !== '#') return
        for (let sy = 0; sy < scale; sy++) {
          x.fillStyle = color(j * scale + sy)
          x.fillRect(i * scale, j * scale + sy, scale, 1)
        }
      }),
    )
    return outline(c, 'rgba(40,8,4,.95)')
  }
  const BIG = {}
  const SMALL = {}
  const SMALLW = {}
  for (const ch of Object.keys(FONT)) {
    BIG[ch] = glyph(ch, 2, (y) => (y < 4 ? P.L : y < 7 ? '#ffd23a' : y < 10 ? P.F : P.f))
    SMALL[ch] = glyph(ch, 1, (y) => (y < 3 ? P.L : P.F))
    SMALLW[ch] = glyph(ch, 1, () => '#ffffff')
  }
  /** Draw a string in the pixel font; returns its width. */
  function drawText(c, str, x, y, set, pitch) {
    let dx = 0
    for (const ch of str) {
      const g = set[ch]
      if (g) c.drawImage(g, Math.round(x + dx) - 1, Math.round(y) - 1)
      dx += pitch
    }
    return dx
  }
  const textW = (str, pitch) => str.length * pitch - (pitch - (pitch > 7 ? 10 : 5))

  function crate(letter, fill, ink) {
    const c = document.createElement('canvas')
    c.width = 11
    c.height = 11
    const x = c.getContext('2d')
    x.fillStyle = P.k
    x.fillRect(0, 0, 11, 11)
    x.fillStyle = fill[0]
    x.fillRect(1, 1, 9, 5)
    x.fillStyle = fill[1]
    x.fillRect(1, 6, 9, 4)
    FONT[letter].forEach((r, j) =>
      [...r].forEach((b, i) => {
        if (b === '#') {
          x.fillStyle = ink
          x.fillRect(3 + Math.floor(i * 0.99), 2 + j, 1, 1)
        }
      }),
    )
    // keep the letter inside the 5-wide window: H/R/B are drawn 5 wide from x=3
    return outline(c, OUT)
  }
  const ITEM = {
    H: crate('H', [P.L, P.F], P.r),
    R: crate('R', [P.L, P.F], P.r),
    B: crate('B', [P.Q, P.O], P.E),
    chicken: S(['....nNNn..', '...nNNNNn.', '..nNNNNNn.', '.WnnNNNnn.', 'WW.nnnn...', '.W........']),
    fish: S(['.....CCCC..C', '...CCcCCCCCC', '..CEcCCCCC.C', '...CCCCCCC..', '.....CC.....']),
    banana: S(['.........k', '........YY', '.......YY.', 'y....YYY..', '.yYYYYy...', '..yyyy....']),
  }
  const ITEM_LINE = { H: 'HEAVY MACHINE GUN!', R: 'ROCKET LAUNCHER!', B: 'BOMB!' }

  // one-pixel sprites and bursts in this palette (the engine's pix/burst use its own)
  const PIXS = {}
  const px = (k) => PIXS[k] || (PIXS[k] = sprite([k], P))
  function burst(s, x, y, n, colors) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2
      const v = rand(15, 55)
      s.particle({ img: px(pick(colors)), x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 15, g: 90, life: rand(0.6, 1.2), fade: true })
    }
  }
  const BULM = {}
  for (const k of Object.keys(BUL)) BULM[k] = mirror(BUL[k])
  const MINICHUTE = S(['..RWRW..', '.WRWRWR.', 'R......W', '.h....h.', '..h..h..'])

  // ---- stage helpers -------------------------------------------------------------------------
  const edgeX = (s, x) => clamp(x, 10, s.W - 10)
  function openSpot(s, x, hw) {
    const blocks = s.fix.map((f) => [f.x - 4, f.x + f.w + 4])
    const ok = (c) => c - hw >= 4 && c + hw <= s.W - 4 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 3) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 4, s.W - hw - 4)
  }
  /** x moved so a body hw wide doesn't sit on the parked tank. */
  function clearOfVehicle(s, x, hw) {
    const sl = s.data.vehicle
    if (!sl || sl.dead || Math.abs(sl.x - x) >= hw + 22) return x
    const side = x >= sl.x ? 1 : -1
    const nx = sl.x + side * (hw + 24)
    return nx > hw && nx < s.W - hw ? nx : sl.x - side * (hw + 24)
  }
  const engaged = (s, now) => now - s.data.clickAt < 9000 || now - s.data.grabAt < 9000 || (s.cursor && now - s.cursor.since < 2500) || keyed(s, now)
  // the keyboard is the game's (armed by a click on a character), or a game key went down lately
  const keyed = (s, now) => now - (s.keyAt ?? -1e9) < 9000
  const keyDir = (s) => (s.keys?.has('right') ? 1 : 0) - (s.keys?.has('left') ? 1 : 0)
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0 // the stage reaches a little above the bar
  const later = (s, ms, fn) => s.data.queue.push({ at: performance.now() + ms, fn })
  function nearest(list, x) {
    let best = null
    for (const a of list) if (!best || Math.abs(a.x - x) < Math.abs(best.x - x)) best = a
    return best
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  function callout(s, text, x, white) {
    const d = s.data
    d.calls.push({ text, x, at: performance.now(), life: 1900, set: white ? SMALLW : SMALL })
    if (d.calls.length > 3) d.calls.shift()
    s.poke()
  }
  function banner(s, text) {
    s.data.banner = { text, at: performance.now(), hold: 2.4 }
    s.poke()
  }
  const SCREAMS = ['Waaah!', 'AIEEE!', 'Help!', 'Mama!', 'Run!!', 'Uwaaa!']
  const DEATH = ['Aaaargh!', 'AAAAH!', 'Gyaaa!', 'Nooo!']
  const TALK = [
    ['Is it lunch yet?', 'We just ate!'],
    ['They say Marco is near.', 'Pfft. One guy?'],
    ['My boots are full of sand.', 'Mine have a crab.'],
    ['Morden wants it shiny.', 'Then you polish it.'],
    ['I joined for the curry.', 'Same.'],
    ['Did you hear that?', '...nah.'],
    ['Nice day for a war.', 'Every day is.'],
  ]
  // one voice at a time in any one spot, so two screams never print over each other
  const SHOUTS = []
  function shout(s, text, x, y, color = '#ffffff', life = 1.4) {
    const now = performance.now()
    for (const k of SHOUTS) if (now - k.at < 700 && Math.abs(k.x - x) < 8 + 3 * (k.n + text.length)) return
    SHOUTS.push({ at: now, x, n: text.length })
    if (SHOUTS.length > 6) SHOUTS.shift()
    s.say(text, x, Math.max(0, y), { color, life, vy: -3 })
  }

  // ---- explosions ---------------------------------------------------------------------------------
  class Boom {
    constructor(x, y, size) {
      this.x = x
      this.y = y
      this.t = 0
      this.z = 7
      this.prop = true
      const n = [3, 6, 10][size]
      const R = [3, 5, 7][size]
      this.puffs = []
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const d = i ? rand(0.3, 1.3) * R : 0
        this.puffs.push({
          dx: Math.cos(a) * d,
          dy: Math.sin(a) * d * 0.6 - (i ? rand(0, R * 0.8) : 0),
          r: clamp(Math.round(R * rand(0.65, 1.1)) - (i ? 1 : 0), 2, 10),
          delay: i ? rand(0, 0.05 * n) : 0,
        })
      }
      this.life = 0.9 + 0.05 * n
    }
    update(dt) {
      this.t += dt
      if (this.t > this.life) this.dead = true
      return FAST
    }
    draw(c) {
      for (const p of this.puffs) {
        const a = this.t - p.delay
        if (a < 0 || a > 0.88) continue
        const img = a < 0.05 ? FLASH[Math.max(0, Math.round(p.r * 0.8) - 1)] : a < 0.34 ? FIRE[clamp(Math.round(p.r * (0.8 + a)), 1, 10) - 1] : SMOKE[clamp(Math.round(p.r * (1.15 - (a - 0.34))), 1, 10) - 1]
        c.drawImage(img, Math.round(this.x + p.dx - img.width / 2), Math.round(this.y + p.dy - a * 18 - img.height / 2))
      }
    }
  }
  function explode(s, x, y, size, friendly, dmg = 6) {
    const d = s.data
    const R = [11, 15, 21][size]
    s.spawn(new Boom(x, Math.min(y, FLOOR - [3, 5, 7][size]), size))
    for (let i = 0; i < 3 + size * 3; i++) s.particle({ img: px(pick(['k', 'g', 'f', 'n'])), x, y: Math.min(y, FLOOR - 3), vx: rand(-60, 60), vy: rand(-110, -40), g: 300, life: rand(0.5, 0.9), fade: true })
    if (friendly) {
      for (const r of d.rebels) if (r.alive && !r.held && Math.abs(r.x - x) < R + 5 && y > r.y - r.top() - 8) r.hurt('blast', Math.sign(r.x - x) || 1)
      const b = d.boss
      if (b && b.alive && Math.abs(b.x - x) < R + b.hw) b.hurt(dmg)
    } else {
      for (const h of d.heroes) if (Math.abs(h.x - x) < R && h.vulnerable() && y > h.y - 32) h.die(Math.sign(h.x - x) || 1)
      if (d.vehicle && d.vehicle.pilot && Math.abs(d.vehicle.x - x) < R + 16) d.vehicle.hurt(2)
    }
    for (const r of d.rebels) if (r.alive && !r.aware && Math.abs(r.x - x) < 120) r.notice(performance.now())
  }

  // ---- shots and grenades ---------------------------------------------------------------------------
  const BLAST = { rocket: [1, 5], shell: [1, 6], gshell: [1, 0] }
  class Shot {
    constructor(s, kind, x, y, vx, vy, friendly) {
      Object.assign(this, { s, kind, x, y, vx, vy, friendly })
      this.t = 0
      this.z = 6
      this.moving = true
      this.dir = vx >= 0 ? 1 : -1
    }
    update(dt, now, s) {
      const d = s.data
      const k = this.kind
      this.t += dt
      if (k === 'rocket') {
        this.vx = this.dir * Math.min(290, Math.abs(this.vx) + 520 * dt)
        if (Math.random() < 0.7) s.particle({ img: SMOKE[Math.random() < 0.5 ? 0 : 1], x: this.x - this.dir * 5 - 2, y: this.y - 2, vy: -8, life: 0.4, fade: true })
      }
      if (k === 'shell') this.vy += 70 * dt
      if (k === 'gshell') this.vy += 300 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.x < -12 || this.x > s.W + 12 || this.t > 4) {
        this.dead = true
        return FAST
      }
      if (this.friendly) {
        for (const r of d.rebels)
          if (r.alive && !r.held && r.hitBy(this.x, this.y)) {
            this.impact(s, () => r.hurt('shot', this.dir))
            return FAST
          }
        const b = d.boss
        if (b && b.alive && b.hitBy(this.x, this.y)) {
          this.impact(s, () => b.hurt(k === 'fat' ? 2 : 1))
          return FAST
        }
      } else {
        for (const h of d.heroes)
          if (h.vulnerable() && h.hitBy(this.x, this.y)) {
            if (BLAST[k]) this.impact(s)
            else {
              this.dead = true
              h.die(this.dir)
            }
            return FAST
          }
        const sl = d.vehicle
        if (sl && sl.pilot && sl.hitBy(this.x, this.y)) {
          if (BLAST[k]) this.impact(s)
          else {
            this.dead = true
            sl.hurt(1)
            burst(s, this.x, this.y, 4, ['L', 'W', 'G'])
          }
          return FAST
        }
      }
      if (this.y >= FLOOR - 1) {
        if (BLAST[k]) this.impact(s)
        else {
          this.dead = true
          burst(s, this.x, FLOOR - 1, 3, ['T', 't'])
        }
      }
      return FAST
    }
    impact(s, hitFn) {
      this.dead = true
      const b = BLAST[this.kind]
      if (b) explode(s, this.x, this.y, b[0], this.friendly, b[1])
      else {
        hitFn?.()
        burst(s, this.x, this.y, 3, ['W', 'L'])
      }
    }
    draw(c) {
      const k = this.kind
      if (k === 'rocket') c.drawImage(ROCKETO[this.dir], Math.round(this.x) - 4, Math.round(this.y) - 3)
      else {
        const img = (this.dir > 0 ? BUL : BULM)[k]
        c.drawImage(img, Math.round(this.x - img.width / 2), Math.round(this.y - img.height / 2))
      }
    }
  }
  class Grenade {
    constructor(s, x, y, vx, vy, friendly) {
      Object.assign(this, { s, x, y, vx, vy, friendly })
      this.b = 0
      this.t = 0
      this.z = 6
      this.moving = true
    }
    update(dt, now, s) {
      this.t += dt
      this.vy += 420 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.x < 4 || this.x > s.W - 4) {
        this.vx = -this.vx * 0.5
        this.x = clamp(this.x, 4, s.W - 4)
      }
      const d = s.data
      if (this.friendly) {
        for (const r of d.rebels) if (r.alive && r.aware && !r.held && Math.abs(r.x - this.x) < 5 && this.y > r.y - 22) return this.boom(s)
        if (d.boss && d.boss.alive && d.boss.hitBy(this.x, this.y)) return this.boom(s)
      }
      if (this.y >= FLOOR - 2) {
        this.y = FLOOR - 2
        if (this.b === 0 && this.vy > 60) {
          this.vy = -this.vy * 0.35
          this.vx *= 0.55
          this.b = 1
        } else return this.boom(s)
      }
      return FAST
    }
    boom(s) {
      this.dead = true
      explode(s, this.x, FLOOR - 4, 1, this.friendly, 6)
      return FAST
    }
    draw(c) {
      c.drawImage(NADE[Math.floor(this.t * 14) % 4], Math.round(this.x) - 2, Math.round(this.y) - 3)
    }
  }
  /** A grenade lobbed from (x, y) to land near tx. */
  function lob(s, x, y, tx, friendly) {
    const vy = -150
    const tof = 0.8
    s.spawn(new Grenade(s, x, y, clamp((tx - x) / tof, -190, 190), vy, friendly))
  }

  // ---- the hero and partner ------------------------------------------------------------------------------
  const SPEED = 64
  const ONFOOT = ['stand', 'run', 'fire', 'knife', 'throw', 'jump', 'win']
  class Hero {
    constructor(s, who, x) {
      this.s = s
      this.who = who
      this.x = x
      this.y = FLOOR
      this.vx = 0
      this.vy = 0
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.rt = 0
      this.weapon = 'pistol'
      this.ammo = 0
      this.bombs = 10
      this.cd = 0
      this.inv = 0
      this.fatUntil = 0
      this.food = 0
      this.steps = []
      this.z = 5
      this.grabbable = true
      this.clicks = []
      this.decideAt = 0
      this.idleAt = 0
      this.lookAt = 0
      this.vehicle = null
      this.shots = 0
      this.shotT = 0
      this.flashT = 0
      this.restT = 0
      this.resting = false
      this.asleep = false
      this.moving = false
    }
    get fat() {
      return this.who === 'lead' && this.fatUntil > performance.now()
    }
    get set() {
      return this.who === 'partner' ? HT : this.fat ? HF : HM
    }
    get onFoot() {
      return ONFOOT.includes(this.state)
    }
    vulnerable() {
      return this.inv <= 0 && ONFOOT.includes(this.state)
    }
    hitBy(x, y) {
      return Math.abs(x - this.x) < (this.fat ? 7 : 5) && y > this.y - 25 && y < this.y + 1
    }
    hit(x, y) {
      if (['tank', 'board', 'dead', 'leave'].includes(this.state)) return false
      const top = this.state === 'sit' ? 22 : 29
      return Math.abs(x - this.x) < 9 && y > this.y - top && y < this.y + 2
    }

    // -- moves --
    go(x) {
      this.tx = edgeX(this.s, x)
      if (Math.abs(this.tx - this.x) < 2) return false
      this.state = 'run'
      this.t = 0
      return true
    }
    stand() {
      this.state = 'stand'
      this.t = 0
    }
    next() {
      while (this.steps.length) {
        const st = this.steps.shift()
        if (st.k === 'go' && this.go(st.x)) return true
        if (st.k === 'face') this.dir = st.dir
        if (st.k === 'fire') {
          if (st.dir) this.dir = st.dir
          this.fire()
          return true
        }
        if (st.k === 'board' && this.board(st.vehicle)) return true
        if (st.k === 'perch' && this.perch(st.vehicle)) return true
        if (st.k === 'sitcamp') {
          this.state = 'sit'
          this.y = FLOOR
          this.restT = 0
          this.camp = st.camp
          st.camp.seat = true
          st.camp.light()
          return true
        }
        if (st.k === 'win') {
          this.state = 'win'
          this.t = 0
          return true
        }
      }
      return false
    }
    fire() {
      this.state = 'fire'
      this.t = 0
      const w = this.weapon
      this.shots = w === 'pistol' ? 2 : w === 'H' ? Math.min(9, this.ammo) : 1
      this.gap = w === 'pistol' ? 0.2 : w === 'H' ? 0.075 : 0.3
      this.shotT = 0.03
      this.flashT = 0
      return true
    }
    shoot(s) {
      const w = this.weapon
      const f = this.set[w].fire[0]
      const mx = this.x + this.dir * f.mx
      const my = this.y + f.my
      if (w === 'pistol') s.spawn(new Shot(s, this.fat ? 'fat' : 'pistol', mx, my, this.dir * 260, 0, true))
      else if (w === 'H') {
        s.spawn(new Shot(s, 'hmg', mx, my + rand(-1, 1), this.dir * 330, rand(-10, 10), true))
        this.ammo--
      } else {
        s.spawn(new Shot(s, 'rocket', mx, my, this.dir * 70, 0, true))
        this.ammo--
      }
      this.flashT = w === 'H' ? 0.05 : 0.07
      if (w !== 'pistol' && this.ammo <= 0) {
        this.weapon = 'pistol'
        this.ammo = 0
        this.shots = 0
      }
    }
    knife() {
      this.state = 'knife'
      this.t = 0
      this.struck = false
    }
    throwG(tx) {
      if (this.bombs <= 0) return false
      this.state = 'throw'
      this.t = 0
      this.thrown = false
      this.throwX = tx ?? this.x + this.dir * 70
      this.bombs--
      return true
    }
    jump(vx = 0) {
      this.state = 'jump'
      this.vy = this.fat ? -100 : -125
      this.vx = vx
      this.t = 0
    }
    die(dir) {
      if (!this.vulnerable()) return
      const s = this.s
      this.state = 'dead'
      this.t = 0
      this.vx = dir * 45
      this.y = FLOOR
      this.steps = []
      s.data.deathAt = performance.now()
      burst(s, this.x, this.y - 14, 10, ['R', 'r', 'W', 'L'])
      shout(s, pick(['Uwaaah!', 'Aaagh!', 'Gwaah!']), this.x, this.y - 36, '#ffd0c0', 1.2)
    }
    board(sl) {
      if (!sl || sl.dead || sl.pilot || sl.state !== 'parked' || this.who !== 'lead') return false
      this.state = 'board'
      this.t = 0
      this.bx0 = this.x
      this.by0 = this.y
      this.target = sl
      this.dir = Math.sign(sl.x - this.x) || this.dir
      sl.reserved = this
      return true
    }
    perch(sl) {
      if (!sl || sl.dead || sl.pilot || sl.state !== 'parked') return false
      this.state = 'perch'
      this.t = 0
      this.bx0 = this.x
      this.by0 = this.y
      this.target = sl
      return true
    }
    eject() {
      const sl = this.vehicle
      this.state = 'jump'
      this.y = (sl ? sl.y : FLOOR) - 20
      this.vy = -150
      this.vx = sl ? -sl.dir * 40 : 0
      this.dir = sl ? sl.dir : this.dir
      this.vehicle = null
      this.inv = Math.max(this.inv, 0.8)
      this.t = 0
    }
    standUp() {
      const s = this.s
      this.asleep = false
      this.resting = false
      if (this.camp) this.camp.seat = false
      this.camp = null
      if (this.on) {
        this.on.rider = null
        this.on = null
        this.jump(-this.dir * 30)
        this.vy = -90
      } else this.stand()
      s.poke()
    }
    leave() {
      this.steps = []
      this.state = 'leave'
      this.dir = this.x < this.s.W / 2 ? -1 : 1
    }
    take(k) {
      const s = this.s
      const now = performance.now()
      if (k === 'H' || k === 'R') {
        this.weapon = k
        this.ammo = k === 'H' ? 200 : 12
        callout(s, ITEM_LINE[k], this.x)
      } else if (k === 'B') {
        this.bombs += 10
        callout(s, ITEM_LINE.B, this.x)
      } else {
        s.particle({ digits: '500', x: this.x - 6, y: this.y - 34, vy: -10, life: 1 })
        this.food++
        if (this.food >= 3 && this.who === 'lead') {
          this.food = 0
          this.fatUntil = now + 30000
          shout(s, 'Burp!', this.x, this.y - 36, '#ffe9a0')
        } else shout(s, pick(['Yum!', 'Mmm!', 'Tasty!']), this.x, this.y - 36, '#ffe9a0', 1)
      }
    }
    /** The user (or a click on a foe) sends him at f. */
    attack(f) {
      if (!['stand', 'run', 'fire', 'win'].includes(this.state)) return
      this.steps = []
      const dx = f.x - this.x
      this.dir = Math.sign(dx) || this.dir
      if (!f.isBoss && Math.abs(dx) < f.hw + 14) this.knife()
      else this.fire()
    }

    // -- user --
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.clickAt = now
      this.clicks = this.clicks.filter((t) => now - t < 2500)
      this.clicks.push(now)
      if (this.clicks.length >= 5) {
        this.clicks.length = 0
        supplyDrop(s, this)
        return
      }
      if (this.state === 'sit') {
        this.standUp()
        shout(s, 'Hm?', this.x, this.y - 34, '#ffe9a0', 1)
        return
      }
      if (!['stand', 'run', 'fire'].includes(this.state)) return
      this.steps = []
      if (!this.throwG()) this.knife()
    }
    onDblClick() {
      if (['stand', 'run', 'fire'].includes(this.state)) this.jump(this.dir * 30)
    }
    grab(p) {
      if (!['stand', 'run', 'fire', 'win', 'sit', 'knife', 'throw'].includes(this.state)) return
      if (this.state === 'sit') this.standUp()
      this.s.data.grabAt = performance.now()
      this.steps = []
      this.state = 'held'
      this.t = 0
      this.drag(p)
    }
    drag(p) {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      const nx = clamp(p.x, 8, this.s.W - 8)
      if (Math.abs(nx - this.x) > 1.5) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.y = clamp(p.y + 26, 24 - SPILL, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      // dropped in by the player, the way a new life drops in
      const sl = this.s.data.vehicle
      if (this.who === 'lead' && sl && sl.state === 'parked' && !sl.pilot && Math.abs(sl.x - this.x) < 16) {
        this.state = 'stand'
        this.board(sl)
        return
      }
      this.state = 'drop'
      this.vy = 20
      this.t = 0
    }

    update(dt, now, s) {
      const awake = s.lively(now)
      this.t += dt
      this.cd -= dt
      this.flashT -= dt
      if (this.inv > 0) this.inv -= dt
      this.moving = !['stand', 'sit', 'tank'].includes(this.state)
      if (this === s.data.lead) this.keySteer(dt, s)
      switch (this.state) {
        case 'run': {
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          const step = (this.fat ? 40 : SPEED) * dt
          this.rt += dt
          if (Math.abs(dx) <= step) {
            this.x = this.tx
            this.stand()
            if (!this.next() && awake) this.think(now, s, awake)
          } else this.x += this.dir * step
          if (this.state === 'run' && awake && !engaged(s, now) && !this.steps.length) this.reflex(now, s)
          return FAST
        }
        case 'fire': {
          while (this.shots > 0 && this.t >= this.shotT) {
            this.shoot(s)
            this.shots--
            this.shotT += this.gap
          }
          if (this.shots <= 0 && this.t > this.shotT + 0.08) {
            this.cd = this.weapon === 'R' ? 0.8 : this.weapon === 'H' ? 0.25 : 0.4
            this.stand()
            this.next()
          }
          return FAST
        }
        case 'knife':
          if (!this.struck && this.t > 0.1) {
            this.struck = true
            this.strike(s)
          }
          if (this.t > 0.36) {
            this.stand()
            this.next()
          }
          return FAST
        case 'throw':
          if (!this.thrown && this.t > 0.16) {
            this.thrown = true
            lob(s, this.x + this.dir * 2, this.y - 28, this.throwX, true)
          }
          if (this.t > 0.42) {
            this.stand()
            this.next()
          }
          return FAST
        case 'jump':
        case 'drop': {
          // a floaty jump, as in the arcade, that peaks inside the headroom above the bar
          this.vy += (this.state === 'drop' ? 360 : 420) * dt
          this.x = edgeX(s, this.x + this.vx * dt)
          this.y += this.vy * dt
          if (this.y >= FLOOR && this.vy > 0) {
            this.y = FLOOR
            this.vx = 0
            if (this.state === 'drop' || this.fat) burst(s, this.x, FLOOR - 1, 6, ['T', 't', 'X'])
            this.stand()
            this.next()
          }
          return FAST
        }
        case 'dead': {
          this.vx *= Math.pow(0.05, dt)
          this.x = edgeX(s, this.x + this.vx * dt)
          if (this.t > 2.1) {
            // a new life drops in from the top, back to the pistol
            this.state = 'drop'
            this.t = 0
            this.y = -6
            this.vy = 30
            this.inv = 2.6
            this.weapon = 'pistol'
            this.ammo = 0
            this.bombs = 10
            this.fatUntil = 0
          }
          return FAST
        }
        case 'board':
        case 'perch': {
          const sl = this.target
          const u = clamp(this.t / 0.5, 0, 1)
          const tx = this.state === 'board' ? sl.x - sl.dir * 3 : sl.x - sl.dir * 14
          const ty = this.state === 'board' ? sl.y - 18 : sl.y - 10
          this.x = this.bx0 + (tx - this.bx0) * u
          this.y = this.by0 + (ty - this.by0) * u - 30 * u * (1 - u)
          if (sl.dead || (this.state === 'board' && sl.pilot)) {
            this.state = 'drop'
            this.vy = 0
            return FAST
          }
          if (u >= 1) {
            if (this.state === 'board') {
              this.state = 'tank'
              this.vehicle = sl
              sl.enter(this)
            } else {
              this.state = 'sit'
              this.restT = 0
              this.on = sl
              sl.rider = this
              this.dir = -sl.dir
            }
          }
          return FAST
        }
        case 'tank': {
          const sl = this.vehicle
          if (!sl || sl.dead || sl.pilot !== this) {
            this.eject()
            return FAST
          }
          this.x = sl.x
          this.y = sl.y
          this.dir = sl.dir
          return Infinity
        }
        case 'win':
          if (this.t > 3.2) {
            this.stand()
            this.decideAt = now + 800
          }
          return this.t < 1.6 ? FAST : 400
        case 'held':
          return FAST
        case 'leave': {
          this.x += this.dir * SPEED * 1.1 * dt
          this.rt += dt
          if (this.x < -16 || this.x > s.W + 16) this.dead = true
          return FAST
        }
        case 'sit': {
          if (this.on) {
            this.x = this.on.x - this.on.dir * 14
            this.y = this.on.y - 10
            if (this.on.dead || this.on.pilot) this.standUp()
          }
          if (awake) {
            this.standUp()
            return FAST
          }
          this.restT += dt
          if (this.restT < 2.4) return SLOW
          this.asleep = true
          return Infinity
        }
      }
      return this.think(now, s, awake)
    }

    /** A/D held: run that way at once (and keep moving while firing, or steer a jump). */
    keySteer(dt, s) {
      const kx = keyDir(s)
      if (kx && ['stand', 'run', 'win', 'sit'].includes(this.state)) {
        if (this.state === 'sit') this.standUp()
        this.steps = []
        this.dir = kx
        this.tx = edgeX(s, this.x + kx * 24)
        if (this.state !== 'run') this.t = 0
        this.state = Math.abs(this.tx - this.x) > 0.5 ? 'run' : 'stand'
        this.keyRun = true
      } else if (kx && ['fire', 'knife', 'throw'].includes(this.state)) {
        // run and gun
        this.dir = kx
        this.x = edgeX(s, this.x + kx * (this.fat ? 40 : SPEED) * dt)
        this.rt += dt
        this.keyRun = true
      } else if (kx && this.state === 'jump') {
        this.vx = kx * 50
      } else if (this.keyRun && !kx) {
        this.keyRun = false
        if (this.state === 'run') this.tx = this.x
      }
    }
    think(now, s, awake) {
      if (!awake) return this.restThink(now, s)
      this.resting = false
      this.asleep = false
      if (this.next()) return FAST
      const user = engaged(s, now)
      if (!user && this.reflex(now, s)) return FAST
      if (s.cursor && user && now > this.lookAt && Math.abs(s.cursor.x - this.x) > 6) {
        const want = s.cursor.x > this.x ? 1 : -1
        if (want !== this.dir) {
          this.dir = want
          this.lookAt = now + 500
        }
      }
      if (user) return SLOW
      return this.auto(now, s)
    }
    reflex(now, s) {
      for (const a of s.actors) {
        if (a.dead || a.friendly !== false || a.seen) continue
        if (a instanceof Shot) {
          const toward = Math.sign(a.vx) === Math.sign(this.x - a.x)
          if (toward && Math.abs(a.x - this.x) < 34 && a.y > this.y - 26 && a.kind !== 'gshell') {
            a.seen = true
            if (Math.random() < 0.68 && this.onFoot) {
              this.jump(this.state === 'run' ? this.dir * 40 : 0)
              return true
            }
          }
        } else if (a instanceof Grenade && a.vy > 0 && Math.abs(a.x - this.x) < 45) {
          a.seen = true
          if (Math.random() < 0.75 && this.onFoot) {
            this.steps = []
            this.go(this.x + (Math.sign(this.x - a.x) || 1) * 48)
            return true
          }
        }
      }
      return false
    }
    pickFoe(s) {
      const d = s.data
      let best = null
      let bd = 1e9
      for (const r of d.rebels) {
        if (!r.alive || !r.hostile() || !r.onField(s)) continue
        const dd = Math.abs(r.x - this.x)
        if (dd < bd) {
          bd = dd
          best = r
        }
      }
      const b = d.boss
      if (b && b.alive && b.onField(s) && b.state !== 'leave' && (!best || Math.abs(b.x - this.x) - 40 < bd)) best = b
      if (!best)
        for (const r of d.rebels) if (r.alive && r.state === 'flee' && !r.spare && r.onField(s) && Math.abs(r.x - this.x) < 120) return r
      return best
    }
    engage(f, s) {
      const dx = f.x - this.x
      const adx = Math.abs(dx)
      const side = Math.sign(dx) || this.dir
      this.dir = side
      if (adx < f.hw + 14) {
        if (f.isBoss) this.go(this.x - side * 70)
        else this.knife()
        return
      }
      if (adx > 150) {
        this.go(f.x - side * rand(85, 115))
        return
      }
      if (this.bombs > 0 && adx > 40 && adx < 120 && Math.random() < (f.isBoss ? 0.3 : 0.14)) {
        this.throwG(f.x)
        return
      }
      if (this.cd <= 0) this.fire()
    }
    auto(now, s) {
      const d = s.data
      if (now < this.decideAt) return SLOW
      this.decideAt = now + rand(240, 460)
      const foe = this.pickFoe(s)
      if (foe) {
        this.engage(foe, s)
        return FAST
      }
      const pow = nearest(
        d.pows.filter((p) => p.state === 'tied' && p.onField(s)),
        this.x,
      )
      if (pow && Math.abs(pow.x - this.x) > 3) {
        this.go(pow.x)
        return FAST
      }
      const it = nearest(
        d.items.filter((i) => i.landed && !i.held && i.onField(s)),
        this.x,
      )
      if (it) {
        this.go(it.x)
        return FAST
      }
      const sl = d.vehicle
      if (this.who === 'lead' && d.wantVehicle && sl && sl.state === 'parked' && !sl.reserved) {
        if (Math.abs(sl.x - this.x) > 16) this.go(sl.x - (Math.sign(sl.x - this.x) || 1) * 12)
        else this.board(sl)
        return FAST
      }
      const idle = nearest(
        d.rebels.filter((r) => r.alive && !r.aware && r.onField(s) && r.state !== 'walk'),
        this.x,
      )
      if (idle && now > d.sneakAt) {
        const side = Math.sign(idle.x - this.x) || 1
        const adx = Math.abs(idle.x - this.x)
        if (!this.lobbed && this.bombs > 0 && adx > 60 && adx < 120 && Math.random() < 0.3) {
          this.lobbed = true
          this.dir = side
          this.throwG(idle.x)
        } else if (adx > 18) this.go(idle.x - side * 14)
        else {
          this.dir = side
          this.knife()
        }
        return FAST
      }
      this.lobbed = false
      if (this.who === 'partner') {
        const m = d.lead
        if (now > d.partnerUntil && !d.rebels.some((r) => r.alive)) {
          shout(s, 'See ya, Marco!', this.x, 1, '#a8e6a0', 1.8)
          this.leave()
          return FAST
        }
        if (m && Math.abs(m.x - this.x) > 50) this.go(m.x - (Math.sign(m.x - this.x) || 1) * 26)
        return SLOW
      }
      if (now > this.idleAt) {
        this.idleAt = now + rand(2600, 5200)
        const r = Math.random()
        if (r < 0.45) this.go(openSpot(s, rand(40, s.W - 40), 10))
        else if (r < 0.75) this.dir = -this.dir
        else if (r < 0.85) this.jump()
      }
      return SLOW
    }
    restThink(now, s) {
      const d = s.data
      if (this.who === 'partner') {
        this.leave()
        return FAST
      }
      if (!this.resting) {
        this.resting = true
        this.steps = []
        const sl = d.vehicle
        if (sl && !sl.dead && sl.state === 'parked' && Math.abs(sl.x - this.x) < 520) {
          const back = clamp(sl.x - sl.dir * 30, 6, s.W - 6)
          this.steps = [{ k: 'go', x: back }, { k: 'perch', vehicle: sl }]
        } else {
          let camp = d.camp
          if (!camp || camp.dead || Math.abs(camp.x - this.x) > 520) {
            if (camp) camp.dead = true
            camp = d.camp = s.spawn(new Camp(s, openSpot(s, this.x, 22), false))
          }
          let side = this.x < camp.x ? -1 : 1
          if (camp.x + side * 13 < 8 || camp.x + side * 13 > s.W - 8) side = -side
          camp.seatX = camp.x + side * 13
          this.steps = [{ k: 'go', x: camp.seatX }, { k: 'face', dir: -side }, { k: 'sitcamp', camp }]
        }
      }
      if (this.next()) return FAST
      if (this.state === 'stand') {
        this.state = 'sit'
        this.restT = 0
      }
      return FAST
    }
    strike(s) {
      const d = s.data
      for (const r of d.rebels) {
        const ahead = (r.x - this.x) * this.dir
        if (r.alive && !r.held && ahead > -4 && ahead < 22) r.hurt('cut', this.dir)
      }
      const b = d.boss
      if (b && b.alive && (b.x - this.x) * this.dir > -4 && Math.abs(b.x - this.x) < b.hw + 16) b.hurt(4)
    }

    frame() {
      const S = this.set
      const W = S[this.weapon]
      switch (this.state) {
        case 'run':
        case 'leave':
          return W.run[Math.floor(this.rt * 11) % 6]
        case 'fire':
          return W.fire[this.flashT > 0 ? 1 : 0]
        case 'knife':
          return S.knife[this.t < 0.1 ? 0 : this.t < 0.22 ? 1 : 2]
        case 'throw':
          return S.throw[this.t < 0.1 ? 0 : this.t < 0.18 ? 1 : 2]
        case 'jump':
        case 'board':
        case 'perch':
          return W.jump
        case 'dead':
          return S.dead[this.t < 0.12 ? 0 : this.t < 0.42 ? 1 : 2]
        case 'drop':
        case 'held':
          return S.held[Math.floor(this.t * 6) % 2]
        case 'win':
          return S.win[this.t < 1.6 ? Math.floor(this.t * 4) % 2 : 0]
        case 'sit':
          return S.sit[this.restT > 2.2 ? 1 : 0]
        default:
          return W.stand[Math.floor(performance.now() / 650) % 2]
      }
    }
    draw(c) {
      if (this.state === 'tank') return
      if (this.state === 'dead' && this.t > 1.5 && Math.floor(this.t * 12) % 2) return
      if (this.inv > 0 && this.state !== 'dead' && Math.floor(this.inv * 14) % 2) return
      const f = this.frame()
      drawFr(c, f, HX, this.x, this.y, this.dir)
      if (this.state === 'fire' && this.flashT > 0) {
        const m = MUZ[this.weapon === 'pistol' ? 0 : 1]
        const mx = this.x + this.dir * f.mx
        c.drawImage(this.dir > 0 ? m : MUZL[this.weapon === 'pistol' ? 0 : 1], Math.round(mx - (this.dir > 0 ? 1 : m.width - 1)), Math.round(this.y + f.my - m.height / 2))
      }
      if (this.state === 'knife' && this.t >= 0.1 && this.t < 0.26) c.drawImage(SLASH[this.dir], Math.round(this.x + this.dir * 8 - (this.dir > 0 ? 0 : SLASH.w)), Math.round(this.y - 22))
    }
  }

  // ---- the rebel army ----------------------------------------------------------------------------
  const UNAWARE = ['patrol', 'guard', 'cook', 'sun', 'sleep', 'coward']
  class Rebel {
    constructor(s, x, dir, role) {
      this.s = s
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.role = role
      this.alive = true
      this.aware = !UNAWARE.includes(role)
      this.state = this.aware ? 'run' : 'walk'
      this.t = 0
      this.rt = rand(0, 1)
      this.hw = 6
      this.z = 3 + Math.random() * 0.5
      this.moving = true
      this.grabbable = true
      this.brave = role === 'coward' || role === 'cook' || role === 'sun' ? 0 : Math.random()
      this.noticeR = rand(55, 95)
      this.spare = Math.random() < 0.6
      this.hat = role === 'cook' ? 'chef' : role === 'sun' ? 'bare' : 'helmet'
      this.tx = x
      this.vx = 0
      this.vy = 0
      this.fireAt = 0
      this.turnAt = 0
      this.panicAt = 0
      this.curiousAt = 0
      this.talkUntil = 0
      this.nextAt = 0
    }
    get F() {
      return this.hat === 'chef' ? RFC : this.hat === 'bare' ? RFS : RF
    }
    top() {
      if (!this.alive) return this.dk === 'blast' && !this.landed ? 20 : 8
      return this.state === 'sun' ? 7 : this.state === 'sleep' || this.state === 'dazed' ? 17 : 25
    }
    hitBy(x, y) {
      const lying = this.state === 'sun'
      return Math.abs(x - this.x) < (lying ? 11 : 5) && y > this.y - this.top() && y < this.y + 1
    }
    hit(x, y) {
      return this.alive && Math.abs(x - this.x) < (this.state === 'sun' ? 13 : 9) && y > this.y - this.top() - 4 && y < this.y + 2
    }
    hostile() {
      return this.alive && this.aware && !['flee', 'held', 'fall'].includes(this.state)
    }
    onField(s) {
      return this.x > 2 && this.x < s.W - 2
    }
    // -- events --
    notice(now) {
      if (this.aware || !this.alive) return
      const s = this.s
      this.aware = true
      this.state = 'shock'
      this.t = 0
      const h = nearest(s.data.heroes, this.x)
      if (h) this.dir = Math.sign(h.x - this.x) || this.dir
      s.particle({ img: BUBBLE['!'], x: this.x - 2, y: this.y - 36, vy: -4, life: 0.8 })
      if (this.hat !== 'bare') s.particle({ img: this.hat === 'chef' ? FLASH[2] : HELMET, x: this.x - 3, y: this.y - 26, vx: -this.dir * 10, vy: -70, g: 260, life: 0.6 })
      if (this.state === 'shock' && Math.random() < 0.45) shout(s, pick(['!?', 'Huh?!', 'Eek!', 'Marco!!', 'Wha-?!']), this.x, this.y - 36, '#ffffff', 1.1)
      if (this.role === 'sun') s.spawn(new Towel(this.x))
      if (this.buddy && this.buddy.alive && !this.buddy.aware) {
        const b = this.buddy
        later(s, 260, () => b.notice(performance.now()))
      }
      if (this.pow && this.pow.state === 'tied') this.pow.guardGone = true
    }
    flee() {
      if (!this.alive) return
      this.aware = true
      this.state = 'flee'
      this.t = 0
      this.screamed = false
    }
    daze() {
      if (!this.alive) return
      this.aware = true
      this.state = 'dazed'
      this.t = 0
      this.y = FLOOR
    }
    hurt(kind, dir) {
      if (!this.alive) return
      const s = this.s
      const d = s.data
      this.alive = false
      this.aware = true
      this.dk = kind
      this.t = 0
      this.state = 'dying'
      this.held = false
      this.landed = kind !== 'blast'
      this.moving = true
      this.grabbable = false
      this.dir = -dir
      this.vx = dir * (kind === 'blast' ? rand(50, 90) : 30)
      this.vy = kind === 'blast' ? -rand(130, 170) : 0
      d.kills++
      s.particle({ digits: '100', x: this.x - 6, y: this.y - 32, vy: -12, life: 0.9 })
      if (kind === 'blast' || Math.random() < 0.35) shout(s, pick(DEATH), this.x, this.y - 36, '#ffd0c0', 1.1)
      if (this.hat === 'helmet' && Math.random() < 0.5) s.particle({ img: HELMET, x: this.x - 3, y: this.y - 26, vx: dir * 30, vy: -80, g: 260, life: 0.7 })
      // a comrade going down can break the others' nerve
      for (const r of d.rebels) if (r !== this && r.hostile() && Math.abs(r.x - this.x) < 80 && Math.random() < 0.3) later(s, rand(150, 500), () => r.hostile() && r.flee())
    }
    // -- user --
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.clickAt = now
      if (!this.alive) return
      if (!this.aware) {
        // poked while off guard: he jumps out of his skin and runs for it
        this.brave = Math.random() < 0.75 ? 0 : 1
        this.notice(now)
        return
      }
      commandAttack(s, this)
    }
    onDblClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      const h = s.data.lead
      if (h && this.alive && ['stand', 'run', 'fire'].includes(h.state)) {
        h.steps = []
        h.dir = Math.sign(this.x - h.x) || h.dir
        h.throwG(this.x)
      }
    }
    grab(p) {
      if (!this.alive) return
      const s = this.s
      s.data.grabAt = performance.now()
      if (!this.aware) this.notice(performance.now())
      this.state = 'held'
      this.held = true
      this.t = 0
      shout(s, pick(['Waaah!', 'Put me down!', 'Mama!']), this.x, this.y - 36, '#ffffff', 1.2)
      this.drag(p)
    }
    drag(p) {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      const nx = clamp(p.x, 6, this.s.W - 6)
      this.vx = (nx - this.x) * 8
      if (Math.abs(nx - this.x) > 1) this.dir = nx > this.x ? -1 : 1
      this.x = nx
      this.y = clamp(p.y + 24, 24 - SPILL, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      this.held = false
      this.state = 'fall'
      this.vy = -20
      this.vx = clamp(this.vx, -160, 160)
    }

    update(dt, now, s) {
      this.t += dt
      const d = s.data
      const awake = s.lively(now)
      this.moving = true
      if (!this.alive) return this.dying(dt, now, s)
      switch (this.state) {
        case 'walk':
        case 'run': {
          const sp = this.state === 'run' ? 56 : this.role === 'coward' ? 30 : 26
          this.rt += dt
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          if (Math.abs(dx) <= sp * dt) {
            this.x = this.tx
            this.arrive(now)
          } else this.x += this.dir * sp * dt
          if (!this.aware) {
            this.watch(now, s)
            if (this.role === 'coward' && Math.random() < dt * 1.2) s.particle({ img: BUBBLE['♪'], x: this.x + this.dir * 4, y: this.y - 32, vy: -10, life: 0.9, fade: true })
          }
          return FAST
        }
        case 'idle':
          this.moving = false
          this.watch(now, s)
          if (!awake || this.aware) return this.aware ? FAST : Infinity
          if (now > this.nextAt) {
            this.nextAt = now + rand(3000, 6000)
            if (this.role === 'guard' || Math.random() < 0.5) this.dir = -this.dir
            else {
              this.tx = edgeX(s, (this.post ?? this.x) + rand(-40, 40))
              this.state = 'walk'
            }
          }
          return SLOW
        case 'chat':
        case 'cook':
        case 'sun':
        case 'sleep': {
          this.moving = false
          this.watch(now, s)
          if (this.aware) return FAST
          if (!awake) return Infinity
          if (this.state === 'chat' && this.leader) this.chatter(now, s)
          if (this.state === 'sleep' && now > this.nextAt) {
            this.nextAt = now + 2200
            s.particle({ img: ZZ, x: this.x + this.dir * 6, y: this.y - 22, vx: 3, vy: -6, life: 1.6, fade: true })
          }
          if (this.state === 'cook' && now > this.nextAt) {
            this.nextAt = now + rand(2500, 5000)
            if (Math.random() < 0.5) s.particle({ img: BUBBLE['♪'], x: this.x, y: this.y - 34, vy: -8, life: 1, fade: true })
          }
          return this.state === 'cook' || now < this.talkUntil ? 180 : SLOW
        }
        case 'shock': {
          const u = this.t / 0.5
          this.y = FLOOR - 7 * Math.sin(Math.PI * Math.min(1, u))
          if (u >= 1) {
            this.y = FLOOR
            this.state = 'slide'
            this.t = 0
            this.vx = -this.dir * 75
          }
          return FAST
        }
        case 'slide': {
          this.x = clamp(this.x + this.vx * dt, -10, s.W + 10)
          this.vx *= Math.pow(0.03, dt)
          if (Math.random() < 0.5) s.particle({ img: px(pick(['T', 't'])), x: this.x + this.dir * 3, y: FLOOR - 1, vx: -this.vx * 0.2, vy: -rand(5, 15), g: 40, life: 0.35, fade: true })
          if (this.t > 0.42) {
            if (this.brave > 0.4 && this.hat === 'helmet') {
              this.state = 'fight'
              this.fireAt = now + rand(300, 900)
            } else this.flee()
          }
          return FAST
        }
        case 'fight':
          return this.fight(now, s)
        case 'aim':
          this.moving = false
          if (this.t > 0.35) {
            const f = this.F.aim
            s.spawn(new Shot(s, 'rebel', this.x + this.dir * f.mx, this.y + f.my, this.dir * 100, 0, false))
            this.state = 'fire'
            this.t = 0
          }
          return FAST
        case 'fire':
          if (this.t > 0.25) this.state = 'fight'
          return FAST
        case 'throw':
          if (!this.thrown && this.t > 0.16) {
            this.thrown = true
            lob(s, this.x + this.dir * 2, this.y - 27, this.throwX + rand(-10, 10), false)
          }
          if (this.t > 0.45) this.state = 'fight'
          return FAST
        case 'flee': {
          const h = nearest(d.heroes, this.x)
          if (h && now > this.turnAt) {
            const away = Math.sign(this.x - h.x) || this.dir
            if (away !== this.dir) {
              this.dir = away
              this.turnAt = now + 1500
            }
          }
          this.x += this.dir * 84 * dt
          this.rt += dt
          if (!this.screamed) {
            this.screamed = true
            shout(s, pick(SCREAMS), this.x, this.y - 36)
          }
          if (Math.random() < dt * 4) s.particle({ img: SWEAT, x: this.x - this.dir * 4, y: this.y - 28, vx: -this.dir * 20, vy: -20, g: 120, life: 0.5 })
          if (this.x < -18 || this.x > s.W + 18) {
            this.dead = true
            this.gone = true
            this.onGone?.(this.dir)
          }
          return FAST
        }
        case 'held':
          return FAST
        case 'fall': {
          this.vy += 480 * dt
          this.x += this.vx * dt
          this.y += this.vy * dt
          if (this.x < 6 || this.x > s.W - 6) {
            this.vx = -this.vx * 0.5
            this.x = clamp(this.x, 6, s.W - 6)
          }
          if (this.y >= FLOOR) {
            burst(s, this.x, FLOOR - 1, 6, ['T', 't', 'X'])
            for (const r of d.rebels)
              if (r !== this && r.alive && !r.held && Math.abs(r.x - this.x) < 14) {
                if (!r.aware) r.notice(now)
                r.daze()
              }
            this.daze()
          }
          return FAST
        }
        case 'dazed': {
          this.moving = false
          if (Math.random() < dt * 5) s.particle({ img: STAR, x: this.x + rand(-5, 5), y: this.y - 20, vx: rand(-8, 8), vy: -6, life: 0.5, fade: true })
          if (this.t > 1.7) {
            if (this.brave > 0.55 && this.hat === 'helmet') {
              this.state = 'fight'
              this.fireAt = now + 600
            } else this.flee()
          }
          return FAST
        }
      }
      return FAST
    }
    arrive(now) {
      const s = this.s
      if (this.aware) {
        this.state = 'fight'
        this.fireAt = now + rand(300, 1200)
        return
      }
      const r = this.role
      this.post = this.x
      if (r === 'cook') {
        this.state = 'cook'
        const camp = s.data.camp
        if (camp) {
          this.dir = Math.sign(camp.x - this.x) || this.dir
          camp.light()
        }
      } else if (r === 'sun') this.state = 'sun'
      else if (r === 'sleep') this.state = 'sleep'
      else if (r === 'patrol' && this.buddy && this.buddy.alive && !this.buddy.aware && Math.abs(this.buddy.x - this.x) < 34) {
        const b = this.buddy
        this.state = 'chat'
        b.state = 'chat'
        this.dir = Math.sign(b.x - this.x) || 1
        b.dir = -this.dir
        this.leader = true
        this.talk = pick(TALK)
        this.line = 0
        this.lineAt = now + 700
      } else {
        this.state = 'idle'
        this.nextAt = now + rand(2500, 5000)
        if (this.pow) this.dir = Math.sign(this.pow.x - this.x) || this.dir
      }
    }
    chatter(now, s) {
      const b = this.buddy
      if (!b || !b.alive || b.state !== 'chat' || now < this.lineAt) return
      const who = this.line % 2 ? b : this
      shout(s, this.talk[this.line], who.x, who.y - 35, '#cfe59a', 2.6)
      who.talkUntil = now + 1300
      this.line++
      if (this.line >= this.talk.length) {
        this.talk = pick(TALK)
        this.line = 0
        this.lineAt = now + rand(4500, 7500)
      } else this.lineAt = now + 2700
    }
    watch(now, s) {
      const d = s.data
      for (const h of d.heroes) {
        if (!h.onFoot && h.state !== 'tank') continue
        const dx = h.x - this.x
        let R = this.noticeR
        if (this.state === 'sun' || this.state === 'sleep') R = 24
        else if (Math.sign(dx) !== this.dir) R *= 0.55
        if (h.state === 'tank') R += 30
        if (Math.abs(dx) < R) {
          this.notice(now)
          return
        }
      }
      // a cursor hovering right over him makes him curious
      const c = s.cursor
      if (c && now > this.curiousAt && Math.abs(c.x - this.x) < 10 && c.y > this.y - 34 && this.state !== 'sun' && this.state !== 'sleep') {
        this.curiousAt = now + 6000
        this.dir = c.x >= this.x ? 1 : -1
        s.particle({ img: BUBBLE['?'], x: this.x - 2, y: this.y - 36, vy: -4, life: 1 })
      }
    }
    fight(now, s) {
      this.moving = false
      const d = s.data
      const h = nearest(
        d.heroes.filter((q) => q.onFoot || q.state === 'tank'),
        this.x,
      )
      if (!h) {
        if (now > this.nextAt && now - d.deathAt < 1500) {
          this.nextAt = now + 5000
          if (Math.random() < 0.5) shout(s, pick(['Got him!', 'Hah!']), this.x, this.y - 36, '#cfe59a', 1.2)
        }
        return SLOW
      }
      const dx = h.x - this.x
      const adx = Math.abs(dx)
      const side = Math.sign(dx) || this.dir
      if (side !== this.dir && now > this.turnAt) {
        this.dir = side
        this.turnAt = now + 400
      }
      if (h.state === 'tank' && adx < 110 && !this.tankSeen) {
        this.tankSeen = true
        if (this.brave < 0.75) {
          shout(s, pick(["It's the Slug!", 'Tank!!']), this.x, this.y - 36)
          this.flee()
          this.screamed = true
          return FAST
        }
      }
      if (adx < 24 && now > this.panicAt) {
        this.panicAt = now + 3000
        this.state = 'slide'
        this.t = 0
        this.vx = -side * 80
        return FAST
      }
      if (adx > 140) {
        this.state = 'run'
        this.tx = edgeX(s, h.x - side * rand(85, 120))
        return FAST
      }
      if (now > this.fireAt) {
        this.fireAt = now + rand(1400, 2800)
        if (this.role === 'grenadier' || Math.random() < 0.2) {
          this.state = 'throw'
          this.thrown = false
          this.throwX = h.x
        } else this.state = 'aim'
        this.t = 0
        return FAST
      }
      return Math.min(SLOW, this.fireAt - now)
    }
    dying(dt, now, s) {
      this.x = clamp(this.x + this.vx * dt, -20, s.W + 20)
      if (this.dk === 'blast' && !this.landed) {
        this.vy += 420 * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR && this.vy > 0) {
          this.y = FLOOR
          this.landed = true
          this.vx *= 0.3
          this.t = Math.max(this.t, 0.5)
        }
      } else this.vx *= Math.pow(0.05, dt)
      if (this.t > 2.3) this.dead = true
      return FAST
    }
    frame() {
      const F = this.F
      const now = performance.now()
      switch (this.state) {
        case 'walk':
          return F.walk[Math.floor(this.rt * 7) % 4]
        case 'run':
          return F.run[Math.floor(this.rt * 11) % 6]
        case 'idle':
        case 'fight':
          return F.stand[Math.floor(now / 700) % 2]
        case 'chat':
          return F.chat[now < this.talkUntil ? Math.floor(now / 170) % 2 : 0]
        case 'cook':
          return F.cook[this.s.lively(now) ? Math.floor(now / 360) % 2 : 0]
        case 'sun':
          return F.sun
        case 'sleep':
        case 'dazed':
          return F.sleep
        case 'shock':
          return F.shock
        case 'slide':
          return F.slide
        case 'aim':
          return F.aim
        case 'fire':
          return F.fire
        case 'throw':
          return F.throw[this.t < 0.1 ? 0 : this.t < 0.18 ? 1 : 2]
        case 'flee':
          return F.flee[Math.floor(this.rt * 13) % 6]
        case 'held':
        case 'fall':
          return F.held[Math.floor(now / 140) % 2]
        case 'dying':
          if (this.dk === 'blast') return this.landed ? F.dead[2] : F.spin[Math.floor(this.t * 12) % 4]
          return F.dead[this.t < 0.15 ? 0 : this.t < 0.45 ? 1 : 2]
      }
      return F.stand[0]
    }
    draw(c) {
      if (this.state === 'dying' && this.t > 1.7 && Math.floor(this.t * 12) % 2) return
      if (this.state === 'sun') c.drawImage(TOWEL, Math.round(this.x) - 11, FLOOR - 3)
      const f = this.frame()
      drawFr(c, f, RX, this.x, this.y, this.dir)
      if (this.state === 'fire') {
        const g = this.F.aim
        c.drawImage(this.dir > 0 ? MUZ[0] : MUZL[0], Math.round(this.x + this.dir * g.mx - 2), Math.round(this.y + g.my - 3))
      }
    }
  }

  // ---- POWs and items -----------------------------------------------------------------------------
  class Pow {
    constructor(s, x, state) {
      this.s = s
      this.x = x
      this.y = FLOOR
      this.dir = -1
      this.state = state
      this.t = 0
      this.rt = 0
      this.z = 3.4
      this.hw = 6
      this.helpAt = 0
      this.moving = state !== 'tied'
    }
    onField(s) {
      return this.x > 4 && this.x < s.W - 4
    }
    hit(x, y) {
      const top = this.state === 'tied' ? 20 : 27
      return Math.abs(x - this.x) < 10 && y > this.y - top && y < this.y + 2
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      if (this.state === 'tied' || this.state === 'escort') this.free()
      else if (this.state === 'line' || this.state === 'salute') shout(s, pick(['Sir!', 'Thank you, sir!']), this.x, this.y - 34, '#ffe9a0', 1.2)
    }
    free() {
      const s = this.s
      if (this.state !== 'tied' && this.state !== 'escort') return
      this.state = 'freed'
      this.t = 0
      this.moving = true
      for (let i = 0; i < 8; i++) s.particle({ img: pick(ROPE), x: this.x, y: this.y - 10, vx: rand(-50, 50), vy: rand(-90, -30), g: 260, life: 0.7 })
      shout(s, 'Thank you!', this.x, this.y - 35, '#ffe9a0', 1.6)
      const h = nearest(s.data.heroes, this.x)
      if (h) this.dir = Math.sign(h.x - this.x) || this.dir
    }
    give() {
      const s = this.s
      const h = nearest(s.data.heroes, this.x)
      const r = Math.random()
      const kind = this.gift || (r < 0.35 ? 'H' : r < 0.55 ? 'R' : r < 0.72 ? 'B' : pick(['chicken', 'fish', 'banana']))
      const dir = h ? Math.sign(h.x - this.x) || 1 : this.dir
      const it = new Item(s, kind, this.x + dir * 4, this.y - 14, dir * 28, -80)
      s.data.items.push(it)
      s.spawn(it)
    }
    update(dt, now, s) {
      this.t += dt
      const awake = s.lively(now)
      switch (this.state) {
        case 'escort': {
          this.rt += dt
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          if (Math.abs(dx) < 22 * dt) {
            this.x = this.tx
            this.state = 'tied'
            this.moving = false
          } else this.x += this.dir * 22 * dt
          return FAST
        }
        case 'tied': {
          for (const h of s.data.heroes) if (h.onFoot && Math.abs(h.x - this.x) < 8) this.free()
          if (this.state !== 'tied') return FAST
          const c = s.cursor
          if (c && Math.abs(c.x - this.x) < 30 && now > this.helpAt) {
            this.helpAt = now + 7000
            shout(s, pick(['Help!', 'Over here!', 'Untie me!']), this.x, this.y - 33, '#ffe9a0', 1.4)
          }
          if (!awake) return Infinity
          return 380
        }
        case 'freed':
          this.yoff = -6 * Math.sin(Math.PI * Math.min(1, this.t / 0.45))
          if (this.t > 0.5) {
            this.yoff = 0
            this.state = 'salute'
            this.t = 0
          }
          return FAST
        case 'salute':
          if (this.t > 0.7) {
            this.state = 'dig'
            this.t = 0
          }
          return FAST
        case 'dig':
          if (this.t > 0.8 && !this.gave) {
            this.gave = true
            this.give()
          }
          if (this.t > 1.05) {
            this.state = 'bye'
            this.t = 0
          }
          return FAST
        case 'bye':
          if (this.t > 0.5) {
            this.state = 'run'
            this.dir = this.x < s.W / 2 ? -1 : 1
          }
          return FAST
        case 'run':
          this.rt += dt
          this.x += this.dir * 105 * dt
          if (this.x < -16 || this.x > s.W + 16) this.dead = true
          return FAST
        case 'enter': {
          this.rt += dt
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          if (Math.abs(dx) < 95 * dt) {
            this.x = this.tx
            this.state = 'line'
            this.t = 0
            this.moving = false
            const h = s.data.lead
            if (h) this.dir = Math.sign(h.x - this.x) || this.dir
          } else this.x += this.dir * 95 * dt
          return FAST
        }
        case 'line':
          if (now > this.leaveAt || !awake) {
            this.state = 'run'
            this.moving = true
            this.dir = this.x < s.W / 2 ? -1 : 1
            return FAST
          }
          return Math.max(FAST, this.leaveAt - now)
      }
      return FAST
    }
    draw(c) {
      let f
      switch (this.state) {
        case 'escort':
          f = PF.walk[Math.floor(this.rt * 6) % 4]
          break
        case 'tied':
          f = PF.tied[this.s.lively() ? Math.floor(performance.now() / 380) % 2 : 0]
          break
        case 'salute':
        case 'bye':
        case 'line':
          f = this.state === 'line' && this.t < 0.3 ? PF.stand : PF.salute
          break
        case 'dig':
          f = PF.dig[Math.floor(this.t * 8) % 2]
          break
        case 'run':
        case 'enter':
          f = PF.run[Math.floor(this.rt * 12) % 6]
          break
        default:
          f = PF.stand
      }
      drawFr(c, f, PX, this.x, this.y + (this.yoff || 0), this.dir)
    }
  }

  class Item {
    constructor(s, kind, x, y, vx, vy, chute) {
      Object.assign(this, { s, kind, x, y, vx, vy, chute })
      this.landed = false
      this.t = 0
      this.z = 4
      this.grabbable = true
      this.img = ITEM[kind]
      this.moving = true
    }
    onField(s) {
      return this.x > 4 && this.x < s.W - 4
    }
    hit(x, y) {
      return Math.abs(x - this.x) < 9 && y > this.y - this.img.height - 4 && y < this.y + 3
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      const h = nearest(
        s.data.heroes.filter((q) => ['stand', 'run', 'fire', 'win'].includes(q.state)),
        this.x,
      )
      if (h) {
        h.steps = []
        h.go(this.x)
      }
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.held = true
      this.chute = false
      this.drag(p)
    }
    drag(p) {
      if (!this.held) return
      this.s.data.grabAt = performance.now()
      this.x = clamp(p.x, 6, this.s.W - 6)
      this.y = clamp(p.y + 5, 8, FLOOR)
    }
    drop() {
      if (!this.held) return
      this.held = false
      this.landed = false
      this.vx = 0
      this.vy = 0
    }
    update(dt, now, s) {
      this.t += dt
      if (this.held) return FAST
      if (!this.landed) {
        this.moving = true
        this.vy += (this.chute ? 0 : 380) * dt
        if (this.chute) this.vy = 20
        this.x = clamp(this.x + this.vx * dt, 6, s.W - 6)
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          if (this.vy > 70 && !this.chute) {
            this.vy = -this.vy * 0.3
            this.vx *= 0.5
          } else {
            this.landed = true
            this.chute = false
            this.vx = 0
            this.vy = 0
            this.t = 0
          }
        }
        return FAST
      }
      this.moving = false
      for (const h of s.data.heroes)
        if (h.onFoot && Math.abs(h.x - this.x) < 8) {
          this.dead = true
          h.take(this.kind)
          burst(s, this.x, this.y - 5, 8, ['L', 'W', 'F'])
          return FAST
        }
      if (!s.lively(now)) return Infinity
      if (this.t > 30) this.dead = true
      return this.t > 26 ? SLOW / 2 : SLOW
    }
    draw(c) {
      if (this.landed && this.t > 26 && Math.floor(this.t * 8) % 2) return
      const img = this.img
      if (this.chute) c.drawImage(MINICHUTE, Math.round(this.x) - 5, Math.round(this.y - img.height) - 8)
      c.drawImage(img, Math.round(this.x - img.width / 2), Math.round(this.y - img.height))
    }
  }
  function supplyDrop(s, h) {
    const d = s.data
    shout(s, 'Supply drop!', h.x, 1, '#ffe9a0', 1.6)
    if (!d.vehicle && h.who === 'lead') {
      d.vehicle = s.spawn(new Vehicle(s, openSpot(s, edgeX(s, h.x + h.dir * 50), 22), h.dir, true))
      return
    }
    const it = new Item(s, pick(['H', 'R', 'B', 'chicken']), edgeX(s, h.x + h.dir * rand(30, 50)), -4, 0, 20, true)
    d.items.push(it)
    s.spawn(it)
  }
  function commandAttack(s, f) {
    const d = s.data
    d.clickAt = performance.now()
    for (const h of d.heroes) h.attack(f)
    if (d.vehicle && d.vehicle.pilot) d.vehicle.fireAt(f)
  }

  // ---- props --------------------------------------------------------------------------------------
  class Camp {
    constructor(s, x, pot) {
      this.s = s
      this.x = x
      this.pot = pot
      this.z = 2
      this.prop = true
      this.lit = false
      this.litAt = 0
      this.seat = false
      this.seatX = x
    }
    light() {
      if (this.lit) return
      this.lit = true
      this.litAt = performance.now()
      burst(this.s, this.x, FLOOR - 4, 6, ['L', 'F', 'f'])
    }
    update(dt, now, s) {
      if (!this.lit) return Infinity
      if (!s.lively(now)) {
        // burns down to embers, then nothing moves
        if (!this.restAt) this.restAt = now
        if (now - this.restAt > 5000) {
          this.embers = true
          return Infinity
        }
        return 160
      }
      this.restAt = 0
      this.embers = false
      if (this.pot && Math.random() < 0.25) s.particle({ img: pick(STEAM), x: this.x - 1 + rand(-3, 3), y: FLOOR - 16, vy: -9, life: 1, fade: true })
      return 160
    }
    draw(c) {
      if (this.seat) c.drawImage(SEAT, Math.round(this.seatX) - 6, FLOOR - 5)
      c.drawImage(LOGS, Math.round(this.x) - 7, FLOOR - 3)
      if (this.lit) {
        if (this.embers) c.drawImage(EMBER, Math.round(this.x) - 5, FLOOR - 3)
        else c.drawImage(FLAME[Math.floor(performance.now() / 160) % 3], Math.round(this.x) - 5, FLOOR - 9)
      }
      if (this.pot) c.drawImage(POT, Math.round(this.x) - 9, FLOOR - 14)
    }
  }
  class Towel {
    constructor(x) {
      this.x = x
      this.z = 1
      this.prop = true
      this.towel = true
    }
    update() {
      return Infinity
    }
    draw(c) {
      c.drawImage(TOWEL, Math.round(this.x) - 11, FLOOR - 3)
    }
  }

  // ---- the tank ---------------------------------------------------------------------------------
  class Vehicle {
    constructor(s, x, dir, chute) {
      this.s = s
      this.x = x
      this.y = chute ? -2 : FLOOR
      this.dir = dir
      this.state = chute ? 'chute' : 'parked'
      this.t = 0
      this.tp = 0
      this.hp = 10
      this.pilot = null
      this.rider = null
      this.reserved = null
      this.ang = 0
      this.angT = 0
      this.cd = 0
      this.vcd = 0
      this.burstN = 0
      this.burstT = 0
      this.yoff = 0
      this.vy = 0
      this.recoil = 0
      this.flash = 0
      this.vflash = 0
      this.z = 4.5
      this.hw = 18
      this.idleT = 0
      this.turnAt = 0
      this.moving = !!chute
    }
    hit(x, y) {
      return this.state !== 'wreck' && Math.abs(x - this.x) < 20 && y > this.y - 28 && y < this.y + 2
    }
    hitBy(x, y) {
      return Math.abs(x - this.x) < 18 && y > this.y + this.yoff - 25 && y < this.y + 1
    }
    onClick() {
      const s = this.s
      const d = s.data
      d.clickAt = performance.now()
      if (this.pilot) {
        this.pilot.eject()
        this.pilot = null
        this.state = 'parked'
        return
      }
      if (this.state !== 'parked') return
      const h = d.lead
      if (!h) return
      if (h.state === 'sit') h.standUp()
      if (['stand', 'run', 'fire', 'win', 'jump'].includes(h.state)) {
        h.steps = [{ k: 'go', x: this.x - (Math.sign(this.x - h.x) || 1) * 12 }, { k: 'board', vehicle: this }]
        if (h.state !== 'jump') {
          h.stand()
          h.next()
        }
      }
    }
    onDblClick() {
      if (this.pilot) this.hop()
    }
    enter(h) {
      this.pilot = h
      this.reserved = null
      this.state = 'drive'
      this.idleT = 0
      this.vy = 40
      this.yoff = -1
      burst(this.s, this.x, FLOOR - 1, 5, ['T', 't'])
    }
    hop() {
      if (this.yoff === 0 && this.vy === 0) this.vy = -150
    }
    hurt(n) {
      if (this.state !== 'drive') return
      this.hp -= n
      this.flash = 0.12
      if (this.hp <= 0 || (this.hp <= 3 && Math.random() < 0.4)) this.wreck()
    }
    wreck() {
      const s = this.s
      if (this.pilot) {
        shout(s, 'Bail out!', this.x, 1, '#ffe9a0', 1.4)
        this.pilot.eject()
      }
      this.pilot = null
      this.state = 'wreck'
      this.t = 0
    }
    fireAt(f) {
      this.dir = Math.sign(f.x - this.x) || this.dir
      this.angT = clamp(Math.atan2(f.y - 14 - (this.y - 12), Math.abs(f.x - this.x)), -0.7, 0.3)
      this.cd = 0
      this.queued = true
    }
    fireCannon(s) {
      const a = this.ang
      const mx = this.x + this.dir * (9 + Math.cos(a) * 16)
      const my = this.y - 12 + this.yoff + Math.sin(a) * 16
      s.spawn(new Shot(s, 'shell', mx, my, this.dir * Math.cos(a) * 240, Math.sin(a) * 240, true))
      this.recoil = 1
      this.cflash = 0.07
      this.cd = 1.3
    }
    roll(tx, dt) {
      const dx = tx - this.x
      if (Math.abs(dx) < 2) {
        this.moving = false
        return false
      }
      const side = Math.sign(dx)
      // reverse for short hops, turn around for long ones
      if (Math.abs(dx) > 40 && side !== this.dir && this.s && performance.now() > this.turnAt) {
        this.dir = side
        this.turnAt = performance.now() + 900
      }
      this.x += side * Math.min(46 * dt, Math.abs(dx))
      this.tp += dt * side * this.dir
      this.moving = true
      return true
    }
    update(dt, now, s) {
      this.t += dt
      this.flash -= dt
      this.vflash -= dt
      this.cflash -= dt
      this.recoil = Math.max(0, this.recoil - dt * 10)
      let busy = this.recoil > 0 || this.cflash > 0
      if (this.vy || this.yoff < 0) {
        this.vy += 520 * dt
        this.yoff += this.vy * dt
        if (this.yoff >= 0) {
          if (this.vy > 100) burst(s, this.x, FLOOR - 1, 5, ['T', 't'])
          this.yoff = 0
          this.vy = 0
        }
        busy = true
      }
      switch (this.state) {
        case 'chute':
          this.y += 22 * dt
          if (this.y >= FLOOR) {
            this.y = FLOOR
            this.state = 'parked'
            this.moving = false
            this.vy = 60
            this.yoff = -1
            burst(s, this.x, FLOOR - 1, 8, ['T', 't', 'X'])
            s.particle({ img: VEHICLE.chute.sp[1], x: this.x - 22, y: this.y - 50, vx: rand(-20, 20), vy: -6, life: 1.2, fade: true })
          }
          return FAST
        case 'parked': {
          this.moving = false
          if (this.hp <= 3 && s.lively(now) && Math.random() < 0.3) s.particle({ img: SMOKE[1], x: this.x - this.dir * 6, y: this.y - 26, vy: -10, life: 0.8, fade: true })
          return busy ? FAST : this.hp <= 3 && s.lively(now) ? SLOW : Infinity
        }
        case 'wreck':
          if (this.t > 1.5) {
            this.dead = true
            if (this.rider) this.rider.standUp()
            explode(s, this.x, FLOOR - 8, 2, true, 8)
            later(s, 160, () => explode(s, this.x + 10, FLOOR - 14, 1, true, 4))
            if (s.data.vehicle === this) s.data.vehicle = null
          }
          return FAST
        case 'drive':
          return this.drive(dt, now, s)
      }
      return FAST
    }
    drive(dt, now, s) {
      const d = s.data
      const h = this.pilot
      if (!h || h.state !== 'tank') {
        this.pilot = null
        this.state = 'parked'
        return FAST
      }
      h.x = this.x
      h.y = this.y
      this.cd -= dt
      this.vcd -= dt
      if (this.burstN > 0) {
        this.burstT -= dt
        if (this.burstT <= 0) {
          this.burstN--
          this.burstT = 0.07
          s.spawn(new Shot(s, 'vulcan', this.x + this.dir * 15, this.y - 20.6 + this.yoff + rand(-1, 1), this.dir * 300, rand(-6, 6), true))
          this.vflash = 0.04
        }
      }
      const ease = () => {
        this.ang += clamp(this.angT - this.ang, -1.6 * dt, 1.6 * dt)
      }
      if (!s.lively(now) || d.parkVehicle) {
        // roll to an open spot, then hop out
        const spot = openSpot(s, this.x, 24)
        if (!this.roll(spot, dt)) {
          d.parkVehicle = false
          this.angT = 0
          h.eject()
          this.pilot = null
          this.state = 'parked'
        }
        return FAST
      }
      if (this.queued && Math.abs(this.ang - this.angT) < 0.08 && this.cd <= 0) {
        this.queued = false
        this.fireCannon(s)
      }
      if (keyed(s, now)) {
        // A/D drive (reversing; a held key the other way turns her round), W hops, Space fires
        const kx = keyDir(s)
        this.moving = false
        if (kx) {
          if (kx !== this.dir && now > this.turnAt && this.keyHeldT > 0.5) {
            this.dir = kx
            this.turnAt = now + 600
          }
          this.keyHeldT = (this.keyHeldT || 0) + dt
          this.x = clamp(this.x + kx * 46 * dt, 22, s.W - 22)
          this.tp += dt * kx * this.dir
          this.moving = true
        } else this.keyHeldT = 0
        if (!this.queued) this.angT = 0
        ease()
        return FAST
      }
      if (engaged(s, now)) {
        const c = s.cursor
        this.moving = false
        if (c && !this.queued) {
          const dx = c.x - this.x
          if (Math.abs(dx) > 10 && Math.sign(dx) !== this.dir && now > this.turnAt) {
            this.dir = Math.sign(dx)
            this.turnAt = now + 600
          }
          this.angT = clamp(Math.atan2(c.y - (this.y - 12), Math.max(6, Math.abs(dx))), -0.7, 0.3)
        }
        ease()
        return FAST
      }
      const f = h.pickFoe(s)
      if (f) {
        this.idleT = 0
        const dx = f.x - this.x
        const adx = Math.abs(dx)
        const side = Math.sign(dx) || this.dir
        if (side !== this.dir && now > this.turnAt) {
          this.dir = side
          this.turnAt = now + 700
        }
        if (adx > 115) this.roll(f.x - side * 80, dt)
        else if (adx < 42) this.roll(f.x - side * 70, dt)
        else this.moving = false
        this.angT = clamp(Math.atan2(f.y - (f.isBoss ? 18 : 14) - (this.y - 12), adx) - (adx > 90 ? 0.12 : 0), -0.7, 0.3)
        ease()
        if (this.cd <= 0 && Math.abs(this.ang - this.angT) < 0.1 && side === this.dir) this.fireCannon(s)
        if (this.vcd <= 0 && adx < 130 && side === this.dir) {
          this.burstN = 7
          this.vcd = 2.2
        }
        for (const a of s.actors)
          if (a instanceof Grenade && !a.friendly && !a.seen && Math.abs(a.x - this.x) < 30) {
            a.seen = true
            if (Math.random() < 0.6) this.hop()
          }
        return FAST
      }
      this.moving = false
      this.angT = 0
      ease()
      this.idleT += dt
      if (this.idleT > 6 && !s.busy && now > (d.vehicleUntil || 0)) {
        d.parkVehicle = true
        d.wantVehicle = false
      }
      return FAST
    }
    draw(c) {
      const dir = this.dir
      const yy = this.y + this.yoff
      if (this.state === 'chute') drawFr(c, VEHICLE.chute, 22, this.x, yy - 26, 1)
      if (this.pilot) drawFr(c, PILOT[this.pilot.who], 6, this.x - dir * 3, yy - 19.8, dir)
      const idx = clamp(Math.round((this.ang + 0.7) / 0.1), 0, 10)
      const px = this.x + dir * (9 - this.recoil * 2.5)
      drawFr(c, VEHICLE.cannon[idx], 18, px, yy - 12 + 17, dir)
      const blink = this.state === 'wreck' && Math.floor(this.t * 10) % 2
      drawFr(c, this.flash > 0 || blink ? VEHICLE.hurt : VEHICLE.body, SX, this.x, yy, dir)
      drawFr(c, VEHICLE.tracks[((Math.floor(this.tp * 14) % 3) + 3) % 3], SX, this.x, this.y, dir)
      if (this.vflash > 0) c.drawImage(dir > 0 ? MUZ[0] : MUZL[0], Math.round(this.x + dir * 16 - 2), Math.round(yy - 23))
      if (this.cflash > 0) {
        const a = this.ang
        c.drawImage(dir > 0 ? MUZ[1] : MUZL[1], Math.round(this.x + dir * (9 + Math.cos(a) * 17) - 3), Math.round(yy - 12 + Math.sin(a) * 17 - 3))
      }
    }
  }

  // ---- bosses -------------------------------------------------------------------------------------
  class Brute {
    constructor(s, x, dir, tx) {
      this.s = s
      this.isBoss = true
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.tx = tx
      this.hw = 9
      this.hp = 38
      this.alive = true
      this.state = 'enter'
      this.t = 0
      this.rt = 0
      this.z = 3.8
      this.flash = 0
      this.moving = true
      this.seenDeath = 0
    }
    onField(s) {
      return this.x > 10 && this.x < s.W - 10
    }
    hit(x, y) {
      return this.alive && Math.abs(x - this.x) < 12 && y > this.y - 34 && y < this.y + 2
    }
    hitBy(x, y) {
      return Math.abs(x - this.x) < 7 && y > this.y - 31 && y < this.y + 1
    }
    onClick() {
      const s = this.s
      if (Math.random() < 0.3 && this.alive) shout(s, pick(['Come on, boy!', 'Is that all?']), this.x, 1, '#ffb070', 1.4)
      commandAttack(s, this)
    }
    hurt(n) {
      if (!this.alive || this.state === 'enter') return
      this.hp -= n
      this.flash = 0.08
      if (this.hp <= 0) this.die()
    }
    die() {
      const s = this.s
      this.alive = false
      this.state = 'dying'
      this.t = 0
      this.moving = true
      shout(s, 'Nooooo!', this.x, 1, '#ffb070', 1.8)
      s.particle({ digits: '5000', x: this.x - 8, y: this.y - 36, vy: -10, life: 1.4 })
      s.data.kills += 10
    }
    leave() {
      if (this.alive) {
        this.state = 'leave'
        this.dir = this.x < this.s.W / 2 ? -1 : 1
      }
    }
    update(dt, now, s) {
      this.t += dt
      this.flash -= dt
      const d = s.data
      const h = nearest(
        d.heroes.filter((q) => q.onFoot || q.state === 'tank'),
        this.x,
      )
      if (this.alive && d.deathAt > this.seenDeath && now - d.deathAt < 1000 && this.state !== 'enter' && this.state !== 'leave') {
        this.seenDeath = d.deathAt
        this.state = 'laugh'
        this.t = 0
        shout(s, 'Ha ha ha ha!', this.x, 1, '#ffb070', 1.6)
      }
      switch (this.state) {
        case 'enter':
        case 'walk':
        case 'leave': {
          const sp = this.state === 'leave' ? 40 : 30
          if (this.state === 'leave') this.tx = this.dir > 0 ? s.W + 30 : -30
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          this.rt += dt
          if (Math.abs(dx) < sp * dt) {
            this.x = this.tx
            if (this.state === 'enter') {
              this.state = 'taunt'
              shout(s, 'Come on, boy!', this.x, 1, '#ffb070', 1.8)
            } else this.state = 'think'
            this.t = 0
          } else this.x += this.dir * sp * dt
          if (this.state === 'leave' && (this.x < -24 || this.x > s.W + 24)) {
            this.dead = true
            if (d.boss === this) d.boss = null
          }
          return FAST
        }
        case 'taunt':
        case 'laugh':
          if (h) this.dir = Math.sign(h.x - this.x) || this.dir
          if (this.t > 1.5) {
            this.state = 'think'
            this.t = 0
          }
          return FAST
        case 'think': {
          if (!h) return SLOW
          const dx = h.x - this.x
          const adx = Math.abs(dx)
          this.dir = Math.sign(dx) || this.dir
          if (this.t < 0.5) return FAST
          this.t = 0
          if (adx < 22 && h.vulnerable()) {
            this.state = 'bash'
            return FAST
          }
          const r = Math.random()
          if (adx > 150 || (adx < 60 && r < 0.4)) {
            this.state = 'walk'
            this.tx = edgeX(s, h.x - this.dir * rand(90, 130))
          } else if (r < 0.62) {
            this.state = 'fire'
            this.nextShot = 0.15
          } else if (r < 0.86) {
            this.state = 'throw'
            this.thrown = false
            this.throwX = h.x
          }
          return FAST
        }
        case 'fire':
          while (this.t > this.nextShot && this.nextShot < 1.5) {
            const f = AF.fire[0]
            s.spawn(new Shot(s, 'm60', this.x + this.dir * f.mx, this.y + f.my + rand(-2, 2), this.dir * 220, rand(-8, 8), false))
            this.nextShot += 0.11
          }
          if (this.t > 1.7) {
            this.state = 'think'
            this.t = 0
          }
          return FAST
        case 'throw':
          if (!this.thrown && this.t > 0.25) {
            this.thrown = true
            lob(s, this.x + this.dir * 4, this.y - 30, this.throwX, false)
          }
          if (this.t > 0.6) {
            this.state = 'think'
            this.t = 0
          }
          return FAST
        case 'bash':
          if (this.t > 0.18 && !this.bashed) {
            this.bashed = true
            for (const q of d.heroes) if (Math.abs(q.x - this.x) < 24) q.die(this.dir)
          }
          if (this.t > 0.5) {
            this.bashed = false
            this.state = 'think'
            this.t = 0
          }
          return FAST
        case 'dying':
          if (Math.random() < dt * 5 && this.t < 1.6) s.spawn(new Boom(this.x + rand(-8, 8), this.y - rand(6, 24), 0))
          if (this.t > 2.8) {
            this.dead = true
            if (d.boss === this) d.boss = null
          }
          return FAST
      }
      return FAST
    }
    draw(c) {
      if (this.state === 'dying' && this.t > 2.1 && Math.floor(this.t * 12) % 2) return
      let f
      switch (this.state) {
        case 'enter':
        case 'walk':
        case 'leave':
          f = AF.walk[Math.floor(this.rt * 6) % 4]
          break
        case 'fire':
          f = AF.fire[Math.floor(this.t * 18) % 2]
          break
        case 'throw':
          f = AF.throw[this.t < 0.22 ? 0 : 1]
          break
        case 'bash':
          f = AF.throw[1]
          break
        case 'laugh':
        case 'taunt':
          f = AF.laugh[Math.floor(this.t * 6) % 2]
          break
        case 'dying':
          f = this.t < 0.4 ? AF.hurt : AF.dead
          break
        default:
          f = AF.stand[Math.floor(performance.now() / 700) % 2]
      }
      if (this.flash > 0 && this.alive) f = AF.hurt
      drawFr(c, f, AX, this.x, this.y, this.dir)
      if (this.state === 'fire' && Math.floor(this.t * 18) % 2 === 0) {
        const g = AF.fire[0]
        c.drawImage(this.dir > 0 ? MUZ[1] : MUZL[1], Math.round(this.x + this.dir * g.mx - 3), Math.round(this.y + g.my - 3))
      }
    }
  }

  class BossTank {
    constructor(s, x, dir, tx) {
      this.s = s
      this.isBoss = true
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.tx = tx
      this.hw = 25
      this.hp = 60
      this.alive = true
      this.state = 'enter'
      this.t = 0
      this.tp = 0
      this.z = 3.6
      this.flash = 0
      this.recoil = 0
      this.moving = true
      this.nextAt = 0
    }
    onField(s) {
      return this.x > 16 && this.x < s.W - 16
    }
    hit(x, y) {
      return this.alive && Math.abs(x - this.x) < 27 && y > this.y - 32 && y < this.y + 2
    }
    hitBy(x, y) {
      return Math.abs(x - this.x) < 25 && y > this.y - 30 && y < this.y + 1
    }
    onClick() {
      commandAttack(this.s, this)
    }
    hurt(n) {
      if (!this.alive || this.state === 'enter') return
      this.hp -= n
      this.flash = 0.08
      if (this.hp <= 0) this.die()
    }
    die() {
      const s = this.s
      this.alive = false
      this.state = 'dying'
      this.t = 0
      this.nb = 0
      s.particle({ digits: '9000', x: this.x - 8, y: this.y - 36, vy: -10, life: 1.4 })
      s.data.kills += 10
    }
    leave() {
      if (this.alive) {
        this.state = 'leave'
        this.dir = this.x < this.s.W / 2 ? -1 : 1
      }
    }
    update(dt, now, s) {
      this.t += dt
      this.flash -= dt
      this.recoil -= dt
      const d = s.data
      const h = nearest(
        d.heroes.filter((q) => q.onFoot || q.state === 'tank'),
        this.x,
      )
      switch (this.state) {
        case 'enter':
        case 'leave': {
          if (this.state === 'leave') this.tx = this.dir > 0 ? s.W + 40 : -40
          const dx = this.tx - this.x
          const sp = 24
          if (this.state === 'enter') this.dir = Math.sign(dx) || this.dir
          this.tp += dt
          if (Math.abs(dx) < sp * dt) {
            this.x = this.tx
            this.state = 'idle'
            this.t = 0
            this.nextAt = now + 800
          } else this.x += Math.sign(dx) * sp * dt
          if (this.state === 'leave' && (this.x < -36 || this.x > s.W + 36)) {
            this.dead = true
            if (d.boss === this) d.boss = null
          }
          return FAST
        }
        case 'idle': {
          this.moving = false
          if (!h || now < this.nextAt) return this.recoil > 0 ? FAST : SLOW
          const dx = h.x - this.x
          this.dir = Math.sign(dx) || this.dir
          this.nextAt = now + rand(1600, 2600)
          const r = Math.random()
          if (r < 0.55) {
            // a shell in a high arc
            this.recoil = 0.25
            const mx = this.x + this.dir * BOSS_TANK.body.mx
            const my = this.y + BOSS_TANK.body.my
            const vy = -120
            const fall = FLOOR - 3 - my
            const tof = (-vy + Math.sqrt(vy * vy + 2 * 300 * fall)) / 300
            s.spawn(new Shot(s, 'gshell', mx, my, clamp((h.x + rand(-12, 12) - mx) / tof, -200, 200), vy, false))
            s.spawn(new Boom(mx, my, 0))
          } else if (r < 0.85) {
            this.mg = 9
            this.mgT = 0
            this.state = 'mg'
          } else {
            this.state = 'enter'
            this.tx = clamp(clearOfVehicle(s, this.x + rand(-40, 40), 26), 30, s.W - 30)
          }
          return FAST
        }
        case 'mg':
          this.mgT -= dt
          if (this.mgT <= 0 && this.mg > 0) {
            this.mg--
            this.mgT = 0.12
            s.spawn(new Shot(s, 'm60', this.x + this.dir * 26, this.y - 8, this.dir * 200, 0, false))
          }
          if (this.mg <= 0 && this.mgT < -0.3) this.state = 'idle'
          return FAST
        case 'dying':
          this.moving = true
          if (this.t > this.nb * 0.2 && this.t < 2.2) {
            this.nb++
            s.spawn(new Boom(this.x + rand(-22, 22), this.y - rand(6, 26), Math.random() < 0.3 ? 1 : 0))
          }
          if (this.t > 2.4) {
            this.dead = true
            explode(s, this.x, FLOOR - 10, 2, true, 0)
            if (d.boss === this) d.boss = null
          }
          return FAST
      }
      return FAST
    }
    draw(c) {
      const blink = (this.flash > 0 && this.alive) || (this.state === 'dying' && Math.floor(this.t * 10) % 2)
      const body = blink ? BOSS_TANK.hurt : this.recoil > 0 ? BOSS_TANK.recoil : BOSS_TANK.body
      drawFr(c, body, GX_, this.x, this.y, this.dir)
      drawFr(c, BOSS_TANK.tracks[Math.floor(this.tp * 12) % 3], GX_, this.x, this.y, this.dir)
      if (this.state === 'mg' && this.mgT > 0.06) c.drawImage(this.dir > 0 ? MUZ[0] : MUZL[0], Math.round(this.x + this.dir * 26 - 2), Math.round(this.y - 10))
    }
  }

  // ---- director ------------------------------------------------------------------------------------
  function spawnRebel(s, role, side, tx) {
    const d = s.data
    if (d.rebels.filter((r) => r.alive).length >= 8) return null
    const r = new Rebel(s, side > 0 ? s.W + 14 : -14, -side, role)
    r.tx = edgeX(s, tx)
    d.rebels.push(r)
    s.spawn(r)
    return r
  }
  const farSide = (s) => (s.data.lead.x < s.W / 2 ? 1 : -1)
  function squad(s, n, side, roles, gap = 650) {
    const m = s.data.lead
    for (let i = 0; i < n; i++)
      later(s, i * gap, () => {
        const sd = typeof side === 'function' ? side(i) : side
        spawnRebel(s, pick(roles), sd, m.x + sd * rand(90, 140))
      })
  }
  function joinPartner(s, now, ms) {
    const d = s.data
    if (d.partner) return
    const m = d.lead
    const t = new Hero(s, 'partner', edgeX(s, m.x - m.dir * 26))
    t.state = 'drop'
    t.y = -6
    t.vy = 30
    t.inv = 1.5
    t.dir = m.dir
    d.partner = t
    d.heroes.push(t)
    d.partnerUntil = now + ms
    s.spawn(t)
    later(s, 700, () => shout(s, pick(['Need a hand, Marco?', 'Tarma here!']), t.x, 1, '#a8e6a0', 1.8))
  }
  const EPISODES = ['patrol', 'camp', 'pow', 'vehicle', 'grenadiers', 'ambush', 'coward', 'partner', 'pow', 'patrol', 'camp']
  function runEpisode(s, now) {
    const d = s.data
    if (!d.bag.length) d.bag = shuffle(EPISODES.slice())
    let ep = d.bag.pop()
    if (ep === 'partner' && d.partner) ep = 'ambush'
    if (ep === 'vehicle' && d.vehicle && d.vehicle.state !== 'parked') ep = 'patrol'
    const m = d.lead
    const side = farSide(s)
    const far = (k) => clamp(m.x + side * k, 26, s.W - 26)
    d.sneakAt = now
    for (const a of s.actors) if (a.towel) a.dead = true
    switch (ep) {
      case 'patrol': {
        const a = spawnRebel(s, 'patrol', side, openSpot(s, far(rand(110, 170)), 12))
        if (!a) break
        later(s, 900, () => {
          const b = spawnRebel(s, 'patrol', side, a.tx + side * 20)
          if (b) {
            a.buddy = b
            b.buddy = a
          }
        })
        d.sneakAt = now + 9000
        break
      }
      case 'camp': {
        const spot = openSpot(s, far(rand(120, 170)), 22)
        if (d.camp) d.camp.dead = true
        d.camp = s.spawn(new Camp(s, spot, true))
        spawnRebel(s, 'cook', side, spot + side * 10)
        later(s, 1800, () => spawnRebel(s, 'sun', side, edgeX(s, spot + side * 38)))
        if (Math.random() < 0.5) later(s, 3200, () => spawnRebel(s, 'sleep', side, edgeX(s, spot - side * 26)))
        d.sneakAt = now + 10000
        break
      }
      case 'pow': {
        const spot = openSpot(s, far(rand(100, 160)), 12)
        const p = new Pow(s, side > 0 ? s.W + 12 : -12, 'escort')
        p.tx = spot
        d.pows.push(p)
        s.spawn(p)
        later(s, 700, () => {
          const g = spawnRebel(s, 'guard', side, spot + side * 18)
          if (g) g.pow = p
        })
        d.sneakAt = now + 7000
        break
      }
      case 'vehicle':
        if (!d.vehicle) d.vehicle = s.spawn(new Vehicle(s, openSpot(s, edgeX(s, m.x + side * 50), 22), side, true))
        d.wantVehicle = true
        d.vehicleUntil = now + 22000
        squad(s, 3, side, ['fight', 'fight', 'grenadier'])
        d.queue[d.queue.length - 3].at += 4500
        d.queue[d.queue.length - 2].at += 4500
        d.queue[d.queue.length - 1].at += 4500
        break
      case 'grenadiers':
        squad(s, Math.floor(rand(2, 4)), side, ['grenadier'], 900)
        break
      case 'ambush':
        squad(s, 4, (i) => (i % 2 ? -side : side), ['fight', 'fight', 'grenadier'], 800)
        break
      case 'coward': {
        const c = spawnRebel(s, 'coward', side, far(50))
        if (c) {
          c.noticeR = 95
          c.onGone = (dir) =>
            later(s, 1500, () => {
              const sd = dir > 0 ? 1 : -1
              const r = spawnRebel(s, 'fight', sd, m.x + sd * 100)
              if (r) later(s, 300, () => shout(s, 'There he is!', clamp(r.x, 20, s.W - 20), 1, '#cfe59a', 1.6))
              squad(s, 3, sd, ['fight', 'fight', 'grenadier'], 500)
            })
        }
        break
      }
      case 'partner':
        joinPartner(s, now, 45000)
        squad(s, 3, side, ['fight', 'grenadier'], 900)
        d.queue.forEach((q) => (q.at += 2500))
        break
    }
  }
  function startCeremony(s, now) {
    const d = s.data
    const m = d.lead
    const spot = openSpot(s, m.x, 12)
    m.steps = [{ k: 'go', x: spot }, { k: 'face', dir: spot < s.W / 2 ? 1 : -1 }, { k: 'win' }]
    if (m.state === 'tank') {
      d.parkVehicle = true
    } else if (['stand', 'run', 'fire'].includes(m.state)) {
      m.stand()
      m.next()
    }
    if (d.partner && ['stand', 'run', 'fire'].includes(d.partner.state)) {
      d.partner.steps = [{ k: 'go', x: edgeX(s, spot + (spot < s.W / 2 ? -22 : 22)) }, { k: 'face', dir: spot < s.W / 2 ? 1 : -1 }, { k: 'win' }]
      d.partner.stand()
      d.partner.next()
    }
    // the POWs he freed come back to salute
    const slots = [-30, 30, -52, 52].map((k) => clamp(spot + k, 10, s.W - 10)).slice(0, Math.floor(rand(2, 5)))
    slots.forEach((x, i) => {
      later(s, 600 + i * 450, () => {
        if (d.pows.length > 6) return
        const p = new Pow(s, x < spot ? -12 : s.W + 12, 'enter')
        p.tx = x
        p.leaveAt = performance.now() + 6500 - i * 300
        d.pows.push(p)
        s.spawn(p)
      })
    })
  }

  registerConcept({
    key: 'tankcommando',
    title: 'Tank commando',
    blurb:
      'A commando in a red vest takes on an army of rebel soldiers. Rebels chat, cook, sunbathe and nap until they spot him, then jump out of their skins, skid back on their heels and either fight or run off screaming. Bearded POWs salute and hand over a heavy machine gun, rockets, bombs or food, and a small tank drops in by parachute for the hero to drive; his green-vested partner sometimes lends a hand. <b>Click a rebel</b> to shoot or knife him (an off-guard one just panics), click the hero to throw a grenade, click a POW to free him, click the tank to hop in or out, and drag soldiers, items or the hero around. The hero turns to your cursor and the autopilot waits while you play. Working brings MISSION START, waves and a boss (a boss tank or a burly sergeant); done is MISSION COMPLETE with the POWs saluting. Quiet leaves the hero sitting on the parked tank or by a campfire.',
    setup(s) {
      s.data = { heroes: [], rebels: [], pows: [], items: [], queue: [], bag: [], calls: [], banner: null, kills: 0, clickAt: -1e9, grabAt: -1e9, deathAt: -1e9, sneakAt: 0, vehicle: null, boss: null, camp: null, partner: null, wantVehicle: false, parkVehicle: false, nextBoss: Math.random() < 0.5 ? 'bosstank' : 'brute' }
      const d = s.data
      const now = performance.now()
      if (Math.random() < 0.6) {
        d.vehicle = new Vehicle(s, openSpot(s, s.W * 0.18, 22), 1, false)
        s.actors.push(d.vehicle)
      }
      d.lead = new Hero(s, 'lead', openSpot(s, s.W * 0.32, 10))
      d.heroes.push(d.lead)
      s.actors.push(d.lead)
      d.epAt = now + rand(2500, 4000)
      d.banner = { text: 'MISSION START!', at: now + 400, hold: 2 }
    },
    relayout(s) {
      const d = s.data
      if (!d.lead) return
      for (const a of s.actors) {
        if (a.x === undefined) continue
        const off = a.x < -2 || a.x > s.W + 2
        if (a instanceof Hero || a instanceof Item || (a instanceof Rebel && !off) || (a instanceof Pow && a.state === 'tied')) a.x = edgeX(s, a.x)
        else a.x = clamp(a.x, -30, s.W + 30)
        if (a.tx !== undefined) a.tx = edgeX(s, a.tx)
      }
      if (d.vehicle && !d.vehicle.dead) d.vehicle.x = clamp(d.vehicle.x, 22, s.W - 22)
      if (d.camp) {
        d.camp.x = clamp(d.camp.x, 18, s.W - 18)
        d.camp.seatX = clamp(d.camp.seatX, 8, s.W - 8)
      }
      for (const h of d.heroes) {
        if (h.state === 'sit' && h.camp) h.x = h.camp.seatX
        h.steps = h.steps.filter((st) => st.k !== 'go')
        if (h.state === 'run') h.tx = edgeX(s, h.tx)
        if (h.state === 'sit') h.restT = Math.min(h.restT, 2)
      }
    },
    // keyboard: on foot A/D run, W jumps, S throws a grenade (or climbs into the tank
    // when next to it), Space fires (knife up close). In the tank: A/D drive, W hops,
    // S hops out, Space fires the cannon (the Vulcan while it reloads).
    onKey(s, key, down) {
      const d = s.data
      const m = d.lead
      if (!down || !m) return
      const sl = m.vehicle
      if (m.state === 'tank' && sl && sl.pilot === m) {
        if (key === 'up') sl.hop()
        else if (key === 'down') sl.onClick()
        else if (key === 'fire') {
          if (sl.cd <= 0) {
            sl.angT = sl.ang
            sl.fireCannon(s)
          } else if (sl.burstN <= 0) {
            sl.burstN = 5
            sl.burstT = 0
          }
        }
        return
      }
      if (m.state === 'sit') m.standUp()
      const ready = ['stand', 'run', 'win'].includes(m.state)
      if (!ready && !(key === 'fire' && m.state === 'jump')) return
      m.steps = []
      const kx = keyDir(s)
      if (key === 'up' && ready) m.jump(kx * 50)
      else if (key === 'down' && ready) {
        const vehicle = d.vehicle
        if (m.who === 'lead' && vehicle && !vehicle.dead && vehicle.state === 'parked' && !vehicle.pilot && Math.abs(vehicle.x - m.x) < 30) m.board(vehicle)
        else if (!m.throwG()) shout(s, 'No bombs!', m.x, m.y - 36, '#ffe9a0', 1)
      } else if (key === 'fire') {
        if (m.state === 'jump') {
          m.shoot(s)
          return
        }
        let near = null
        for (const r of d.rebels) if (r.alive && Math.sign(r.x - m.x) !== -m.dir && Math.abs(r.x - m.x) < 18) near = r
        if (near) m.knife()
        else m.fire()
      }
    },
    onBarClick(s, p) {
      // mockup only (Aico has no empty-bar clicks): the hero runs there
      s.data.clickAt = performance.now()
      const m = s.data.lead
      if (['stand', 'run', 'fire', 'win'].includes(m.state)) {
        m.steps = []
        m.go(p.x)
      } else if (m.state === 'sit') m.standUp()
    },
    onBonk(s) {
      // a window button clicked: the noise startles anyone off guard
      const now = performance.now()
      for (const r of s.data.rebels) if (r.alive && !r.aware && r.state !== 'walk') r.notice(now)
    },
    onBusy(s) {
      const d = s.data
      const now = performance.now()
      banner(s, 'MISSION START!')
      d.waveAt = now + 1800
      d.bossAt = now + rand(14000, 20000)
      d.epAt = 0
      if (!d.partner && Math.random() < 0.5) later(s, 1500, () => joinPartner(s, performance.now(), 60000))
      if (d.vehicle && d.vehicle.state === 'parked' && Math.random() < 0.5) {
        d.wantVehicle = true
        d.vehicleUntil = now + 30000
      }
    },
    onDone(s) {
      const d = s.data
      const now = performance.now()
      banner(s, 'MISSION COMPLETE!')
      d.queue.length = 0
      d.wantVehicle = false
      for (const a of s.actors) if (a instanceof Shot && !a.friendly) a.dead = true
      let k = 0
      for (const r of d.rebels)
        if (r.alive && !r.held) {
          if (!r.aware) r.notice(now)
          r.brave = 0
          const rr = r
          later(s, 300 + k++ * 140, () => rr.alive && rr.state !== 'held' && (rr.state === 'shock' || rr.state === 'slide' ? (rr.brave = 0) : rr.flee()))
        }
      const b = d.boss
      if (b && b.alive) b.die()
      later(s, 1300, () => startCeremony(s, performance.now()))
      d.epAt = now + 11000
    },
    onNap(s) {
      s.data.queue.length = 0
    },
    update(s, dt, now) {
      // held game keys keep it at full rate
      return Math.min(this.step(s, dt, now) ?? Infinity, s.keys?.size ? FAST : Infinity)
    },
    step(s, dt, now) {
      const d = s.data
      let wait = Infinity
      d.rebels = d.rebels.filter((r) => !r.dead)
      d.pows = d.pows.filter((p) => !p.dead)
      d.items = d.items.filter((i) => !i.dead)
      d.heroes = d.heroes.filter((h) => !h.dead)
      if (d.partner && d.partner.dead) d.partner = null
      if (d.vehicle && d.vehicle.dead) d.vehicle = null
      if (d.camp && d.camp.dead) d.camp = null
      // queued events
      d.queue.sort((a, b) => a.at - b.at)
      while (d.queue.length && d.queue[0].at <= now) d.queue.shift().fn()
      if (d.queue.length) wait = Math.min(wait, Math.max(FAST, d.queue[0].at - now))
      // banner and callouts
      const b = d.banner
      if (b) {
        const e = (now - b.at) / 1000
        const reveal = b.text.length * 0.045 + 0.12
        if (e > reveal + b.hold + 0.5) d.banner = null
        else if (e < 0) wait = Math.min(wait, -e * 1000)
        else if (e < reveal || e > reveal + b.hold) wait = FAST
        else wait = Math.min(wait, (reveal + b.hold - e) * 1000)
      }
      d.calls = d.calls.filter((k) => now - k.at < k.life)
      for (const k of d.calls) wait = Math.min(wait, Math.max(FAST, k.at + k.life - now))
      const awake = s.lively(now)
      if (!awake) {
        if (!d.resting) {
          d.resting = true
          d.queue.length = 0
          d.wantVehicle = false
          for (const r of d.rebels) if (r.alive && r.aware && r.state !== 'held' && r.state !== 'fall') r.flee()
          if (d.boss && d.boss.alive) d.boss.leave()
          d.offDutyAt = now + 3000
        }
        if (d.offDutyAt) {
          if (now >= d.offDutyAt) {
            d.offDutyAt = 0
            // a rebel comes off duty for a lie-down, well away from the hero
            const m = d.lead
            if (!d.rebels.some((r) => r.alive && !r.aware) && s.W > 300) {
              const side = m.x < s.W / 2 ? 1 : -1
              const spot = openSpot(s, side > 0 ? s.W - 80 : 80, 14)
              if (Math.abs(spot - m.x) > 70 && (!d.vehicle || Math.abs(spot - d.vehicle.x) > 40)) spawnRebel(s, Math.random() < 0.6 ? 'sun' : 'sleep', side, spot)
            }
          } else wait = Math.min(wait, d.offDutyAt - now)
        }
        return wait
      }
      if (d.resting) {
        d.resting = false
        d.offDutyAt = 0
        d.sneakAt = now + 4000
        d.epAt = now + rand(1500, 3000)
      }
      if (s.busy) {
        const m = d.lead
        if (!d.boss && now > d.bossAt) {
          const side = farSide(s)
          const tx = clamp(clearOfVehicle(s, clamp(m.x + side * rand(110, 160), 40, s.W - 40), d.nextBoss === 'bosstank' ? 26 : 10), 30, s.W - 30)
          d.boss = d.nextBoss === 'bosstank' ? new BossTank(s, side > 0 ? s.W + 34 : -34, -side, tx) : new Brute(s, side > 0 ? s.W + 14 : -14, -side, tx)
          d.nextBoss = d.nextBoss === 'bosstank' ? 'brute' : 'bosstank'
          s.spawn(d.boss)
          d.bossAt = now + rand(28000, 40000)
        }
        if (now > d.waveAt) {
          const hostile = d.rebels.filter((r) => r.alive && r.aware && r.state !== 'flee').length
          if (hostile < (d.boss ? 2 : 5)) {
            const side = Math.random() < 0.7 ? farSide(s) : -farSide(s)
            squad(s, d.boss ? 1 : Math.floor(rand(1, 3.6)), side, ['fight', 'fight', 'fight', 'grenadier'], 700)
          }
          if (!d.pows.some((p) => p.state === 'tied' || p.state === 'escort') && Math.random() < 0.2) {
            const side = farSide(s)
            const p = new Pow(s, side > 0 ? s.W + 12 : -12, 'escort')
            p.tx = openSpot(s, clamp(m.x + side * rand(80, 140), 20, s.W - 20), 10)
            d.pows.push(p)
            s.spawn(p)
          }
          if (!d.vehicle && Math.random() < 0.07) {
            d.vehicle = s.spawn(new Vehicle(s, openSpot(s, edgeX(s, m.x + rand(-60, 60)), 22), m.dir, true))
            d.wantVehicle = true
            d.vehicleUntil = now + 30000
          }
          d.waveAt = now + (d.boss ? rand(4500, 7000) : rand(2200, 4000))
        }
        return Math.min(wait, SLOW)
      }
      // watch mode: one episode at a time, with a breather between them
      const m = d.lead
      const quiet =
        !d.rebels.some((r) => r.alive && r.onField(s)) &&
        !d.rebels.some((r) => r.alive && r.state === 'walk') &&
        !d.pows.some((p) => p.state === 'tied' || p.state === 'escort') &&
        !d.items.length &&
        !d.boss &&
        !d.queue.length &&
        !d.banner &&
        !(d.vehicle && (d.vehicle.pilot || d.vehicle.state === 'chute')) &&
        !m.steps.length &&
        m.state === 'stand'
      if (quiet && !engaged(s, now)) {
        if (!d.epAt) d.epAt = now + rand(1800, 3800)
        if (now > d.epAt) {
          d.epAt = 0
          runEpisode(s, now)
        } else wait = Math.min(wait, d.epAt - now)
      } else if (!quiet) d.epAt = 0
      return Math.min(wait, SLOW)
    },
    drawFront(s, c) {
      const d = s.data
      const now = performance.now()
      const b = d.banner
      if (b) {
        const e = (now - b.at) / 1000
        const reveal = b.text.length * 0.045 + 0.12
        const pitch = 11
        const x0 = Math.round(s.W / 2 - (b.text.length * pitch - 1) / 2)
        const out = e > reveal + b.hold ? (e - reveal - b.hold) / 0.5 : 0
        for (let i = 0; i < b.text.length; i++) {
          const g = BIG[b.text[i]]
          const li = e - i * 0.045
          if (li < 0) break
          if (!g) continue
          const drop = li < 0.12 ? (1 - li / 0.12) * -12 : 0
          const fall = out > 0 ? out * out * 40 * (1 + (i % 3) * 0.35) : 0
          c.drawImage(g, x0 + i * pitch - 1, Math.round(4 + drop + fall) - 1)
        }
      }
      for (const k of d.calls) {
        const w = k.text.length * 6 - 1
        drawText(c, k.text, clamp(Math.round(k.x - w / 2), 2, s.W - w - 2), 2, k.set, 6)
      }
    },
  })
})()
