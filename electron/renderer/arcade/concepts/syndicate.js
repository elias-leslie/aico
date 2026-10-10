;(() => {
  // Syndicate: four trench-coated agents move as a squad and use the
  // Persuadertron on passers-by, who then trail behind them in a line.
  const BASE = { H: '#161616', S: '#d7a687', G: '#050505', C: '#655d6b', c: '#958ca0', k: '#0c0c0c', g: '#7fe0a0', T: '#c84040', P: '#3a4a7a', h: '#7a5428' }
  const AGENT_COL = ['#f0d040', '#40d0f0', '#f06868', '#78f078']
  const BEAM = ['#40ff80', '#c0ffe0', '#20c060']
  const RET = '#e8e060'
  const LOCK = '#ff4848'
  const mk = (rows, pal, cx) => {
    const p = pair(rows, pal)
    p.cx = cx
    return p
  }
  const aTop = ['.HH..', '.HSG.', '.cCC.', 'cCCCg', '.CCC.', '.CCC.']
  const AGENT = {
    stand: mk([...aTop, '.C.C.', '.k.k.'], BASE, 2),
    walk: [mk([...aTop, 'C..C.', 'k...k'], BASE, 2), mk([...aTop, '.CC..', '.kk..'], BASE, 2)],
  }
  const MARK = AGENT_COL.map((col) => sprite(['mmm', '.m.'], { m: col }))
  const cTop = ['.HH.', '.SS.', 'TTTT', 'STTS', '.PP.', '.PP.']
  const civRows = { stand: [...cTop, '.kk.'], a: [...cTop.slice(0, 5), '.P.P', 'k..k'], b: [...cTop.slice(0, 5), '.PP.', '.k.k'] }
  const copRows = { stand: ['HHH.', '.SS.', ...cTop.slice(2), '.kk.'], a: ['HHH.', '.SS.', ...cTop.slice(2, 5), '.P.P', 'k..k'], b: ['HHH.', '.SS.', ...cTop.slice(2, 5), '.PP.', '.k.k'] }
  const civSet = (rows, pal) => ({ stand: mk(rows.stand, pal, 1), walk: [mk(rows.a, pal, 1), mk(rows.b, pal, 1)] })
  const CIVS = [
    { T: '#c84040', H: '#7a5428', P: '#3a4a7a' },
    { T: '#e8c040', H: '#161616', P: '#5a5a5a' },
    { T: '#40b0a0', H: '#d8b060', P: '#2a3a5a' },
    { T: '#e080b0', H: '#5a3418', P: '#4a3a2a' },
    { T: '#e8e4dc', H: '#161616', P: '#6a4a8a' },
    { T: '#7080e0', H: '#a05030', P: '#3a3a3a' },
  ].map((c) => civSet(civRows, { ...BASE, ...c }))
  const COP = civSet(copRows, { ...BASE, H: '#2a3f9a', T: '#3858c8', P: '#24306a' })
  const FOLLOW_DOT = sprite(['g'], { g: '#5cff9a' })

  const blit = (c, sp, x, dir, lift = 0) => {
    const left = dir > 0 ? x - sp.cx : x - (sp.w - 1 - sp.cx)
    c.drawImage(sp[dir], Math.round(left), FLOOR - sp.h - lift)
  }

  // ---- the squad -------------------------------------------------------------
  class Squad {
    constructor(s) {
      this.s = s
      this.z = 3
      const cx = Math.round(s.W * 0.55)
      this.agents = [0, 1, 2, 3].map((i) => ({ x: cx + (i - 1.5) * 7, dir: 1, ft: 0, mv: false, lookDir: 1, lookUntil: 0 }))
      this.tx = cx
      this.face = 1
      this.beam = null
      this.followers = []
      this.tail = -1
      this.pending = null
      this.y = FLOOR
    }
    get x() {
      return (this.agents[0].x + this.agents[3].x) / 2
    }
    get moving() {
      return this.agents.some((a) => a.mv)
    }
    moveTo(x) {
      const tx = Math.round(clamp(x, 14, this.s.W - 15))
      if (Math.abs(tx - this.x) > 4) this.face = tx > this.x ? 1 : -1
      this.tx = tx
      // Followers trail opposite the march. If most of them are already
      // beyond where the squad is going, they stay on that side instead of
      // filing through the squad; flip only if there's no room.
      const n = this.followers.length
      const need = n * 6 + 18
      this.tail = -this.face
      if (n) {
        const avg = this.followers.reduce((t, f) => t + f.x, 0) / n
        if ((avg - tx) * this.face > 14) this.tail = this.face
      }
      if (this.tail < 0 && tx - need < 2) this.tail = 1
      if (this.tail > 0 && tx + need > this.s.W - 2) this.tail = -1
    }
    /** Left and right edge of the squad as it stands now. */
    span() {
      let a = 1e9
      let b = -1e9
      for (const g of this.agents) {
        a = Math.min(a, g.x)
        b = Math.max(b, g.x)
      }
      return [a - 3, b + 3]
    }
    hit(px, py) {
      if (py < FLOOR - 11 || py > FLOOR + 1) return false
      return this.agents.some((a) => Math.abs(px - a.x) <= 3.5)
    }
    /** Clicking an agent: the squad goes after the nearest bystander, or
     * moves out on patrol if there's nobody about. */
    onClick(p) {
      const s = this.s
      const d = s.data
      if (d.mode === 'done' || this.beam) return
      const a = this.nearest(p.x)
      a.lookDir = a.dir
      a.lookUntil = performance.now() + 900
      d.picked = { a, until: performance.now() + 900 }
      let best = null
      for (const c of free(s)) if (!best || Math.abs(c.x - this.x) < Math.abs(best.x - this.x)) best = c
      d.patrolAt = performance.now() + rand(8000, 12000)
      if (best && Math.abs(best.x - this.x) < s.W) {
        if (Math.abs(this.nearest(best.x).x - best.x) <= 40) this.persuade(best)
        else {
          this.pending = best
          this.moveTo(best.x + (this.x < best.x ? -30 : 30))
        }
      } else this.moveTo(this.x < s.W / 2 ? s.W - 40 : 40)
      s.poke()
    }
    nearest(x) {
      let best = this.agents[0]
      for (const a of this.agents) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a
      return best
    }
    /** Persuadertron: the nearest agent beams `civ`; a neighbour covers his back. */
    persuade(civ) {
      if (this.beam || civ.state === 'follow' || civ.dead) return false
      const now = performance.now()
      const a = this.nearest(civ.x)
      const i = this.agents.indexOf(a)
      a.dir = civ.x > a.x ? 1 : -1
      a.lookDir = a.dir
      a.lookUntil = now + 800
      const mate = this.agents[i === 3 ? 2 : i + 1]
      mate.lookDir = -a.dir
      mate.lookUntil = now + 1600
      civ.state = 'held'
      civ.dir = a.x > civ.x ? 1 : -1
      this.beam = { a, civ, until: now + 750 }
      this.s.poke()
      return true
    }
    finishBeam() {
      const { civ } = this.beam
      this.beam = null
      if (civ.dead) return
      const s = this.s
      civ.state = 'follow'
      this.followers.push(civ)
      s.burst(civ.x, FLOOR - 6, 6, ['G', 'g', 'w'])
      // Bystanders see a friend fall in line and scatter (some duck under furniture).
      for (const o of s.actors) {
        if (!(o instanceof Civ) || o === civ || o.cop || o.state === 'follow' || o.state === 'held') continue
        if (Math.abs(o.x - civ.x) < 60 && performance.now() > o.scareCool) o.scare(civ.x)
      }
      // Too many followers: the earliest one wanders off home.
      const cap = s.busy ? 9 : 7
      while (this.followers.length > cap) this.followers.shift().leave()
    }
    tailSlot(k) {
      const xs = this.agents.map((a) => a.x)
      const start = this.tail < 0 ? Math.min(...xs) - 7 : Math.max(...xs) + 7
      return clamp(start + this.tail * k * 6, 3, this.s.W - 4)
    }
    update(dt, now) {
      if (this.beam) {
        if (now >= this.beam.until) this.finishBeam()
        else return FAST
      }
      let any = false
      const sp = this.s.busy ? 34 : 30
      this.agents.forEach((a, i) => {
        const d = this.tx + (i - 1.5) * 7 - a.x
        if (Math.abs(d) <= sp * dt + 0.01) {
          a.x += d
          if (a.mv) a.dir = this.face
          a.mv = false
        } else {
          a.dir = d > 0 ? 1 : -1
          a.x += a.dir * sp * dt
          a.ft += dt
          a.mv = true
          any = true
        }
      })
      if (!any && this.pending) {
        const civ = this.pending
        this.pending = null
        if (!civ.dead && civ.state !== 'follow') this.persuade(civ)
        return FAST
      }
      if (any) return FAST
      const looks = Math.max(...this.agents.map((a) => a.lookUntil))
      return looks > now ? looks - now : Infinity
    }
    draw(c) {
      const now = performance.now()
      const pk = this.s.data.picked
      this.agents.forEach((a, i) => {
        const sp = a.mv ? AGENT.walk[Math.floor(a.ft * 7) % 2] : AGENT.stand
        const dir = !a.mv && now < a.lookUntil ? a.lookDir : a.dir
        blit(c, sp, a.x, dir)
        // the selected agent's marker bobs, like picking him in the game
        const bob = pk && pk.a === a && now < pk.until ? Math.floor(now / 120) % 2 : 0
        c.drawImage(MARK[i], Math.round(a.x - 1), FLOOR - 12 - bob)
      })
      const b = this.beam
      if (b) {
        const fr = Math.floor(now / 60)
        const x0 = Math.round(b.a.x + b.a.dir * 3)
        const x1 = Math.round(b.civ.x)
        const dir = x1 > x0 ? 1 : -1
        for (let x = x0, k = 0; x !== x1; x += dir, k++) {
          if ((k + fr) % 4 === 3) continue
          c.fillStyle = BEAM[(k + fr) % 3]
          c.fillRect(x, FLOOR - 5 + Math.round(Math.sin((k + fr * 2) * 0.8)), 1, 1)
        }
        c.fillStyle = BEAM[fr % 3]
        c.fillRect(x1 - 2, FLOOR - 8 - (fr % 2), 5, 1)
      }
    }
  }

  // ---- civilians and police ----------------------------------------------------
  class Civ {
    constructor(s, x, cop = false) {
      this.s = s
      this.cop = cop
      this.set = cop ? COP : pick(CIVS)
      this.x = x
      this.y = FLOOR
      this.dir = x < s.W / 2 ? 1 : -1
      this.state = 'wander'
      this.tx = null
      this.speed = 16
      this.ft = 0
      this.nextAt = performance.now() + rand(300, 2500)
      this.scareCool = 0
      this.z = 2
    }
    get moving() {
      return this.tx !== null
    }
    hit(x, y) {
      return !['follow', 'held', 'leave'].includes(this.state) && Math.abs(x - this.x) <= 4 && y >= FLOOR - 10
    }
    onClick() {
      const sq = this.s.data.squad
      const a = sq.nearest(this.x)
      if (Math.abs(a.x - this.x) <= 70) sq.persuade(this)
      else {
        sq.pending = this
        sq.moveTo(this.x + (sq.x < this.x ? -40 : 40))
        this.tx = null
        this.state = 'wait'
      }
    }
    scare(fromX) {
      const now = performance.now()
      this.scareCool = now + 7000
      this.s.particle({ img: BUBBLE['!'], x: this.x - 2, y: FLOOR - 17, life: 0.9, vy: -3 })
      const away = this.x >= fromX ? 1 : -1
      // nearest furniture on the far side to duck under, if any
      const under = this.s.fix
        .map((f) => f.x + f.w / 2)
        .filter((fx) => (fx - this.x) * away > 0 && Math.abs(fx - this.x) < 120)
        .sort((a, b) => Math.abs(a - this.x) - Math.abs(b - this.x))[0]
      this.state = under !== undefined ? 'hide' : 'flee'
      this.goto(under ?? this.x + away * rand(40, 70), 34)
      this.nextAt = now + rand(4000, 7000)
    }
    leave() {
      this.state = 'leave'
      this.goto(this.x < this.s.W / 2 ? -8 : this.s.W + 8, 22)
    }
    goto(x, speed) {
      this.tx = Math.round(x < -6 || x > this.s.W + 6 ? x : clamp(x, 3, this.s.W - 4))
      this.speed = speed
    }
    step(dt) {
      if (this.tx === null) return false
      const d = this.tx - this.x
      if (Math.abs(d) <= this.speed * dt + 0.01) {
        this.x = this.tx
        this.tx = null
        return false
      }
      this.dir = d > 0 ? 1 : -1
      this.x += this.dir * this.speed * dt
      this.ft += dt
      return true
    }
    update(dt, now, s) {
      const d = s.data
      const sq = d.squad
      if (this.state === 'held') return FAST
      if (this.state === 'leave') {
        this.step(dt)
        if (this.tx === null) this.dead = true
        return FAST
      }
      if (this.state === 'follow' || this.state === 'line') {
        const k = sq.followers.indexOf(this)
        if (k < 0) {
          this.leave()
          return FAST
        }
        const want = this.state === 'line' ? clamp(d.lineX + d.lineDir * k * 6, 3, s.W - 4) : sq.tailSlot(k)
        // On the wrong side of a squad that's coming this way: stand aside
        // (a step back) and let it pass, then fall in behind, rather than
        // walking through it.
        const [l, r] = sq.span()
        const wrong = this.state === 'follow' && (sq.tail < 0 ? this.x > l - 2 : this.x < r + 2)
        if (wrong && sq.moving && (this.x - sq.x) * sq.face > -8) {
          this.tx = null
          this.aside = true
          this.dir = sq.x > this.x ? 1 : -1
          return FAST
        }
        this.aside = wrong
        if (this.tx === null && Math.abs(want - this.x) > (sq.moving ? 3 : 5)) this.goto(want, 38)
        else if (this.tx !== null) this.tx = Math.round(want)
        if (this.step(dt)) return FAST
        this.aside = false
        // face the squad when idle in line
        this.dir = sq.x > this.x ? 1 : -1
        return sq.moving ? FAST : Infinity
      }
      if (!s.lively(now)) {
        // rest: bystanders stop where they are
        this.tx = null
        return Infinity
      }
      if (this.step(dt)) return FAST
      if (this.state === 'wait') {
        if (!sq.pending || sq.pending !== this) this.state = 'wander'
        return SLOW
      }
      if (this.cop && s.busy) {
        // police walk up to the squad to see what's going on
        if (Math.abs(sq.x - this.x) > 36) this.goto(sq.x + (this.x < sq.x ? -30 : 30), 24)
        return FAST
      }
      if (now < this.nextAt) {
        return this.nextAt - now
      }
      if (this.state === 'hide' || this.state === 'flee') this.state = 'wander'
      // wander: amble somewhere, pause, repeat
      let x = this.x + rand(-90, 90)
      if (Math.abs(x - this.x) < 20) x = this.x + (x > this.x ? 30 : -30)
      this.goto(clamp(x, 4, s.W - 5), rand(12, 18))
      this.nextAt = now + rand(2500, 6000)
      return FAST
    }
    draw(c) {
      const sp = this.tx !== null ? this.set.walk[Math.floor(this.ft * (this.speed > 25 ? 10 : 6)) % 2] : this.set.stand
      const lift = this.aside ? 1 : 0
      blit(c, sp, this.x, this.dir, lift)
      if (this.state === 'follow' || this.state === 'line') c.drawImage(FOLLOW_DOT, Math.round(this.x), FLOOR - 9 - lift)
    }
  }

  // ---- director ----------------------------------------------------------------
  const civs = (s) => s.actors.filter((a) => a instanceof Civ && !a.dead)
  const free = (s) => civs(s).filter((a) => !['follow', 'held', 'leave', 'line'].includes(a.state))

  function setup(s) {
    const d = s.data
    d.ret = null
    d.picked = null
    d.W = s.W
    d.squad = new Squad(s)
    s.actors.push(d.squad)
    for (const f of [0.12, 0.3, 0.75, 0.9]) s.actors.push(new Civ(s, Math.round(s.W * f + rand(-10, 10))))
    d.mode = 'idle'
    d.persuadeAt = performance.now() + 4000
    d.spawnAt = 0
    d.patrolAt = performance.now() + rand(6000, 10000)
    d.copAt = 0
  }

  function lockTarget(s) {
    const c = s.cursor
    if (!c || c.y < 0 || c.y > H) return null
    let best = null
    for (const a of free(s)) if (Math.abs(a.x - c.x) <= 5 && c.y >= FLOOR - 12 && (!best || Math.abs(a.x - c.x) < Math.abs(best.x - c.x))) best = a
    return best
  }

  function update(s, dt, now) {
    const d = s.data
    const sq = d.squad
    let wait = Infinity
    // the targeting reticle glides after the (coarse) cursor
    const cur = s.cursor
    if (cur) {
      if (!d.ret) d.ret = { x: cur.x, y: cur.y }
      const k = 1 - Math.exp(-dt * 16)
      d.ret.x += (cur.x - d.ret.x) * k
      d.ret.y += (cur.y - d.ret.y) * k
      if (Math.abs(cur.x - d.ret.x) + Math.abs(cur.y - d.ret.y) > 0.6) wait = FAST
    } else d.ret = null
    if (!s.lively(now)) {
      d.ret = null
      if (d.mode !== 'rest') {
        // Rest: the squad closes formation where it stands; everyone holds still.
        d.mode = 'rest'
        sq.pending = null
        sq.moveTo(sq.x)
        for (const a of free(s)) if (a.state !== 'leave') a.tx = null
      }
      return Infinity
    }
    if (d.mode === 'rest') d.mode = 'idle'
    if (d.mode === 'done') {
      if (now < d.doneUntil) return Math.min(wait, d.doneUntil - now)
      d.mode = 'idle'
      for (const f of sq.followers) f.state = 'follow'
      // then the converts drift back to their lives
      const out = sq.followers.splice(0)
      for (const f of out) {
        f.leave()
        f.speed = rand(14, 26)
      }
      d.persuadeAt = now + 6000
    }

    // keep a few bystanders around
    const fr = free(s)
    const crowd = clamp(Math.round(s.W / 140), 3, 8) // wider bar, a few more people
    if (fr.length < crowd && now > d.spawnAt && civs(s).length < 16) {
      d.spawnAt = now + rand(2500, 5000)
      const left = Math.random() < 0.5
      const c = new Civ(s, left ? -6 : s.W + 6)
      c.goto(left ? rand(20, 120) : s.W - rand(20, 120), 16)
      c.nextAt = now + rand(3000, 6000)
      s.spawn(c)
    }
    if (fr.length < crowd) wait = Math.min(wait, Math.max(50, d.spawnAt - now))

    // patrol: march to a new point, persuading on the way. Busy work keeps
    // them on the move; otherwise they stroll out every so often.
    if (!sq.moving && !sq.beam && !sq.pending && now > d.patrolAt) {
      d.patrolAt = now + (s.busy ? rand(5000, 8000) : rand(9000, 18000))
      const reach = Math.min(180, s.W * 0.4)
      let x = rand(20, s.W - 20)
      if (Math.abs(x - sq.x) < reach * 0.5) x = sq.x < s.W / 2 ? sq.x + rand(reach * 0.55, reach) : sq.x - rand(reach * 0.55, reach)
      sq.moveTo(x)
    }
    if (!sq.moving) wait = Math.min(wait, Math.max(50, d.patrolAt - now))
    if (s.busy) {
      // police show up to see what's going on
      if (now > d.copAt && civs(s).length < 16) {
        d.copAt = now + rand(7000, 11000)
        const left = sq.x > s.W / 2
        const cop = new Civ(s, left ? -6 : s.W + 6, true)
        s.spawn(cop)
        s.particle({ img: BUBBLE['!'], x: cop.x < 0 ? 2 : s.W - 8, y: FLOOR - 17, life: 1, vy: -3 })
      }
      wait = Math.min(wait, Math.max(50, d.copAt - now))
    }

    // auto-Persuadertron: police first, then the nearest bystander in range
    if (!sq.beam && !sq.pending && now > d.persuadeAt) {
      const range = s.busy ? 44 : 32
      const cap = s.busy ? 99 : 6
      if (sq.followers.length < cap || s.busy) {
        let best = null
        let bd = 1e9
        for (const a of fr) {
          if (a.state === 'wait') continue
          const dist = Math.abs(sq.nearest(a.x).x - a.x) - (a.cop ? 30 : 0)
          if (dist < bd && Math.abs(sq.nearest(a.x).x - a.x) <= range) {
            bd = dist
            best = a
          }
        }
        if (best && sq.persuade(best)) d.persuadeAt = now + (s.busy ? 1300 : 4000)
      }
    }
    if (!sq.beam) wait = Math.min(wait, Math.max(SLOW, d.persuadeAt - now))
    // look in now and then so the squad notices when things go quiet
    if (!s.busy) wait = Math.min(wait, 2000)
    return wait
  }

  registerConcept({
    key: 'syndicate',
    title: 'Syndicate',
    sub: 'Bullfrog, 1993',
    blurb:
      'Four trench-coated agents patrol the bar as a squad and use the Persuadertron on passers-by when they get close, while a squadmate turns to cover his back. Converts fall in line behind the squad and step aside to let it pass when it turns around, and other bystanders who see it scatter or duck under the furniture. <b>Click a passer-by</b> to have the squad go and persuade them, or <b>click an agent</b> to send the squad after the nearest one. While the agent works they patrol harder and police come to investigate, and get persuaded too; on done the converts line up for MISSION COMPLETE, then wander home. At rest everyone holds still.',
    setup,
    update,
    onBusy(s) {
      s.data.patrolAt = 0
      s.data.copAt = performance.now() + 1500
      s.data.persuadeAt = 0
    },
    onDone(s) {
      const d = s.data
      const sq = d.squad
      sq.pending = null
      sq.moveTo(sq.x)
      d.mode = 'done'
      d.doneUntil = performance.now() + 6000
      d.lineDir = sq.tail
      d.lineX = sq.tailSlot(0)
      for (const f of sq.followers) f.state = 'line'
      s.say('MISSION COMPLETE', clamp(sq.x, 40, s.W - 40), 1, { color: '#ffe14a', life: 3.5 })
    },
    relayout(s) {
      const sq = s.data.squad
      const k = s.data.W ? s.W / s.data.W : 1
      s.data.W = s.W
      // keep everyone where they were relative to the width, and in bounds
      const cx = Math.round(clamp(sq.x * k, 14, s.W - 15))
      sq.agents.forEach((a, i) => (a.x = cx + (i - 1.5) * 7))
      sq.tx = sq.moving ? Math.round(clamp(sq.tx * k, 14, s.W - 15)) : cx
      for (const a of s.actors) {
        if (!(a instanceof Civ)) continue
        if (a.state === 'leave') {
          if (a.x > s.W) a.x = s.W
          a.tx = a.tx < 0 ? -8 : s.W + 8
          continue
        }
        a.x = Math.round(clamp(a.x * k, 3, s.W - 4))
        if (a.tx !== null) a.tx = Math.round(clamp(a.tx * k, 3, s.W - 4))
      }
      s.poke()
    },
    // Mockup extra (the bar is a drag region in Aico): march to a clicked spot.
    onBarClick(s, p) {
      const d = s.data
      if (d.mode === 'done') return
      const sq = d.squad
      sq.pending = null
      sq.moveTo(p.x)
      d.patrolAt = performance.now() + 6000
    },
    drawFront(s, c) {
      const cur = s.data.ret
      if (!cur || cur.y < 0 || cur.y > H || cur.x < 0 || cur.x > s.W) return
      const t = lockTarget(s)
      let x0
      let y0
      let x1
      let y1
      if (t) {
        x0 = Math.round(t.x) - 4
        x1 = Math.round(t.x) + 4
        y0 = FLOOR - 10
        y1 = FLOOR - 1
        c.fillStyle = LOCK
      } else {
        x0 = Math.round(cur.x) - 4
        x1 = Math.round(cur.x) + 4
        y0 = Math.round(cur.y) - 4
        y1 = Math.round(cur.y) + 4
        c.fillStyle = RET
      }
      for (const [x, y, sx, sy] of [
        [x0, y0, 1, 1],
        [x1, y0, -1, 1],
        [x0, y1, 1, -1],
        [x1, y1, -1, -1],
      ]) {
        c.fillRect(Math.min(x, x + sx * 2), y, 3, 1)
        c.fillRect(x, Math.min(y, y + sy * 2), 1, 3)
      }
      if (!t) c.fillRect(Math.round(cur.x), Math.round(cur.y), 1, 1)
    },
  })
})()
