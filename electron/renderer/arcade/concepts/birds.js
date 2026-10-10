;(() => {
  // Birds: sparrows, pigeons and the odd crow living on the titlebar. They
  // perch on Aico's eyes, the title and the window dots, hop and waddle about
  // the floor, flock, squabble over bread, court, and doze when it's quiet.

  const BP = {
    // sparrow
    k: '#3a281b', n: '#8a5f3c', N: '#b98b58', r: '#a3532c', c: '#8f918f', C: '#d6d0c0', W: '#f3efe3', E: '#141414', q: '#4a4a4a', f: '#c98a62',
    // pigeon
    a: '#8d93a3', A: '#b7bccb', d: '#565b6b', g: '#3fae86', v: '#8d5cb0', o: '#f08a2c', p: '#e07b8c', w: '#e9e9ee', u: '#2f3340',
    // crow
    K: '#222330', j: '#353b52', J: '#5b6ea3', x: '#b8c0d4', Q: '#3a3a40',
    // bread
    B: '#d9a254', b: '#9a6a2e', y: '#f2d38a',
  }
  /** Outlined sprite pair with the feet column cx at the centre. */
  function mk(rows, cx, edge) {
    const w0 = Math.max(...rows.map((r) => r.length))
    const pad = Math.max(cx, w0 - 1 - cx)
    const rr = rows.map((r) => '.'.repeat(pad - cx) + r.padEnd(w0, '.') + '.'.repeat(pad - (w0 - 1 - cx)))
    const p = pairOutlined(rr, BP, edge)
    p.cw = rr[0].length
    p.ch = rr.length
    return p
  }
  function put(c, sp, x, y, dir, dy = 0) {
    c.drawImage(sp[dir], Math.round(x) - (sp.cw >> 1) - 1, Math.round(y) - sp.ch - 1 + dy)
  }

  // ---- art (right-facing) ---------------------------------------------------
  const SPARROW = {
    stand: mk(['......rcc..', '.....rccEq.', '.....rWWqq.', '....nnWEE..', '...nNknEEC.', '..nkNnkCCC.', '.nkNknnCCC.', 'kk.nkkCCC..', 'k.....f.f..'], 6),
    look: mk(['.....ccr...', '....qEccr..', '....qqWWr..', '.....EEWnn.', '...nNknEEC.', '..nkNnkCCC.', '.nkNknnCCC.', 'kk.nkkCCC..', 'k.....f.f..'], 6),
    peck: mk(['...........', '...........', '....nn.....', '...nNkrcc..', '..nNknrcEq.', '.nkNnkWWqq.', 'nkNknnEEC..', 'k..nkkCCC..', '......f.f..'], 6),
    sing: mk(['......rcc.q', '.....rccEq.', '.....rWW.q.', '....nnWEE..', '...nNknEEC.', '..nkNnkCCC.', '.nkNknnCCC.', 'kk.nkkCCC..', 'k.....f.f..'], 6),
    preen: mk(['...........', '....rcc....', '...rccEn...', '...rWnNq...', '..nnNkEEC..', '.nkNnkCCC..', 'nkNknnCCC..', 'k.nkkCCC...', '.....f.f...'], 5),
    puff: mk(['...........', '....rccc...', '...nnccEq..', '..nNknWWq..', '.nkNknEECC.', 'knNknnCCCC.', 'k.nkkCCCC..', '.....f.f...'], 5),
    sleep: mk(['...........', '...........', '....rcc....', '...nnccr...', '..nNknnCC..', '.nkNknCCCC.', 'knNknCCCC..', 'k..kkCCC...', '.....f.f...'], 5),
    fly: [
      mk(['...kn......', '...knN.....', '....kNn.rcc', '.....nNrcEq', 'kkknnnNWWq.', '..kkNnnCEC.', '.....kCCC..'], 6),
      mk(['...........', '.......rcc.', '......rcEq.', 'kkkn.nrWWq.', '..knNNNCEC.', '...knNnCC..', '....kNn....', '.....kn....'], 6),
    ],
  }
  const PIGEON = {
    stand: mk(['..........aa..', '.........aaoE.', '.........aaawu', '........gvaa..', '.......ggvv...', '.....aAgvva...', '...aaAAAAaaa..', '.ddaAAdAAaaa..', 'dddaAAdAAaa...', 'dd.aaAAAaa....', '.....aaaa.....', '......p.p.....', '.....pp.pp....'], 7),
    bob: mk(['...........aa.', '..........aaoE', '..........aaaw', '........gvaa.u', '.......ggvv...', '.....aAgvva...', '...aaAAAAaaa..', '.ddaAAdAAaaa..', 'dddaAAdAAaa...', 'dd.aaAAAaa....', '.....aaaa.....', '.....p...p....', '....pp...pp...'], 7),
    peck: mk(['..............', '..............', '..............', '.......aa.....', '.....aAgga....', '...aaAAAgvaa..', '.ddaAAdAAgvaa.', 'dddaAAdAAaaaoE', 'dd.aAAdAAa.aaw', '...aaAAAaa...u', '.....aaaa.....', '......p.p.....', '.....pp.pp....'], 7),
    puff: mk(['...........aa.', '..........aaoE', '..........aaaw', '.......ggvaa.u', '.....gggvvv...', '...aaggvvvva..', '.daaAAgvvvaa..', 'ddaAAAAAAaaa..', 'dddaAAdAAaaa..', 'dd.aaAAAaa....', '.....aaaa.....', '......p.p.....', '.....pp.pp....'], 7),
    bow: mk(['..............', '..............', '..............', '..............', '......aagg....', '....aaggvvaa..', '..daAAgvvvaaaa', '.ddaAAAAAaaaoE', 'dddaAAdAAaa.aw', 'dd.aaAAAaa...u', '.....aaaa.....', '......p.p.....', '.....pp.pp....'], 7),
    sleep: mk(['..............', '..............', '..............', '..............', '........aa....', '......gvaaa...', '....aaggvvaa..', '..ddaAAAAAaa..', '.dddaAAdAAaa..', '.dd.aaAAAaa...', '.....aaaaa....', '..............', '..............'], 7),
    fly: [
      mk(['...dd..........', '...daA.........', '....daA....aa..', '.....aAa..aaoE.', '......aAagvaawu', 'dddaaAAAAgvv...', '.ddaAAAAAaaa...', '....aaaaaa.....'], 8),
      mk(['...........aa..', '..........aaoE.', '..........aaawu', '.........gvaa..', 'dddaaaaaggvv...', '.ddaAAAAAAaa...', '....aAAaaa.....', '.....daAa......', '......dda......'], 8),
    ],
  }
  const RIM = 'rgba(150,160,190,.45)'
  const CROW = {
    stand: mk(['..........KKK...', '.........KKxKK..', '.........KKKKKKQ', '........KjKKK...', '.......KjjKK....', '.....KKjJjKK....', '...KKjjJJjKK....', '.KKjjjJJjjKK....', 'KKjKjjjjjKKK....', 'K..KKjjjjKK.....', '....KKKKKK......', '.....Q..Q.......', '.....Q..Q.......', '....QQ.QQ.......'], 6, RIM),
    step: mk(['..........KKK...', '.........KKxKK..', '.........KKKKKKQ', '........KjKKK...', '.......KjjKK....', '.....KKjJjKK....', '...KKjjJJjKK....', '.KKjjjJJjjKK....', 'KKjKjjjjjKKK....', 'K..KKjjjjKK.....', '....KKKKKK......', '....Q....Q......', '...Q......Q.....', '..QQ.....QQ.....'], 6, RIM),
    caw: mk(['..........KKK..Q', '.........KKxKKQ.', '.........KKKK...', '........KjKKKQQ.', '.......KjjKK..Q.', '.....KKjJjKK....', '...KKjjJJjKK....', '.KKjjjJJjjKK....', 'KKjKjjjjjKKK....', 'K..KKjjjjKK.....', '....KKKKKK......', '.....Q..Q.......', '.....Q..Q.......', '....QQ.QQ.......'], 6, RIM),
    peck: mk(['................', '................', '................', '................', '.......KKK......', '.....KKjjKKK....', '...KKjjJjjKKK...', '.KKjjjJJjjKKxK..', 'KKjKjjjjjKKKKKKQ', 'K..KKjjjjKK.....', '....KKKKKK......', '.....Q..Q.......', '.....Q..Q.......', '....QQ.QQ.......'], 6, RIM),
    sleep: mk(['................', '................', '................', '................', '................', '........KKK.....', '.....KKKjjKK....', '...KKjjJJjKK....', '.KKjjjJJjjKK....', 'KKjKjjjjjKKK....', 'K..KKjjjjKK.....', '....KKKKKK......', '.....Q..Q.......', '....QQ.QQ.......'], 6, RIM),
    fly: [
      mk(['..KK.............', '..KjK............', '...KjK...........', '....KjJK....KKK..', '.....KjJK..KKxKK.', 'KKKKjjjJJKKKKKKKQ', '.KKjjjjjjjKK.....', '...KKKKKKK.......'], 8, RIM),
      mk(['............KKK..', '...........KKxKK.', 'KKKK.......KKKKKQ', '.KKjjKKKKKKKK....', '...KjjjJJJjK.....', '....KKjjJjK......', '......KjJK.......', '.......KjK.......', '........KK.......'], 8, RIM),
    ],
  }
  const SPR = { sparrow: SPARROW, pigeon: PIGEON, crow: CROW }
  const STATS = {
    sparrow: { hw: 5, h: 9, fly: 95, walk: 0 },
    pigeon: { hw: 7, h: 13, fly: 75, walk: 10 },
    crow: { hw: 7, h: 14, fly: 85, walk: 9 },
  }
  const CRUST = sprite(['.bBBb.', 'bByyBb', '.bBBb.'], BP)
  const CRUMB = [sprite(['B'], BP), sprite(['y'], BP), sprite(['BB'], BP)]
  const BAG = mk(['..B.y...', '.CCNCC..', '.CNNNCC.', '..CCCC..', '.NNNNNN.', 'NNCNNNNN', 'NNNNNCNN', 'NNNNNNNN', 'NkNNNNkN', '.NNNNNN.'], 3)
  const FEATHER = { sparrow: sprite(['n'], BP), pigeon: sprite(['a'], BP), crow: sprite(['K'], BP) }
  const GNAT = [sprite(['c.c', '.E.'], { c: '#cfe6ff', E: '#151515' }), sprite(['...', 'cEc'], { c: '#cfe6ff', E: '#151515' })]

  // ---- the places a bird can stand ---------------------------------------
  function surfaces(s) {
    const out = [{ x0: 3, x1: s.W - 3, y: FLOOR, kind: 'floor' }]
    for (const f of s.fix) if (f.kind === 'eyes' || f.kind === 'title') out.push({ x0: Math.round(f.x), x1: Math.round(f.x + f.w), y: Math.round(f.y), kind: f.kind })
    for (const d of s.dots) out.push({ x0: Math.round(d.x) - 1, x1: Math.round(d.x + d.w) + 1, y: Math.round(d.y), kind: d.kind })
    return out
  }
  function birds(s) {
    return s.actors.filter((a) => a instanceof Bird && !a.dead)
  }
  /** Is x on surface y free for bird b (looking at where everyone is headed)? */
  function free(s, b, x, y) {
    for (const o of birds(s)) {
      if (o === b || o.state === 'gone' || o.leaving) continue
      const oy = o.dest ? o.dest.y : o.y
      const ox = o.dest ? o.dest.x : o.x
      if (oy === y && Math.abs(ox - x) < o.st.hw + b.st.hw - 1) return false
    }
    return true
  }
  /** A free spot for b: opts.near / opts.far (x), opts.floor / opts.perch. */
  function spotFor(s, b, opts = {}) {
    const out = []
    for (const sf of s.data.surfs) {
      if (sf.y - b.st.h < -1 || sf.x1 - sf.x0 < b.st.hw * 2 - 4) continue
      if (opts.floor && sf.kind !== 'floor') continue
      if (opts.perch && sf.kind === 'floor') continue
      const lo = sf.x0 + b.st.hw - 2
      const hi = sf.x1 - b.st.hw + 2
      const n = sf.kind === 'floor' ? 40 : 4
      for (let i = 0; i <= n; i++) {
        const x = Math.round(lo + ((hi - lo) * i) / n + (sf.kind === 'floor' ? rand(-3, 3) : 0))
        if (x < lo || x > hi || !free(s, b, x, sf.y)) continue
        let score = Math.random() * 40
        if (opts.near !== undefined) score += Math.abs(x - opts.near) + Math.abs(sf.y - (opts.nearY ?? sf.y)) * 2
        if (opts.far !== undefined) score -= Math.abs(x - opts.far) * 0.6
        if (b.kind === 'pigeon' && sf.kind !== 'floor') score += 60
        if (b.kind === 'sparrow' && sf.kind !== 'floor') score -= 25
        out.push({ x, y: sf.y, kind: sf.kind, score })
      }
    }
    if (!out.length) return { x: Math.round(rand(10, s.W - 10)), y: FLOOR, kind: 'floor' }
    out.sort((p, q) => p.score - q.score)
    return out[0]
  }
  function onSurface(s, x, y) {
    return s.data.surfs.find((sf) => sf.y === y && x >= sf.x0 - 1 && x <= sf.x1 + 1)
  }
  /** The first surface at or below (x, y). */
  function landingY(s, x, y) {
    let best = FLOOR
    for (const sf of s.data.surfs) if (x >= sf.x0 && x <= sf.x1 && sf.y >= y && sf.y < best) best = sf.y
    return best
  }
  function engaged(s, now) {
    const c = s.cursor
    return now - (s.data.touchAt || -1e9) < 9000 || (!!c && now - c.since < 2500 && now - (c.t ?? now) < 1500)
  }

  // ---- a bird ----------------------------------------------------------------
  class Bird {
    constructor(s, kind, arrive = false) {
      this.s = s
      this.kind = kind
      this.sp = SPR[kind]
      this.st = STATS[kind]
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.state = 'idle'
      this.pose = 'stand'
      this.anim = Math.random() * 3
      this.next = performance.now() + rand(500, 3000)
      this.grabbable = true
      this.social = performance.now() + rand(4000, 12000)
      const sp = spotFor(s, this)
      this.x = sp.x
      this.y = sp.y
      if (arrive) {
        this.x = Math.random() < 0.5 ? -16 : s.W + 16
        this.y = this.st.h + 2
        this.flyTo(sp)
      }
    }
    get moving() {
      return this.state === 'fly' || this.state === 'walk' || this.state === 'hop'
    }
    get asleep() {
      return this.state === 'sleep'
    }
    hit(px, py) {
      if (this.state === 'gone') return false
      return px >= this.x - this.st.hw - 3 && px <= this.x + this.st.hw + 3 && py >= this.y - this.st.h - 4 && py <= this.y + 2
    }
    say(k) {
      this.s.particle({ img: BUBBLE[k], x: this.x - 2, y: Math.max(0, this.y - this.st.h - 9), life: 1.1, vy: -3, fade: true })
    }
    // ---- moving about ----
    flyTo(spot, fast = false, path = null) {
      this.food = path ? null : this.food
      this.dest = { x: spot.x, y: spot.y }
      this.from = { x: this.x, y: this.y }
      this.path = path
      this.state = 'fly'
      const d = Math.hypot(spot.x - this.x, spot.y - this.y)
      this.dur = Math.max(0.35, d / (this.st.fly * (fast ? 1.4 : 1)))
      this.ft = 0
      const top = Math.min(this.y, spot.y) - clamp(d / 8, 3, 14)
      this.arc = Math.max(0, Math.min(this.y, spot.y) - Math.max(this.st.h - 2, top))
      if (Math.abs(spot.x - this.x) > 1) this.dir = spot.x > this.x ? 1 : -1
      this.s.poke()
    }
    /** Off out of the bar, back in a while. */
    flyAway(back = rand(3500, 7000)) {
      const out = this.x < this.s.W / 2 ? -18 : this.s.W + 18
      this.flyTo({ x: out, y: this.st.h - 2 }, true)
      this.away = true
      this.backIn = back
    }
    hopTo(x) {
      this.state = 'hop'
      this.hop = { x0: this.x, x1: x, t: 0, d: 0.22 }
      if (x !== this.x) this.dir = x > this.x ? 1 : -1
    }
    walkTo(x) {
      this.state = 'walk'
      this.wx = x
      if (x !== this.x) this.dir = x > this.x ? 1 : -1
    }
    /** Get to (x, y) the way this kind does: hop or walk if close, else fly. */
    goTo(x, y, fast = false) {
      if (y === this.y && onSurface(this.s, x, y) === onSurface(this.s, this.x, this.y) && Math.abs(x - this.x) < (this.kind === 'sparrow' ? 26 : 60)) {
        if (this.kind === 'sparrow' || (this.kind === 'crow' && Math.random() < 0.4)) {
          this.hopTo(this.x + clamp(x - this.x, -7, 7))
          this.goal = { x, y }
        } else this.walkTo(x)
      } else this.flyTo({ x, y }, fast)
    }
    startle(from, far = true) {
      if (['fly', 'held', 'gone'].includes(this.state)) return
      this.say('!')
      for (let i = 0; i < 2; i++) this.s.particle({ img: FEATHER[this.kind], x: this.x + rand(-3, 3), y: this.y - this.st.h / 2, vx: rand(-8, 8), vy: rand(-6, 2), g: 10, life: 1.4, fade: true })
      if (this.carry) this.dropCarry()
      if (far && this.kind !== 'pigeon') this.flyAway()
      else this.flyTo(spotFor(this.s, this, { far: from ?? this.x }), true)
    }
    dropCarry() {
      const f = this.carry
      this.carry = null
      f.carried = null
      f.x = this.x + this.dir * 4
      f.y = this.y - 6
      f.vy = -10
      f.landed = false
      this.s.data.food.push(f)
    }
    // ---- input ----
    onClick() {
      const s = this.s
      s.data.touchAt = performance.now()
      if (this.state === 'sleep') this.wake()
      if (this.kind === 'crow') s.say('Caw!', this.x, Math.max(0, this.y - this.st.h - 9), { life: 1, color: '#c9d2ea', size: 6 })
      this.startle(this.x, true)
      // the neighbours take fright too, a beat later
      for (const o of birds(s)) if (o !== this && Math.abs(o.x - this.x) < 40 && Math.abs(o.y - this.y) < 16 && Math.random() < 0.7) o.alarmAt = performance.now() + rand(120, 400)
    }
    onDblClick() {
      // a little show: a song, a coo, a caw
      if (this.state !== 'idle') return
      this.show()
    }
    show() {
      const s = this.s
      if (this.kind === 'sparrow') {
        this.pose = 'sing'
        this.say('♪')
      } else if (this.kind === 'pigeon') {
        this.pose = 'puff'
        s.say('coo', this.x, Math.max(0, this.y - this.st.h - 8), { life: 1, color: '#c8cde0', size: 6 })
      } else {
        this.pose = 'caw'
        s.say('Caw!', this.x, Math.max(0, this.y - this.st.h - 9), { life: 1, color: '#c9d2ea', size: 6 })
      }
      this.next = performance.now() + 900
    }
    grab() {
      const s = this.s
      s.data.touchAt = performance.now()
      if (this.state === 'gone') return
      if (this.carry) this.dropCarry()
      this.state = 'held'
      this.food = null
      this.say('!')
      for (const o of birds(s)) if (o !== this && Math.abs(o.x - this.x) < 60) o.alarmAt = performance.now() + rand(80, 300)
    }
    drag(p) {
      if (this.state !== 'held') return
      this.x = clamp(p.x, 4, this.s.W - 4)
      this.y = clamp(p.y + 5, this.st.h, FLOOR)
    }
    drop() {
      if (this.state !== 'held') return
      this.state = 'idle'
      this.flyTo(spotFor(this.s, this, { near: this.x }), true)
    }
    onBusy() {
      if (this.state === 'sleep') this.wake()
    }
    onDone(ran) {
      if (ran > 1500 && this.state === 'idle') {
        this.show()
        this.next = performance.now() + rand(600, 1400)
      }
    }
    onNap() {
      if (this.state === 'idle') this.next = 0
    }
    bonked(r, kind) {
      // a click on the window dot it's sitting on
      if (this.state !== 'idle' && this.state !== 'sleep') return
      if (this.y <= r.y + 1 && this.x >= r.x - 2 && this.x <= r.x + r.w + 2) {
        if (this.state === 'sleep') this.wake()
        this.startle(this.x, Math.random() < 0.5)
      }
    }
    wake() {
      this.state = 'idle'
      this.pose = 'look'
      this.next = performance.now() + rand(400, 1200)
    }

    // ---- per tick ----
    update(dt, now, s) {
      this.anim += dt
      const D = s.data
      if (this.alarmAt && now >= this.alarmAt) {
        this.alarmAt = 0
        if (this.state === 'sleep') this.wake()
        this.startle(this.x, this.kind === 'sparrow' && Math.random() < 0.5)
      }
      switch (this.state) {
        case 'held':
          return FAST
        case 'gone':
          if (!s.lively(now) && !this.leaving) return Infinity
          if (now >= this.backAt) {
            if (this.leaving) {
              this.dead = true
              return Infinity
            }
            this.x = this.x < 0 ? -16 : s.W + 16
            this.y = this.st.h
            this.state = 'idle'
            this.flyTo(spotFor(s, this, { near: rand(0, s.W) }))
            return FAST
          }
          return this.backAt - now
        case 'fly':
          return this.fly(dt, now, s)
        case 'hop': {
          const h = this.hop
          h.t += dt
          const k = Math.min(1, h.t / h.d)
          this.x = h.x0 + (h.x1 - h.x0) * k
          if (k >= 1) {
            this.x = h.x1
            this.state = 'idle'
            if (this.goal && Math.abs(this.goal.x - this.x) > 1) {
              this.hopTo(this.x + clamp(this.goal.x - this.x, -7, 7))
            } else {
              this.goal = null
              this.next = now + rand(200, 900)
            }
          }
          return FAST
        }
        case 'walk': {
          const d = this.wx - this.x
          const step = this.st.walk * dt
          if (Math.abs(d) <= step) {
            this.x = this.wx
            this.state = 'idle'
            this.next = now + rand(300, 1200)
          } else this.x += Math.sign(d) * step
          return FAST
        }
        case 'spar': {
          this.sparT -= dt
          if (Math.random() < dt * 4) s.particle({ img: FEATHER[this.kind], x: this.x + rand(-3, 3), y: this.y - 6, vx: rand(-10, 10), vy: rand(-10, 0), g: 12, life: 1.2, fade: true })
          if (this.sparT <= 0) {
            this.state = 'idle'
            if (this.loser) {
              this.loser = false
              this.flyTo(spotFor(s, this, { far: this.x }), true)
            } else {
              this.pose = 'puff'
              this.next = now + 1200
            }
          }
          return FAST
        }
        case 'sleep':
          if (s.lively(now) && !s.napping) {
            if (!this.wakeAt) this.wakeAt = now + rand(300, 3000)
            if (now >= this.wakeAt) {
              this.wakeAt = 0
              this.wake()
              return FAST
            }
            return this.wakeAt - now
          }
          if (now - this.sleptAt < 9000) {
            if (now - (this.lastZ || 0) > 2400) {
              this.lastZ = now
              s.particle({ img: ZZ, x: this.x + 2, y: this.y - this.st.h, vx: 2, vy: -3, life: 2.4, fade: true })
            }
            return 2400
          }
          return Infinity
      }
      return this.idle(dt, now, s, D)
    }

    fly(dt, now, s) {
      this.ft += dt
      const k = Math.min(1, this.ft / this.dur)
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      if (this.hunt && !this.hunt.dead) {
        this.dest.x = this.hunt.x
        this.dest.y = this.hunt.y + 4
      }
      this.x = this.from.x + (this.dest.x - this.from.x) * e
      this.y = this.from.y + (this.dest.y - this.from.y) * e - Math.sin(Math.PI * k) * this.arc
      if (k < 1) return FAST
      this.x = this.dest.x
      this.y = this.dest.y
      if (this.hunt) {
        const g = this.hunt
        this.hunt = null
        if (!g.dead && Math.hypot(g.x - this.x, g.y - (this.y - 4)) < 7) {
          g.dead = true
          this.say('♪')
        }
        this.dest = null
        this.flyTo(spotFor(s, this, { near: this.x }), true)
        return FAST
      }
      if (this.path && this.path.length) {
        const p = this.path.shift()
        this.flyTo(p, false, this.path)
        return FAST
      }
      this.path = null
      this.dest = null
      if (this.away) {
        this.away = false
        this.state = 'gone'
        this.backAt = now + (this.backIn || 5000)
        return FAST
      }
      if (this.y < FLOOR && !onSurface(s, this.x, this.y)) {
        // the perch went away (resize): drop to whatever is below
        this.flyTo({ x: this.x, y: landingY(s, this.x, this.y) })
        return FAST
      }
      this.state = 'idle'
      this.pose = 'stand'
      this.next = now + rand(300, 1200)
      return FAST
    }

    idle(dt, now, s, D) {
      const lively = s.lively(now)
      const cur = s.cursor
      // the cursor: a quick pass startles, a slow hover makes them curious
      if (cur && lively) {
        const d = Math.hypot(cur.x - this.x, cur.y - (this.y - this.st.h / 2))
        if (d < 22 && cur.speed > 110 && now - (this.calmAt || 0) > 800) {
          this.calmAt = now
          this.startle(cur.x, false)
          for (const o of birds(s)) if (o !== this && Math.abs(o.x - this.x) < 30 && Math.random() < 0.5) o.alarmAt = now + rand(150, 450)
          return FAST
        }
        if (d < 40 && cur.speed < 60 && now - (this.curious || 0) > 1500) {
          this.curious = now
          this.dir = cur.x > this.x ? 1 : -1
          this.pose = this.kind === 'sparrow' ? 'look' : 'stand'
          // crows like shiny things: a step closer
          if (this.kind === 'crow' && Math.abs(cur.x - this.x) > 10 && this.y === FLOOR) this.walkTo(clamp(cur.x - this.dir * 9, 8, s.W - 8))
        }
      }
      // food: go for it, eat it, fight over it
      const f = this.food
      if (f && (f.dead || f.carried)) this.food = null
      if (this.food) {
        const want = f.x - this.dir * (this.st.hw - 1)
        const there = Math.abs(this.x - want) <= 2 && this.y === f.y
        if (!there) {
          if (now < this.next) return Math.max(FAST, this.next - now)
          const side = this.x < f.x ? -1 : 1
          const tx = clamp(Math.round(f.x + side * (this.st.hw - 1)), 3, s.W - 3)
          this.goTo(tx, f.y, true)
          if (this.state !== 'idle') this.dir = f.x > tx ? 1 : -1
          return FAST
        }
        this.dir = f.x >= this.x ? 1 : -1
        if (this.kind === 'crow' && f.big) {
          // snatch the crust and make off with it
          f.carried = this
          this.carry = f
          D.food.splice(D.food.indexOf(f), 1)
          this.food = null
          s.say('Caw!', this.x, Math.max(0, this.y - this.st.h - 9), { life: 0.9, color: '#c9d2ea', size: 6 })
          for (const o of birds(s)) if (o.food === f) {
            o.food = null
            o.say('!')
          }
          this.flyAway(rand(9000, 16000))
          return FAST
        }
        if (now >= this.next) {
          this.pose = this.pose === 'peck' ? 'stand' : 'peck'
          this.next = now + (this.pose === 'peck' ? 220 : rand(150, 450))
          if (this.pose === 'peck') {
            f.n--
            if (f.big && Math.random() < 0.5) s.particle({ img: pick(CRUMB), x: f.x, y: f.y - 2, vx: rand(-14, 14), vy: rand(-18, -8), g: 70, life: 0.6 })
            if (f.n <= 0) {
              f.dead = true
              D.food.splice(D.food.indexOf(f), 1)
              this.food = null
              if (Math.random() < 0.5) this.show()
            } else this.rival(now, s)
          }
        }
        return FAST
      }
      if (now < this.next) return Math.max(FAST, Math.min(this.next - now, 4000))
      this.pose = 'stand'
      if (!lively) return this.settle(now, s)
      return this.decide(now, s, D)
    }

    /** Someone else on the same food: who gives way? */
    rival(now, s) {
      const f = this.food
      for (const o of birds(s)) {
        if (o === this || o.food !== f || o.state !== 'idle' || Math.abs(o.x - this.x) > 16) continue
        if (Math.random() > 0.25) return
        const big = { sparrow: 1, pigeon: 2, crow: 3 }
        const [win, lose] = big[o.kind] > big[this.kind] ? [o, this] : big[o.kind] < big[this.kind] ? [this, o] : Math.random() < 0.5 ? [this, o] : [o, this]
        if (win.kind === lose.kind && lose.kind === 'sparrow') {
          // a proper flutter-fight
          for (const b of [win, lose]) {
            b.state = 'spar'
            b.sparT = rand(1, 1.6)
            b.food = null
            b.dir = (b === win ? lose.x : win.x) > b.x ? 1 : -1
          }
          lose.loser = true
          win.food = f
        } else {
          lose.food = null
          lose.say('!')
          lose.startle(win.x, false)
        }
        return
      }
    }

    settle(now, s) {
      // quiet: the sparrows huddle up, everyone fluffs up and dozes
      if (this.kind === 'sparrow' && !this.huddled) {
        this.huddled = true
        const pal = birds(s).find((o) => o !== this && o.kind === 'sparrow' && o.state === 'sleep')
        if (pal && Math.abs(pal.x - this.x) > 12) {
          const x = pal.x + (Math.random() < 0.5 ? -9 : 9)
          if (onSurface(s, x, pal.y) && free(s, this, x, pal.y)) {
            this.flyTo({ x, y: pal.y })
            return FAST
          }
        }
      }
      this.state = 'sleep'
      this.pose = 'sleep'
      this.sleptAt = now
      this.lastZ = now
      return 2400
    }

    decide(now, s, D) {
      this.huddled = false
      const r = Math.random()
      const pace = s.busy ? 0.6 : 1
      const others = birds(s).filter((o) => o !== this && o.state === 'idle')
      // food lying about that nobody is on yet
      const lying = s.data.food.find((f) => f.landed && Math.abs(f.x - this.x) < 260 && (this.kind !== 'crow' || f.big) && birds(s).filter((o) => o.food === f).length < (f.big ? 3 : 1))
      if (lying && Math.random() < 0.7) {
        this.food = lying
        this.next = now + rand(100, 500)
        return FAST
      }
      // social: chirp at a neighbour, who answers; go and sit by a friend
      if (now > this.social && others.length) {
        this.social = now + rand(9000, 20000)
        const near = others.find((o) => o.kind === this.kind && Math.abs(o.x - this.x) < 45 && o.y === this.y)
        if (near && this.kind === 'sparrow') {
          this.dir = near.x > this.x ? 1 : -1
          this.pose = 'sing'
          this.say('♪')
          near.dir = -this.dir
          near.pose = 'look'
          near.next = now + 700
          near.replyAt = now + 800
          this.next = now + 1500
          return FAST
        }
        const friend = pick(others.filter((o) => o.kind === this.kind))
        if (friend && Math.abs(friend.x - this.x) > 60) {
          const sp = spotFor(s, this, { near: friend.x, nearY: friend.y })
          this.goTo(sp.x, sp.y)
          return FAST
        }
      }
      if (this.replyAt) {
        this.replyAt = 0
        this.pose = 'sing'
        this.say('♪')
        this.next = now + 900
        return FAST
      }
      if (this.kind === 'sparrow') {
        if (r < 0.22) {
          this.pose = 'peck'
          this.next = now + 250
        } else if (r < 0.36) this.hopTo(this.hopTarget(s))
        else if (r < 0.46) {
          this.pose = 'preen'
          this.next = now + rand(600, 1400) * pace
        } else if (r < 0.58) {
          this.pose = 'look'
          this.dir = Math.random() < 0.5 ? 1 : -1
          this.next = now + rand(600, 1600) * pace
        } else if (r < 0.64) {
          this.pose = 'sing'
          this.say('♪')
          this.next = now + 800
        } else if (r < 0.74) {
          const sp = spotFor(s, this, { near: this.x + rand(-160, 160) })
          this.flyTo(sp)
        } else this.next = now + rand(700, 2400) * pace
      } else if (this.kind === 'pigeon') {
        if (r < 0.3 && this.y === FLOOR) this.walkTo(clamp(this.x + rand(-40, 40), 8, s.W - 8))
        else if (r < 0.5) {
          this.pose = 'peck'
          this.next = now + 300
        } else if (r < 0.58) {
          this.pose = 'puff'
          this.next = now + rand(900, 1800)
        } else if (r < 0.66 && this.y !== FLOOR) this.flyTo(spotFor(s, this, { floor: true, near: this.x }))
        else if (r < 0.7) this.flyTo(spotFor(s, this, { near: this.x + rand(-200, 200) }))
        else this.next = now + rand(800, 2600) * pace
      } else {
        if (r < 0.2 && this.y === FLOOR) this.walkTo(clamp(this.x + rand(-30, 30), 8, s.W - 8))
        else if (r < 0.32) {
          this.pose = 'caw'
          s.say('Caw!', this.x, Math.max(0, this.y - this.st.h - 9), { life: 0.9, color: '#c9d2ea', size: 6 })
          this.next = now + 900
          // the little ones don't like it
          for (const o of birds(s)) if (o.kind === 'sparrow' && Math.abs(o.x - this.x) < 36 && o.state === 'idle' && Math.random() < 0.6) o.alarmAt = now + rand(150, 500)
        } else if (r < 0.45) {
          this.pose = 'peck'
          this.next = now + 300
        } else if (r < 0.5) this.flyTo(spotFor(s, this, { near: this.x + rand(-200, 200) }))
        else this.next = now + rand(900, 3000) * pace
      }
      // a gnat drifting by while the agent works: dart out for it
      if (s.busy && this.state === 'idle' && this.kind !== 'pigeon') {
        const g = D.gnats.find((q) => !q.chased && Math.abs(q.x - this.x) < 90)
        if (g) {
          g.chased = true
          this.hunt = g
          this.flyTo({ x: g.x, y: g.y + 4 }, true)
        }
      }
      return this.state === 'idle' ? Math.max(FAST, this.next - now) : FAST
    }
    hopTarget(s) {
      const sf = onSurface(s, this.x, this.y)
      let d = (Math.random() < 0.7 ? this.dir : -this.dir) * Math.round(rand(3, 7))
      if (!sf) return this.x
      const x = clamp(this.x + d, sf.x0 + 2, sf.x1 - 2)
      return free(s, this, x, this.y) ? x : this.x
    }

    draw(c) {
      const S = this.sp
      let sp
      let dy = 0
      if (this.state === 'gone') return
      if (this.state === 'fly' || this.state === 'held') {
        const k = this.state === 'fly' ? this.ft / this.dur : 0
        sp = this.state === 'fly' && k > 0.7 && this.dest && this.dest.y >= this.y ? S.fly[1] : S.fly[Math.floor(this.anim * 10) % 2]
      } else if (this.state === 'spar') {
        sp = S.fly[Math.floor(this.anim * 12) % 2]
        dy = -3 - Math.round(Math.abs(Math.sin(this.anim * 9)) * 3)
      } else if (this.state === 'hop') {
        sp = S.stand
        const k = this.hop.t / this.hop.d
        dy = -Math.round(Math.sin(Math.PI * Math.min(1, k)) * 3)
      } else if (this.state === 'walk') {
        if (this.kind === 'pigeon') sp = Math.floor(this.anim * 6) % 2 ? S.bob : S.stand
        else sp = Math.floor(this.anim * 5) % 2 ? S.step : S.stand
      } else if (this.state === 'sleep') sp = S.sleep
      else sp = S[this.pose] || S.stand
      put(c, sp, this.x, this.y, this.dir, dy)
      if (this.carry) c.drawImage(CRUST, Math.round(this.x + this.dir * (this.st.hw + 1)) - 3, Math.round(this.y - this.st.h + 1 + dy))
    }
  }

  /** The paper bag of crumbs: click it to throw some. */
  class Bag {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = -1
      this.place()
    }
    place() {
      const s = this.s
      const e = s.fixture('eyes')
      const t = s.fixture('title')
      this.x = Math.round(clamp(e.x + e.w + 14, 8, Math.max(8, t.x - 14)))
      this.y = FLOOR
    }
    hit(px, py) {
      return px >= this.x - 6 && px <= this.x + 6 && py >= this.y - 12
    }
    onClick() {
      const s = this.s
      s.data.touchAt = performance.now()
      this.toss(5)
    }
    toss(n) {
      const s = this.s
      const dir = this.x < s.W / 2 ? 1 : -1
      for (let i = 0; i < n; i++) throwFood(s, this.x + dir * 3, this.y - 8, dir * rand(20, 70), rand(-55, -30), false)
      for (const f of s.data.food) f.tossed = true
      this.wob = performance.now()
      s.poke()
    }
    update(dt, now) {
      return this.wob && now - this.wob < 400 ? FAST : Infinity
    }
    draw(c) {
      const w = this.wob && performance.now() - this.wob < 400 ? (Math.floor(performance.now() / 80) % 2 ? 1 : -1) : 0
      put(c, BAG, this.x + w, this.y, 1)
    }
  }

  function throwFood(s, x, y, vx, vy, big) {
    const D = s.data
    if (D.food.length >= 30) D.food.shift()
    D.food.push({ x, y, vx, vy, big, n: big ? 9 : 2, landed: false, at: performance.now() })
    s.poke()
  }
  function dropBread(s, x) {
    throwFood(s, clamp(x, 10, s.W - 10), -3, rand(-6, 6), 0, true)
  }
  /** Birds notice food that has just landed. */
  function notice(s, f, now) {
    for (const b of birds(s)) {
      if (b.state !== 'idle' || b.food) continue
      const reach = f.big || f.tossed ? 320 : 140
      if (Math.abs(b.x - f.x) > reach) continue
      if (b.kind === 'crow' && !f.big) continue
      const crowd = birds(s).filter((o) => o.food === f).length
      if (crowd >= (f.big ? 3 : 1) && Math.random() < 0.6) continue
      b.food = f
      b.next = now + rand(80, 700) + Math.abs(b.x - f.x) * 3
    }
  }

  // ---- scripted episodes, run by the scene while nobody is playing --------
  const EVENTS = {
    bread(s, now) {
      const bs = birds(s).filter((b) => b.state === 'idle')
      const x = bs.length ? pick(bs).x + rand(-50, 50) : rand(20, s.W - 20)
      dropBread(s, x)
      if (Math.random() < 0.3) setTimeoutFree(s, now + 700, () => dropBread(s, x + rand(-30, 30)))
    },
    flock(s, now) {
      const sp = birds(s).filter((b) => b.kind === 'sparrow' && b.state === 'idle')
      if (sp.length < 3) return false
      const cx = rand(60, s.W - 60)
      const dir = Math.random() < 0.5 ? 1 : -1
      sp.forEach((b, i) => {
        b.food = null
        const off = i * 9
        const p1 = { x: clamp(cx - dir * 40 + off, 8, s.W - 8), y: 9 + (i % 3) * 3 }
        const p2 = { x: clamp(cx + dir * 60 + off, 8, s.W - 8), y: 11 + (i % 2) * 4 }
        setTimeoutFree(s, now + i * 140, () => {
          if (b.state !== 'idle') return
          b.flyTo(p1, false, [p2, spotFor(s, b, { near: cx + rand(-120, 120) })])
        })
      })
      sp[0].say('!')
    },
    court(s, now) {
      const pg = birds(s).filter((b) => b.kind === 'pigeon' && b.state === 'idle')
      if (pg.length < 2) {
        if (birds(s).filter((b) => b.kind === 'pigeon').length < 2) s.spawn(new Bird(s, 'pigeon', true))
        return
      }
      const [m, f] = pg
      s.data.court = { m, f, until: now + rand(9000, 14000), next: now }
      if (f.y !== FLOOR) f.flyTo(spotFor(s, f, { floor: true, near: m.x }))
    },
    squabble(s, now) {
      const sp = birds(s).filter((b) => b.kind === 'sparrow' && b.state === 'idle')
      if (sp.length < 2) return false
      const a = pick(sp)
      const b = sp.filter((o) => o !== a).sort((p, q) => Math.abs(p.x - a.x) - Math.abs(q.x - a.x))[0]
      const x = clamp(a.x + (b.x > a.x ? 9 : -9), 6, s.W - 6)
      if (!onSurface(s, x, a.y)) return false
      b.flyTo({ x, y: a.y }, true)
      setTimeoutFree(s, now + b.dur * 1000 + 300, () => {
        if (a.state !== 'idle' || b.state !== 'idle') return
        for (const q of [a, b]) {
          q.state = 'spar'
          q.sparT = rand(1.1, 1.7)
          q.dir = (q === a ? b.x : a.x) > q.x ? 1 : -1
        }
        ;(Math.random() < 0.5 ? a : b).loser = true
      })
    },
    crow(s, now) {
      const crow = birds(s).find((b) => b.kind === 'crow')
      if (!crow) {
        s.spawn(new Bird(s, 'crow', true))
        return
      }
      if (crow.state !== 'idle') return false
      // a caw, and the crow wants whatever bread is about
      const big = s.data.food.find((f) => f.big && f.landed)
      if (big) {
        crow.food = big
        crow.next = now
      } else crow.show()
    },
    visit(s) {
      const all = birds(s)
      const n = (k) => all.filter((b) => b.kind === k).length
      if (all.length < 7 && (n('sparrow') < 5 || n('pigeon') < 2) && Math.random() < 0.65) s.spawn(new Bird(s, n('sparrow') < 5 && Math.random() < 0.7 ? 'sparrow' : 'pigeon', true))
      else {
        const idle = all.filter((b) => b.state === 'idle' && (b.kind !== 'sparrow' || n('sparrow') > 2))
        const b = pick(idle)
        if (b) {
          b.leaving = true
          b.flyAway(0)
        }
      }
    },
  }
  /** A tiny one-shot timer living in s.data, run from update (no setTimeout). */
  function setTimeoutFree(s, at, fn) {
    if (s.data.later.length < 20) s.data.later.push({ at, fn })
  }
  function courtTick(s, now) {
    const C = s.data.court
    const { m, f } = C
    if (m.dead || f.dead || m.state === 'gone' || f.state === 'gone' || m.state === 'held' || f.state === 'held' || now > C.until) {
      if (!m.dead && !f.dead && now > C.until && m.state === 'idle' && f.state === 'idle') {
        if (Math.random() < 0.5) {
          f.say('♥')
          m.say('♥')
        } else {
          m.say('…')
          f.flyTo(spotFor(s, f, { far: m.x }))
        }
      }
      s.data.court = null
      return
    }
    if (now < C.next || m.state !== 'idle' || f.state !== 'idle' || m.food || f.food) return
    const gap = f.x - m.x
    if (f.y !== m.y) {
      C.next = now + 800
      if (m.y !== f.y) m.goTo(spotFor(s, m, { near: f.x, nearY: f.y }).x, f.y)
      return
    }
    if (Math.abs(gap) > 18) {
      m.walkTo(f.x - Math.sign(gap) * 13)
      C.next = now + 400
      return
    }
    // the display: puff up, bow, coo, turn about; she edges away
    const r = Math.random()
    m.dir = gap > 0 ? 1 : -1
    if (r < 0.35) {
      m.pose = 'puff'
      s.say('coo', m.x, Math.max(0, m.y - 22), { life: 0.9, color: '#c8cde0', size: 6 })
    } else if (r < 0.6) m.pose = 'bow'
    else if (r < 0.8) {
      m.dir = -m.dir
      m.pose = 'puff'
    } else {
      f.walkTo(clamp(f.x + Math.sign(gap || 1) * rand(10, 20), 8, s.W - 8))
    }
    m.next = now + 800
    C.next = now + rand(700, 1100)
  }

  registerConcept({
    key: 'birds',
    title: 'Birds on the bar',
    sub: 'calm, all-day',
    chosen: true,
    blurb:
      'Sparrows, pigeons and now and then a crow. They perch on Aico\'s eyes, the title and the window dots, hop and waddle along the floor, peck and preen, and sing back and forth. Someone drops bread: they converge, squabble, and a crow may swoop in and steal the crust. The sparrows take off as a flock and land again one by one, two of them have a flutter-fight, and a pigeon puffs up, bows and coos at another pigeon who keeps walking off. While the agent works they dart after gnats, and a finished run gets a song. <b>Click a bird</b> to startle it (it flaps away and comes back, and the neighbours may go too; a crow drops what it\'s carrying), <b>double-click</b> one to make it sing, coo or caw, <b>drag</b> one about, click the <b>paper bag</b> to throw crumbs. A slow cursor makes them curious, a quick one scares them. When it\'s quiet they huddle up and doze.',
    setup(s) {
      const now = performance.now()
      s.data = { surfs: [], food: [], gnats: [], later: [], court: null, nextEvent: now + rand(5000, 10000), nextGnat: 0, touchAt: -1e9 }
      s.data.surfs = surfaces(s)
      s.actors.push(new Bag(s))
      const kinds = ['sparrow', 'sparrow', 'sparrow', 'pigeon']
      if (Math.random() < 0.5) kinds.push('pigeon')
      if (Math.random() < 0.5) kinds.push('crow')
      for (const k of kinds) s.actors.push(new Bird(s, k))
    },
    relayout(s) {
      const D = s.data
      if (!D.surfs) return
      D.surfs = surfaces(s)
      for (const a of s.actors) {
        if (a instanceof Bag) a.place()
        if (!(a instanceof Bird)) continue
        if (a.state === 'gone' || a.state === 'held') continue
        if (a.state === 'fly') {
          if (!a.away) {
            a.dest.x = clamp(a.dest.x, 3, s.W - 3)
            if (!onSurface(s, a.dest.x, a.dest.y)) a.dest.y = landingY(s, a.dest.x, a.dest.y)
          }
          continue
        }
        a.x = clamp(a.x, 3, s.W - 3)
        if (a.state === 'walk') a.wx = clamp(a.wx, 3, s.W - 3)
        if (!onSurface(s, a.x, a.y)) {
          // the perch moved (title renamed, window resized)
          a.state = 'idle'
          a.goal = null
          a.flyTo(spotFor(s, a, { near: a.x, nearY: a.y }), true)
        }
      }
      for (const f of D.food) f.x = clamp(f.x, 2, s.W - 2)
      s.poke()
    },
    update(s, dt, now) {
      const D = s.data
      const lively = s.lively(now)
      let moving = false
      // one-shot timers
      if (D.later.length) {
        const due = D.later.filter((l) => now >= l.at)
        D.later = D.later.filter((l) => now < l.at)
        for (const l of due) l.fn()
        moving = true
      }
      // food in flight; landed food goes stale after a while
      for (const f of D.food) {
        if (f.landed) continue
        moving = true
        f.vy += 150 * dt
        const ny = f.y + f.vy * dt
        f.x = clamp(f.x + (f.vx || 0) * dt, 2, s.W - 2)
        const g = landingY(s, f.x, Math.max(0, Math.ceil(f.y)))
        if (f.vy > 0 && ny >= g) {
          f.y = g
          f.landed = true
          f.at = now
          notice(s, f, now)
        } else f.y = ny
      }
      if (D.food.length) {
        const before = D.food.length
        D.food = D.food.filter((f) => now - f.at < 150000)
        if (D.food.length !== before) moving = true
      }
      // gnats while the agent works
      if (s.busy && now > D.nextGnat && D.gnats.length < 3) {
        D.nextGnat = now + rand(2500, 6000)
        const left = Math.random() < 0.5
        D.gnats.push({ x: left ? -3 : s.W + 2, y: rand(6, FLOOR - 10), vx: (left ? 1 : -1) * rand(8, 14), ph: rand(0, 6), age: 0, dead: false, chased: false })
      }
      for (const g of D.gnats) {
        g.age += dt
        g.ph += dt * 5
        g.x += (g.vx + Math.sin(g.ph * 0.7) * 10) * dt
        g.y = clamp(g.y + Math.cos(g.ph) * 14 * dt, 4, FLOOR - 6)
        if (g.x < -6 || g.x > s.W + 4 || g.age > 30) g.dead = true
        if (g.chased && !s.actors.some((a) => a.hunt === g)) g.chased = false
      }
      D.gnats = D.gnats.filter((g) => !g.dead)
      if (D.gnats.length) moving = true
      if (D.court) courtTick(s, now)
      // the scene plays itself unless someone's playing with it
      if (lively && now > D.nextEvent && !engaged(s, now)) {
        D.nextEvent = now + (s.busy ? rand(4500, 9000) : rand(8000, 17000))
        const all = birds(s)
        const opts = [['bread', 3], ['flock', 2], ['squabble', 2], ['court', D.court ? 0 : 2], ['crow', 1.5], ['visit', all.length < 4 ? 3 : 1]]
        let tot = opts.reduce((a, [, w]) => a + w, 0)
        let r = Math.random() * tot
        for (const [k, w] of opts) {
          if ((r -= w) < 0) {
            EVENTS[k](s, now)
            break
          }
        }
        moving = true
      }
      if (moving || D.court) return FAST
      return lively ? Math.max(FAST, D.nextEvent - now) : Infinity
    },
    drawBehind(s, c) {
      for (const f of s.data.food) c.drawImage(f.big ? CRUST : CRUMB[(Math.round(f.x) % 2) | 0], Math.round(f.x) - (f.big ? 3 : 0), Math.round(f.y) - (f.big ? 3 : 1))
    },
    drawFront(s, c) {
      for (const g of s.data.gnats) c.drawImage(GNAT[Math.floor(g.ph * 2) % 2], Math.round(g.x) - 1, Math.round(g.y) - 1)
    },
    onDone(s, ran) {
      if (ran < 1500) return
      // a good run: bread all round
      const bs = birds(s)
      for (let i = 0; i < 2; i++) setTimeoutFree(s, performance.now() + i * 600, () => dropBread(s, (bs.length ? pick(bs).x : s.W / 2) + rand(-40, 40)))
    },
  })
})()
