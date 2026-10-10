;(() => {
  // Joust (Williams, 1982), big: a knight on an ostrich and buzzard riders the
  // same size flap through the whole height of the bar, wrapping at the edges.
  // The higher lance wins; losers drop eggs that hatch and get picked up by a
  // riderless buzzard. Waves, the pterodactyl, and the lava troll's hand.

  // ---- art ----------------------------------------------------------------------
  const JP = {
    ...PAL,
    W: '#f2efe6', c: '#93bde0', // knight's armour
    Y: '#f2d14b', y: '#b8901e', O: '#f08a2c', // ostrich
    Z: '#4fa83a', z: '#2b6420', h: '#e6c2a4', K: '#f2d14b', // buzzard
    R: '#e0483f', r: '#7e2019', A: '#c7ccd4', a: '#6d737d', b: '#5a7cf0', D: '#26338a', // riders
    N: '#d8c49a', n: '#8a7148', w: '#ffffff', E: '#151515', k: '#5a3a1a',
    m: '#8d7fd6', M: '#4c3f94', q: '#ff7a5a', // pterodactyl
    L: '#ff6a1a', l: '#a8280c', // troll hand / lava
  }
  const SW = 30 // frame width; body centre at column BX, facing right
  const SH = 22 // frame height; feet on the last row
  const BX = 12
  const GRAV = 60
  const MAXY = FLOOR - SH // lowest top: standing on the floor

  const grid = (w = SW, h = SH) => Array.from({ length: h }, () => Array(w).fill('.'))
  const put = (g, x, y, ch) => {
    x = Math.round(x)
    y = Math.round(y)
    if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = ch
  }
  function line(g, x0, y0, x1, y1, ch) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) put(g, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, ch)
  }
  function oval(g, cx, cy, rx, ry, ch) {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) put(g, x, y, ch)
  }
  function tri(g, ax, ay, bx, by, cx, cy, ch) {
    const x0 = Math.floor(Math.min(ax, bx, cx))
    const x1 = Math.ceil(Math.max(ax, bx, cx))
    const y0 = Math.floor(Math.min(ay, by, cy))
    const y1 = Math.ceil(Math.max(ay, by, cy))
    const e = (px, py, qx, qy, x, y) => (qx - px) * (y - py) - (qy - py) * (x - px)
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const a = e(ax, ay, bx, by, x, y)
        const b = e(bx, by, cx, cy, x, y)
        const c = e(cx, cy, ax, ay, x, y)
        if ((a >= -0.5 && b >= -0.5 && c >= -0.5) || (a <= 0.5 && b <= 0.5 && c <= 0.5)) put(g, x, y, ch)
      }
  }
  const stamp = (g, x, y, rows) => rows.forEach((r, j) => [...r].forEach((ch, i) => ch !== '.' && put(g, x + i, y + j, ch)))
  const rowsOf = (g) => g.map((r) => r.join(''))

  /**
   * One rider-and-mount frame. mount: { body, shade, leg, buzz } ; armour [main, shade];
   * legs: 'stand' | 'skid' | 'tuck' | a run phase in radians; wing: 'fold' | 'up' | 'mid' | 'down'.
   */
  function frame(mount, armour, legs, wing, rider = true) {
    const g = grid()
    const [B, b, LG] = [mount.body, mount.shade, mount.leg]
    // legs first, so the body overlaps the hips
    const hips = [[10, 15], [13, 15]]
    if (legs === 'tuck') {
      line(g, 10, 15, 7, 17, LG)
      line(g, 7, 17, 5, 17, LG)
      line(g, 13, 15, 10, 18, LG)
      line(g, 10, 18, 8, 18, LG)
    } else {
      hips.forEach(([hx, hy], i) => {
        let fx
        let lift = 0
        if (legs === 'stand') fx = hx + (i ? 1 : -1)
        else if (legs === 'skid') fx = hx + 5
        else {
          const p = legs + i * Math.PI
          fx = hx + Math.sin(p) * 5
          lift = Math.max(0, Math.cos(p)) * 2.5
        }
        const fy = 21 - lift
        const kx = (hx + fx) / 2 - 2 // the backward-bending ankle of a big bird
        const ky = (hy + fy) / 2
        line(g, hx, hy, kx, ky, LG)
        line(g, kx, ky, fx, fy, LG)
        line(g, fx, fy, fx + 2, fy, LG) // toes forward
        put(g, fx - 1, fy, LG)
      })
    }
    // tail plumes
    line(g, 5, 10, 1, 7, b)
    line(g, 5, 11, 1, 9, B)
    line(g, 5, 12, 2, 11, b)
    // body
    oval(g, 11, 12, 7, 3.2, B)
    line(g, 6, 14, 15, 14, b)
    line(g, 8, 15, 13, 15, b)
    if (mount.buzz) {
      // hunched neck, low bald head, hooked beak
      line(g, 16, 11, 19, 9, B)
      line(g, 17, 12, 20, 10, B)
      stamp(g, 18, 7, ['.hhh..', 'hhEhh.', 'hhhhKK', '.hh..K'])
    } else {
      // tall neck, head high, straight beak
      line(g, 16, 10, 19, 5, B)
      line(g, 17, 11, 20, 6, B)
      line(g, 17, 12, 20, 7, b)
      stamp(g, 18, 2, ['.BBB...', 'BBEBB..', 'BBBBOOO', '.BB....'].map((r) => r.replace(/B/g, B)))
    }
    // wing
    if (wing === 'fold') {
      line(g, 6, 11, 13, 10, b)
      line(g, 7, 12, 13, 12, b)
    } else if (wing === 'up') {
      tri(g, 6, 11, 14, 11, 2, 1, B)
      line(g, 2, 1, 6, 11, b)
      line(g, 4, 4, 8, 10, b)
    } else if (wing === 'mid') {
      tri(g, 6, 10, 14, 11, 0, 8, B)
      line(g, 0, 8, 6, 11, b)
      line(g, 3, 9, 13, 11, b)
    } else if (wing === 'down') {
      tri(g, 6, 13, 14, 13, 3, 20, B)
      line(g, 3, 20, 6, 13, b)
      line(g, 6, 18, 10, 13, b)
    }
    if (rider) {
      const [A, a] = armour
      // lance couched along the bird's neck, tip forward
      line(g, 4, 6, 27, 6, 'N')
      line(g, 4, 7, 6, 7, 'n')
      put(g, 28, 6, 'w')
      put(g, 29, 6, 'w')
      // knight: plumed helmet, visor, mail
      const P = mount.plume || A
      const S = mount.shield || a
      // helmet with visor slit and plume, broad mailed torso, shield on the near arm
      stamp(g, 7, 0, [`..${a}${A}${A}${a}`, `.${A}${A}${A}${A}${A}`, `.${A}${A}${A}EE`, `.${a}${A}${A}${A}${a}`])
      line(g, 8, 0, 4, 2, P)
      line(g, 8, 1, 5, 3, P)
      stamp(g, 7, 4, [`.${a}${A}${A}${A}${a}.`, `${a}${A}${A}${A}${A}${A}k`, `${a}${A}${A}${A}${A}${A}.`, `${a}${a}${A}${A}${A}${a}.`, `..${A}${A}${a}..`])
      line(g, 4, 6, 27, 6, 'N')
      put(g, 28, 6, 'w')
      put(g, 29, 6, 'w')
      stamp(g, 6, 5, [`${S}${S}${S}${S}`, `${S}ww${S}`, `${S}w${S}${S}`, `.${S}${S}.`])
      stamp(g, 11, 9, [`${A}${a}`, `${A}${a}`, 'kk', 'kkk'])
    }
    return rowsOf(g)
  }
  const RUN = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]
  function makeSet(mount, armour, rider = true) {
    const o = (legs, wing) => pairOutlined(frame(mount, armour, legs, wing, rider), JP)
    return {
      run: RUN.map((p) => o(p, 'fold')),
      stand: o('stand', 'fold'),
      skid: o('skid', 'mid'),
      up: o('tuck', 'up'),
      mid: o('tuck', 'mid'),
      down: o('tuck', 'down'),
    }
  }
  const OSTRICH = { body: 'Y', shade: 'y', leg: 'O', plume: 'O', shield: 'b' }
  const BUZZ = { body: 'Z', shade: 'z', leg: 'K', buzz: true }
  const KNIGHT = makeSet(OSTRICH, ['W', 'c'])
  const KINDS = [
    { name: 'Bounder', armour: ['R', 'r'], speed: 26, aggro: 0.35, lane: 0.6, pts: 500 },
    { name: 'Hunter', armour: ['A', 'a'], speed: 32, aggro: 0.6, lane: 0.4, pts: 750 },
    { name: 'Shadow Lord', armour: ['b', 'D'], speed: 40, aggro: 0.85, lane: 0.1, pts: 1500 },
  ]
  const RIDERS = KINDS.map((k) => makeSet({ ...BUZZ, plume: k.armour[1], shield: k.armour[1] }, k.armour))
  const EMPTY = makeSet(BUZZ, ['A', 'a'], false)
  const EGG = outline(sprite(['..ww..', '.wwww.', 'wwwwww', 'wwwwwA', 'wwwwwA', 'wwwwAA', '.wAAA.'], JP))
  const EGG_CRACK = outline(sprite(['..ww..', '.w.ww.', 'ww.www', 'www.wA', 'wwwwwA', 'wwwwAA', '.wAAA.'], JP))
  const PILOT = KINDS.map((k) => {
    const [A, a] = k.armour
    const rows = (up) => [up ? `${A}...${A}.` : '.......', up ? `.${A}${A}${A}..` : `.${A}${A}${A}..`, `.${A}EE${A}.`, up ? `..${A}...` : `${A}.${A}.${A}.`, `.${a}${A}${a}..`, `.${A}.${A}..`, `.k.k..`, 'w.AwwA', '.wAAA.']
    return [pairOutlined(rows(true), JP), pairOutlined(rows(false), JP)]
  })
  const PTERO = [0, 1].map((f) => {
    const g = grid(36, 16)
    // long head and beak, crest back, body, tail, big wings
    line(g, 4, 8, 30, 8, 'm')
    line(g, 6, 9, 26, 9, 'M')
    line(g, 26, 7, 33, 7, 'm') // upper beak
    line(g, 26, 9, 32, 10 + f, 'm') // lower jaw, open on f
    put(g, 27, 6, 'E')
    line(g, 24, 7, 20, 4, 'm') // crest
    line(g, 4, 8, 0, 10, 'M') // tail
    if (f) {
      tri(g, 9, 8, 21, 8, 6, 0, 'm')
      line(g, 6, 0, 9, 8, 'M')
      line(g, 10, 3, 14, 8, 'M')
    } else {
      tri(g, 9, 9, 21, 9, 7, 15, 'm')
      line(g, 7, 15, 9, 9, 'M')
      line(g, 11, 13, 14, 9, 'M')
    }
    line(g, 14, 10, 12, 13, 'q')
    line(g, 18, 10, 17, 13, 'q')
    return pairOutlined(rowsOf(g), JP)
  })
  const HAND = [
    ['..L.L.L.....', '.LL.L.LL....', '.LL.L.LL.L..', '.LLLLLLL.LL.', '.LLLLLLLLLL.', '.LLLLLLLLL..', '..LLLLLLL...', '..LlLLLlL...', '..LLLLLLL...', '..lLLLLLl...', '..LLLLLLL...', '..lLLLLLl...', '..LLLLLLL...', '..lLLLLLl...'],
    ['............', '............', '..LLLLLL....', '.LLLLLLLL...', '.LLLLLLLLLL.', '.LLLLLLLLL..', '..LLLLLLL...', '..LlLLLlL...', '..LLLLLLL...', '..lLLLLLl...', '..LLLLLLL...', '..lLLLLLl...', '..LLLLLLL...', '..lLLLLLl...'],
  ].map((r) => outline(sprite(r, JP)))
  const FEATHER = [pix('Y'), pix('w'), pix('y')]

  // ---- helpers ------------------------------------------------------------------
  const wrap = (x, W) => ((x % W) + W) % W
  const wdx = (dx, W) => wrap(dx + W / 2, W) - W / 2
  const riders = (s) => s.actors.filter((a) => a.enemy && !a.dead)
  const eggs = (s) => s.actors.filter((a) => a.egg && !a.dead)
  const engaged = (s, now) => now - (s.data.lastClick || -1e9) < 9000 || (s.cursor && now - s.cursor.t < 1200 && s.cursor.y < H + 2)
  const steering = (s, now) => s.cursor && now - s.cursor.t < 1500 && s.cursor.y < H + 2 && engaged(s, now)
  function openSpot(s, near) {
    const spans = s.fix.map((f) => [f.x - 20, f.x + f.w + 20]).sort((a, b) => a[0] - b[0])
    let x = 20
    let best = null
    for (const [a, b] of [...spans, [s.W - 20, s.W + 99]]) {
      if (a - x >= 34) {
        const c = (x + a) / 2
        if (best === null || Math.abs(wdx(c - near, s.W)) < Math.abs(wdx(best - near, s.W))) best = c
      }
      x = Math.max(x, b)
    }
    return best ?? s.W * 0.3
  }
  /** Draw a frame centred on x (body centre), wrapping at the bar ends; `phase` = materialize scanlines. */
  function blit(c, s, sp, dir, cx, y, phase = -1) {
    const img = sp[dir]
    const X = Math.round(cx - (dir > 0 ? BX : SW - 1 - BX)) - 1
    const Y = Math.round(y) - 1
    for (const ox of [X, X - s.W, X + s.W]) {
      if (ox > s.W || ox + img.width < 0) continue
      if (phase < 0) c.drawImage(img, ox, Y)
      else for (let r = phase % 2; r < img.height; r += 2) c.drawImage(img, 0, r, img.width, 1, ox, Y + r, img.width, 1)
    }
  }
  const pts = (s, n, x, y) => s.say(String(n), x, clamp(y, 0, FLOOR - 8), { color: '#f2d14b', life: 1.1, vy: -6 })

  // ---- shared flap/gravity body -------------------------------------------
  class Body {
    constructor(x, y, dir) {
      this.x = x
      this.y = y
      this.vx = 0
      this.vy = 0
      this.dir = dir
      this.onGround = y >= MAXY
      this.flapCd = 0
      this.flapT = 0
      this.turnCd = 0
      this.leg = 0
      this.skid = 0
      this.held = false
    }
    get moving() {
      return !this.onGround || Math.abs(this.vx) > 1 || this.flapT > 0
    }
    get cx() {
      return this.x
    }
    get lanceY() {
      return this.y + 6
    }
    flap(power = 20) {
      if (this.flapCd > 0) return
      this.vy = Math.max(-36, Math.min(this.vy, 4) - power)
      this.flapCd = 0.17
      this.flapT = 0.16
      this.onGround = false
    }
    steer(dx, dead = 10) {
      const d = Math.abs(dx) > 3 ? Math.sign(dx) : 0
      if (d && d !== this.dir && this.turnCd <= 0 && Math.abs(dx) > dead) {
        this.dir = d
        this.turnCd = 0.7
        if (this.onGround && Math.abs(this.vx) > 12) this.skid = 0.3
      }
      return d === this.dir ? d : 0
    }
    physics(dt, s, want, maxV) {
      this.flapCd -= dt
      this.flapT -= dt
      this.turnCd -= dt
      this.skid -= dt
      const acc = this.onGround ? 70 : 48
      if (want && this.skid <= 0) this.vx += want * acc * dt
      else this.vx *= this.onGround ? Math.max(0, 1 - 6 * dt) : 1 - 0.4 * dt
      this.vx = clamp(this.vx, -maxV, maxV)
      if (!this.onGround) this.vy = Math.min(this.vy + GRAV * dt, 50)
      this.x = wrap(this.x + this.vx * dt, s.W)
      this.y += this.vy * dt
      if (this.y >= MAXY) {
        if (!this.onGround && this.vy > 18) {
          s.particle({ img: pix('N'), x: this.x - 4, y: FLOOR - 1, vx: -14, life: 0.3 })
          s.particle({ img: pix('N'), x: this.x + 4, y: FLOOR - 1, vx: 14, life: 0.3 })
        }
        this.y = MAXY
        this.vy = 0
        this.onGround = true
      } else if (this.y < 0) {
        // the top of the bar is a hard ceiling: bounce off it
        this.y = 0
        this.vy = 12
      }
      if (this.onGround && Math.abs(this.vx) > 2) this.leg += Math.abs(this.vx) * dt * 0.28
    }
    pose(set) {
      if (this.onGround) {
        if (this.skid > 0) return set.skid
        return Math.abs(this.vx) > 2 ? set.run[Math.floor(this.leg) % 4] : set.stand
      }
      if (this.flapT > 0.08) return set.down
      if (this.flapT > 0) return set.mid
      return this.vy > 20 ? set.up : set.mid
    }
  }

  // ---- the knight ------------------------------------------------------------
  class Knight extends Body {
    constructor(s) {
      super(openSpot(s, s.W * 0.25), MAXY, 1)
      this.s = s
      this.z = 3
      this.out = 0
      this.spawn = 0
      this.grace = 0
      this.order = null // a click: { x, y, until } or { foe, until }
      this.wander = null
      this.wanderAt = 0
      this.grabbable = true
    }
    get asleep() {
      return this.sleeping
    }
    hit(px, py) {
      return !this.out && Math.abs(wdx(px - this.x, this.s.W)) < 13 && py > this.y - 3 && py < this.y + SH + 2
    }
    onClick() {
      const s = this.s
      s.data.lastClick = performance.now()
      this.sleeping = false
      this.flapCd = 0
      this.flap(30)
      for (let i = 0; i < 5; i++) s.particle({ img: pick(FEATHER), x: this.x - 4 + rand(-3, 3), y: this.y + 12, vx: rand(-25, 25), vy: rand(-20, 5), g: 40, life: 0.9, fade: true })
    }
    onDblClick() {
      // the ostrich's honk
      this.s.say('SQUAWK!', this.x, Math.max(0, this.y - 9), { color: '#f2d14b', life: 1.2 })
    }
    grab() {
      this.held = true
      this.sleeping = false
      this.s.data.lastClick = performance.now()
    }
    drag(p) {
      this.x = wrap(p.x, this.s.W)
      this.y = clamp(p.y - SH / 2, 0, MAXY)
      this.vx = this.vy = 0
      this.onGround = this.y >= MAXY
    }
    drop() {
      this.held = false
      this.onGround = this.y >= MAXY
      this.s.data.lastClick = performance.now()
    }
    knockOut(s) {
      s.burst(this.x, this.y + 10, 16, ['Y', 'O', 'w', 'c'])
      this.out = 1.8
      this.order = null
      this.held = false
    }
    target(now) {
      const s = this.s
      const d = s.data
      if (this.order && (now > this.order.until || this.order.foe?.dead)) this.order = null
      if (this.order?.foe) {
        const f = this.order.foe
        return { x: f.x, y: f.ptero ? f.y : f.y - 5, charge: true }
      }
      if (this.order) return this.order
      if (steering(s, now)) return { x: s.cursor.x, y: clamp(s.cursor.y - SH / 2, 0, MAXY) }
      if (!s.lively(now) && !s.busy) return { x: d.restX, y: MAXY, land: true }
      // a pterodactyl: meet it head-on, lance at its mouth
      if (d.ptero && !d.ptero.dead && d.ptero.hunting) return { x: d.ptero.x + d.ptero.dir * 50, y: d.ptero.y - 4, face: d.ptero }
      const egg = eggs(s).sort((a, b) => Math.abs(wdx(a.x - this.x, s.W)) - Math.abs(wdx(b.x - this.x, s.W)))[0]
      const foe = riders(s).filter((r) => r.spawn <= 0 && !r.carrier && !(r.leaving > 0) && !r.grabbed)
        .sort((a, b) => Math.abs(wdx(a.x - this.x, s.W)) - Math.abs(wdx(b.x - this.x, s.W)))[0]
      if (egg && (!foe || d.mode === 'done' || Math.abs(wdx(egg.x - this.x, s.W)) < Math.abs(wdx(foe.x - this.x, s.W)))) return { x: egg.x, y: MAXY - 2, land: egg.grounded }
      if (foe) return { x: foe.x, y: Math.max(0, foe.y - 5), charge: true } // get above him: the higher lance wins
      if (!this.wander || now > this.wanderAt) {
        const land = Math.random() < 0.35
        this.wander = { x: land ? openSpot(s, rand(0, s.W)) : rand(20, s.W - 20), y: land ? MAXY : rand(0, MAXY - 3), land }
        this.wanderAt = now + rand(4000, 8000)
      }
      return this.wander
    }
    update(dt, now, s) {
      const d = s.data
      if (this.out > 0) {
        this.out -= dt
        if (this.out > 0) return FAST
        // rematerialize on the floor in an open stretch
        this.x = openSpot(s, rand(0, s.W))
        this.y = MAXY
        this.vx = this.vy = 0
        this.onGround = true
        this.spawn = 0.8
        this.grace = 3
      }
      if (this.spawn > 0) {
        this.spawn -= dt
        return FAST
      }
      this.grace -= dt
      if (this.held) return FAST
      if (this.grip) {
        // the troll has him by the ankle: flap like mad
        this.grip -= dt
        this.flapCd = 0
        if (Math.random() < 0.5) this.flapT = 0.16
        this.y = MAXY
        if (this.grip <= 0) {
          this.grip = 0
          this.flap(34)
          s.say('free!', this.x, Math.max(0, this.y - 9), { color: '#ffffff', life: 0.9 })
        }
        return FAST
      }
      const lively = s.lively(now) || s.busy
      if (!lively) {
        if (!d.restX) d.restX = openSpot(s, this.x)
        // backstop: still not down well into rest: blink out and back on the spot
        if (now - d.restAt > 15000 && !(this.onGround && Math.abs(wdx(this.x - d.restX, s.W)) < 4)) {
          this.x = d.restX
          this.y = MAXY
          this.vx = this.vy = 0
          this.onGround = true
          this.spawn = 0.8
          return FAST
        }
      }
      const t = this.target(now)
      const dx = wdx(t.x - this.x, s.W)
      let want = this.steer(dx, t.land ? 4 : 10)
      if (t.face) want = this.steer(wdx(t.face.x - this.x, s.W), 2) || want
      let doFlap = false
      if (t.land) {
        // fly over, then drop onto the spot
        if (Math.abs(dx) < 5) want = 0
        if (Math.abs(dx) > 30 && this.y > MAXY - 6 && this.onGround) doFlap = true
        if (!this.onGround && this.vy > 30) doFlap = true
      } else {
        const dy = t.y - this.y
        doFlap = (dy < -1 && this.vy > -10) || this.vy > 28
        if (Math.abs(dx) < 4 && !t.charge) want = 0
      }
      // stuck on the floor with somewhere to be: hop
      if (this.onGround && want && Math.abs(this.x - (this.lastX ?? this.x)) < 0.2) this.stuck = (this.stuck || 0) + dt
      else this.stuck = 0
      this.lastX = this.x
      if (this.stuck > 1) {
        this.stuck = 0
        this.flap(30)
      }
      if (doFlap) this.flap()
      this.physics(dt, s, want, this.onGround ? 30 : t.charge ? 46 : 40)
      if (lively) {
        this.joust(s, now)
        this.collect(s)
      }
      // cursor nearby and still: he turns to face it
      const cur = s.cursor
      if (cur && this.onGround && Math.abs(this.vx) < 2 && this.turnCd <= 0 && Math.abs(wdx(cur.x - this.x, s.W)) < 80) {
        const f = Math.sign(wdx(cur.x - this.x, s.W)) || this.dir
        if (f !== this.dir) {
          this.dir = f
          this.turnCd = 1
        }
      }
      const settled = this.onGround && Math.abs(this.vx) < 1 && this.flapT <= 0
      this.sleeping = !lively && settled
      if (this.sleeping) {
        d.sleptAt ||= now
        if (now - d.sleptAt < 6000) {
          if (now - (this.lastZ || 0) > 1500) {
            this.lastZ = now
            s.particle({ img: ZZ, x: this.x + 4, y: this.y - 4, vx: 3, vy: -4, life: 2.2, fade: true })
          }
          return 1500
        }
        return Infinity
      }
      d.sleptAt = 0
      if (settled && t === this.wander) return Math.max(FAST, this.wanderAt - now)
      if (settled && !riders(s).length && !eggs(s).length && !steering(s, now)) return SLOW
      return FAST
    }
    collect(s) {
      for (const e of eggs(s)) {
        if (e.fresh > 0 || Math.abs(wdx(e.x - this.x, s.W)) > 12 || e.y + 7 < this.y + 8) continue
        e.dead = true
        const n = e.hatched ? 1000 : e.grounded ? 250 : 500
        s.data.score += n
        pts(s, n, e.x, e.y - 8)
        s.burst(e.x, e.y + 3, 6, ['w', 'Y'])
        if (s.data.mode === 'done' && !eggs(s).length && !riders(s).length) {
          s.data.mode = 'calm'
          s.say('EGG WAVE CLEARED', s.W / 2, 1, { color: '#f2d14b', life: 2.4 })
        }
      }
    }
    joust(s, now) {
      if (this.grace > 0) return
      for (const r of riders(s)) {
        if (r.spawn > 0 || r.leaving > 0 || r.carrier || r.tieCd > 0 || r.grabbed) continue
        if (Math.abs(wdx(r.x - this.x, s.W)) > 18 || Math.abs(r.y - this.y) > 10) continue
        const sparkX = this.x + wdx(r.x - this.x, s.W) / 2
        // height decides; whoever is climbing at the moment of impact gets a slight edge
        const ky = this.y + this.vy * 0.04
        const ry = r.y + r.vy * 0.04
        if (ky < ry - 1) {
          r.unseat(s)
          s.data.score += KINDS[r.kind].pts
          pts(s, KINDS[r.kind].pts, r.x, r.y - 8)
          s.burst(sparkX, this.y + 6, 10, ['w', 'y', 'c'])
          this.vy = Math.min(this.vy, -8)
          for (const o of riders(s)) if (o !== r) o.fear = 2.5 // the rest scatter for a moment
          if (this.order?.foe === r) this.order = null
        } else if (ry < ky - 1) {
          r.gloat = 1.5
          s.say(pick(['HA!', 'HAH!']), r.x, Math.max(0, r.y - 9), { color: JP[KINDS[r.kind].armour[0]], life: 1 })
          this.knockOut(s)
        } else {
          // dead even: both bounce off
          s.burst(sparkX, this.y + 6, 6, ['w', 'A'])
          const side = Math.sign(wdx(this.x - r.x, s.W)) || 1
          this.vx = side * 28
          r.vx = -side * 28
          this.vy = r.vy = -14
          this.onGround = r.onGround = false
          this.turnCd = r.turnCd = 0.8
          r.tieCd = 1.2
        }
        return
      }
    }
    draw(c, s) {
      if (this.out > 0) return
      blit(c, s, this.pose(KNIGHT), this.dir, this.x, this.y, this.spawn > 0 ? Math.floor(this.spawn * 12) : -1)
    }
  }

  // ---- buzzard riders --------------------------------------------------------
  class Buzzard extends Body {
    constructor(s, x, y, kind = 0, carrier = null) {
      super(x, y, Math.random() < 0.5 ? 1 : -1)
      this.s = s
      this.enemy = true
      this.kind = kind
      this.carrier = carrier // riderless: flying in to pick up a hatched rider
      this.spawn = carrier ? 0 : 0.9
      this.leaving = 0
      this.fear = 0
      this.gloat = 0
      this.tieCd = 0
      this.retarget = 0
      this.tx = x
      this.ty = y
      this.z = 2
    }
    hit(px, py) {
      return !this.carrier && Math.abs(wdx(px - this.x, this.s.W)) < 14 && py > this.y - 4 && py < this.y + SH + 2
    }
    onClick() {
      // send the knight at this one
      const s = this.s
      const now = performance.now()
      s.data.lastClick = now
      s.data.knight.order = { foe: this, until: now + 7000 }
      s.data.knight.sleeping = false
      s.particle({ img: BUBBLE['!'], x: this.x - 2, y: Math.max(0, this.y - 9), life: 0.7 })
      this.fear = 1.2 // he's seen it coming
    }
    onDblClick() {
      this.s.say(KINDS[this.kind].name.toUpperCase(), this.x, Math.max(0, this.y - 9), { color: JP[KINDS[this.kind].armour[0]], life: 1.4 })
    }
    unseat(s) {
      this.dead = true
      s.spawn(new Egg(this.x, this.y + 8, this.vx * 0.6 + this.dir * 10, -16, this.kind))
      // the riderless buzzard flaps off
      const b = new Buzzard(s, this.x, this.y, this.kind, 'flee')
      b.vx = this.vx
      b.dir = this.dir
      s.spawn(b)
    }
    leave() {
      if (!this.leaving) this.leaving = 0.8
    }
    update(dt, now, s) {
      if (this.leaving > 0) {
        this.leaving -= dt
        if (this.leaving <= 0) this.dead = true
        return FAST
      }
      if (this.spawn > 0) {
        this.spawn -= dt
        return FAST
      }
      if (this.grabbed) {
        // pulled down into the lava
        this.grabbed -= dt
        this.flapT = Math.random() < 0.5 ? 0.16 : 0
        this.y = MAXY + (1.4 - this.grabbed) * 8
        if (this.grabbed <= 0) {
          this.dead = true
          s.burst(this.x, FLOOR - 3, 14, ['L', 'O', 'Y', 'l'])
        }
        return FAST
      }
      this.fear -= dt
      this.gloat -= dt
      this.tieCd -= dt
      this.retarget -= dt
      const k = s.data.knight
      if (this.carrier === 'flee') {
        // riderless and spooked: off over the edge, gone
        this.ty = 2
        this.tx = this.x + this.dir * 200
        this.age = (this.age || 0) + dt
        if (this.age > 2.5) this.leave()
      } else if (this.carrier) {
        // fly to the waiting rider and scoop him up
        const p = this.carrier.dead ? null : this.carrier
        if (!p) {
          this.carrier = null
          this.leave()
          return FAST
        }
        this.tx = p.x
        this.ty = MAXY - 4
        if (Math.abs(wdx(this.tx - this.x, s.W)) < 6 && this.y > MAXY - 9) {
          p.dead = true
          this.carrier = null
          this.kind = p.kind
          s.burst(this.x, this.y + 6, 4, ['w'])
        }
      } else if (this.retarget <= 0) {
        const kind = KINDS[this.kind]
        this.retarget = rand(0.7, 1.5)
        const kOk = k && k.out <= 0 && k.spawn <= 0
        // the cursor swept through him: he shies up and away
        const cur = s.cursor
        if (cur && cur.speed > 120 && Math.abs(wdx(cur.x - this.x, s.W)) < 24 && now - cur.t < 300) this.fear = 1.5
        if (this.lane === undefined || Math.random() < 0.2) this.lane = clamp(kind.lane + rand(-0.25, 0.25), 0, 1) * MAXY
        if (this.gloat > 0 || !kOk || Math.random() > kind.aggro) {
          // patrol: sweep across the bar in my lane
          this.tx = this.x + this.dir * rand(80, 160)
          this.ty = this.lane
        } else if (this.fear > 0 || k.y < this.y - 3) {
          // he's above me: veer off and climb
          this.tx = k.x - Math.sign(wdx(k.x - this.x, s.W) || 1) * rand(50, 90)
          this.ty = Math.max(0, k.y - 6)
        } else {
          // dive at him from just above
          this.tx = k.x + rand(-15, 15)
          this.ty = Math.max(0, k.y - rand(2, 5))
        }
        for (const o of riders(s))
          if (o !== this && Math.abs(wdx(o.x - this.x, s.W)) < 20 && Math.abs(o.y - this.y) < 8) this.ty = clamp(this.ty + (o.y > this.y ? -5 : 5), 0, MAXY)
      }
      const dx = wdx(this.tx - this.x, s.W)
      const want = this.steer(dx, 12)
      if (this.ty < this.y - 1 && this.vy > -10 && Math.random() < 0.6) this.flap(19)
      else if (this.vy > 30) this.flap(19)
      // most of the time they fly; now and then one lands and runs a stretch
      if (this.onGround && Math.random() < dt * 0.8) this.flap(22)
      this.physics(dt, s, want, (s.busy ? 1.15 : 1) * KINDS[this.kind].speed)
      return FAST
    }
    draw(c, s) {
      const set = this.carrier ? EMPTY : RIDERS[this.kind]
      const ph = this.spawn > 0 ? Math.floor(this.spawn * 12) : this.leaving > 0 ? Math.floor(this.leaving * 12) : -1
      if (this.grabbed) {
        c.save()
        c.beginPath()
        c.rect(-SW, 0, s.W + 2 * SW, FLOOR)
        c.clip()
        blit(c, s, this.pose(set), this.dir, this.x, this.y, ph)
        c.restore()
        return
      }
      blit(c, s, this.pose(set), this.dir, this.x, this.y, ph)
    }
  }

  // ---- eggs ------------------------------------------------------------------
  class Egg {
    constructor(x, y, vx, vy, kind) {
      this.egg = true
      this.x = x
      this.y = y
      this.vx = vx
      this.vy = vy
      this.kind = kind
      this.grounded = false
      this.age = 0
      this.hatchIn = rand(8, 12)
      this.hatched = false
      this.fresh = 0.8 // can't be scooped up the instant it pops out
      this.z = 1
    }
    get moving() {
      return !this.grounded || Math.abs(this.vx) > 1
    }
    hit(px, py) {
      return Math.abs(wdx(px - this.x, this.s?.W ?? 1e6)) < 8 && py > this.y - 5 && py < this.y + 12
    }
    onClick() {
      // the knight swoops for this one
      const s = this.s
      if (!s) return
      const now = performance.now()
      s.data.lastClick = now
      s.data.knight.order = { x: this.x, y: MAXY, land: true, until: now + 4000 }
      if (this.hatched) {
        this.wave = 1 // the little rider waves frantically
        s.particle({ img: BUBBLE['!'], x: this.x - 2, y: this.y - 10, life: 0.7 })
      }
    }
    update(dt, now, s) {
      this.s = s
      this.fresh -= dt
      if (!this.grounded) {
        this.vy = Math.min(this.vy + GRAV * dt, 50)
        this.y += this.vy * dt
        this.x = wrap(this.x + this.vx * dt, s.W)
        if (this.y >= FLOOR - 7) {
          this.y = FLOOR - 7
          if (this.vy > 22) this.vy = -this.vy * 0.35
          else {
            this.vy = 0
            this.grounded = true
          }
        }
        return FAST
      }
      if (Math.abs(this.vx) > 1) {
        this.x = wrap(this.x + this.vx * dt, s.W)
        this.vx *= 1 - 2.5 * dt
        return FAST
      }
      this.vx = 0
      if (!(s.lively(now) || s.busy) || s.data.mode === 'done') {
        this.since = 0
        return Infinity
      }
      // hatch clock from timestamps: long waits between ticks don't count short
      if (!this.since) this.since = now - this.age * 1000
      this.age = (now - this.since) / 1000
      if (!this.hatched) {
        if (this.age < this.hatchIn - 1.5) return Math.max(FAST, (this.hatchIn - 1.5 - this.age) * 1000)
        if (this.age < this.hatchIn) return FAST // wobble and crack
        this.hatched = true
        s.particle({ img: BUBBLE['!'], x: this.x - 2, y: FLOOR - 22, life: 0.8 })
        // a riderless buzzard comes for him
        s.spawn(new Buzzard(s, wrap(this.x + s.W / 2, s.W), 0, this.kind, this))
      }
      return SLOW
    }
    draw(c, s) {
      const x = Math.round(this.x) - 4
      if (!this.hatched) {
        const crack = this.age > this.hatchIn - 1.5
        const wob = crack ? (Math.floor(this.age * 8) % 2 ? 1 : -1) : 0
        c.drawImage(crack ? EGG_CRACK : EGG, x + wob, Math.round(this.y) - 1)
      } else {
        const up = Math.floor(this.age * (this.wave ? 8 : 3)) % 2
        c.drawImage(PILOT[this.kind][up ? 0 : 1][1], x - 1, FLOOR - 10)
      }
    }
  }

  // ---- the pterodactyl -------------------------------------------------------
  class Ptero {
    constructor(s) {
      this.s = s
      this.ptero = true
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.x = this.dir > 0 ? -20 : s.W + 20
      this.y = rand(2, MAXY)
      this.passes = 0
      this.t = 0
      this.z = 4
      this.hunting = true
      s.say('PTERODACTYL!', s.W / 2, 1, { color: '#b9adff', life: 1.8 })
    }
    get moving() {
      return true
    }
    get mouthOpen() {
      return Math.floor(this.t * 3) % 2 === 0
    }
    hit(px, py) {
      return Math.abs(px - this.x) < 18 && py > this.y - 2 && py < this.y + 16
    }
    onClick() {
      const s = this.s
      const now = performance.now()
      s.data.lastClick = now
      s.data.knight.order = { foe: this, until: now + 5000 }
      this.y = clamp(this.y + rand(-4, 4), 0, MAXY) // it shrieks and swerves
      s.particle({ img: BUBBLE['!'], x: this.x, y: Math.max(0, this.y - 8), life: 0.6 })
    }
    update(dt, now, s) {
      this.t += dt
      const k = s.data.knight
      if (!(s.lively(now) || s.busy)) this.hunting = false
      // swoop towards the knight's height, fast and straight
      if (this.hunting && k.out <= 0) this.y += clamp(k.y + 4 - this.y, -14 * dt, 14 * dt)
      this.y = clamp(this.y, 0, MAXY + 4)
      this.x += this.dir * (this.hunting ? 70 : 150) * dt
      if (this.x < -40 || this.x > s.W + 40) {
        this.passes++
        if (this.passes >= 3 || !this.hunting) {
          this.dead = true
          s.data.ptero = null
          return FAST
        }
        this.x = this.dir > 0 ? -38 : s.W + 38
      }
      // the only kill: lance straight into the open mouth
      if (k.out <= 0 && k.spawn <= 0 && k.grace <= 0 && Math.abs(k.x - this.x) < 20 && Math.abs(k.y + 4 - this.y) < 9) {
        if (this.mouthOpen && k.dir === -this.dir && Math.abs(k.y + 4 - this.y) < 6) {
          this.dead = true
          s.data.ptero = null
          s.burst(this.x, this.y + 8, 24, ['m', 'M', 'w', 'y'])
          s.data.score += 1000
          pts(s, 1000, this.x, this.y - 6)
          k.order = null
        } else k.knockOut(s)
      }
      return FAST
    }
    draw(c) {
      const f = Math.floor(this.t * 6) % 2
      const img = PTERO[f][this.dir]
      c.drawImage(img, Math.round(this.x - 18), Math.round(this.y))
      // jaw: drawn open on alternate beats
      if (!this.mouthOpen) {
        c.fillStyle = JP.m
        c.fillRect(Math.round(this.x - 18) + (this.dir > 0 ? 27 : 3), Math.round(this.y) + 9, 6, 1)
      }
    }
  }

  // ---- the lava troll's hand -----------------------------------------------
  class Hand {
    constructor(s, victim) {
      this.s = s
      this.victim = victim
      this.x = victim.x
      this.t = 0
      this.z = 5
      this.prop = true
    }
    update(dt, now, s) {
      this.t += dt
      const v = this.victim
      if (this.t < 0.6) this.x = v.x
      if (this.t > 0.6 && !this.grabbed) {
        this.grabbed = true
        if (v instanceof Knight) {
          if (v.out <= 0 && v.onGround) v.grip = 1.3
        } else if (!v.dead && v.onGround) v.grabbed = 1.4
      }
      if (this.t > 2.2) this.dead = true
      return FAST
    }
    draw(c) {
      const t = this.t
      const rise = t < 0.6 ? t / 0.6 : t < 1.6 ? 1 : Math.max(0, 1 - (t - 1.6) / 0.6)
      const img = HAND[t < 0.6 ? 0 : 1]
      const h = Math.round(rise * 12)
      if (h > 0) c.drawImage(img, 0, 0, img.width, h, Math.round(this.x) - 7, FLOOR - h, img.width, h)
    }
  }

  // ---- director --------------------------------------------------------------
  function spawnRider(s, kind = 0) {
    const k = s.data.knight
    const x = openSpot(s, wrap(k.x + s.W / 2 + rand(-80, 80), s.W))
    return s.spawn(new Buzzard(s, x, MAXY, kind))
  }
  function settle(s) {
    for (const r of riders(s)) r.leave()
    for (const e of eggs(s)) {
      e.dead = true
      s.burst(e.x, e.y + 3, 3, ['w'])
    }
    if (s.data.ptero) s.data.ptero.hunting = false
  }

  registerConcept({
    key: 'joust',
    title: 'Joust',
    sub: 'Williams, 1982',
    blurb:
      'A knight on an ostrich and buzzard riders flap through the whole height of the bar and wrap around its ends. When they meet, the higher lance wins: the loser drops an egg, the other riders scatter, and an egg left alone hatches and a riderless buzzard flies in for the rider. Bounders (red) are slow, Hunters (grey) chase, Shadow Lords (blue) fly high and fast. Work brings waves, sometimes the pterodactyl, which only dies to a lance in its open mouth, and the lava troll\'s hand reaches up for anyone on the floor. <b>Move the cursor</b> over the bar and he flies after it; <b>click a rider</b> to send him at it, an egg to grab it, the knight to flap, or drag him; double-click for a name or a squawk. Leave it and he plays on his own. Done turns every rider into an egg, and when it is quiet he lands and dozes.',
    setup(s) {
      const now = performance.now()
      s.data = { mode: 'calm', wave: 0, waveAt: 0, visitAt: now + 3000, handAt: now + 20000, resting: false, restX: 0, restAt: 0, score: 0, lastClick: -1e9, ptero: null, waveStart: 0 }
      s.data.knight = new Knight(s)
      s.actors.push(s.data.knight)
    },
    relayout(s) {
      for (const a of s.actors) if (a.x > s.W) a.x = wrap(a.x, s.W)
      s.data.restX = 0
    },
    onBarClick(s, p) {
      const k = s.data.knight
      const now = performance.now()
      s.data.lastClick = now
      k.order = { x: p.x, y: clamp(p.y - SH / 2, 0, MAXY), until: now + 2000 }
      k.flap(28)
    },
    onBusy(s) {
      s.data.mode = 'busy'
      s.data.waveAt = performance.now() + 900
      if (!s.data.wave) s.say('PREPARE TO JOUST', s.W / 2, 1, { color: '#f2d14b', life: 2 })
    },
    onDone(s) {
      const d = s.data
      d.mode = 'done'
      for (const r of riders(s)) if (!r.carrier && !r.grabbed && r.spawn <= 0) r.unseat(s)
      for (const r of riders(s)) if (r.carrier !== 'flee') r.leave()
      for (const e of eggs(s)) if (e.hatched) e.dead = true
      if (d.ptero) d.ptero.hunting = false
      if (!eggs(s).length) {
        d.mode = 'calm'
        s.say('WAVE CLEARED', s.W / 2, 1, { color: '#f2d14b', life: 2 })
      }
    },
    onNap(s) {
      s.data.mode = 'calm'
      settle(s)
    },
    onBonk(s) {
      // knocking on the window dots calls up a challenger
      if (riders(s).length < 4) spawnRider(s, Math.floor(rand(0, 3)))
    },
    update(s, dt, now) {
      const d = s.data
      const k = d.knight
      if (!(s.lively(now) || s.busy)) {
        if (!d.resting) {
          d.resting = true
          d.restAt = now
          d.restX = openSpot(s, k.x)
          d.mode = 'calm'
          settle(s)
        }
        return Infinity
      }
      d.resting = false
      d.restX = 0
      const rs = riders(s).filter((r) => !r.carrier)
      // the troll reaches up for whoever is down on the floor
      if (s.busy && now > d.handAt) {
        d.handAt = now + rand(25000, 45000)
        const low = [...rs.filter((r) => r.onGround && r.spawn <= 0), ...(k.onGround && k.out <= 0 && k.spawn <= 0 && Math.random() < 0.4 ? [k] : [])]
        if (low.length) s.spawn(new Hand(s, pick(low)))
        else d.handAt = now + 3000
      }
      const n = rs.length + eggs(s).length
      if (d.mode === 'busy') {
        if (n === 0 && !d.ptero) {
          if (!d.waveAt) d.waveAt = now + 2000
          if (now >= d.waveAt) {
            d.wave++
            d.waveAt = 0
            d.waveStart = now
            d.pteroDone = false
            if (d.wave > 1) s.say(`WAVE ${d.wave}`, s.W / 2, 1, { color: '#f2d14b', life: 1.6 })
            const count = Math.min(2 + Math.floor(d.wave / 2), s.W < 500 ? 3 : 4)
            for (let i = 0; i < count; i++) spawnRider(s, Math.min(2, Math.floor(rand(0, 1 + d.wave / 2))))
          }
          return d.waveAt ? Math.max(FAST, d.waveAt - now) : FAST
        }
        // a wave that drags on brings the pterodactyl (and the odd early one)
        if (!d.ptero && !d.pteroDone && d.wave >= 2 && now - d.waveStart > (d.wave % 3 === 0 ? 8000 : 40000)) {
          d.pteroDone = true
          d.ptero = s.spawn(new Ptero(s))
        }
        return Infinity
      }
      if (d.mode === 'calm' && n === 0) {
        if (now >= d.visitAt) {
          spawnRider(s, Math.random() < 0.7 ? 0 : 1)
          d.visitAt = now + rand(14000, 24000)
        }
        return Math.max(FAST, Math.min(d.visitAt - now, 30000 - (now - s.lastTouch) + 50))
      }
      return Math.max(FAST, 30000 - (now - s.lastTouch) + 50)
    },
  })
})()
