;(() => {
  // Strider (Capcom, 1989), big: Strider Hiryu in his blue gi and long red
  // scarf runs the bar with the cypher. His signature slide carries him along
  // the floor beneath the title, cutting whatever stands there; he cartwheels
  // over the other furniture and off the bar's ends. Kazakh infantry and robot
  // dogs come in waves, the Option power-up brings the hawk or the robot
  // panther to his side, and while the agent works Mecha Pon the robot gorilla
  // fights him. Done blows Pon apart; quiet leaves Hiryu crouched, scarf moving.

  // ---- palette ---------------------------------------------------------------------------
  const P = {
    E: '#10101a', H: '#2a1c18', h: '#4a3226', S: '#f2b484', s: '#b86e44', w: '#f4f4ff',
    B: '#3c62ee', b: '#22359a', D: '#141e5c', n: '#9ab4ff', // Hiryu's gi
    K: '#d8a030', k: '#24243a', R: '#e8302a', r: '#8a1410', // belt, boots, scarf
    c: '#8fe8ff', W: '#ffffff', g: '#8a8f98', Y: '#ffd040', // cypher
    U: '#7a6a3c', u: '#4c4226', F: '#d8d4cc', f: '#9a968e', Z: '#ff3a2a', // infantry
    M: '#8a909c', m: '#4a4e5a', X: '#c8ccd6', O: '#e07a20', o: '#9a4c10', // steel / Pon
    Q: '#2c2c40', q: '#16161f', V: '#6a70b0', // panther
    T: '#b07a3c', t: '#6a4420', N: '#f0e2c0', y: '#ffe040', // hawk
    a: '#6a6e78', A: '#c4c8d0', p: '#ff9a2c', v: '#c86aff',
  }
  const OUT = 'rgba(8,9,11,.92)'

  // ---- pixel painter ----------------------------------------------------------------------
  // Frames share one anchor: feet centre at column CX of the last row.
  const FW = 48
  const FH = 36
  const CX = 22
  const grid = () => Array.from({ length: FH }, () => Array(FW).fill('.'))
  const put = (g, x, y, ch) => {
    x = Math.round(x)
    y = Math.round(y)
    if (y >= 0 && y < FH && x >= 0 && x < FW && ch) g[y][x] = ch
  }
  const X0 = (p) => CX + p[0]
  const Y0 = (p) => FH - 1 + p[1]
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const add = (a, v, k = 1) => [a[0] + v[0] * k, a[1] + v[1] * k]
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1]) || 1
    return [v[0] / l, v[1] / l]
  }
  /** A filled capsule a→b of radius r; the side to the left of a→b gets the shade. */
  function capsule(g, a, b, r, ch, sh, side = 1) {
    const ax = X0(a)
    const ay = Y0(a)
    const bx = X0(b)
    const by = Y0(b)
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy || 1e-6
    const L = Math.sqrt(L2)
    for (let j = Math.floor(Math.min(ay, by) - r - 1); j <= Math.ceil(Math.max(ay, by) + r + 1); j++)
      for (let i = Math.floor(Math.min(ax, bx) - r - 1); i <= Math.ceil(Math.max(ax, bx) + r + 1); i++) {
        const t = clamp(((i - ax) * dx + (j - ay) * dy) / L2, 0, 1)
        const ex = i - (ax + dx * t)
        const ey = j - (ay + dy * t)
        if (ex * ex + ey * ey > r * r) continue
        let c = ch
        if (sh && L > 0.3 && ((dx * (j - ay) - dy * (i - ax)) / L) * side > r * 0.3) c = sh
        put(g, i, j, c)
      }
  }
  /** Fill a disc, asking fn(a, f) for each pixel's letter (a: along U, f: along F). */
  function disc(g, c, r, U, F, fn) {
    const cx = X0(c)
    const cy = Y0(c)
    for (let j = Math.floor(cy - r - 1); j <= Math.ceil(cy + r + 1); j++)
      for (let i = Math.floor(cx - r - 1); i <= Math.ceil(cx + r + 1); i++) {
        const vx = i - cx
        const vy = j - cy
        if (vx * vx + vy * vy > r * r) continue
        put(g, i, j, fn(vx * U[0] + vy * U[1], vx * F[0] + vy * F[1]))
      }
  }
  const dot = (g, p, ch) => put(g, X0(p), Y0(p), ch)
  const rowsOf = (g) => g.map((r) => r.join(''))

  function rotPose(pose, ang, pivot) {
    const c = Math.cos(ang)
    const sn = Math.sin(ang)
    const R = (p) => [pivot[0] + (p[0] - pivot[0]) * c - (p[1] - pivot[1]) * sn, pivot[1] + (p[0] - pivot[0]) * sn + (p[1] - pivot[1]) * c]
    const V = (v) => [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c]
    const o = { ...pose }
    for (const k of ['hip', 'neck', 'head', 'fk', 'ff', 'bk', 'bf', 'fe', 'fh', 'be', 'bh']) if (pose[k]) o[k] = R(pose[k])
    o.F = V(pose.F || [1, 0])
    o.U = V(pose.U || [0, -1])
    if (pose.sa) o.sa = V(pose.sa)
    if (pose.rifle) o.rifle = pose.rifle.map(R)
    return o
  }

  // ---- Strider Hiryu ---------------------------------------------------------------------
  function sword(g, hand, dir, len) {
    const d = norm(dir)
    capsule(g, hand, add(hand, d, 1.6), 0.7, 'g')
    dot(g, add(hand, d, 1.8), 'Y')
    const a = add(hand, d, 2.6)
    const b = add(hand, d, 2.6 + len)
    capsule(g, a, b, 1.05, 'c')
    capsule(g, a, add(b, d, -0.6), 0.45, 'W')
  }
  function limb(g, a, k, e, r1, r2, ch, sh) {
    capsule(g, a, k, r1, ch, sh)
    capsule(g, k, e, r2, ch, sh)
  }
  function leg(g, hip, knee, foot, ch, sh, F) {
    limb(g, hip, knee, foot, 1.75, 1.5, ch, sh)
    capsule(g, lerp(knee, foot, 0.4), foot, 1.55, 'k', 'E')
    capsule(g, foot, add(foot, F, 2.3), 1.0, 'k')
  }
  function hiryuHead(g, c, F, U) {
    disc(g, c, 3.65, U, F, (a, f) => {
      if (Math.abs(a - 1.15) < 0.55 && f > -3.2) return 'w' // headband
      if (a > 1.6 || f < -0.9) return a > 2.6 && f > 0.5 ? 'h' : 'H'
      if (a < -1.9 && f < 1.4) return 's'
      return 'S'
    })
    dot(g, add(add(c, F, 1.9), U, 0.1), 'E')
    // spiky hair and the headband's loose ends
    dot(g, add(add(c, U, 4.2), F, -0.4), 'H')
    dot(g, add(add(c, U, 3.7), F, -2.4), 'H')
    dot(g, add(add(c, U, 2.4), F, -4.0), 'H')
    dot(g, add(add(c, U, 1.3), F, -4.3), 'w')
    dot(g, add(add(c, U, 0.6), F, -5.3), 'w')
  }
  function hiryu(pose) {
    const g = grid()
    const { hip, neck, head, fk, ff, bk, bf, fe, fh, be, bh } = pose
    const F = pose.F || [1, 0]
    const U = pose.U || [0, -1]
    const sho = lerp(neck, hip, 0.14)
    // far arm, far leg, torso, near leg, head, near arm with the cypher
    if (pose.sw === 'b') sword(g, bh, pose.sa, pose.len ?? 9)
    limb(g, sho, be, bh, 1.35, 1.2, 'b', 'D')
    capsule(g, bh, bh, 1.3, 'k')
    leg(g, hip, bk, bf, 'b', 'D', F)
    capsule(g, neck, hip, 2.75, 'B', 'b')
    capsule(g, lerp(hip, neck, 0.04), lerp(hip, neck, 0.16), 2.8, 'K', 'o')
    dot(g, add(lerp(neck, hip, 0.3), F, 1.2), 'n')
    dot(g, add(lerp(neck, hip, 0.45), F, 1.4), 'n')
    leg(g, hip, fk, ff, 'B', 'b', F)
    capsule(g, add(neck, F, -0.6), add(neck, F, 0.6), 1.8, 'R', 'r')
    hiryuHead(g, head, F, U)
    if (pose.sw !== 'b') sword(g, fh, pose.sa, pose.len ?? 9)
    limb(g, sho, fe, fh, 1.4, 1.25, 'B', 'b')
    capsule(g, fh, fh, 1.35, 'k')
    const knot = add(neck, F, -1.3)
    return { sp: pairOutlined(rowsOf(g), P, OUT), nx: knot[0], ny: knot[1] }
  }

  // leg pair for a running/walking phase; returns knees/feet relative to the hip
  function stride(ph, swing, len) {
    const one = (p) => {
      const th = swing * Math.sin(p)
      const bend = 0.15 + 1.25 * Math.max(0, Math.cos(p))
      const k = [len * Math.sin(th), len * Math.cos(th)]
      const f = add(k, [Math.sin(th - bend), Math.cos(th - bend)], len)
      return [k, f]
    }
    return [one(ph), one(ph + Math.PI)]
  }

  const HF = {}
  {
    const stand = {
      hip: [0, -11], neck: [1, -19], head: [2, -22.6], fk: [3, -6.2], ff: [3, -1.6], bk: [-2, -6.2], bf: [-3, -1.6],
      fe: [3.5, -14], fh: [5.5, -11.5], sa: [0.85, 0.5], be: [-2, -14], bh: [-1, -11],
    }
    HF.stand = hiryu(stand)
    HF.ready = hiryu({ ...stand, fk: [4, -6], ff: [5, -1.6], bk: [-3, -6], bf: [-5, -1.6], hip: [0, -10.5], fe: [5, -16], fh: [8, -16], sa: [0.95, -0.3] })
    HF.look = hiryu({ ...stand, head: [2.2, -22.8], F: norm([1, -0.35]), U: norm([-0.35, -1]) })
    HF.run = []
    for (let i = 0; i < 6; i++) {
      const ph = (i / 6) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.85, 5.1)
      const hip0 = [0, 0]
      const lowest = Math.max(f1[1], f2[1])
      const hy = -1.6 - lowest
      const hip = [0, hy]
      const sw = Math.sin(ph)
      HF.run.push(
        hiryu({
          hip, neck: [3.4, hy - 8], head: [5, hy - 11.4], F: norm([1, 0.15]), U: norm([0.15, -1]),
          fk: add(hip, k1), ff: add(hip, f1), bk: add(hip, k2), bf: add(hip, f2),
          fe: [-1 - sw, hy - 4.6], fh: [-4 - sw * 1.5, hy - 2.6], sa: [-1, -0.22], len: 9,
          be: [4 + sw * 1.5, hy - 4.5], bh: [6 + sw * 2.5, hy - 2.5 - Math.abs(sw)],
        }),
      )
      void hip0
    }
    const lunge = { hip: [0, -10], neck: [3, -18], head: [5, -21.5], fk: [5, -5.6], ff: [8, -1.6], bk: [-3, -5.4], bf: [-7, -1.6], be: [-2, -14], bh: [-5, -13] }
    HF.slash = [
      hiryu({ ...stand, hip: [0, -10.6], neck: [0, -18.6], head: [1, -22.2], fe: [-0.5, -21], fh: [-2, -24], sa: [-0.5, -0.86], be: [3, -14], bh: [5, -12] }),
      hiryu({ ...lunge, fe: [7, -17], fh: [11, -16.4], sa: [1, 0.08], len: 10 }),
      hiryu({ ...lunge, fe: [6, -14], fh: [9, -10.5], sa: [0.72, 0.7], len: 10 }),
    ]
    HF.slide = [0, 1].map((k) =>
      hiryu({
        hip: [0, -3.6], neck: [-5, -7.4], head: [-7.6, -9.3], F: [1, 0], U: [0, -1],
        fk: [5, -2.6], ff: [10 + k * 0.5, -1.6], bk: [2, -5.4], bf: [4.5, -1.6],
        be: [-7, -4], bh: [-9.5, -1.4], fe: [-2, -6.2], fh: [1, -6.6 - k * 0.4], sa: [1, -0.06], len: 9,
      }),
    )
    HF.leap = hiryu({
      hip: [0, -14], neck: [2, -22], head: [3.4, -25.4], fk: [4, -11], ff: [2.5, -6.2], bk: [-1, -9.4], bf: [-4.5, -7],
      fe: [4, -22.4], fh: [7, -24.6], sa: [0.7, -0.7], len: 8, be: [-3, -18.5], bh: [-6, -17],
    })
    HF.cling = hiryu({
      hip: [-1, -14], neck: [-0.5, -22], head: [0.4, -25.4], fk: [3, -12], ff: [4.5, -7], bk: [2, -10], bf: [4, -5.5],
      fe: [3, -24.5], fh: [5.4, -27.5], sa: [-0.3, -1], len: 6, be: [-3, -19], bh: [-6, -21],
    })
    const tuck = {
      hip: [-1.5, 2], neck: [1, -3.6], head: [3.6, -2.4], F: norm([1, 0.5]), U: norm([0.5, -1]),
      fk: [3.6, 1.2], ff: [0.8, 5.2], bk: [2.4, 3], bf: [-1, 5.6], fe: [2.2, -1], fh: [4.2, 2], sa: [-0.55, -0.85], len: 8,
      be: [-1, -1], bh: [1, 1],
    }
    HF.tuck = []
    for (let i = 0; i < 8; i++) {
      const r = rotPose(tuck, (i * Math.PI) / 4, [0, 0])
      for (const k of ['hip', 'neck', 'head', 'fk', 'ff', 'bk', 'bf', 'fe', 'fh', 'be', 'bh']) r[k] = add(r[k], [0, -9])
      HF.tuck.push(hiryu(r))
    }
    HF.crouch = hiryu({
      hip: [0, -6.6], neck: [2, -14], head: [3.6, -17.4], F: norm([1, 0.3]), U: norm([0.3, -1]),
      fk: [5, -6.6], ff: [5.5, -1.6], bk: [-1, -1.6], bf: [-6, -1.4], sw: 'b',
      be: [-1.5, -10], bh: [-3.5, -7.5], sa: [-0.9, -0.42], len: 9, fe: [3.6, -9.6], fh: [5.4, -7.6],
    })
    HF.win = hiryu({
      hip: [0, -11], neck: [0.5, -19.5], head: [1.2, -23], fk: [3, -6.2], ff: [4.5, -1.6], bk: [-3, -6.2], bf: [-4.5, -1.6],
      fe: [3, -23.6], fh: [3.6, -26.4], sa: [0.36, -0.93], len: 7.5, be: [-4, -15], bh: [-1.6, -12],
    })
    HF.hurt = hiryu({
      hip: [0, -11], neck: [-3, -18.6], head: [-4.6, -21.6], F: norm([1, -0.4]), U: norm([-0.4, -1]),
      fk: [3, -6], ff: [5, -1.6], bk: [-2, -6], bf: [-2, -1.6], fe: [2, -19], fh: [5, -22], sa: [0.8, -0.6], len: 8,
      be: [-5, -16], bh: [-8, -18],
    })
  }

  // the cypher's crescent: two frames, drawn in front of Hiryu
  function arcSprite(fade) {
    const w = 30
    const h = 36
    const g = Array.from({ length: h }, () => Array(w).fill('.'))
    const cx = 4
    const cy = 18
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const dx = i - cx
        const dy = j - cy
        const r = Math.hypot(dx, dy)
        const a = Math.atan2(dy, dx) // 0 = forward, -π/2 = up
        const a0 = -1.95
        const a1 = 1.15
        if (a < a0 || a > a1) continue
        const u = (a - a0) / (a1 - a0)
        const thick = (fade ? 2.4 : 5.4) * Math.sin(Math.PI * Math.pow(u, 0.8)) + 0.6
        const ro = 17.5 - (fade ? 0 : 0)
        if (r > ro || r < ro - thick) continue
        const k = (ro - r) / thick
        g[j][i] = fade ? (k < 0.4 ? 'c' : 'b') : k < 0.22 ? 'W' : k < 0.55 ? 'c' : 'B'
      }
    return outline(sprite(g.map((r) => r.join('')), P), 'rgba(8,9,40,.5)')
  }
  const ARC = [arcSprite(false), arcSprite(true)].map((c) => ({ 1: c, '-1': mirror(c), cx: 4 + 1, cy: 18 + 1 }))

  // ---- Kazakh infantry --------------------------------------------------------------------
  function soldier(pose) {
    const g = grid()
    const { hip, neck, head, fk, ff, bk, bf } = pose
    const F = pose.F || [1, 0]
    const U = pose.U || [0, -1]
    if (pose.rifle) {
      capsule(g, pose.rifle[0], pose.rifle[1], 0.9, 'm')
      capsule(g, pose.rifle[0], lerp(pose.rifle[0], pose.rifle[1], 0.3), 1.2, 't')
      dot(g, pose.rifle[1], 'a')
    }
    if (pose.be) limb(g, lerp(neck, hip, 0.15), pose.be, pose.bh, 1.3, 1.15, 'u', 'E')
    leg(g, hip, bk, bf, 'u', 'E', F)
    capsule(g, neck, hip, 2.8, 'U', 'u')
    capsule(g, hip, add(hip, U, -2.2), 2.9, 'U', 'u') // greatcoat skirt
    capsule(g, lerp(hip, neck, 0.1), lerp(hip, neck, 0.2), 2.85, 'k')
    leg(g, hip, fk, ff, 'U', 'u', F)
    disc(g, head, 3.4, U, F, (a, f) => {
      if (a > 0.7) return a > 2.4 ? 'F' : 'f'
      if (f < -1.2) return 'F'
      return a < -1.8 && f < 1.2 ? 's' : 'S'
    })
    dot(g, add(add(head, F, 1.8), U, -0.2), 'E')
    dot(g, add(add(head, F, 2.0), U, 1.6), 'Z') // star on the ushanka
    if (pose.fe) {
      limb(g, lerp(neck, hip, 0.15), pose.fe, pose.fh, 1.35, 1.2, 'U', 'u')
      capsule(g, pose.fh, pose.fh, 1.2, 'S')
    }
    return { sp: pairOutlined(rowsOf(g), P, OUT) }
  }
  const SF = {}
  {
    const base = { hip: [0, -9.4], neck: [0.6, -16.4], head: [1.4, -19.8] }
    SF.walk = []
    for (let i = 0; i < 4; i++) {
      const ph = (i / 4) * Math.PI * 2
      const [[k1, f1], [k2, f2]] = stride(ph, 0.5, 4.2)
      const hy = -1.6 - Math.max(f1[1], f2[1])
      const hip = [0, hy]
      SF.walk.push(
        soldier({
          hip, neck: [0.8, hy - 7], head: [1.6, hy - 10.4], fk: add(hip, k1), ff: add(hip, f1), bk: add(hip, k2), bf: add(hip, f2),
          rifle: [[-2, hy - 5], [10, hy - 6.6]], fe: [2.4, hy - 3], fh: [4.6, hy - 4.6], be: [1, hy - 3.6], bh: [-1, hy - 4.4],
        }),
      )
    }
    const st = { ...base, fk: [2.4, -5], ff: [3, -1.6], bk: [-2, -5], bf: [-3, -1.6] }
    SF.aim = soldier({ ...st, rifle: [[-1, -15.4], [12, -15.8]], fe: [3, -13.4], fh: [5, -15], be: [1, -13], bh: [0, -15] })
    SF.fire = soldier({ ...st, hip: [-0.6, -9.4], neck: [-0.4, -16.4], head: [0.4, -19.8], rifle: [[-2, -15.2], [11, -15.8]], fe: [2, -13.4], fh: [4, -15], be: [0, -13], bh: [-1, -15] })
    SF.hands = soldier({ ...st, fe: [3, -21], fh: [3.5, -24], be: [-1, -21], bh: [-1.5, -24] })
    const fall = { ...st, fe: [3, -19], fh: [6, -21], be: [-2, -19], bh: [-5, -21] }
    SF.fall = [rotPose(fall, -0.5, [0, -1]), rotPose(fall, -1.25, [0, -1])].map(soldier)
  }

  // ---- robot dog and robot panther ---------------------------------------------------------
  function beast(o) {
    const { len, r, legPh, leap, body, dark, hi, eye, tail } = o
    const g = grid()
    const back = [-len * 0.55, -8 - (leap ? 2 : 0)]
    const front = [len * 0.45, -9 - (leap ? 3 : 0)]
    const legsAt = (x0, y0, ph, ch) => {
      if (leap) {
        const sx = x0 > 0 ? 1 : -1
        capsule(g, [x0, y0], [x0 + sx * 3, y0 + 3], 1, ch)
        capsule(g, [x0 + sx * 3, y0 + 3], [x0 + sx * 6, y0 + 4], 0.8, ch)
        return
      }
      const s = Math.sin(ph)
      const lift = Math.max(0, Math.cos(ph)) * 1.6
      capsule(g, [x0, y0], [x0 + s * 1.6, -4.2], 1.05, ch)
      capsule(g, [x0 + s * 1.6, -4.2], [x0 + s * 3, -1.4 - lift], 0.85, ch)
      dot(g, [x0 + s * 3 + 1, -1.4 - lift], 'E')
    }
    // far legs, tail, body, near legs, head
    legsAt(back[0] + 1, back[1] + 1, legPh + Math.PI, dark)
    legsAt(front[0] - 1, front[1] + 1, legPh, dark)
    const tl = add(back, [-1, 0])
    capsule(g, tl, add(tl, tail[0]), 0.75, dark)
    capsule(g, add(tl, tail[0]), add(tl, tail[1]), 0.65, dark)
    capsule(g, front, back, r, body, dark, -1)
    for (let i = -2; i <= 2; i++) dot(g, add(lerp(back, front, 0.5 + i * 0.16), [0, -r + 0.4]), hi)
    legsAt(back[0], back[1] + 1.2, legPh, body)
    legsAt(front[0], front[1] + 1.2, legPh + Math.PI, body)
    const neck = add(front, [2, -1.6])
    capsule(g, front, neck, r * 0.7, body, dark, -1)
    const h0 = add(neck, [0.6, -0.8])
    const h1 = add(h0, [4.2, 0.6])
    capsule(g, h0, h1, 1.9, body, dark, -1)
    capsule(g, add(h0, [1.5, 1.6]), add(h1, [0.5, 1.6]), 0.7, dark) // jaw
    dot(g, add(h0, [1.6, -0.6]), eye)
    dot(g, add(h0, [2.6, -0.6]), eye)
    capsule(g, add(h0, [-0.6, -1.2]), add(h0, [0.2, -3.6]), 0.6, dark) // ear
    return { sp: pairOutlined(rowsOf(g), P, OUT) }
  }
  const DOG = { len: 12, r: 2.7, body: 'M', dark: 'm', hi: 'X', eye: 'Z', tail: [[-2, -2], [-4, -4.5]] }
  const PAN = { len: 16, r: 3.1, body: 'Q', dark: 'q', hi: 'V', eye: 'c', tail: [[-4, -1], [-7, -4]] }
  const DF = { run: [0, 1, 2, 3].map((i) => beast({ ...DOG, legPh: (i * Math.PI) / 2 })), leap: beast({ ...DOG, legPh: 0, leap: true }) }
  const PF = { run: [0, 1, 2, 3].map((i) => beast({ ...PAN, legPh: (i * Math.PI) / 2 })), leap: beast({ ...PAN, legPh: 0, leap: true }) }
  PF.sit = beast({ ...PAN, legPh: Math.PI / 2 })

  // ---- the hawk Option ---------------------------------------------------------------------
  const HAWK = [
    ['TT..............', '.TTT............', '..TTTT.....NN...', '...ttTTTTTNNNEy.', '....tTTTTTTNN.yy', '......TTTT......', '.......t.t......'],
    ['................', '................', '...........NN...', '....tTTTTTNNNEy.', '..TTTTTTTTTNN.yy', '.TTTT..TTT......', 'TTT.....t.t.....'],
    ['................', '..........NN....', '....TTTTTNNNEy..', '...tTTTTTTNN.yy.', '..tt.TTT........', '.......t........', '................'],
  ].map((r) => pairOutlined(r, P, OUT))

  // ---- Mecha Pon -----------------------------------------------------------------------
  function pon(o) {
    const g = grid()
    const hip = o.hip || [-4, -11]
    const sho = o.sho || [0, -20]
    const head = o.head || [7.5, -19.5]
    const ps = add(sho, [2, 0.5])
    // far arm, legs, torso, head, near arm
    capsule(g, ps, o.be, 2.4, 'm')
    capsule(g, o.be, o.bh, 2.2, 'm')
    capsule(g, o.bh, o.bh, 3.2, 'q')
    capsule(g, hip, o.bk, 2.8, 'm')
    capsule(g, o.bk, o.bf, 2.6, 'm')
    capsule(g, o.bf, add(o.bf, [2.5, 0]), 1.6, 'q')
    capsule(g, sho, hip, 6, 'a', 'm')
    capsule(g, add(sho, [-2, -2]), add(sho, [-4, -1]), 3.4, 'm') // hunched back
    for (let i = 0; i < 3; i++) capsule(g, add(lerp(sho, hip, 0.35 + i * 0.2), [2.2, 0]), add(lerp(sho, hip, 0.35 + i * 0.2), [4.6, 0]), 0.5, 'X')
    capsule(g, hip, o.fk, 2.9, 'M', 'm')
    capsule(g, o.fk, o.ff, 2.7, 'M', 'm')
    capsule(g, o.ff, add(o.ff, [3, 0]), 1.7, 'q')
    capsule(g, sho, add(sho, [1, 0]), 3.2, 'O', 'o')
    capsule(g, add(sho, [2.5, 0.5]), o.fe, 2.6, 'M', 'a')
    capsule(g, o.fe, o.fh, 2.4, 'M', 'a')
    capsule(g, o.fh, o.fh, 3.6, 'A', 'a')
    dot(g, add(o.fh, [1.5, 1.5]), 'm')
    dot(g, add(o.fh, [0, 2]), 'm')
    // the head juts forward, low between the shoulders: dark face, heavy brow, jaw
    disc(g, head, 3.5, [0, -1], [1, 0], (a, f) => (a > 1.4 ? 'X' : a < -1.4 ? 'a' : f < -1.5 ? 'm' : 'q'))
    capsule(g, add(head, [-1, -1.8]), add(head, [3.2, -1.8]), 0.7, 'X')
    capsule(g, add(head, [0.8, -0.2]), add(head, [3, -0.2]), 0.6, o.eye || 'Z')
    capsule(g, add(head, [1, 2]), add(head, [3.4, 2]), 0.6, 'A')
    return { sp: pairOutlined(rowsOf(g), P, OUT) }
  }
  const GF = {}
  {
    const legsA = { fk: [0, -5.6], ff: [1, -2.6], bk: [-6, -5.6], bf: [-7, -2.6] }
    const legsB = { fk: [-2, -5.6], ff: [-2, -2.6], bk: [-4, -5.6], bf: [-4, -2.6] }
    GF.walk = [
      pon({ ...legsA, fe: [8, -12], fh: [10, -3.8], be: [4, -12], bh: [4, -3.8] }),
      pon({ ...legsB, fe: [7, -12.5], fh: [7, -3.8], be: [5, -12], bh: [8, -3.8] }),
    ]
    GF.wind = pon({ ...legsA, hip: [-5, -11], sho: [-2, -20], head: [5, -20], fe: [-4, -16], fh: [-8, -20], be: [4, -12], bh: [5, -3.8] })
    GF.punch = pon({ ...legsA, hip: [-3, -11], sho: [2, -19.5], head: [9.5, -19], fe: [11, -18], fh: [18, -17.6], be: [5, -12], bh: [5, -3.8] })
    GF.raise = pon({ ...legsB, head: [6.5, -21], fe: [5, -26], fh: [7, -30.5], be: [1, -26], bh: [2, -30.5] })
    GF.slam = pon({ ...legsA, hip: [-3, -10], sho: [2, -18], head: [9, -17.4], fe: [10, -11], fh: [14, -3.8], be: [7, -11], bh: [10, -3.8] })
    GF.hurt = pon({ ...legsB, hip: [-5, -11], sho: [-4, -20.5], head: [2.5, -22], fe: [3, -14], fh: [6, -8], be: [-1, -13], bh: [0, -6], eye: 'W' })
    GF.roar = pon({ ...legsA, sho: [0, -21], head: [6, -23], fe: [5, -15], fh: [3, -17.5], be: [3, -15], bh: [0, -17.5], eye: 'y' })
  }

  // ---- small things -------------------------------------------------------------------------
  const BULLET = outline(sprite(['pyy', 'pyy'], P), OUT)
  const ORB = [
    outline(sprite(['..bbb..', '.bcccb.', 'bcWccBb', 'bccWcBb', 'bcccBBb', '.bBBBb.', '..bbb..'], P), OUT),
    outline(sprite(['..ccc..', '.cWWWc.', 'cWWWWWc', 'cWWWWWc', 'cWWWWWc', '.cWWWc.', '..ccc..'], P), OUT),
  ]
  const BOOM = [2.2, 4, 5.6, 6.4].map((R, i) => {
    const n = 15
    const g = Array.from({ length: n }, () => Array(n).fill('.'))
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        const r = Math.hypot(k - 7, j - 7)
        if (r > R) continue
        const q = r / R
        if (i === 3 && q < 0.6) continue
        g[j][k] = i === 3 ? (q > 0.85 ? 'a' : 'p') : q < 0.4 ? 'W' : q < 0.7 ? 'y' : 'p'
      }
    return sprite(g.map((r) => r.join('')), P)
  })
  const BITS = ['a', 'A', 'M', 'p', 'y']
  const SPARK = ['W', 'c', 'y']

  // ---- layout helpers ---------------------------------------------------------------------
  function openSpot(s, x, hw) {
    const blocks = s.fix.map((f) => [f.x - 3, f.x + f.w + 3])
    const ok = (c) => c - hw >= 3 && c + hw <= s.W - 3 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 2) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 3, s.W - hw - 3)
  }
  const edgeX = (s, x) => clamp(x, 9, s.W - 9)
  /** Obstacles as merged spans along the floor, with the title flagged. */
  function spans(s) {
    const list = s.fix.map((f) => ({ a: f.x, b: f.x + f.w, title: f.kind === 'title' })).sort((p, q) => p.a - q.a)
    const out = []
    for (const o of list) {
      const last = out[out.length - 1]
      if (last && !last.title && !o.title && o.a - last.b < 22) last.b = Math.max(last.b, o.b)
      else out.push({ ...o })
    }
    return out
  }
  const MEIO = ['Kneel before Meio, Strider.', 'The Third Moon is already mine.', 'You are too late, Hiryu.', 'Pon! Crush that insect!', 'Your clan sent only one?', 'All of Earth will bow to me.']
  const MEIO_LOSE = ['Impossible... Pon!', 'This is not over, Strider.', 'Curse you, Hiryu!']
  const meio = (s, list) => s.say(pick(list), s.W / 2, 1, { color: '#d39bff', life: 3.4 })

  const engaged = (s, now) => now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (s.cursor && now - s.cursor.since < 2500) || keyed(s, now)
  // the keyboard is the game's (armed by a click on a character), or a game key went down lately
  const keyed = (s, now) => now - (s.keyAt ?? -1e9) < 9000
  const keyDir = (s) => (s.keys?.has('right') ? 1 : 0) - (s.keys?.has('left') ? 1 : 0)
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0 // big leaps may rise a little above the bar

  // ---- Hiryu ---------------------------------------------------------------------------------
  const RUN = 108
  class Hiryu {
    constructor(s) {
      this.s = s
      this.x = openSpot(s, s.W * 0.3, 12)
      this.y = FLOOR
      this.vx = 0
      this.vy = 0
      this.dir = 1
      this.state = 'stand'
      this.t = 0
      this.rt = 0
      this.ph = 0
      this.plan = []
      this.z = 4
      this.moving = false
      this.slashCd = 0
      this.inv = 0
      this.flash = 0
      this.lookAt = 0
      this.decideAt = performance.now() + 1500
      this.restT = 0
      this.asleep = false
      this.grabbable = true
      this.clicks = []
    }
    get grounded() {
      return this.y >= FLOOR - 0.01 && !['flip', 'spring', 'cling', 'held', 'fall'].includes(this.state)
    }
    hurtbox() {
      const st = this.state
      if (st === 'flip' || st === 'held' || st === 'fall' || this.inv > 0) return null
      if (st === 'slide') return [this.x - 9, this.x + 11, this.y - 11, this.y]
      if (st === 'crouch') return [this.x - 6, this.x + 6, this.y - 18, this.y]
      return [this.x - 5, this.x + 5, this.y - 25, this.y]
    }
    hit(x, y) {
      const top = this.state === 'slide' ? 13 : this.state === 'crouch' ? 20 : this.state === 'flip' ? 18 : 28
      return Math.abs(x - this.x) < 10 && y > this.y - top - 2 && y < this.y + 2
    }
    wind() {
      const st = this.state
      if (st === 'win') return 1
      if (st === 'slide' || st === 'flip' || st === 'fall') return 1
      if (st === 'run') return 0.95
      if (st === 'held') return 0.6
      if (st === 'crouch') return 0.6
      return 0.38
    }

    // -- moves --
    go(x) {
      this.tx = edgeX(this.s, x)
      if (Math.abs(this.tx - this.x) < 2) return false
      this.state = 'run'
      this.t = 0
      return true
    }
    slash() {
      if (!this.grounded && this.state !== 'stand') return
      this.state = 'slash'
      this.t = 0
      this.struck = false
      this.slashCd = 0.32
    }
    slide(to) {
      to = edgeX(this.s, to)
      if (Math.abs(to - this.x) < 8) return false
      this.dir = Math.sign(to - this.x)
      this.sx = to
      this.state = 'slide'
      this.t = 0
      this.cutBoss = false
      this.s.burst(this.x - this.dir * 4, FLOOR - 2, 5, ['a', 'A', 'n'])
      return true
    }
    flip(to, h = 18, y0 = this.y) {
      to = edgeX(this.s, to)
      const dx = to - this.x
      if (Math.abs(dx) > 1) this.dir = Math.sign(dx)
      this.fx0 = this.x
      this.fx1 = to
      this.fy0 = y0
      this.fh = Math.min(h, FLOOR - 18 + SPILL)
      this.fT = clamp(Math.abs(dx) / 120, 0.45, 0.95)
      this.state = 'flip'
      this.t = 0
    }
    hurt(fromDir) {
      if (this.inv > 0 || this.state === 'flip') return
      this.state = 'hurt'
      this.t = 0
      this.dir = -fromDir
      this.vx = fromDir * 70
      this.inv = 1.3
      this.plan.length = 0
      this.s.burst(this.x, this.y - 16, 8, ['W', 'y', 'R'])
    }
    /** Steps that take him to x: slides beneath the title, cartwheels over the rest. */
    pathTo(tx) {
      const s = this.s
      tx = edgeX(s, tx)
      const steps = []
      let x = this.x
      const dir = Math.sign(tx - x)
      if (!dir) return steps
      const list = spans(s).filter((o) => (dir > 0 ? o.b > x : o.a < x))
      if (dir < 0) list.reverse()
      for (const o of list) {
        const near = dir > 0 ? o.a : o.b
        const far = dir > 0 ? o.b : o.a
        if ((near - x) * dir < 2) continue // already in front of it
        if ((tx - near) * dir <= 0) break // stops short of it
        if (o.title) {
          if ((tx - far) * dir < 0) {
            // destination is under the title: slide right up to it
            if ((near - x) * dir > 26) steps.push({ k: 'go', x: near - dir * 24 })
            steps.push({ k: 'slide', x: tx })
            return steps
          }
          if ((near - x) * dir > 26) steps.push({ k: 'go', x: near - dir * 24 })
          const end = edgeX(s, far + dir * 12)
          steps.push({ k: 'slide', x: end })
          x = end
        } else {
          if ((near - x) * dir > 16) steps.push({ k: 'go', x: near - dir * 13 })
          const land = edgeX(s, far + dir * 11)
          steps.push({ k: 'flip', x: land, h: 20 })
          x = land
        }
      }
      steps.push({ k: 'go', x: tx })
      return steps
    }
    setPlan(steps) {
      this.plan = steps
      if (['stand', 'run', 'ready'].includes(this.state)) {
        this.state = 'stand'
        this.next()
      }
    }
    next() {
      while (this.plan.length) {
        const st = this.plan.shift()
        if (st.k === 'go' && this.go(st.x)) return true
        if (st.k === 'slide' && this.slide(st.x)) return true
        if (st.k === 'flip') {
          this.flip(st.x, st.h)
          return true
        }
        if (st.k === 'slash') {
          if (st.dir) this.dir = st.dir
          this.slash()
          return true
        }
        if (st.k === 'face') this.dir = st.dir
        if (st.k === 'wall') {
          this.state = 'cling'
          this.t = 0
          this.dir = st.side
          return true
        }
        if (st.k === 'crouch') {
          this.state = 'crouch'
          this.t = 0
          this.restT = 0
          return true
        }
        if (st.k === 'win') {
          this.state = 'win'
          this.t = 0
          return true
        }
        if (st.k === 'hold') {
          this.holdUntil = performance.now() + st.ms
          return false
        }
      }
      return false
    }
    attack(f) {
      // sent at a foe (by a click or by the autopilot)
      const side = Math.sign(f.x - this.x) || this.dir
      const gap = Math.abs(f.x - this.x) - f.hw
      if (gap < 22) {
        this.dir = side
        this.plan = []
        this.slash()
        return
      }
      const steps = this.pathTo(f.x - side * (f.hw + 12))
      // a direct dash at a grounded foe in the open: slide through it instead, now and then
      if (steps.length === 1 && f.grounded && gap > 40 && gap < 110 && Math.random() < 0.4) steps[0] = { k: 'slide', x: f.x + side * (f.hw + 10) }
      steps.push({ k: 'slash', dir: side })
      this.target = f
      this.setPlan(steps)
    }

    // -- user --
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.clickAt = now
      this.clicks = this.clicks.filter((t) => now - t < 2500)
      this.clicks.push(now)
      if (this.state === 'crouch') {
        this.asleep = false
        this.state = 'stand'
        this.slash()
        return
      }
      if (this.clicks.length >= 5) {
        // easter egg: the triple somersault
        this.clicks.length = 0
        this.plan = [{ k: 'flip', x: openSpot(s, this.x + this.dir * 70, 10), h: 26 }, { k: 'flip', x: openSpot(s, this.x - this.dir * 10, 10), h: 24 }, { k: 'win' }]
        this.state = 'stand'
        this.next()
        s.say('Strider Hiryu!', this.x, 1, { color: '#9ab4ff', life: 2.4 })
        return
      }
      if (!this.grounded && this.state !== 'stand') return
      if (this.state === 'slide' || this.state === 'slash') return
      this.plan = []
      this.target = null
      if (this.clicks.length % 2 === 1) {
        if (s.cursor) this.dir = s.cursor.x >= this.x ? 1 : -1
        this.slash()
      } else {
        let dir = this.dir
        if ((dir > 0 && this.x > s.W - 60) || (dir < 0 && this.x < 60)) dir = -dir
        this.dir = dir
        const t = spans(s).find((o) => o.title && (dir > 0 ? o.a > this.x && o.a - this.x < 150 : o.b < this.x && this.x - o.b < 150))
        this.slide(t ? (dir > 0 ? t.b + 12 : t.a - 12) : this.x + dir * 80)
      }
    }
    onDblClick() {
      if (this.state !== 'stand' && this.state !== 'run' && this.state !== 'slash') return
      this.plan = []
      this.flip(openSpot(this.s, this.x + this.dir * 60, 10), 26)
    }
    grab(p) {
      this.s.data.grabAt = performance.now()
      this.plan = []
      this.state = 'held'
      this.asleep = false
      this.t = 0
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (this.state !== 'held') return
      const nx = clamp(p.x, 8, this.s.W - 8)
      if (Math.abs(nx - this.x) > 1.5) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.y = clamp(p.y + 27, 26 - SPILL, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.s.data.grabAt = performance.now()
      // he lets go of the "grip", tucks and lands on his feet
      this.state = 'fall'
      this.vy = -40
      this.t = 0
    }

    update(dt, now, s) {
      const d = s.data
      const awake = s.lively(now)
      this.t += dt
      this.ph += dt * (4 + 10 * this.wind())
      this.slashCd -= dt
      if (this.inv > 0) this.inv -= dt
      this.moving = !['stand', 'crouch', 'win'].includes(this.state)
      // A/D held: he runs that way at once; let go and he stops where he is
      const kx = keyDir(s)
      if (kx && ['stand', 'run', 'crouch', 'win'].includes(this.state)) {
        this.plan = []
        this.target = null
        this.asleep = false
        this.dir = kx
        this.tx = edgeX(s, this.x + kx * 24)
        if (this.state !== 'run') this.t = 0
        this.state = Math.abs(this.tx - this.x) > 0.5 ? 'run' : 'stand'
        this.keyRun = true
      } else if (this.keyRun) {
        this.keyRun = false
        if (this.state === 'run') this.tx = this.x
      }
      switch (this.state) {
        case 'run': {
          const dx = this.tx - this.x
          this.dir = Math.sign(dx) || this.dir
          const step = RUN * dt
          this.rt += dt
          if (Math.abs(dx) <= step) {
            this.x = this.tx
            this.state = 'stand'
            this.t = 0
          } else this.x += this.dir * step
          if (!this.reflex(now, s)) if (this.state === 'stand') this.next()
          return FAST
        }
        case 'slide': {
          const v = Math.max(115, 190 - this.t * 55)
          this.x += this.dir * v * dt
          if (Math.random() < 0.35) s.particle({ img: pix(pick(['a', 'A'])), x: this.x - this.dir * 8, y: FLOOR - rand(1, 3), vx: -this.dir * rand(10, 30), vy: -rand(4, 14), g: 40, life: 0.4, fade: true })
          for (const f of d.foes) {
            if (!f.alive) continue
            const ahead = (f.x - this.x) * this.dir
            if (f.kind === 'boss') {
              if (!this.cutBoss && Math.abs(f.x - this.x) < f.hw && f.grounded) {
                this.cutBoss = true
                f.cut(this.dir, now)
              }
            } else if (f.grounded && ahead > -4 && ahead - f.hw < 12) f.cut(this.dir, now)
          }
          if ((this.x - this.sx) * this.dir >= 0 || this.x <= 8 || this.x >= s.W - 8) {
            this.x = edgeX(s, this.x)
            this.state = 'spring'
            this.vy = -105
            this.vx = this.dir * 45
            this.t = 0
          }
          return FAST
        }
        case 'spring':
        case 'fall': {
          this.vy += 560 * dt
          this.y += this.vy * dt
          this.x = edgeX(s, this.x + (this.vx || 0) * dt)
          if (this.y >= FLOOR && this.vy > 0) {
            this.y = FLOOR
            this.vx = 0
            if (this.state === 'fall') s.burst(this.x, FLOOR - 1, 6, ['a', 'A'])
            this.state = 'stand'
            this.t = 0
            this.next()
          }
          return FAST
        }
        case 'flip': {
          const u = clamp(this.t / this.fT, 0, 1)
          this.x = this.fx0 + (this.fx1 - this.fx0) * u
          this.y = this.fy0 + (FLOOR - this.fy0) * u - 4 * this.fh * u * (1 - u)
          // the spinning cypher cuts on the way
          for (const f of d.foes)
            if (f.alive && f.kind !== 'boss' && Math.abs(f.x - this.x) < f.hw + 6 && Math.abs(f.y - f.hh / 2 - (this.y - 9)) < f.hh / 2 + 7) f.cut(this.dir, now)
          if (u >= 1) {
            this.y = FLOOR
            this.state = 'stand'
            this.t = 0
            this.next()
          }
          return FAST
        }
        case 'cling': {
          // up the bar's end wall, a beat, then a long somersault back into the fight
          const side = this.dir
          this.x = side > 0 ? s.W - 8 : 8
          this.y = FLOOR - Math.min(1, this.t / 0.16) * 9
          if (this.t > 0.45) {
            this.dir = -side
            this.flip(openSpot(s, this.x - side * rand(90, 150), 10), 22, this.y)
          }
          return FAST
        }
        case 'slash': {
          if (!this.struck && this.t > 0.07) {
            this.struck = true
            this.strike(now, s)
          }
          if (this.t > 0.34) {
            this.state = 'stand'
            this.t = 0
            this.next()
          }
          return FAST
        }
        case 'hurt': {
          this.vx *= Math.pow(0.02, dt)
          this.x = edgeX(s, this.x + this.vx * dt)
          if (this.t > 0.45) {
            this.state = 'stand'
            this.t = 0
          }
          return FAST
        }
        case 'held':
          return FAST
        case 'win':
          if (this.t > 4.2) {
            this.state = 'stand'
            this.t = 0
            this.decideAt = now + rand(800, 2000)
          }
          return FAST
        case 'crouch': {
          if (awake) {
            this.asleep = false
            this.state = 'stand'
            this.t = 0
            this.resting = false
            this.decideAt = now + rand(500, 1400)
            return FAST
          }
          this.restT += dt
          if (this.restT < 6) return FAST // the scarf settles
          this.asleep = true
          this.moving = false
          return Infinity
        }
      }
      return this.think(now, s, awake)
    }

    // stand state: reflexes, then the plan, then the autopilot or the user
    think(now, s, awake) {
      const d = s.data
      if (!awake) {
        if (!this.resting) {
          this.resting = true
          this.plan = this.pathTo(openSpot(s, this.x, 14))
          this.plan.push({ k: 'face', dir: this.x < s.W / 2 ? 1 : -1 }, { k: 'crouch' })
        }
        if (this.next()) return FAST
        if (this.state !== 'crouch' && !this.plan.length) {
          this.state = 'crouch'
          this.restT = 0
        }
        return FAST
      }
      this.resting = false
      if (this.reflex(now, s)) return FAST
      if (this.holdUntil && now < this.holdUntil) return FAST
      if (this.next()) return FAST
      const user = engaged(s, now)
      // he keeps an eye on the cursor
      if (s.cursor && now > this.lookAt && Math.abs(s.cursor.x - this.x) > 6) {
        const want = s.cursor.x > this.x ? 1 : -1
        if (want !== this.dir) {
          this.dir = want
          this.lookAt = now + 600
        }
      }
      if (user) return FAST // the user is playing: no autopilot
      const live = d.foes.filter((f) => f.alive && f.onField(s))
      if (live.length) {
        if (now > (this.engageAt || 0)) {
          this.engageAt = now + 500
          let best = live[0]
          for (const f of live) if (Math.abs(f.x - this.x) - (f.kind === 'boss' ? 30 : 0) < Math.abs(best.x - this.x) - (best.kind === 'boss' ? 30 : 0)) best = f
          this.attack(best)
        }
        return FAST
      }
      if (d.orb && d.orb.landed && !d.orb.dead) {
        this.setPlan(this.pathTo(d.orb.x))
        return FAST
      }
      if (now > this.decideAt) {
        this.decideAt = now + rand(2500, 5000)
        if (Math.random() < 0.55) {
          // patrol to the far side (the title means a slide)
          const t = s.fixture('title')
          const far = t ? (this.x < t.x + t.w / 2 ? rand(t.x + t.w + 20, s.W - 40) : rand(40, t.x - 20)) : rand(30, s.W - 30)
          this.setPlan(this.pathTo(openSpot(s, far, 10)))
        } else if (Math.random() < 0.5) this.slash()
        return FAST
      }
      return FAST
    }
    /** Instant reactions to danger: deflect bullets, cut what is in reach, dodge. */
    reflex(now, s) {
      const d = s.data
      if (this.slashCd > 0) return false
      for (const a of s.actors) {
        if (!(a instanceof Bullet) || a.dead || a.seen) continue
        const ahead = (a.x - this.x) * this.dir
        const toward = Math.sign(a.vx) === -Math.sign(a.x - this.x)
        if (!toward || Math.abs(a.x - this.x) > 40) continue
        a.seen = true
        const r = Math.random()
        if (r < 0.12) continue // too slow this time
        if (ahead < 0) this.dir = -this.dir
        this.plan = []
        if (r < 0.7) this.slash()
        else if (r < 0.88) this.slide(this.x + this.dir * 60)
        else this.flip(this.x + this.dir * 55, 16)
        return true
      }
      for (const f of d.foes) {
        if (!f.alive) continue
        const dx = f.x - this.x
        const gap = Math.abs(dx) - f.hw
        const reach = f.kind === 'dog' && !f.grounded ? 34 : 22
        if (gap < reach && f.y - f.hh < this.y + 2 && f.y > this.y - 34) {
          if (f.kind === 'boss' && f.state === 'wind' && Math.random() < 0.6) {
            // Pon winds up: slide right under him to the other side
            this.plan = []
            if (this.slide(f.x + Math.sign(dx) * (f.hw + 14))) return true
          }
          this.dir = Math.sign(dx) || this.dir
          this.slash()
          return true
        }
      }
      return false
    }
    strike(now, s) {
      const d = s.data
      for (const f of d.foes) {
        if (!f.alive) continue
        const ahead = (f.x - this.x) * this.dir
        if (ahead > -6 && ahead - f.hw < 27 && f.y - f.hh < this.y + 2 && f.y > this.y - 36) f.cut(this.dir, now)
      }
      for (const a of s.actors)
        if (a instanceof Bullet && !a.dead) {
          const ahead = (a.x - this.x) * this.dir
          if (ahead > -4 && ahead < 30) {
            a.dead = true
            s.burst(a.x, a.y, 5, SPARK)
          }
        }
    }

    frame() {
      switch (this.state) {
        case 'run':
          return HF.run[Math.floor(this.rt * 15) % 6]
        case 'slide':
          return HF.slide[Math.floor(this.t * 10) % 2]
        case 'spring':
          return HF.leap
        case 'fall':
          return this.vy < 60 ? HF.tuck[Math.floor(this.t * 16) % 8] : HF.leap
        case 'flip':
          return HF.tuck[Math.floor(clamp(this.t / this.fT, 0, 0.999) * 8 * (this.fT > 0.7 ? 2 : 1)) % 8]
        case 'cling':
          return HF.cling
        case 'held':
          return HF.cling
        case 'slash':
          return HF.slash[this.t < 0.07 ? 0 : this.t < 0.2 ? 1 : 2]
        case 'hurt':
          return HF.hurt
        case 'win':
          return HF.win
        case 'crouch':
          return HF.crouch
        default: {
          const s = this.s
          if (s.cursor && Math.abs(s.cursor.x - this.x) < 40 && s.cursor.y < 12) return HF.look
          return s.data.foes.some((f) => f.alive && Math.abs(f.x - this.x) < 90) ? HF.ready : HF.stand
        }
      }
    }
    drawScarf(c, fr) {
      const ax = this.x + this.dir * fr.nx
      const ay = this.y + fr.ny
      const wind = this.wind()
      const N = 12
      const amp = this.state === 'win' ? 1.6 : 1
      const pts = SCARF
      for (let i = 1; i <= N; i++) {
        const k = i / N
        let px = ax - this.dir * i * 1.45 * (0.3 + 0.7 * wind)
        let py = ay + i * 1.45 * (0.85 * (1 - wind) + 0.08) + Math.sin(this.ph - i * 0.75) * (0.3 + 2.4 * k) * (0.35 + 0.65 * wind) * amp
        if (py > FLOOR - 1) {
          px -= this.dir * (py - FLOOR + 1) * 0.8
          py = FLOOR - 1
        }
        pts[i * 2] = px
        pts[i * 2 + 1] = py
      }
      c.fillStyle = OUT
      for (let i = 1; i <= N; i++) c.fillRect(Math.round(pts[i * 2]) - 1, Math.round(pts[i * 2 + 1]) - 1, i < N - 2 ? 4 : 3, 4)
      for (let i = 1; i <= N; i++) {
        const x = Math.round(pts[i * 2])
        const y = Math.round(pts[i * 2 + 1])
        c.fillStyle = P.R
        c.fillRect(x, y, i < N - 2 ? 2 : 1, 2)
        c.fillStyle = P.r
        c.fillRect(x, y + 1, i < N - 2 ? 2 : 1, 1)
      }
    }
    draw(c) {
      if (this.inv > 0 && this.state !== 'hurt' && Math.floor(this.inv * 14) % 2) return
      const fr = this.frame()
      this.drawScarf(c, fr)
      const ax = this.dir === 1 ? CX : FW - 1 - CX
      c.drawImage(fr.sp[this.dir], Math.round(this.x) - ax - 1, Math.round(this.y) - FH - 1)
      if (this.state === 'slash' && this.t >= 0.07) {
        const a = ARC[this.t < 0.2 ? 0 : 1]
        const img = a[this.dir]
        const ox = this.dir === 1 ? a.cx : img.width - 1 - a.cx
        c.drawImage(img, Math.round(this.x + this.dir * 3) - ox, Math.round(this.y - 19) - a.cy)
      }
    }
  }
  const SCARF = new Float32Array(32)

  // ---- foes -----------------------------------------------------------------------------------
  class Foe {
    constructor(s, kind, x, dir) {
      this.s = s
      this.kind = kind
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.alive = true
      this.t = 0
      this.z = 2
      this.moving = true
      this.grabbable = true
    }
    get grounded() {
      return this.y >= FLOOR - 0.5 && !this.held
    }
    onField(s) {
      return this.x > 4 && this.x < s.W - 4 && !this.fleeing
    }
    hit(x, y) {
      return this.alive && Math.abs(x - this.x) < this.hw + 4 && y > this.y - this.hh - 3 && y < this.y + 2
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      s.data.hiryu.attack(this)
      s.particle({ img: BUBBLE['!'], x: this.x - 2, y: this.y - this.hh - 9, vy: -4, life: 0.7 })
    }
    grab(p) {
      if (!this.alive || this.kind === 'boss') return
      this.s.data.grabAt = performance.now()
      this.held = true
      this.drag(p)
    }
    drag(p) {
      if (!this.held) return
      this.s.data.grabAt = performance.now()
      const nx = clamp(p.x, 6, this.s.W - 6)
      this.vx = (nx - this.x) * 10
      this.x = nx
      this.y = clamp(p.y + this.hh / 2, this.hh, FLOOR)
    }
    drop() {
      if (!this.held) return
      this.held = false
      this.s.data.grabAt = performance.now()
      this.thrown = true
      this.vy = -30
      this.vx = clamp(this.vx || 0, -160, 160)
    }
    thrownStep(dt, now) {
      this.vy += 500 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.x < 6 || this.x > this.s.W - 6) this.vx = -this.vx * 0.5
      this.x = clamp(this.x, 6, this.s.W - 6)
      if (this.y >= FLOOR) {
        this.y = FLOOR
        this.thrown = false
        this.cut(Math.sign(this.vx) || 1, now) // slammed into the floor
      }
    }
    die(now, digits) {
      this.alive = false
      this.dying = 0
      this.moving = false
      const s = this.s
      s.data.kills++
      s.particle({ digits, x: this.x - 6, y: this.y - this.hh - 7, vy: -14, life: 0.9 })
    }
  }

  class Soldier extends Foe {
    constructor(s, x, dir) {
      super(s, 'soldier', x, dir)
      this.hw = 5
      this.hh = 23
      this.state = 'walk'
      this.walkT = 0
      this.post = null
      this.fireAt = performance.now() + rand(900, 1800)
      this.shots = 0
      this.postAt = 0
    }
    cut(dir, now) {
      if (!this.alive) return
      this.dir = -dir
      this.die(now, '100')
      this.s.burst(this.x, this.y - 13, 12, ['R', 'r', 'y', 'W'])
    }
    onDblClick() {
      // a click too many: he throws up his hands and runs for it
      if (!this.alive) return
      this.s.data.clickAt = performance.now()
      this.state = 'hands'
      this.t = 0
      this.s.say(pick(['Nyet!', 'Ne strelyay!', 'Bozhe moy!']), this.x, this.y - 32, { color: '#f0d890', life: 1.6 })
    }
    update(dt, now, s) {
      this.t += dt
      if (this.held) return FAST
      if (this.thrown) {
        this.thrownStep(dt, now)
        return FAST
      }
      if (!this.alive) {
        this.dying += dt
        if (this.dying > 1.1) this.dead = true
        return FAST
      }
      const h = s.data.hiryu
      const awake = s.lively(now)
      if (!awake || this.state === 'flee') {
        this.state = 'flee'
        this.fleeing = true
        this.dir = this.x < s.W / 2 ? -1 : 1
        this.x += this.dir * 55 * dt
        this.walkT += dt
        if (this.x < -14 || this.x > s.W + 14) this.dead = true
        return FAST
      }
      if (this.state === 'hands') {
        if (this.t > 1.2) this.state = 'flee'
        return FAST
      }
      if (!this.post || now > this.postAt) {
        const side = Math.sign(this.x - h.x) || 1
        this.post = openSpot(s, clamp(h.x + side * rand(48, 88), 12, s.W - 12), 6)
        this.postAt = now + rand(2500, 4500)
      }
      const dx = this.post - this.x
      if (Math.abs(dx) > 2 && this.state !== 'fire') {
        this.state = 'walk'
        this.dir = Math.sign(dx)
        this.x += this.dir * 38 * dt
        this.walkT += dt
        this.moving = true
      } else {
        this.moving = false
        if (this.state === 'walk') this.state = 'aim'
        this.dir = Math.sign(h.x - this.x) || this.dir
        if (this.state === 'fire' && this.t > 0.25) this.state = 'aim'
        if (now > this.fireAt && Math.abs(h.x - this.x) < 170 && h.state !== 'crouch') {
          this.state = 'fire'
          this.t = 0
          this.fireAt = now + rand(1300, 2400)
          s.spawn(new Bullet(this.x + this.dir * 13, this.y - 17, this.dir * 120))
          if (++this.shots > 2 && Math.random() < 0.5) {
            this.shots = 0
            this.postAt = 0
          }
        }
      }
      return FAST
    }
    draw(c) {
      let fr
      if (!this.alive) {
        if (this.dying > 0.6 && Math.floor(this.dying * 14) % 2) return
        fr = SF.fall[this.dying < 0.15 ? 0 : 1]
      } else if (this.held || this.thrown) fr = SF.fall[0]
      else if (this.state === 'hands') fr = SF.hands
      else if (this.state === 'walk' || this.state === 'flee') fr = SF.walk[Math.floor(this.walkT * 8) % 4]
      else fr = this.state === 'fire' ? SF.fire : SF.aim
      const ax = this.dir === 1 ? CX : FW - 1 - CX
      c.drawImage(fr.sp[this.dir], Math.round(this.x) - ax - 1, Math.round(this.y) - FH - 1)
      if (this.state === 'fire' && this.t < 0.08 && this.alive) c.drawImage(STAR, Math.round(this.x + this.dir * 14) - 1, Math.round(this.y - 18))
    }
  }

  class Dog extends Foe {
    constructor(s, x, dir) {
      super(s, 'dog', x, dir)
      this.hw = 9
      this.hh = 13
      this.vx = 0
      this.vy = 0
      this.turnAt = 0
      this.runT = 0
    }
    cut(dir, now) {
      if (!this.alive) return
      this.die(now, '200')
      this.vy = -60
      this.s.burst(this.x, this.y - 7, 14, BITS)
    }
    onDblClick() {
      // the easter egg: scratch it behind the ear and it sits, tail going, then trots off
      if (!this.alive || !this.grounded) return
      this.s.data.clickAt = performance.now()
      this.state = 'sit'
      this.t = 0
      this.s.particle({ img: BUBBLE['♥'], x: this.x - 3, y: this.y - 22, vy: -6, life: 1.4 })
    }
    update(dt, now, s) {
      this.t += dt
      if (this.held) return FAST
      if (this.thrown) {
        this.thrownStep(dt, now)
        return FAST
      }
      if (!this.alive) {
        this.dying += dt
        if (this.dying > 0.25) this.dead = true
        return FAST
      }
      const h = s.data.hiryu
      if (this.state === 'sit') {
        this.moving = false
        if (this.t > 2) {
          this.state = 'flee'
          this.fleeing = true
        }
        return FAST
      }
      if (!this.grounded) {
        this.vy += 520 * dt
        this.x += this.vx * dt
        this.y += this.vy * dt
        if (this.y >= FLOOR) {
          this.y = FLOOR
          this.vy = 0
          this.turnAt = now + 450
        }
      } else if (!s.lively(now) || this.state === 'flee') {
        this.fleeing = true
        this.dir = this.x < s.W / 2 ? -1 : 1
        this.x += this.dir * 120 * dt
        this.runT += dt
        if (this.x < -16 || this.x > s.W + 16) this.dead = true
      } else {
        const dx = h.x - this.x
        if (now > this.turnAt && Math.sign(dx) !== this.dir && Math.abs(dx) > 14) {
          this.dir = Math.sign(dx)
          this.turnAt = now + 700
        }
        this.x += this.dir * 118 * dt
        this.runT += dt
        if (dx * this.dir > 0 && Math.abs(dx) < 38 && now > this.turnAt) {
          this.vy = -150
          this.vx = this.dir * 125
          this.y -= 1
        }
      }
      this.x = clamp(this.x, -20, s.W + 20)
      // bite
      const hb = h.hurtbox()
      if (hb && !this.fleeing && this.x + this.hw > hb[0] && this.x - this.hw < hb[1] && this.y - this.hh < hb[3] && this.y > hb[2] && Math.abs(this.x - h.x) < 8) {
        h.hurt(this.dir)
        this.vx = -this.dir * 60
        this.vy = -90
        this.y -= 1
        this.turnAt = now + 800
      }
      return FAST
    }
    draw(c) {
      const fr = this.held || this.thrown ? DF.leap : !this.grounded ? DF.leap : this.state === 'sit' ? DF.run[1] : DF.run[Math.floor(this.runT * 14) % 4]
      const ax = this.dir === 1 ? CX : FW - 1 - CX
      c.drawImage(fr.sp[this.dir], Math.round(this.x) - ax - 1, Math.round(this.y) - FH - 1)
      if (this.state === 'sit' && Math.floor(this.t * 8) % 2) c.drawImage(pix('m'), Math.round(this.x - this.dir * 12), Math.round(this.y - 12))
    }
  }

  class Pon extends Foe {
    constructor(s, x, dir) {
      super(s, 'boss', x, dir)
      this.hw = 12
      this.hh = 30
      this.hp = 26
      this.state = 'enter'
      this.y = -10
      this.vy = 0
      this.flashT = 0
      this.grabbable = false
      this.next = performance.now() + 1500
      this.z = 1.5
    }
    get grounded() {
      return this.y >= FLOOR - 0.5
    }
    onField() {
      return this.state !== 'leave' && this.state !== 'explode'
    }
    cut(dir, now) {
      if (!this.alive || this.state === 'explode' || this.state === 'enter') return
      this.hp--
      this.flashT = 0.12
      this.s.burst(this.x - dir * 6, this.y - 16, 6, SPARK)
      this.s.particle({ digits: '50', x: this.x - 4, y: this.y - 34, vy: -12, life: 0.7 })
      if (this.hp <= 3) {
        if (this.s.busy) {
          // he refuses to go down while the agent is still working
          this.hp = 16
          this.state = 'roar'
          this.t = 0
          meio(this.s, ['Get up, Pon!', 'Pon! Rebuild yourself!'])
        } else this.explode(now)
      }
    }
    explode(now) {
      if (this.state === 'explode') return
      this.state = 'explode'
      this.t = 0
      this.moving = true
      const d = this.s.data
      for (let i = 0; i < 7; i++) d.booms.push({ at: now + i * 230, x: this.x + rand(-12, 12), y: this.y - rand(4, 28) })
      d.booms.sort((a, b) => a.at - b.at)
    }
    leave() {
      if (this.state === 'explode' || this.state === 'leave') return
      this.state = 'leave'
      this.vy = -230
    }
    update(dt, now, s) {
      this.t += dt
      if (this.flashT > 0) this.flashT -= dt
      const h = s.data.hiryu
      const st = this.state
      if (st === 'explode') {
        if (this.t > 1.75) {
          this.dead = true
          this.alive = false
          s.burst(this.x, this.y - 15, 30, ['W', 'y', 'p', 'R', 'a'])
          for (const [ox, oy] of [[0, -15], [-9, -8], [9, -22], [7, -6], [-7, -25]]) s.spawn(new Boom(this.x + ox, this.y + oy))
          s.data.kills++
          s.particle({ digits: '5000', x: this.x - 8, y: 6, vy: -6, life: 1.6 })
          meio(s, MEIO_LOSE)
        }
        return FAST
      }
      if (st === 'enter' || st === 'leap' || st === 'leave' || this.y < FLOOR) {
        this.vy += 600 * dt
        this.y += this.vy * dt
        this.x = clamp(this.x + (this.vx || 0) * dt, 14, s.W - 14)
        if (st === 'leave' && this.y < -50) this.dead = true
        if (st !== 'leave' && this.y >= FLOOR) {
          this.y = FLOOR
          this.vx = 0
          this.vy = 0
          this.state = 'slam'
          this.t = 0
          // shockwave
          for (const k of [-1, 1]) for (let i = 0; i < 6; i++) s.particle({ img: pix(pick(['p', 'y', 'a'])), x: this.x + k * (8 + i * 3), y: FLOOR - 2, vx: k * rand(60, 110), vy: -rand(10, 40), g: 120, life: 0.6, fade: true })
          if (h.grounded && h.state !== 'slide' && Math.abs(h.x - this.x) < 30) h.hurt(Math.sign(h.x - this.x) || 1)
        }
        return FAST
      }
      if (!s.lively(now)) {
        this.leave()
        return FAST
      }
      const dx = h.x - this.x
      const gap = Math.abs(dx) - this.hw
      switch (st) {
        case 'slam':
        case 'recover':
          if (this.t > 0.6) this.state = 'stalk'
          break
        case 'roar':
          if (this.t > 1.2) this.state = 'stalk'
          if (Math.floor(this.t * 6) !== Math.floor((this.t - dt) * 6)) s.burst(this.x, this.y - 22, 3, SPARK)
          break
        case 'wind':
          if (this.t > 0.55) {
            this.state = 'punch'
            this.t = 0
            const hb = h.hurtbox()
            const ahead = (h.x - this.x) * this.dir
            if (hb && ahead > 0 && ahead < 30 && h.state !== 'slide') h.hurt(this.dir)
          }
          break
        case 'punch':
          if (this.t > 0.3) {
            this.state = 'recover'
            this.t = 0
          }
          break
        default: {
          // stalk
          if (Math.abs(dx) > 10 && now > (this.turnAt || 0) && Math.sign(dx) !== this.dir) {
            this.dir = Math.sign(dx)
            this.turnAt = now + 700
          }
          if (now > this.next) {
            this.next = now + rand(1600, 2800)
            if (gap > 50 && Math.random() < 0.55) {
              this.state = 'leap'
              this.t = 0
              this.vy = -230
              this.vx = clamp(dx * 1.4, -140, 140)
              this.y -= 1
              break
            }
            if (Math.random() < 0.18) {
              this.state = 'roar'
              this.t = 0
              if (Math.random() < 0.5) meio(s, MEIO)
              break
            }
          }
          if (gap < 22 && this.dir === Math.sign(dx)) {
            this.state = 'wind'
            this.t = 0
          } else if (gap > 18) {
            this.x += this.dir * 24 * dt
            this.walkT = (this.walkT || 0) + dt
          }
        }
      }
      this.x = clamp(this.x, 14, s.W - 14)
      return FAST
    }
    draw(c) {
      const st = this.state
      let fr
      if (this.flashT > 0 || (st === 'explode' && Math.floor(this.t * 10) % 2)) fr = GF.hurt
      else if (st === 'wind') fr = GF.wind
      else if (st === 'punch') fr = GF.punch
      else if (st === 'enter' || st === 'leap' || st === 'leave') fr = this.vy < 0 ? GF.raise : GF.slam
      else if (st === 'slam') fr = this.t < 0.25 ? GF.slam : GF.walk[0]
      else if (st === 'roar') fr = Math.floor(this.t * 8) % 2 ? GF.roar : GF.walk[0]
      else fr = GF.walk[Math.floor((this.walkT || 0) * 4) % 2]
      const ax = this.dir === 1 ? CX : FW - 1 - CX
      const jx = st === 'explode' ? Math.round(rand(-1, 1)) : 0
      c.drawImage(fr.sp[this.dir], Math.round(this.x) - ax - 1 + jx, Math.round(this.y) - FH - 1)
      // life bar
      if (st !== 'leave') {
        const w = 24
        const x = Math.round(this.x - w / 2)
        const y = Math.max(0, Math.round(this.y - 34))
        c.fillStyle = OUT
        c.fillRect(x - 1, y - 1, w + 2, 4)
        c.fillStyle = '#ff9a2c'
        c.fillRect(x, y, Math.round((w * clamp(this.hp, 0, 26)) / 26), 2)
      }
    }
  }

  class Bullet {
    constructor(x, y, vx) {
      Object.assign(this, { x, y, vx })
      this.z = 5
      this.moving = true
    }
    update(dt, now, s) {
      this.x += this.vx * dt
      if (this.x < -6 || this.x > s.W + 6) this.dead = true
      const hb = s.data.hiryu.hurtbox()
      if (hb && this.x > hb[0] && this.x < hb[1] && this.y > hb[2] && this.y < hb[3]) {
        this.dead = true
        s.data.hiryu.hurt(Math.sign(this.vx))
      }
      return FAST
    }
    draw(c) {
      c.drawImage(BULLET, Math.round(this.x) - 2, Math.round(this.y) - 1)
    }
  }

  class Boom {
    constructor(x, y) {
      Object.assign(this, { x, y })
      this.t = 0
      this.z = 6
      this.prop = true
    }
    update(dt) {
      this.t += dt
      if (this.t > 0.45) this.dead = true
      return FAST
    }
    draw(c) {
      const img = BOOM[Math.min(3, Math.floor(this.t * 9))]
      c.drawImage(img, Math.round(this.x) - 7, Math.round(this.y) - 7)
    }
  }

  // the Option power-up: drops in, blinks, Hiryu grabs it
  class Orb {
    constructor(s, x) {
      this.s = s
      this.x = x
      this.y = -8
      this.t = 0
      this.z = 3
      this.moving = true
    }
    get landed() {
      return this.y >= FLOOR - 9
    }
    hit(x, y) {
      return Math.abs(x - this.x) < 8 && Math.abs(y - (this.y + 4)) < 8
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      s.data.hiryu.setPlan(s.data.hiryu.pathTo(this.x))
    }
    update(dt, now, s) {
      this.t += dt
      if (!this.landed) this.y += 34 * dt
      const h = s.data.hiryu
      if (Math.abs(h.x - this.x) < 9 && h.y > FLOOR - 14 && this.landed) {
        this.dead = true
        s.burst(this.x, this.y + 3, 10, ['c', 'W', 'B'])
        summonOption(s, now)
      }
      if (this.t > 22 || !s.lively(now)) this.dead = true
      return this.landed ? SLOW / 2 : FAST
    }
    draw(c) {
      c.drawImage(ORB[Math.floor(this.t * 6) % 3 === 0 ? 1 : 0], Math.round(this.x) - 4, Math.round(this.y) - 1)
    }
  }

  function summonOption(s, now) {
    const d = s.data
    const have = d.opts.map((o) => o.kind)
    const kind = !have.includes('hawk') && (have.includes('panther') || Math.random() < 0.55) ? 'hawk' : !have.includes('panther') ? 'panther' : null
    if (!kind) {
      for (const o of d.opts) o.until = now + 25000
      return
    }
    const o = kind === 'hawk' ? new Hawk(s, now) : new Panther(s, now)
    d.opts.push(o)
    s.spawn(o)
    s.say(kind === 'hawk' ? 'Option: hawk' : 'Option: panther', d.hiryu.x, 1, { color: '#8fe8ff', life: 1.8 })
  }

  class Hawk {
    constructor(s, now) {
      this.s = s
      this.kind = 'hawk'
      const h = s.data.hiryu
      this.x = h.x < s.W / 2 ? s.W + 10 : -10
      this.y = 6
      this.dir = this.x < 0 ? 1 : -1
      this.t = 0
      this.z = 3.5
      this.moving = true
      this.until = now + 26000
      this.diveAt = now + 1500
      this.state = 'fly'
    }
    hit(x, y) {
      return Math.abs(x - this.x) < 9 && Math.abs(y - this.y) < 7
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      const f = nearestFoe(s, this.x)
      if (f) this.dive(f)
      else s.particle({ img: BUBBLE['♪'], x: this.x, y: this.y - 8, vy: -8, life: 1 })
    }
    dive(f) {
      this.state = 'dive'
      this.prey = f
      this.t = 0
    }
    update(dt, now, s) {
      this.t += dt
      const h = s.data.hiryu
      if (this.state === 'leave' || now > this.until || !s.lively(now)) {
        this.state = 'leave'
        this.y -= 30 * dt
        this.x += this.dir * 90 * dt
        if (this.x < -20 || this.x > s.W + 20 || this.y < -12) this.dead = true
        return FAST
      }
      let tx
      let ty
      if (this.state === 'dive') {
        const f = this.prey
        if (!f || !f.alive) {
          this.state = 'fly'
          return FAST
        }
        tx = f.x
        ty = f.y - f.hh / 2
        if (Math.abs(tx - this.x) < 6 && Math.abs(ty - this.y) < 6) {
          f.cut(this.dir, now)
          this.state = 'fly'
          this.diveAt = now + rand(1800, 3000)
        }
        const k = Math.min(1, (150 * dt) / (Math.hypot(tx - this.x, ty - this.y) || 1))
        this.dir = Math.sign(tx - this.x) || this.dir
        this.x += (tx - this.x) * k
        this.y += (ty - this.y) * k
        return FAST
      }
      // circle above Hiryu
      tx = h.x + Math.cos(this.t * 1.8) * 26
      ty = 6 + Math.sin(this.t * 3.6) * 2.5
      const vx = (tx - this.x) * 2.2
      if (Math.abs(vx) > 4) this.dir = Math.sign(vx)
      this.x += clamp(vx, -110, 110) * dt
      this.y += (ty - this.y) * Math.min(1, dt * 3)
      if (now > this.diveAt) {
        const f = nearestFoe(s, this.x, 120)
        this.diveAt = now + rand(1500, 2600)
        if (f) this.dive(f)
      }
      return FAST
    }
    draw(c) {
      const sp = HAWK[this.state === 'dive' ? 2 : Math.floor(this.t * 8) % 2]
      c.drawImage(sp[this.dir], Math.round(this.x) - 8, Math.round(this.y) - 4)
    }
  }
  class Panther {
    constructor(s, now) {
      this.s = s
      this.kind = 'panther'
      const h = s.data.hiryu
      this.x = h.x < s.W / 2 ? -14 : s.W + 14
      this.y = FLOOR
      this.dir = this.x < 0 ? 1 : -1
      this.vy = 0
      this.vx = 0
      this.t = 0
      this.runT = 0
      this.z = 3.2
      this.moving = true
      this.until = now + 26000
      this.pounceAt = now + 1200
    }
    hit(x, y) {
      return Math.abs(x - this.x) < 12 && y > this.y - 15 && y < this.y + 2
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      const f = nearestFoe(s, this.x, 200)
      if (f && this.y >= FLOOR) this.pounce(f)
      else s.say('grr', this.x, this.y - 22, { color: '#b0b4ff', life: 1 })
    }
    pounce(f) {
      this.dir = Math.sign(f.x - this.x) || this.dir
      this.vx = clamp((f.x - this.x) * 2.2, -170, 170)
      this.vy = -150
      this.y -= 1
    }
    update(dt, now, s) {
      this.t += dt
      const h = s.data.hiryu
      if (this.y < FLOOR) {
        this.vy += 520 * dt
        this.x += this.vx * dt
        this.y += this.vy * dt
        for (const f of s.data.foes) if (f.alive && f.kind !== 'boss' && Math.abs(f.x - this.x) < f.hw + 6 && this.y > f.y - f.hh) f.cut(this.dir, now)
        if (this.y >= FLOOR) this.y = FLOOR
        return FAST
      }
      const leaving = now > this.until || !s.lively(now)
      const tx = leaving ? (this.x < s.W / 2 ? -30 : s.W + 30) : h.x - h.dir * 20
      const dx = tx - this.x
      if (Math.abs(dx) > 4) {
        if (Math.sign(dx) !== this.dir && now > (this.turnAt || 0)) {
          this.dir = Math.sign(dx)
          this.turnAt = now + 500
        }
        this.x += this.dir * Math.min(Math.abs(dx) * 3, 125) * dt
        this.runT += dt
        this.moving = true
      } else {
        this.moving = false
        this.dir = h.dir
      }
      if (leaving && (this.x < -20 || this.x > s.W + 20)) this.dead = true
      if (!leaving && now > this.pounceAt) {
        this.pounceAt = now + rand(1600, 2600)
        const f = nearestFoe(s, this.x, 90)
        if (f) this.pounce(f)
      }
      return FAST
    }
    draw(c) {
      const fr = this.y < FLOOR ? PF.leap : this.moving ? PF.run[Math.floor(this.runT * 13) % 4] : PF.sit
      const ax = this.dir === 1 ? CX : FW - 1 - CX
      c.drawImage(fr.sp[this.dir], Math.round(this.x) - ax - 1, Math.round(this.y) - FH - 1)
    }
  }
  function nearestFoe(s, x, range = 1e9) {
    let best = null
    for (const f of s.data.foes) if (f.alive && f.kind !== 'boss' && f.onField(s) && Math.abs(f.x - x) < range && (!best || Math.abs(f.x - x) < Math.abs(best.x - x))) best = f
    if (!best) for (const f of s.data.foes) if (f.alive && f.kind === 'boss' && f.state === 'stalk' && Math.abs(f.x - x) < range) best = f
    return best
  }

  // ---- director -----------------------------------------------------------------------------
  function spawnFoe(s, kind, side) {
    const d = s.data
    const x = side > 0 ? s.W + 12 : -12
    const f = kind === 'dog' ? new Dog(s, x, -side) : new Soldier(s, x, -side)
    d.foes.push(f)
    s.spawn(f)
    return f
  }
  /** The side a wave comes from: the far side of the title from Hiryu when there is one, so he slides to meet it. */
  function farSide(s) {
    const t = s.fixture('title')
    const h = s.data.hiryu
    if (t && Math.random() < 0.75) return h.x < t.x + t.w / 2 ? 1 : -1
    return h.x < s.W / 2 ? 1 : -1
  }
  const EPISODES = ['infantry', 'dogs', 'patrol', 'option', 'mixed', 'wall', 'meio', 'infantry', 'dogs']
  function runEpisode(s, now) {
    const d = s.data
    if (!d.bag.length) {
      d.bag = EPISODES.slice()
      for (let i = d.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[d.bag[i], d.bag[j]] = [d.bag[j], d.bag[i]]
      }
    }
    const ep = d.bag.pop()
    const h = d.hiryu
    const side = farSide(s)
    const later = (ms, fn) => d.queue.push({ at: now + ms, fn })
    switch (ep) {
      case 'infantry':
        for (let i = 0, n = Math.floor(rand(2, 4)); i < n; i++) later(i * 900, () => spawnFoe(s, 'soldier', side))
        break
      case 'dogs':
        for (let i = 0, n = Math.floor(rand(2, 4)); i < n; i++) later(i * 650, () => spawnFoe(s, 'dog', i === 2 ? -side : side))
        break
      case 'mixed':
        later(0, () => spawnFoe(s, 'soldier', side))
        later(1400, () => spawnFoe(s, 'dog', -side))
        later(2200, () => spawnFoe(s, 'dog', side))
        break
      case 'meio':
        meio(s, MEIO)
        later(1800, () => spawnFoe(s, 'soldier', side))
        later(2600, () => spawnFoe(s, 'soldier', -side))
        break
      case 'option': {
        const t = s.fixture('title')
        const x = t ? openSpot(s, h.x < t.x ? t.x + t.w + rand(25, 60) : t.x - rand(25, 60), 6) : openSpot(s, rand(40, s.W - 40), 6)
        d.orb = s.spawn(new Orb(s, x))
        later(3500, () => spawnFoe(s, 'soldier', side))
        later(4300, () => spawnFoe(s, 'dog', side))
        break
      }
      case 'wall': {
        const ws = h.x < s.W / 2 ? -1 : 1
        h.setPlan(h.pathTo(ws < 0 ? 9 : s.W - 9).concat([{ k: 'wall', side: ws }]))
        later(2600, () => spawnFoe(s, 'dog', ws))
        break
      }
      default: {
        const t = s.fixture('title')
        if (t) {
          const far = h.x < t.x + t.w / 2 ? openSpot(s, t.x + t.w + rand(30, 80), 10) : openSpot(s, t.x - rand(30, 80), 10)
          h.setPlan(h.pathTo(far).concat([{ k: 'slash' }]))
        }
        later(1800, () => spawnFoe(s, 'soldier', -side))
      }
    }
  }

  registerConcept({
    key: 'strider',
    title: 'Strider',
    sub: 'Capcom, 1989',
    blurb:
      'Strider Hiryu runs the bar with his cypher and long red scarf. Kazakh infantry and robot dogs come in waves; he cuts them down, deflects their bullets with the blade, cartwheels over the eyes and window buttons and off the end walls, and drops into his slide to pass beneath the title, cutting whatever stands under it. Grab the Option orb and a hawk or robot panther fights beside him for a while. He faces your <b>cursor</b>; click him to slash, click again to slide, double-click for a somersault, or drag him and let go. Click an enemy to send him at it, double-click a soldier to make him surrender or a dog to tame it, and drag enemies around to slam them down. While you play, he waits on you; leave him and he carries on alone. While the agent works, Mecha Pon the robot gorilla drops in with Grandmaster Meio taunting; done blows Pon apart and Hiryu strikes his victory pose. Left alone he crouches, only the scarf moving.',
    setup(s) {
      s.data = { foes: [], opts: [], booms: [], queue: [], bag: [], kills: 0, orb: null, boss: null, clickAt: -1e9, grabAt: -1e9 }
      const d = s.data
      d.hiryu = new Hiryu(s)
      s.actors.push(d.hiryu)
      d.epAt = performance.now() + rand(1200, 2500)
    },
    relayout(s) {
      const d = s.data
      if (!d.hiryu) return
      const h = d.hiryu
      h.x = edgeX(s, h.x)
      h.plan = []
      if (h.state === 'run') h.tx = edgeX(s, h.tx)
      if (h.state === 'slide') h.sx = edgeX(s, h.sx)
      if (h.state === 'flip') h.fx1 = edgeX(s, h.fx1)
      if (h.state === 'crouch') {
        h.x = openSpot(s, h.x, 14)
        h.restT = Math.min(h.restT, 5.5) // one more settle frame
      }
      h.resting = h.state === 'crouch'
      for (const a of s.actors) if (a !== h && a.x !== undefined && !(a instanceof Bullet)) a.x = clamp(a.x, -20, s.W + 20)
      if (d.orb && !d.orb.dead) d.orb.x = openSpot(s, clamp(d.orb.x, 10, s.W - 10), 6)
    },
    // keyboard: A/D run, W somersaults (forward if running), S drops into the slide,
    // Space slashes; the autopilot waits while you play
    onKey(s, key, down) {
      const h = s.data.hiryu
      if (!down || !h) return
      const ok = ['stand', 'run', 'crouch', 'win'].includes(h.state)
      if (ok) {
        h.plan = []
        h.target = null
        h.asleep = false
        h.resting = false
      }
      if (key === 'fire' && (ok || h.state === 'slash') && h.slashCd <= 0) {
        if (h.state !== 'slash') h.state = 'stand'
        h.slash()
      } else if (key === 'up' && ok) {
        const kx = keyDir(s)
        h.state = 'stand'
        h.flip(edgeX(s, h.x + kx * 70), 26)
      } else if (key === 'down' && ok) {
        h.state = 'stand'
        h.slide(h.x + h.dir * 90)
      }
    },
    onBarClick(s, p) {
      // mockup only (Aico has no empty-bar clicks): run there
      s.data.clickAt = performance.now()
      const h = s.data.hiryu
      if (h.state === 'stand' || h.state === 'run' || h.state === 'crouch') {
        h.state = 'stand'
        h.setPlan(h.pathTo(p.x))
      }
    },
    onBusy(s) {
      const d = s.data
      const now = performance.now()
      d.waveAt = now + 400
      d.bossAt = now + rand(5000, 8000)
      d.queue.length = 0
    },
    onDone(s) {
      const d = s.data
      const now = performance.now()
      d.queue.length = 0
      for (const a of s.actors) if (a instanceof Bullet) a.dead = true
      let t = 0
      for (const f of d.foes)
        if (f.alive && f.kind !== 'boss') {
          t += 160
          d.booms.push({ at: now + t, x: f.x, y: f.y - f.hh / 2, kill: f })
        }
      if (d.boss && !d.boss.dead) d.boss.explode(now)
      d.booms.sort((a, b) => a.at - b.at)
      d.winAt = now + Math.max(t, d.boss && !d.boss.dead ? 1900 : 0) + 300
      d.epAt = d.winAt + rand(6000, 9000)
    },
    onNap(s) {
      const d = s.data
      d.queue.length = 0
      d.booms.length = 0
      d.winAt = 0
    },
    update(s, dt, now) {
      // held game keys keep it at full rate
      return Math.min(this.step(s, dt, now) ?? Infinity, s.keys?.size ? FAST : Infinity)
    },
    step(s, dt, now) {
      const d = s.data
      const h = d.hiryu
      let wait = Infinity
      while (d.booms.length && d.booms[0].at <= now) {
        const b = d.booms.shift()
        if (b.kill && b.kill.alive) b.kill.cut(1, now)
        s.spawn(new Boom(b.x, b.y))
      }
      if (d.booms.length) wait = d.booms[0].at - now
      d.foes = d.foes.filter((f) => !f.dead)
      d.opts = d.opts.filter((o) => !o.dead)
      if (d.boss && d.boss.dead) d.boss = null
      if (d.orb && d.orb.dead) d.orb = null
      if (d.winAt && now >= d.winAt) {
        d.winAt = 0
        if (s.lively(now) && h.state !== 'held') {
          const spot = openSpot(s, h.x, 12)
          h.plan = []
          h.state = h.grounded ? 'stand' : h.state
          h.setPlan(h.pathTo(spot).concat([{ k: 'face', dir: spot < s.W / 2 ? 1 : -1 }, { k: 'win' }]))
        }
      } else if (d.winAt) wait = Math.min(wait, d.winAt - now)
      if (!s.lively(now)) {
        d.queue.length = 0
        if (d.boss) d.boss.leave()
        return wait
      }
      while (d.queue.length && d.queue[0].at <= now) d.queue.shift().fn()
      d.queue.sort((a, b) => a.at - b.at)
      if (d.queue.length) wait = Math.min(wait, d.queue[0].at - now)
      const foes = d.foes.filter((f) => f.alive && f.kind !== 'boss').length
      if (s.busy) {
        if (!d.boss && now > (d.bossAt || 0)) {
          // Mecha Pon drops in on the side away from Hiryu
          const x = openSpot(s, h.x < s.W / 2 ? s.W - 40 : 40, 14)
          d.boss = new Pon(s, x, h.x < x ? -1 : 1)
          d.foes.push(d.boss)
          s.spawn(d.boss)
          meio(s, MEIO)
          d.bossAt = now + rand(12000, 18000)
        }
        if (now > d.waveAt) {
          const cap = d.boss ? 2 : 5
          if (foes < cap) {
            const side = farSide(s)
            const n = d.boss ? 1 : Math.floor(rand(1, 3.5))
            for (let i = 0; i < n; i++) d.queue.push({ at: now + i * 700, fn: () => spawnFoe(s, Math.random() < 0.45 ? 'dog' : 'soldier', Math.random() < 0.7 ? side : -side) })
            if (!d.orb && !d.opts.length && Math.random() < 0.3) d.orb = s.spawn(new Orb(s, openSpot(s, rand(40, s.W - 40), 6)))
          }
          d.waveAt = now + (d.boss ? rand(5000, 8000) : rand(2500, 4500))
        }
        return Math.min(wait, FAST)
      }
      // watch mode: one episode at a time, a breather between them
      const quiet = !foes && !d.queue.length && !h.plan.length && !d.orb && h.state === 'stand' && !d.winAt
      if (quiet && !engaged(s, now)) {
        if (!d.epAt) d.epAt = now + rand(1500, 3500)
        if (now > d.epAt) {
          d.epAt = 0
          runEpisode(s, now)
        }
      } else if (!quiet) d.epAt = 0
      return Math.min(wait, SLOW)
    },
  })
})()
