;(() => {
  // Isometric cyberpunk squad tactics, big version. Four cyborg agents in long
  // trenchcoats work the street as a squad: the persuader gun turns civilians
  // into a following line, police come to tell them to drop their weapons,
  // rival agents walk in for a firefight (minigun, laser, Gauss gun), a hit
  // on a target in a white suit ends in MISSION COMPLETE. Busy is open war;
  // done is the mission complete moment; at rest the squad stands in a
  // quiet stretch of street with its converts lined up behind it.

  const live = (s, now) => s.lively(now)
  const NOW = () => performance.now()
  // the user is driving: a click in the last 9 s, or the cursor moving over the bar
  const engaged = (s, now) => now - (s.keyAt ?? -1e9) < 9000 || now < (s.data.userUntil || 0) || (s.cursor && now - s.cursor.t < 1600)
  // the keys are driving: held now, or pressed in the last 9 s
  const touched = (s) => {
    s.data.userUntil = NOW() + 9000
  }

  // ---- palette -------------------------------------------------------------
  const P = {
    H: '#18181d', S: '#d9a47e', s: '#a26b4b', G: '#050507', g: '#9fe8ff',
    C: '#56515f', c: '#7d778c', d: '#36323d', a: '#45404e', B: '#121214',
    W: '#7a808b', w: '#c3c9d2', r: '#ff3b3b', x: '#f4f4f4',
    // rival agents: dark red coats, pale hair
    R: '#6e2a33', q: '#97404a', Q: '#45181e', Y: '#d8c79a',
    // civilians
    T: '#b84040', L: '#30384e', F: '#141414', h: '#6a4424', E: '#1a1010', l: '#232a3a',
    // police
    p: '#2f4fb4', P: '#1e3070', y: '#f2d14b', k: '#0e1430',
    // VIP
    V: '#ecebe4', v: '#b9b6ad', t: '#c02828',
    // cars
    K: '#101014', n: '#3f4656', N: '#68718a', o: '#9ad8ff', O: '#ffe58a', b: '#2a5ad8', e: '#e8e8ee',
  }

  // ---- helpers --------------------------------------------------------------
  const compose = (...parts) => [].concat(...parts)
  function overlay(base, top, ox, oy) {
    const out = base.slice()
    top.forEach((r, j) => {
      const y = oy + j
      const row = [...(out[y] || '').padEnd(ox + r.length, '.')]
      ;[...r].forEach((ch, i) => {
        if (ch !== '.') row[ox + i] = ch
      })
      out[y] = row.join('')
    })
    return out
  }
  function frame(rows, ax, pal = P) {
    const w = Math.max(...rows.map((r) => r.length))
    const padded = rows.map((r) => r.padEnd(w, '.'))
    return { sp: pairOutlined(padded, pal), ax, w, h: rows.length }
  }
  const white = (rows) => rows.map((r) => r.replace(/[^.]/g, 'x'))
  function blit(c, f, cx, dir, lift = 0) {
    const left = dir > 0 ? cx - f.ax : cx - (f.w - 1 - f.ax)
    c.drawImage(f.sp[dir], Math.round(left) - 1, Math.round(FLOOR - f.h - lift) - 1)
  }
  /** Draw a frame rotated about its feet (falling over). */
  function blitRot(c, f, cx, dir, ang) {
    c.save()
    c.translate(Math.round(cx), FLOOR)
    c.rotate(ang)
    const left = dir > 0 ? -f.ax : -(f.w - 1 - f.ax)
    c.drawImage(f.sp[dir], left - 1, -f.h - 1)
    c.restore()
  }

  // ---- the agents (24 px, facing right, body centre column 6) ----------------
  const HEAD = [
    '.....HHHH......',
    '....HHHHHH.....',
    '....HHHSSSs....',
    '....HHSGGgG....',
    '.....HSSSSs....',
    '......SSs......',
  ]
  const TORSO_DOWN = [
    '....ccCCCc.....',
    '...cCCCCCCc....',
    '...CCCaCCCCC...',
    '...CCCaCCCCC...',
    '...CCCaCCCCC...',
    '...CCCaCCCCC...',
    '...CCCaCCCCC...',
    '...CCCSWCCCC...',
  ]
  const TORSO_AIM = [
    '....ccCCCc.....',
    '...cCCCCCCc....',
    '...CCCCCaaaaS..',
    '...CCCCCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
  ]
  const TORSO_BEAM = [
    '....ccCCCc.....',
    '...cCCCCCCcaaSS',
    '...CCCCCCaa..S.',
    '...CCCCCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
    '...CCCdCCCCC...',
  ]
  const COAT = {
    stand: [
      '...CCCdCCCCC...',
      '...CCCdCCCCC...',
      '..CCCCdCCCCCC..',
      '..CCCCdCCCCCC..',
      '..CCCCdCCCCCC..',
      '..dCCC.CCCCCd..',
      '..dCC...CCCCd..',
      '....BB..BB.....',
      '....BB..BB.....',
      '...BBB..BBBB...',
    ],
    w0: [
      '...CCCdCCCCC...',
      '..CCCCdCCCCC...',
      '..CCCCdCCCCCC..',
      '.dCCCCdCCCCCC..',
      '.dCCCC.CCCCCCC.',
      'dCCCC...CCCCCC.',
      'dCC......BBCCd.',
      '..BB......BB...',
      '.BB........BB..',
      'BBB........BBBB',
    ],
    w1: [
      '...CCCdCCCCC...',
      '...CCCdCCCCC...',
      '..CCCCdCCCCCC..',
      '.dCCCCdCCCCCC..',
      '.dCCCCdCCCCC...',
      'dCCCC..CCCCd...',
      '.dCC..BBCCd....',
      '....BBBB.......',
      '...BB.BB.......',
      '..BB..BBBB.....',
    ],
    w2: [
      '...CCCdCCCCC...',
      '..CCCCdCCCCC...',
      '.dCCCCdCCCCCC..',
      '.dCCCCdCCCCCCC.',
      'dCCCCC.CCCCCCC.',
      'dCCC....CCCCCCd',
      '.dC......BBCCd.',
      '..BB......BB...',
      '.BB........BB..',
      'BBB........BBBB',
    ],
    w3: [
      '...CCCdCCCCC...',
      '...CCCdCCCCC...',
      '..CCCCdCCCCCC..',
      '..dCCCdCCCCCC..',
      '.dCCCCdCCCCC...',
      '.dCCC..CCCCd...',
      'dCCC..BBCCd....',
      '.....BBB.......',
      '....BB.BB......',
      '...BBB.BBBB....',
    ],
  }
  const GUNS = {
    pistol: ['SWWW', '.W..'],
    minigun: ['.wwwwwww', 'SWWWWWWW', '.WW.w...'],
    laser: ['......w.', 'SWWWWWWr', '.WW.....'],
    gauss: ['.WWWWWWWw', 'SWwwwwwwW', '.WWWWWWWw', '..W......'],
  }
  const GUN_GRIP = { pistol: 0, minigun: 1, laser: 1, gauss: 1 }
  const MUZZLE = { pistol: 16, minigun: 20, laser: 20, gauss: 21 }
  const WEAPONS = ['minigun', 'laser', 'gauss']
  const aimRows = (wpn) => overlay(compose(HEAD, TORSO_AIM, COAT.stand), GUNS[wpn], 12, 8 - GUN_GRIP[wpn])
  function agentSet(map) {
    const tr = (rows) => (map ? recolor(rows, map) : rows)
    const set = {
      stand: frame(tr(compose(HEAD, TORSO_DOWN, COAT.stand)), 6),
      walk: ['w0', 'w1', 'w2', 'w3'].map((k) => frame(tr(compose(HEAD, TORSO_DOWN, COAT[k])), 6)),
      beam: frame(tr(compose(HEAD, TORSO_BEAM, COAT.stand)), 6),
      flash: frame(white(compose(HEAD, TORSO_DOWN, COAT.stand)), 6),
      aim: {},
    }
    for (const w of [...WEAPONS, 'pistol']) set.aim[w] = frame(tr(aimRows(w)), 6)
    return set
  }
  const AGENT = agentSet(null)
  const RIVAL = agentSet({ C: 'R', c: 'q', d: 'Q', a: 'Q', H: 'Y' })

  // ---- civilians, police, the target (20 px) ---------------------------------
  const CIV_TOP = {
    plain: ['...hhh...', '..hhhhh..', '..hhSSS..', '..hSSES..', '...SSSs..', '....SS...'],
    hat: ['..FFFF...', '.FFFFFF..', '..hSSSS..', '..hSSES..', '...SSSs..', '....SS...'],
    long: ['..hhhh...', '.hhhhhh..', '.hhhSSS..', '.hhSSES..', '.hhhSSs..', '.hh.SS...'],
    cap: ['..pppp...', '.pppppPP.', '..pSSSS..', '..pSSES..', '...SSSs..', '....SS...'],
  }
  const CIV_BODY = {
    coat: ['..TTTTT..', '.TTTTTTT.', '.TTaTTTT.', '.TTaTTTT.', '.TTaTTTT.', '.TTSTTTT.', '..LLLLL..', '..LLLLL..'],
    dress: ['..TTTTT..', '.TTTTTTT.', '.TTaTTTT.', '.TTaTTTT.', '.TTSTTTT.', '.TTTTTTT.', 'TTTTTTTTT', '.........'],
    cop: ['..ppppp..', '.pppppyp.', '.ppapppp.', '.ppapppp.', '.ppapppp.', '.pkSkppp.', '..PPPPP..', '..PPPPP..'],
    vip: ['..VVtVV..', '.VVVtVVV.', '.VVvVVVV.', '.VVvVVVV.', '.VVvVVVV.', '.VVSVVVV.', '..vvvvv..', '..vvvvv..'],
  }
  const CIV_UP = {
    coat: ['.STTTTTS.', '.TTTTTTT.', '.TTTTTTT.', '.TTTTTTT.', '..TTTTT..', '..TTTTT..', '..LLLLL..', '..LLLLL..'],
    dress: ['.STTTTTS.', '.TTTTTTT.', '.TTTTTTT.', '..TTTTT..', '..TTTTT..', '.TTTTTTT.', 'TTTTTTTTT', '.........'],
  }
  const LEGS = {
    stand: ['...lLL...', '...lLL...', '...lLL...', '...lLL...', '...lLL...', '...FFFF..'],
    w0: ['..lL.LL..', '..l...L..', '.ll...LL.', '.l.....L.', '.l.....L.', 'FF.....FF'],
    w1: ['...lLL...', '...lLL...', '..ll.L...', '..l..L...', '.ll..L...', '.FF..FFF.'],
    w2: ['..LL.lL..', '..L...l..', '.LL...ll.', '.L.....l.', '.L.....l.', 'FF.....FF'],
    w3: ['...LLl...', '...LLl...', '...L.ll..', '...L..l..', '...L..ll.', '..FFF.FF.'],
  }
  const DRESS_LEGS = {
    stand: ['...S.S...', '...S.S...', '...S.S...', '...S.S...', '...F.F...'],
    w0: ['..S...S..', '..S...S..', '.S.....S.', '.S.....S.', 'FF.....FF'],
    w1: ['...S.S...', '...S.S...', '...SS....', '..S.S....', '.FF.FF...'],
    w2: ['..S...S..', '..S...S..', '.S.....S.', '.S.....S.', 'FF.....FF'],
    w3: ['....SS...', '....S.S..', '...S..S..', '...S...S.', '..FF...FF'],
  }
  function personSet(top, body, up, pal) {
    const legs = body === 'dress' ? DRESS_LEGS : LEGS
    const mk = (b, l) => compose(CIV_TOP[top], CIV_BODY[b], legs[l])
    const upRows = compose(CIV_TOP[top], CIV_UP[up || 'coat'], legs.stand)
    const pp = { ...P, ...pal }
    return {
      stand: frame(mk(body, 'stand'), 4, pp),
      walk: ['w0', 'w1', 'w2', 'w3'].map((k) => frame(mk(body, k), 4, pp)),
      up: frame(up === 'none' ? mk(body, 'stand') : recolor(upRows, body === 'cop' ? { T: 'p', L: 'P' } : body === 'vip' ? { T: 'V', L: 'v' } : {}), 4, pp),
      aim: frame(overlay(mk(body, 'stand'), ['SWWW', '.W..'], 6, 10), 4, pp),
      flash: frame(white(mk(body, 'stand')), 4, pp),
    }
  }
  const CIVS = [
    personSet('hat', 'coat', 'coat', { T: '#8a6a3a', L: '#3a3226', l: '#2a241c' }),
    personSet('plain', 'coat', 'coat', { T: '#b84040', h: '#6a4424' }),
    personSet('long', 'dress', 'dress', { T: '#c06aa0', h: '#d8b060' }),
    personSet('plain', 'coat', 'coat', { T: '#3a9a8a', h: '#141414', L: '#4a4a52', l: '#36363c' }),
    personSet('long', 'dress', 'dress', { T: '#e0c040', h: '#3a2010' }),
    personSet('hat', 'coat', 'coat', { T: '#5a6ad0', F: '#2a2a30', L: '#2a2a34' }),
  ]
  const COP = personSet('cap', 'cop', 'coat', {})
  const VIP = personSet('plain', 'vip', 'coat', { h: '#c8c8c0' })
  const GUARD = personSet('plain', 'coat', 'coat', { T: '#26262c', h: '#101010', L: '#1c1c22', l: '#141418' })

  // ---- cars (36 x 12) ------------------------------------------------------------
  const CAR_ROWS = [
    '.........KKKKKKKKKKKKK..............',
    '........KooooooKoooooKK.............',
    '.......KoooooooKooooooKK............',
    '....KKKKKKKKKKKKKKKKKKKKKKKKKKK.....',
    '..KNNNNNNNNNNNNNNNNNNNNNNNNNNNNNK...',
    '.KnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnOK.',
    'KNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNK',
    'KnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnK',
    'rnnnKKKKKnnnnnnnnnnnnnnnnnKKKKKnnnnK',
    '.KKKKwwwKKKKKKKKKKKKKKKKKKKwwwKKKKK.',
    '....KwWwK.................KwWwK.....',
    '.....KKK...................KKK......',
  ]
  const COPCAR_ROWS = overlay(recolor(CAR_ROWS, { N: 'e', n: 'b' }), ['rrrbbb'], 13, 0)
  const COPCAR2_ROWS = overlay(recolor(CAR_ROWS, { N: 'e', n: 'b' }), ['bbbrrr'], 13, 0)
  const carFrame = (rows, pal = P) => frame(rows, 18, pal)
  const CAR = {
    sedan: [carFrame(CAR_ROWS), carFrame(CAR_ROWS, { ...P, N: '#8a5a3a', n: '#5a3a26' })],
    cop: [carFrame(COPCAR_ROWS), carFrame(COPCAR2_ROWS)],
    wreck: carFrame(recolor(CAR_ROWS, { N: 'K', n: 'd', o: 'd', O: 'd', r: 'd', w: 'd', W: 'K' })),
  }

  // ---- effects -------------------------------------------------------------------
  const TRACER = sprite(['yO'], { y: '#fff6a0', O: '#ffb030' })
  const SHELL = sprite(['y'], { y: '#e0b040' })
  const SPARK = sprite(['c'], { c: '#9fe8ff' })
  const GREEN = [sprite(['g'], { g: '#40ff80' }), sprite(['g'], { g: '#c0ffe0' })]
  const SMOKE = sprite(['.a.', 'aaa', '.a.'], { a: 'rgba(120,120,130,0.7)' })
  const FIRE = ['#fff8c0', '#ffd040', '#ff8020', '#c03010', '#505058'].map((col) => sprite(['c'], { c: col }))
  const BOOM = [
    sprite(['..www..', '.wwyww.', 'wwyyyww', 'wyyyyyw', 'wwyyyww', '.wwyww.', '..www..'], { w: '#fff8d0', y: '#ffd040' }),
    sprite(['...OOOOO...', '..OyyyyyO..', '.OyywwwyyO.', 'OyywwwwwyyO', 'OywwwwwwwyO', 'OyywwwwwyyO', '.OyywwwyyO.', '..OyyyyyO..', '...OOOOO...'], { O: '#ff7020', y: '#ffd040', w: '#fff8d0' }),
    sprite(['...RRRRR...', '..RO.O.OR..', '.RO.....OR.', 'RO.......OR', 'R.........R', 'RO.......OR', '.RO.....OR.', '..RO.O.OR..', '...RRRRR...'], { R: '#902818', O: '#ff7020' }),
  ]
  const BLOOD = sprite(['.rrrr.', 'rrrrrr'], { r: '#7a1010' })
  const BOOST_BARS = ['#e83838', '#3a7aff', '#b08a5a']

  // ---- layout -------------------------------------------------------------------
  const SP = 13 // agent spacing
  function openSpot(s, x, hw) {
    const blocks = s.fix.filter((f) => f.kind !== 'eyes' || true).map((f) => [f.x - 4, f.x + f.w + 4])
    const ok = (c) => c - hw >= 4 && c + hw <= s.W - 4 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
    for (let d = 0; d < s.W; d += 3) {
      if (ok(x - d)) return x - d
      if (ok(x + d)) return x + d
    }
    return clamp(x, hw + 4, s.W - hw - 4)
  }

  // ---- shots and booms -------------------------------------------------------------
  class Rocket {
    constructor(s, x, dir, tx, owner) {
      Object.assign(this, { s, x, dir, tx, owner })
      this.y = FLOOR - 16
      this.z = 8
      this.puff = 0
    }
    update(dt, now, s) {
      this.x += this.dir * 170 * dt
      this.puff += dt
      if (this.puff > 0.05) {
        this.puff = 0
        s.particle({ img: SMOKE, x: this.x - this.dir * 3 - 1, y: this.y - 1, vy: -4, life: 0.5, fade: true })
      }
      if ((this.tx - this.x) * this.dir <= 0 || this.x < -10 || this.x > s.W + 10) {
        this.dead = true
        explode(s, clamp(this.x, 4, s.W - 4), this.owner)
      }
      return FAST
    }
    draw(c) {
      c.fillStyle = '#e8f8ff'
      c.fillRect(Math.round(this.x) - 2, this.y - 1, 4, 3)
      c.fillStyle = '#5ad0ff'
      c.fillRect(Math.round(this.x) - this.dir * 4 - 1, this.y, 3, 1)
    }
  }
  class Boom {
    constructor(x) {
      this.x = x
      this.t = 0
      this.z = 9
      this.prop = true
    }
    update(dt) {
      this.t += dt
      if (this.t > 0.55) this.dead = true
      return FAST
    }
    draw(c) {
      const img = BOOM[Math.min(2, Math.floor(this.t / 0.17))]
      c.drawImage(img, Math.round(this.x - img.width / 2), FLOOR - 4 - img.height)
      if (this.t < 0.12) {
        c.fillStyle = 'rgba(255,240,200,0.18)'
        c.fillRect(Math.round(this.x - 40), 0, 80, H)
      }
    }
  }
  function explode(s, x, owner) {
    s.spawn(new Boom(x))
    for (let i = 0; i < 22; i++) {
      const a = rand(Math.PI, Math.PI * 2)
      const v = rand(20, 70)
      s.particle({ img: pick(FIRE), x, y: FLOOR - 8, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 120, life: rand(0.4, 1), fade: true })
    }
    for (let i = 0; i < 4; i++) s.particle({ img: SMOKE, x: x + rand(-8, 8), y: FLOOR - 12, vx: rand(-4, 4), vy: rand(-12, -6), life: rand(1, 1.6), fade: true })
    for (const a of s.actors) {
      if (a.dead) continue
      if (a instanceof Person && a.hostile && a.alive && Math.abs(a.x - x) < 24) a.damage(99, 0, owner)
      else if (a instanceof Person && a.alive && !a.hostile && Math.abs(a.x - x) < 70 && a.state !== 'follow') a.scare(x)
      else if (a instanceof Car && a.kind !== 'wreck' && Math.abs(a.x - x) < 22) a.wreck()
    }
  }
  /** One gunshot from (x0) to target, with tracer, casings and hit timing. */
  function shoot(s, from, target, wpn, dmg) {
    const dir = target.x > from.x ? 1 : -1
    const mx = from.x + dir * (MUZZLE[wpn] - 6)
    const my = FLOOR - (from instanceof Agent ? 16 : 10)
    const dist = Math.abs(target.x - mx)
    const d = s.data
    if (wpn === 'laser') {
      if (d.beams.length < 10) d.beams.push({ x0: mx, x1: target.x, y: my, until: NOW() + 230, col: from.hostile ? '#ff4ad0' : '#ff3030' })
      target.damage?.(dmg, 40, from)
    } else if (wpn === 'gauss') {
      s.spawn(new Rocket(s, mx, dir, target.x, from))
    } else {
      const v = 420
      s.particle({ img: TRACER, x: mx, y: my + rand(-1, 1), vx: dir * v, life: dist / v })
      if (wpn === 'minigun') s.particle({ img: SHELL, x: from.x, y: my + 1, vx: -dir * rand(10, 30), vy: -rand(20, 40), g: 160, life: 0.45 })
      if (Math.random() < 0.9) target.damage?.(dmg, (dist / v) * 1000, from)
    }
    d.flashes.push({ x: mx, y: my, until: NOW() + 60 })
    if (d.flashes.length > 12) d.flashes.shift()
    // bystanders near the noise scatter
    for (const a of s.actors) if (a instanceof Person && !a.hostile && a.alive && a.state !== 'follow' && a.state !== 'held' && Math.abs(a.x - mx) < 90) a.scare(mx)
  }

  // ---- an agent ---------------------------------------------------------------------
  class Agent {
    constructor(s, i, x) {
      this.s = s
      this.i = i
      this.x = x
      this.tx = x
      this.dir = 1
      this.ft = 0
      this.z = 6
      this.mode = 'idle' // idle | aim | fire | beam
      this.wpn = WEAPONS[i % 3]
      this.goAt = 0
      this.nextThink = NOW() + rand(400, 1400)
      this.boostUntil = 0
      this.hurtUntil = 0
      this.alive = true
      this.grabbable = true
    }
    get moving() {
      return Math.abs(this.tx - this.x) > 0.5 || this.mode !== 'idle'
    }
    hit(x, y) {
      return Math.abs(x - this.x) <= 6 && y >= FLOOR - 26 && y <= FLOOR + 1
    }
    /** Click an agent: he switches to his next weapon and takes the drug
     * boost; with someone hostile about he opens fire, otherwise he turns
     * the persuader gun on the nearest bystander. */
    onClick() {
      const s = this.s
      const now = NOW()
      touched(s)
      s.data.sel = this.i
      if (s.data.mode === 'done') return
      this.wpn = WEAPONS[(WEAPONS.indexOf(this.wpn) + 1) % 3]
      this.boostUntil = now + 6000
      this.tx = this.x
      const t = nearestHostile(s, this.x, 9999) || (s.data.focus?.alive ? s.data.focus : null)
      if (t) return this.attack(t, this.wpn, now)
      const civ = nearestFree(s, this.x, 140)
      if (civ) return this.persuade(civ, now)
      // nobody about: test-fire the new weapon toward the cursor
      const cx = s.cursor ? s.cursor.x : this.x + this.dir * 80
      this.dir = cx >= this.x ? 1 : -1
      this.attack({ x: this.x + this.dir * 120, alive: true, damage() {}, dummy: true }, this.wpn, now)
    }
    // easter egg: double-click an agent for an adrenaline overdose, the
    // whole squad hosing the sky while the street empties
    onDblClick() {
      const s = this.s
      const now = NOW()
      touched(s)
      if (s.data.mode === 'done') return
      s.say('ADRENALINE OVERDOSE', clamp(this.x, 50, s.W - 50), 1, { color: '#ff5a5a', life: 2 })
      for (const a of s.data.agents) {
        a.boostUntil = now + 7000
        a.mode = 'idle'
        a.dir = a.i < 2 ? -1 : 1
        a.attack({ x: a.x + a.dir * 140, alive: true, damage() {}, dummy: true }, 'minigun', now + a.i * 60)
      }
    }
    // drag an agent: the whole squad moves out to where he is dropped
    grab() {
      touched(this.s)
      this.s.data.sel = this.i
    }
    drag(p) {
      touched(this.s)
      this.s.data.dragX = p.x
    }
    drop(p) {
      touched(this.s)
      this.s.data.dragX = null
      march(this.s, p.x - (this.i - 1.5) * SP)
    }
    attack(t, wpn, now) {
      if (this.mode === 'beam') return
      this.target = t
      this.wpn = wpn
      this.mode = 'aim'
      this.dir = t.x > this.x ? 1 : -1
      this.aimUntil = now + (this.boosted(now) ? 180 : 320)
      this.tx = this.x
      if (!t.dummy) t.lockUntil = now + 1600
      this.s.poke()
    }
    persuade(civ, now) {
      if (this.mode !== 'idle' || civ.state === 'held' || !civ.alive) return false
      this.target = civ
      this.mode = 'beam'
      this.dir = civ.x > this.x ? 1 : -1
      this.beamUntil = now + 1100
      this.tx = this.x
      civ.hold(this)
      this.s.poke()
      return true
    }
    boosted(now) {
      return now < this.boostUntil
    }
    hurt(now, fromX) {
      this.hurtUntil = now + 220
      const k = fromX > this.x ? -1 : 1
      this.x = clamp(this.x + k * 2, 6, this.s.W - 6)
      for (let i = 0; i < 4; i++) this.s.particle({ img: SPARK, x: this.x - k * 3, y: FLOOR - rand(10, 20), vx: -k * rand(10, 40), vy: rand(-30, 0), g: 80, life: 0.35 })
    }
    update(dt, now, s) {
      if (this.mode === 'aim') {
        if (!this.target.alive && !this.target.dummy) {
          this.mode = 'idle'
          return FAST
        }
        this.dir = this.target.x > this.x ? 1 : -1
        if (now >= this.aimUntil) {
          this.mode = 'fire'
          const b = this.boosted(now)
          this.shots = this.wpn === 'minigun' ? (b ? 12 : 8) : 1
          this.nextShot = now
        }
        return FAST
      }
      if (this.mode === 'fire') {
        if (now >= this.nextShot) {
          const t = this.target
          if (t.alive || t.dummy) {
            const dmg = this.wpn === 'minigun' ? 1 : 4
            shoot(s, this, t, this.wpn, dmg)
          }
          this.shots--
          this.nextShot = now + 65
          if (this.shots <= 0 || (!t.alive && !t.dummy)) {
            this.mode = 'idle'
            this.holdUntil = now + 500
            this.nextThink = now + (s.busy || this.boosted(now) ? rand(500, 1200) : rand(1200, 2600))
          }
        }
        return FAST
      }
      if (this.mode === 'beam') {
        const t = this.target
        if (!t.alive || t.state !== 'held') {
          this.mode = 'idle'
          return FAST
        }
        if (now >= this.beamUntil) {
          this.mode = 'idle'
          t.convert()
          this.nextThink = now + rand(800, 1600)
        } else if (Math.random() < 0.5) s.particle({ img: pick(GREEN), x: t.x + rand(-4, 4), y: FLOOR - rand(4, 20), vy: -12, life: 0.4 })
        return FAST
      }
      // walking to the formation slot
      const slot = Math.round(clamp(s.data.sx + (this.i - 1.5) * SP, 6, s.W - 6))
      if (this.tx !== slot && s.data.dragX == null) {
        this.tx = slot
        if (this.goAt < now) this.goAt = now + 80
      }
      const d = this.tx - this.x
      if (Math.abs(d) > 0.5 && now >= this.goAt) {
        const sp = (this.boosted(now) ? 50 : 32) * dt
        this.dir = d > 0 ? 1 : -1
        this.x += Math.abs(d) <= sp ? d : this.dir * sp
        this.ft += dt * (this.boosted(now) ? 1.5 : 1)
        return FAST
      }
      if (Math.abs(d) <= 0.5) {
        this.x = this.tx
        this.ft = 0
      }
      // standing: face the cursor while the user is around, else the squad's way
      if (keyMode(s, now) && now > (this.holdUntil || 0)) {
        if (s.data.face) this.dir = s.data.face
      } else if (s.cursor && engaged(s, now) && now > (this.holdUntil || 0)) {
        const want = s.cursor.x > this.x + 4 ? 1 : s.cursor.x < this.x - 4 ? -1 : this.dir
        this.dir = want
      } else if (now > (this.holdUntil || 0) && s.data.face && !nearestHostile(s, this.x, 220)) this.dir = s.data.face
      if (now < this.goAt) return this.goAt - now
      if (now < this.hurtUntil || now < this.boostUntil) return FAST
      if (now < (this.poseUntil || 0)) return this.poseUntil - now
      return Infinity
    }
    draw(c, s) {
      const now = NOW()
      const set = AGENT
      let f
      if (now < this.hurtUntil && Math.floor(now / 60) % 2 === 0) f = set.flash
      else if (this.mode === 'aim' || this.mode === 'fire') f = set.aim[this.wpn]
      else if (this.mode === 'beam') f = set.beam
      else if (now < (this.poseUntil || 0)) f = set.aim[this.wpn]
      else if (Math.abs(this.tx - this.x) > 0.5 && now >= this.goAt) f = set.walk[Math.floor(this.ft * 8) % 4]
      else f = set.stand
      const lift = f === set.walk[1] || f === set.walk[3] ? 1 : 0
      const kick = this.mode === 'fire' && Math.floor(now / 65) % 2 ? -this.dir : 0
      blit(c, f, this.x + kick, this.dir, lift)
      // the drug-boosted agent: boost bars over his head and an after-image
      if (this.boosted(now)) {
        const y = FLOOR - 30
        const left = Math.round(this.x - 4)
        const pulse = Math.floor(now / 200) % 2
        BOOST_BARS.forEach((col, k) => {
          c.fillStyle = col
          c.fillRect(left, y + k * 2, 9 - k * 2 + (k === 0 ? pulse : 0), 1)
        })
      }
      if (this.mode === 'aim' && Math.floor(now / 80) % 2 && this.target && !this.target.dummy) {
        // red targeting line while he lines up the shot
        c.fillStyle = 'rgba(255,40,40,0.75)'
        const x0 = Math.round(this.x + this.dir * 12)
        const x1 = Math.round(this.target.x)
        const y = FLOOR - 16
        for (let x = Math.min(x0, x1); x < Math.max(x0, x1); x += 3) c.fillRect(x, y, 1, 1)
      }
    }
  }

  // ---- people: civilians, police, guards, the target, rival agents ---------------
  class Person {
    constructor(s, role, x) {
      this.s = s
      this.role = role // civ | cop | guard | vip | rival
      this.set = role === 'cop' ? COP : role === 'guard' ? GUARD : role === 'vip' ? VIP : role === 'rival' ? RIVAL : pick(CIVS)
      this.hostile = role === 'cop' || role === 'guard' || role === 'rival'
      this.x = x
      this.tx = null
      this.dir = x < s.W / 2 ? 1 : -1
      this.speed = 16
      this.ft = 0
      this.z = role === 'rival' ? 5 : 3
      this.hp = { civ: 1, cop: 4, guard: 4, vip: 2, rival: 7 }[role]
      this.alive = true
      this.state = 'wander'
      this.nextAt = NOW() + rand(500, 2500)
      this.scareCool = 0
      this.lockUntil = 0
      this.hurtAt = 0
    }
    get moving() {
      return this.tx !== null && this.alive
    }
    hit(x, y) {
      if (!this.alive) return false
      const top = FLOOR - (this.role === 'rival' ? 26 : 22)
      return Math.abs(x - this.x) <= 6 && y >= top && y <= FLOOR + 1
    }
    /** Click a person: hostiles get the whole squad's fire; a bystander gets
     * the persuader gun (the squad walks over if it has to). */
    onClick() {
      const s = this.s
      const now = NOW()
      touched(s)
      if (s.data.mode === 'done') return
      const d = s.data
      if (this.hostile || this.role === 'vip') {
        d.focus = this
        this.lockUntil = now + 2500
        for (const a of d.agents) {
          const wpn = this.role === 'rival' ? (a.i % 2 ? 'laser' : 'minigun') : a.i === 3 && now > (d.gaussAt || 0) ? 'gauss' : a.wpn === 'gauss' ? 'minigun' : a.wpn
          if (wpn === 'gauss') d.gaussAt = now + 5000
          if (a.mode === 'idle' || a.mode === 'aim') setTimeout(() => a.attack(this, wpn, NOW()), a.i * 70)
        }
        return
      }
      if (this.state === 'follow' || this.state === 'held') {
        // a convert: he waves the squad on
        s.particle({ img: BUBBLE['♪'], x: this.x - 2, y: FLOOR - 28, vy: -4, life: 1 })
        return
      }
      const a = nearestAgent(s, this.x)
      if (Math.abs(a.x - this.x) <= 110) a.persuade(this, now)
      else {
        d.pending = this
        this.state = 'wait'
        this.tx = null
        march(s, this.x + (d.sx < this.x ? -50 : 50))
      }
    }
    get grabbable() {
      return this.alive && this.role === 'civ' && this.state !== 'held' && this.state !== 'leave'
    }
    // pick a passer-by up and put them somewhere else; they kick, then bolt
    grab() {
      touched(this.s)
      this.state = 'carried'
      this.tx = null
      this.lockUntil = 0
      const d = this.s.data
      const i = d.followers.indexOf(this)
      if (i >= 0) d.followers.splice(i, 1)
    }
    drag(p) {
      touched(this.s)
      this.x = clamp(p.x, 4, this.s.W - 4)
    }
    drop() {
      touched(this.s)
      this.state = 'wander'
      this.scareCool = 0
      this.scare(this.x + pick([-1, 1]))
    }
    hold(agent) {
      this.state = 'held'
      this.tx = null
      this.dir = agent.x > this.x ? 1 : -1
      this.heldBy = agent
    }
    convert() {
      const s = this.s
      const d = s.data
      this.state = 'follow'
      this.hostile = false
      this.lockUntil = 0
      if (!d.followers.includes(this)) d.followers.push(this)
      s.burst(this.x, FLOOR - 12, 8, ['G', 'g', 'w'])
      for (const o of s.actors) if (o instanceof Person && o !== this && !o.hostile && o.alive && o.state !== 'follow' && Math.abs(o.x - this.x) < 70) o.scare(this.x)
      const cap = clamp(Math.floor((s.W - 80) / 60), 2, 8)
      while (d.followers.length > cap) d.followers.shift().leave()
    }
    scare(fromX) {
      const now = NOW()
      if (now < this.scareCool || this.state === 'held' || this.state === 'follow' || this.hostile || this.state === 'leave') return
      this.scareCool = now + 6000
      this.s.particle({ img: BUBBLE['!'], x: this.x - 2, y: FLOOR - 30, life: 0.9, vy: -3 })
      const away = this.x >= fromX ? 1 : -1
      if (Math.random() < 0.45) {
        this.state = 'leave'
        this.goto(away > 0 ? this.s.W + 10 : -10, 44)
      } else {
        this.state = 'flee'
        this.goto(this.x + away * rand(40, 80), 40)
        this.nextAt = now + rand(3000, 6000)
      }
    }
    leave() {
      this.state = 'leave'
      const d = this.s.data
      const i = d.followers.indexOf(this)
      if (i >= 0) d.followers.splice(i, 1)
      this.goto(this.x < this.s.W / 2 ? -10 : this.s.W + 10, this.hostile ? 30 : 22)
    }
    goto(x, speed) {
      this.tx = Math.round(x < -6 || x > this.s.W + 6 ? x : clamp(x, 4, this.s.W - 4))
      this.speed = speed
    }
    damage(n, delayMs, from) {
      if (!this.alive) return
      this.hp -= n
      const at = NOW() + delayMs
      this.hurtAt = at
      if (this.hp <= 0) {
        this.alive = false
        this.dieAt = at
        this.killer = from
        const d = this.s.data
        const i = d.followers.indexOf(this)
        if (i >= 0) d.followers.splice(i, 1)
      } else if (this.hostile && from && this.state !== 'fight') this.state = 'fight'
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
      this.ft += dt * (this.speed / 18)
      return true
    }
    update(dt, now, s) {
      const d = s.data
      if (!this.alive) {
        if (now < this.dieAt) return Math.max(FAST, this.dieAt - now)
        if (this.fall === undefined) {
          this.fall = 0
          this.dir = this.killer && this.killer.x > this.x ? 1 : -1
          this.tx = null
          if (this.role === 'vip') d.vipDown = now
        }
        if (this.fall < 1) {
          this.fall = Math.min(1, this.fall + dt * 3.2)
          return FAST
        }
        // bodies lie a while, then are cleared (only while the street is live)
        if (this.goneAt === undefined) this.goneAt = now + 6000
        if (!live(s, now)) return Infinity
        if (now > this.goneAt) this.dead = true
        return Math.max(SLOW, this.goneAt - now)
      }
      if (this.state === 'held' || this.state === 'carried') return FAST
      if (this.state === 'leave') {
        this.step(dt)
        if (this.tx === null) this.dead = true
        return FAST
      }
      if (this.state === 'follow') {
        const k = d.followers.indexOf(this)
        if (k < 0) {
          this.leave()
          return FAST
        }
        const want = tailSlot(s, k)
        if (this.tx === null && Math.abs(want - this.x) > 4) this.goto(want, 40)
        else if (this.tx !== null) this.tx = Math.round(want)
        // armed converts (police) join in during a fight
        if (this.role === 'cop' && now > (this.shotAt || 0)) {
          const t = nearestHostile(s, this.x, 140)
          if (t) {
            this.shotAt = now + rand(1200, 2000)
            this.dir = t.x > this.x ? 1 : -1
            this.aimUntil = now + 300
            shoot(s, this, t, 'pistol', 1)
          }
        }
        if (this.step(dt)) return FAST
        this.dir = now < (this.aimUntil || 0) ? this.dir : d.sx > this.x ? 1 : -1
        return now < (this.aimUntil || 0) ? FAST : d.agents.some((a) => a.moving) ? FAST : Infinity
      }
      if (!live(s, now)) {
        // rest: the street empties; hostiles walk away
        if (this.state !== 'leave') this.leave()
        return FAST
      }
      if (this.hostile) return this.fightUpdate(dt, now, s)
      if (this.role === 'vip') return this.vipUpdate(dt, now, s)
      if (this.step(dt)) return FAST
      if (this.state === 'wait') {
        if (d.pending !== this) this.state = 'wander'
        return SLOW
      }
      // the crosshair passing over a bystander: hands up
      const cur = s.cursor
      if (cur && engaged(s, now) && Math.abs(cur.x - this.x) <= 6 && cur.y >= FLOOR - 24) {
        this.lockUntil = Math.max(this.lockUntil, now + 700)
        this.dir = cur.x > this.x ? 1 : -1
      }
      // hands up when an agent has a red lock on you
      if (now < this.lockUntil) return FAST
      if (now < this.nextAt) return this.nextAt - now
      this.state = 'wander'
      let x = this.x + rand(-100, 100)
      if (Math.abs(x - this.x) < 24) x = this.x + (x > this.x ? 34 : -34)
      this.goto(clamp(x, 6, s.W - 6), rand(13, 19))
      this.nextAt = now + rand(2500, 6500)
      return FAST
    }
    fightUpdate(dt, now, s) {
      const tgt = nearestAgent(s, this.x)
      const dist = Math.abs(tgt.x - this.x)
      const range = this.role === 'rival' ? 95 : 70
      if (this.state === 'wander' || this.state === 'approach') {
        this.state = 'approach'
        if (dist > range) {
          this.goto(tgt.x + (this.x < tgt.x ? -range + 6 : range - 6), this.role === 'rival' ? 30 : 24)
          this.step(dt)
          return FAST
        }
        this.tx = null
        this.dir = tgt.x > this.x ? 1 : -1
        if (this.role === 'cop' && !this.warned) {
          this.warned = true
          this.state = 'warn'
          this.fightAt = now + 2200
          s.say('DROP YOUR WEAPONS!', this.x, 1, { color: '#8fb0ff', life: 2 })
          return FAST
        }
        this.state = 'fight'
        this.fightAt = now + rand(300, 900)
      }
      if (this.state === 'warn') {
        this.dir = tgt.x > this.x ? 1 : -1
        if (now < this.fightAt) return Math.min(FAST * 3, this.fightAt - now)
        this.state = 'fight'
      }
      if (this.state === 'fight') {
        if (this.step(dt)) return FAST
        this.dir = tgt.x > this.x ? 1 : -1
        if (dist > range + 30) {
          this.state = 'approach'
          return FAST
        }
        if (now >= this.fightAt) {
          const wpn = this.role === 'rival' ? (Math.random() < 0.6 ? 'laser' : 'minigun') : 'pistol'
          this.wpn = wpn
          this.aimUntil = now + 420
          this.fightAt = now + (this.role === 'rival' ? rand(1300, 2200) : rand(1000, 1700)) * (s.busy ? 0.8 : 1)
          const shots = wpn === 'minigun' ? 5 : 1
          for (let i = 0; i < shots; i++) setTimeout(() => {
            if (!this.alive || this.state === 'follow') return
            shoot(s, this, tgt, wpn, 0)
            if (Math.random() < 0.6) tgt.hurt(NOW(), this.x)
          }, 200 + i * 70)
          // the occasional step to the side between shots
          if (Math.random() < 0.3) this.goto(this.x + pick([-1, 1]) * rand(8, 16), 26)
        }
        return FAST
      }
      return FAST
    }
    vipUpdate(dt, now, s) {
      if (this.state === 'wander') this.state = 'walkby'
      if (this.state === 'walkby' && now < this.lockUntil) {
        this.state = 'run'
        this.goto(this.dir > 0 ? s.W + 12 : -12, 38)
        s.particle({ img: BUBBLE['!'], x: this.x - 2, y: FLOOR - 30, life: 0.9, vy: -3 })
      }
      if (this.tx === null && this.state === 'walkby') this.goto(this.dir > 0 ? s.W + 12 : -12, 14)
      this.step(dt)
      if (this.x < -10 || this.x > s.W + 10) this.dead = true
      return FAST
    }
    draw(c) {
      const now = NOW()
      const set = this.set
      if (!this.alive && now >= this.dieAt) {
        const f = set.stand
        const ang = (-this.dir * Math.PI * 0.5) * (1 - Math.pow(1 - (this.fall || 0), 2))
        if (this.fall >= 1) c.drawImage(BLOOD, Math.round(this.x - this.dir * 10 - 3), FLOOR - 2)
        blitRot(c, f, this.x, this.dir, ang)
        return
      }
      let f
      if (now >= this.hurtAt && now < this.hurtAt + 120) f = set.flash
      else if (this.tx !== null) f = set.walk[Math.floor(this.ft * 7) % 4]
      else if (this.hostile && now < (this.aimUntil || 0)) f = this.role === 'rival' ? set.aim[this.wpn] : set.aim
      else if (this.role === 'cop' && this.state === 'follow' && now < (this.aimUntil || 0)) f = set.aim
      else if ((now < this.lockUntil && !this.hostile) || this.state === 'warn') f = this.state === 'warn' ? set.stand : set.up
      else f = set.stand
      let lift = f === set.walk[1] || f === set.walk[3] ? 1 : 0
      if (this.state === 'carried') {
        f = set.up
        lift = 5 + (Math.floor(now / 120) % 2)
      }
      blit(c, f, this.x, this.dir, lift)
      if (this.state === 'held') {
        // the persuader gun's pull: green rings over the head
        const k = Math.floor(now / 90) % 3
        c.fillStyle = k ? '#40ff80' : '#c0ffe0'
        c.fillRect(Math.round(this.x) - 3 - k, FLOOR - 25 - k, 7 + k * 2, 1)
      } else if (this.state === 'follow') {
        c.fillStyle = '#40ff80'
        c.fillRect(Math.round(this.x), FLOOR - 24, 1, 1)
      }
    }
  }

  // ---- traffic ---------------------------------------------------------------------
  class Car {
    constructor(s, kind, dir, stopX = null) {
      this.s = s
      this.kind = kind
      this.dir = dir
      this.x = dir > 0 ? -20 : s.W + 20
      this.stopX = stopX
      this.z = 1
      this.v = kind === 'cop' ? 80 : rand(55, 85)
      this.alive = true
      this.paint = kind === 'sedan' ? pick([0, 1]) : 0
    }
    get moving() {
      return this.kind !== 'wreck' && this.v > 0
    }
    hit(x, y) {
      return this.kind !== 'wreck' && Math.abs(x - this.x) <= 18 && y >= FLOOR - 12
    }
    onClick() {
      // Gauss gun on the car
      const s = this.s
      touched(s)
      const a = nearestAgent(s, this.x)
      a.attack(this, 'gauss', NOW())
      this.lockUntil = NOW() + 1500
    }
    damage() {}
    wreck() {
      this.kind = 'wreck'
      this.v = 0
      this.smokeUntil = NOW() + 5000
      this.goneAt = NOW() + 9000
      explode(this.s, this.x, null)
    }
    update(dt, now, s) {
      if (this.kind === 'wreck') {
        if (!live(s, now)) return Infinity
        if (now < this.smokeUntil && Math.random() < 0.3) s.particle({ img: SMOKE, x: this.x + rand(-8, 8), y: FLOOR - 12, vy: -10, vx: rand(-3, 3), life: 1.2, fade: true })
        if (now > this.goneAt) this.dead = true
        return now < this.smokeUntil ? SLOW : Math.max(SLOW, this.goneAt - now)
      }
      if (this.stopX !== null && live(s, now)) {
        const d = this.stopX - this.x
        if (Math.abs(d) < 1) {
          this.v = 0
          return now < (this.leaveAt || Infinity) ? (this.kind === 'cop' ? SLOW : Infinity) : (this.stopX = null, FAST)
        }
        this.v = Math.min(80, Math.max(12, Math.abs(d) * 2))
      } else this.v = Math.max(this.v, 60)
      this.x += this.dir * this.v * dt
      if (this.x < -24 || this.x > s.W + 24) this.dead = true
      return FAST
    }
    draw(c) {
      const now = NOW()
      const f = this.kind === 'wreck' ? CAR.wreck : this.kind === 'cop' ? CAR.cop[Math.floor(now / 250) % 2] : CAR.sedan[this.paint]
      blit(c, f, this.x, this.dir, 0)
    }
  }

  // ---- squad helpers ------------------------------------------------------------------
  const nearestAgent = (s, x) => {
    let best = s.data.agents[0]
    for (const a of s.data.agents) if (Math.abs(a.x - x) < Math.abs(best.x - x)) best = a
    return best
  }
  function nearestHostile(s, x, range) {
    let best = null
    for (const a of s.actors) if (a instanceof Person && a.alive && a.hostile && a.state !== 'leave' && a.x > -4 && a.x < s.W + 4 && Math.abs(a.x - x) <= range && (!best || Math.abs(a.x - x) < Math.abs(best.x - x))) best = a
    return best
  }
  function nearestFree(s, x, range) {
    let best = null
    for (const a of s.actors) if (a instanceof Person && a.alive && !a.hostile && a.role !== 'vip' && ['wander', 'flee', 'wait'].includes(a.state) && a.x > 2 && a.x < s.W - 2 && Math.abs(a.x - x) <= range && (!best || Math.abs(a.x - x) < Math.abs(best.x - x))) best = a
    return best
  }
  const people = (s) => s.actors.filter((a) => a instanceof Person && !a.dead)
  function march(s, x) {
    const d = s.data
    const m = 1.5 * SP + 8
    const tx = Math.round(clamp(x, m, s.W - m))
    if (Math.abs(tx - d.sx) > 6) d.face = tx > d.sx ? 1 : -1
    d.sx = tx
    const order = d.face > 0 ? [3, 2, 1, 0] : [0, 1, 2, 3]
    const now = NOW()
    order.forEach((i, k) => {
      const a = d.agents[i]
      if (a.mode !== 'idle') return
      a.tx = Math.round(tx + (i - 1.5) * SP)
      a.goAt = now + k * 110
    })
    s.poke()
  }
  function tailSlot(s, k) {
    const d = s.data
    const tail = d.tailSide || -d.face || -1
    const xs = d.agents.map((a) => a.x)
    const start = tail < 0 ? Math.min(...xs) - 12 : Math.max(...xs) + 12
    return clamp(start + tail * k * 10, 5, s.W - 5)
  }
  const squadMoving = (s) => s.data.agents.some((a) => Math.abs(a.tx - a.x) > 0.5)

  // ---- the city backdrop (built per width, very faint) --------------------------------
  function buildCity(s) {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.ceil(s.W))
    c.height = H
    const x = c.getContext('2d')
    let px = 0
    let seed = 7
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
    while (px < s.W) {
      const w = 14 + Math.floor(rnd() * 26)
      const h = 12 + Math.floor(rnd() * (H - 14))
      x.fillStyle = 'rgba(120,135,170,0.07)'
      x.fillRect(px, H - h, w - 2, h)
      for (let wy = H - h + 3; wy < H - 4; wy += 4)
        for (let wx = px + 2; wx < px + w - 4; wx += 4)
          if (rnd() < 0.18) {
            x.fillStyle = rnd() < 0.5 ? 'rgba(255,200,110,0.16)' : 'rgba(110,220,255,0.13)'
            x.fillRect(wx, wy, 2, 1)
          }
      if (rnd() < 0.12) {
        x.fillStyle = 'rgba(255,60,140,0.16)'
        x.fillRect(px + 3, H - h - 3, Math.min(10, w - 6), 2)
      }
      px += w + Math.floor(rnd() * 8)
    }
    s.data.city = c
  }

  // ---- director ---------------------------------------------------------------------------
  function setup(s) {
    const d = s.data
    d.W = s.W
    d.beams = []
    d.flashes = []
    d.followers = []
    d.face = 1
    d.sx = openSpot(s, Math.round(s.W * 0.6), 30)
    d.agents = [0, 1, 2, 3].map((i) => new Agent(s, i, Math.round(d.sx + (i - 1.5) * SP)))
    for (const a of d.agents) s.actors.push(a)
    for (const f of [0.1, 0.32, 0.85]) s.actors.push(new Person(s, 'civ', Math.round(s.W * f + rand(-10, 10))))
    d.mode = 'live'
    d.ep = null
    d.bag = []
    d.epAt = NOW() + 2500
    d.carAt = NOW() + rand(3000, 8000)
    d.spawnAt = 0
    d.userUntil = 0
    buildCity(s)
  }

  function nextEpisode(s, now) {
    const d = s.data
    if (!d.bag.length) {
      d.bag = ['persuade', 'police', 'rivals', 'hit', 'persuade'].sort(() => Math.random() - 0.5)
      if (d.bag[0] === d.lastEp) d.bag.push(d.bag.shift())
    }
    const k = d.bag.shift()
    d.lastEp = k
    d.ep = { k, t0: now, until: now + 30000, phase: 0 }
    const far = d.sx < s.W / 2 ? 1 : -1 // side with more room
    if (k === 'police') {
      const dir = -far
      const stop = clamp(d.sx + far * 110, 24, s.W - 24)
      const car = new Car(s, 'cop', dir, stop)
      car.leaveAt = Infinity
      s.spawn(car)
      d.ep.car = car
    } else if (k === 'rivals') {
      const n = s.W < 500 ? 1 : 2
      for (let i = 0; i < n; i++) {
        const r = new Person(s, 'rival', far > 0 ? s.W + 10 + i * 16 : -10 - i * 16)
        s.spawn(r)
      }
      for (const a of d.agents) a.boostUntil = now + 9000
      s.say('RIVAL AGENTS', clamp(far > 0 ? s.W - 50 : 50, 30, s.W - 30), 1, { color: '#ff6a6a', life: 2 })
    } else if (k === 'hit') {
      const vip = new Person(s, 'vip', far > 0 ? s.W + 10 : -10)
      vip.dir = -far
      const g = new Person(s, 'guard', vip.x + far * 12)
      g.state = 'escort'
      g.vip = vip
      s.spawn(vip)
      s.spawn(g)
      d.ep.vip = vip
      d.ep.guard = g
    }
  }

  function endEpisode(s, now) {
    const d = s.data
    d.ep = null
    d.epAt = now + rand(3000, 6000)
    d.focus = null
    // stroll to a new stretch of street between jobs
    const reach = Math.min(200, s.W * 0.4)
    let x = rand(30, s.W - 30)
    if (Math.abs(x - d.sx) < reach * 0.4) x = d.sx < s.W / 2 ? d.sx + reach * 0.7 : d.sx - reach * 0.7
    march(s, openSpot(s, x, 2 * SP + 2))
  }

  function missionComplete(s, now) {
    const d = s.data
    s.say('MISSION COMPLETE', clamp(d.sx, 50, s.W - 50), 1, { color: '#ffe14a', life: 3.5 })
    d.cheerUntil = now + 3500
  }

  /** Squad AI: who shoots what (skipped while the user is driving). */
  function squadThink(s, now) {
    const d = s.data
    const mine = keyMode(s, now) ? selected(s) : null
    for (const a of d.agents) {
      if (a === mine || a.mode !== 'idle' || now < a.nextThink) continue
      a.nextThink = now + (s.busy ? rand(500, 1300) : rand(900, 2000))
      const t = d.focus?.alive ? d.focus : nearestHostile(s, a.x, s.busy ? 320 : 240)
      if (t) {
        let wpn = t.role === 'rival' ? (Math.random() < 0.55 ? 'laser' : 'minigun') : 'minigun'
        if (now > (d.gaussAt || 0) && (Math.random() < 0.25 || t.role === 'rival')) {
          wpn = 'gauss'
          d.gaussAt = now + (s.busy ? 3500 : 6000)
        }
        a.attack(t, wpn, now)
        continue
      }
      // police car with no cop left: blow it up
      const car = s.actors.find((c) => c instanceof Car && c.kind === 'cop' && c.v === 0 && !people(s).some((p) => p.role === 'cop' && p.alive && p.hostile))
      if (car && now > (d.gaussAt || 0) && d.ep?.k !== 'persuade') {
        d.gaussAt = now + 6000
        a.attack(car, 'gauss', now)
      }
    }
  }

  // ---- the keys: A/D walk the squad, Space fires, W switches weapon, S persuades ----
  /** The agent on the keys: the last one clicked, else the one at the front. */
  function selected(s) {
    const d = s.data
    if (d.sel == null) d.sel = (d.face || 1) > 0 ? 3 : 0
    return d.agents[d.sel]
  }
  function keyTick(s, dt, now) {
    const d = s.data
    if (d.mode === 'done' || d.dragX != null) return SLOW
    const mx = keyDir(s)
    if (mx) {
      // walk the squad: the selected agent leads, the others keep their slots
      const a = selected(s)
      const m = 1.5 * SP + 8
      const sp = a.boosted(now) ? 50 : 32
      d.face = mx
      d.sx = clamp(d.sx + mx * sp * dt, m, s.W - m)
      for (const g of d.agents) {
        if (g.mode !== 'idle') continue
        g.tx = Math.round(clamp(d.sx + (g.i - 1.5) * SP, 6, s.W - 6))
        g.goAt = now - 1
      }
    }
    if (s.keys.has('fire') && now >= (d.keyFireAt || 0)) keyFire(s, now)
    return s.keys.size ? FAST : SLOW
  }
  function keyFire(s, now) {
    const d = s.data
    const a = selected(s)
    if (d.mode === 'done' || a.mode !== 'idle') return
    d.keyFireAt = now + 250
    a.boostUntil = Math.max(a.boostUntil, now + 1500)
    const dir = d.face || a.dir
    let t = null
    for (const p of s.actors) {
      if (!(p instanceof Person) || !p.alive || !p.hostile || p.state === 'leave' || p.x < -4 || p.x > s.W + 4) continue
      if ((p.x - a.x) * dir < 0 || Math.abs(p.x - a.x) > 260) continue
      if (!t || Math.abs(p.x - a.x) < Math.abs(t.x - a.x)) t = p
    }
    if (!t && d.focus?.alive && (d.focus.x - a.x) * dir > 0) t = d.focus
    a.attack(t || { x: a.x + dir * 120, alive: true, damage() {}, dummy: true }, a.wpn, now)
  }
  function onKey(s, key, down) {
    const d = s.data
    if (!down || d.mode === 'done' || !d.agents) return
    const now = NOW()
    const a = selected(s)
    if (key === 'fire') return keyFire(s, now)
    if (key === 'up') {
      // W: next weapon
      a.wpn = WEAPONS[(WEAPONS.indexOf(a.wpn) + 1) % 3]
      s.say(a.wpn.toUpperCase(), clamp(a.x, 20, s.W - 20), 2, { color: '#9fe8ff', life: 0.8, size: 6 })
    } else if (key === 'down') {
      // S: the persuader gun on the nearest passer-by
      const civ = nearestFree(s, a.x, 90)
      if (civ) a.persuade(civ, now)
      else s.say('?', a.x, FLOOR - 32, { color: '#40ff80', life: 0.6, size: 6 })
    }
    s.poke()
  }

  function update(s, dt, now) {
    const d = s.data
    // expire short effects
    while (d.beams.length && d.beams[0].until < now) d.beams.shift()
    while (d.flashes.length && d.flashes[0].until < now) d.flashes.shift()
    let wait = d.beams.length || d.flashes.length ? FAST : Infinity
    if (d.cursorFx || (s.cursor && engaged(s, now))) wait = Math.min(wait, FAST)
    d.cursorFx = !!(s.cursor && engaged(s, now))

    if (!live(s, now)) {
      if (d.mode !== 'rest') {
        // rest: the squad files into a quiet stretch and stands; converts line up
        d.mode = 'rest'
        d.ep = null
        d.focus = null
        d.pending = null
        for (const a of d.agents) a.boostUntil = 0
        // the squad and its line of converts (on the left) fit in one gap
        d.tailSide = -1
        const R = 1.5 * SP + 7
        const Lt = 1.5 * SP + 14 + d.followers.length * 10
        const c = openSpot(s, d.sx - (Lt - R) / 2, (R + Lt) / 2)
        march(s, c + (Lt - R) / 2)
      }
      return wait
    }
    if (d.mode === 'rest') {
      d.mode = 'live'
      d.tailSide = 0
      d.epAt = now + 1500
    }
    if (d.mode === 'done') {
      if (now < d.doneUntil) return Math.min(wait, FAST)
      d.mode = 'live'
      d.tailSide = 0
      for (const f of d.followers.splice(0)) {
        f.state = 'leave'
        f.goto(f.x < s.W / 2 ? -10 : s.W + 10, rand(16, 26))
      }
      d.epAt = now + 3000
    }
    wait = Math.min(wait, SLOW)
    const user = engaged(s, now)

    // dragging an agent: the squad's ghost target follows
    if (d.dragX != null) wait = FAST

    // traffic now and then
    if (now > d.carAt) {
      d.carAt = now + (s.busy ? rand(5000, 9000) : rand(9000, 20000))
      if (s.actors.filter((a) => a instanceof Car).length < 2) s.spawn(new Car(s, 'sedan', pick([-1, 1])))
    }
    // keep a few bystanders about
    const crowd = clamp(Math.round(s.W / 170), 2, 7)
    const free = people(s).filter((p) => p.role === 'civ' && ['wander', 'flee', 'wait'].includes(p.state)).length
    if (free < crowd && now > d.spawnAt && people(s).length < 18) {
      d.spawnAt = now + rand(2500, 5000)
      const left = Math.random() < 0.5
      const c = new Person(s, 'civ', left ? -8 : s.W + 8)
      c.goto(left ? rand(20, 140) : s.W - rand(20, 140), 16)
      s.spawn(c)
    }

    // a convert the user asked for: persuade once the squad is close
    if (d.pending) {
      const p = d.pending
      if (!p.alive || p.state !== 'wait') d.pending = null
      else if (!squadMoving(s)) {
        nearestAgent(s, p.x).persuade(p, now)
        d.pending = null
      }
    }

    if (s.busy) {
      // open war: police and rival agents keep coming
      if (now > (d.waveAt || 0)) {
        d.waveAt = now + rand(3000, 5500)
        const hostiles = people(s).filter((p) => p.hostile && p.alive).length
        if (hostiles < (s.W < 500 ? 2 : 3)) {
          const side = Math.random() < 0.5 ? -1 : 1
          if (Math.random() < 0.45) {
            const car = new Car(s, 'cop', -side, clamp(d.sx + side * 120, 24, s.W - 24))
            car.leaveAt = Infinity
            s.spawn(car)
            d.copCar = car
          } else s.spawn(new Person(s, 'rival', side > 0 ? s.W + 10 : -10))
        }
      }
      for (const a of d.agents) if (a.boostUntil < now + 2000) a.boostUntil = now + 8000
      // the squad keeps moving between firefights
      if (!user && now > (d.moveAt || 0) && !squadMoving(s) && d.agents.every((a) => a.mode === 'idle')) {
        d.moveAt = now + rand(6000, 11000)
        const h = nearestHostile(s, d.sx, s.W)
        const x = h ? h.x - Math.sign(h.x - d.sx || 1) * rand(70, 110) : rand(40, s.W - 40)
        march(s, openSpot(s, x, 2 * SP + 2))
      }
    } else if (!user) {
      // episodes
      const ep = d.ep
      if (!ep && now > d.epAt) nextEpisode(s, now)
      else if (ep) runEpisode(s, ep, now)
    }
    // police cars let their officer out once parked
    for (const car of s.actors) {
      if (!(car instanceof Car) || car.kind !== 'cop' || car.v !== 0 || car.emptied) continue
      car.emptied = true
      const cop = new Person(s, 'cop', car.x)
      cop.dir = -car.dir
      s.spawn(cop)
    }
    if (keyMode(s, now)) wait = Math.min(wait, keyTick(s, dt, now))
    if (!user || s.busy) squadThink(s, now)
    return wait
  }

  function runEpisode(s, ep, now) {
    const d = s.data
    const hostiles = people(s).filter((p) => p.hostile && p.alive)
    if (ep.k === 'persuade') {
      const busyAgent = d.agents.some((a) => a.mode === 'beam')
      if (!busyAgent && !squadMoving(s) && now > (ep.nextAt || 0)) {
        const civ = nearestFree(s, d.sx, s.W)
        if (civ) {
          ep.nextAt = now + rand(2500, 4000)
          if (Math.abs(civ.x - d.sx) > 60) {
            march(s, civ.x + (civ.x > d.sx ? -46 : 46))
            civ.state = 'wait'
            d.pending = civ
          } else nearestAgent(s, civ.x).persuade(civ, now)
          ep.count = (ep.count || 0) + 1
        }
      }
      if ((ep.count || 0) >= 4 || now > ep.until) endEpisode(s, now)
    } else if (ep.k === 'police') {
      const cop = people(s).find((p) => p.role === 'cop' && p.alive && p.hostile)
      if (cop && cop.state === 'warn' && !ep.decided) {
        ep.decided = true
        if (Math.random() < 0.45) {
          // talk him round instead
          ep.persuaded = true
          setTimeout(() => {
            if (cop.alive && cop.hostile) nearestAgent(s, cop.x).persuade(cop, NOW())
          }, 900)
        }
      }
      if (ep.persuaded && cop) cop.fightAt = Math.max(cop.fightAt || 0, now + 1000)
      if (ep.car && ep.car.emptied && !hostiles.length && !ep.doneAt) {
        ep.doneAt = now + 4000
        if (ep.persuaded) ep.car.leaveAt = now + 1500
      }
      if ((ep.doneAt && now > ep.doneAt) || now > ep.until) {
        if (ep.car && !ep.car.dead && ep.car.kind === 'cop') ep.car.leaveAt = now
        endEpisode(s, now)
      }
    } else if (ep.k === 'rivals') {
      if (!hostiles.length && now > ep.t0 + 3000) {
        if (!ep.doneAt) ep.doneAt = now + 1500
        if (now > ep.doneAt) endEpisode(s, now)
      } else if (now > ep.until) {
        for (const h of hostiles) h.leave()
        endEpisode(s, now)
      }
    } else if (ep.k === 'hit') {
      const vip = ep.vip
      if (vip.alive && vip.x > 10 && vip.x < s.W - 10) {
        if (!ep.locked && Math.abs(vip.x - d.sx) < 160) {
          ep.locked = true
          d.focus = vip
          vip.lockUntil = now + 6000
          s.say('TARGET', clamp(vip.x, 20, s.W - 20), 1, { color: '#ff5050', life: 1.6 })
        }
        if (ep.locked && !squadMoving(s) && Math.abs(vip.x - d.sx) > 90) march(s, vip.x - Math.sign(vip.x - d.sx) * 70)
      }
      if (ep.guard.alive && ep.guard.state === 'escort') {
        ep.guard.state = 'wander'
        ep.guard.hostile = !!ep.locked
        if (!ep.locked) {
          ep.guard.state = 'escort'
          ep.guard.goto(vip.x - vip.dir * 12, vip.speed)
        }
      }
      if (!vip.alive && !ep.won) {
        ep.won = true
        ep.doneAt = now + 1200
      }
      if (ep.won && now > ep.doneAt && !ep.said) {
        ep.said = true
        missionComplete(s, now)
        if (ep.guard.alive) ep.guard.leave()
        ep.doneAt = now + 3500
      }
      if ((ep.said && now > ep.doneAt) || vip.dead || now > ep.until) {
        if (ep.guard.alive && !ep.guard.dead) ep.guard.leave()
        endEpisode(s, now)
      }
    }
  }

  registerConcept({
    key: 'cyberagents',
    title: 'Cyberpunk agents',
    blurb:
      'Four cyborg agents in long trenchcoats work the street on their own: a persuader gun turns passers-by into a line of followers, police pull up and tell them to drop their weapons (they get talked round or gunned down, and the car goes up with a Gauss round), rival agents walk in for a minigun-and-laser firefight with their drug-boost bars glowing, and a target in a white suit gets hit for MISSION COMPLETE. <b>Click a cop, a rival or the target</b> and the whole squad opens fire on it; <b>click a passer-by</b> to persuade them; <b>click an agent</b> to switch his weapon, give him the boost and fire; <b>click a car</b> for the Gauss gun; <b>drag an agent</b> to move the squad, or <b>drag a passer-by</b> somewhere else. While you play the cursor becomes the squad\'s crosshair: the agents face it and wait for orders, and bystanders put their hands up when it passes over them; stop and the squad carries on alone. Double-click an agent for a surprise. While the agent works it is open war; on done the street is cleared for MISSION COMPLETE; at rest the squad stands in a quiet stretch with its converts lined up.',
    setup,
    update,
    onKey,
    onBusy(s) {
      const d = s.data
      d.waveAt = NOW() + 1200
      d.ep = null
      const now = NOW()
      for (const a of d.agents) a.boostUntil = now + 8000
      s.say('IPA BOOST', clamp(d.sx, 30, s.W - 30), 1, { color: '#ff6a6a', life: 1.6 })
    },
    onDone(s) {
      const d = s.data
      const now = NOW()
      d.ep = null
      // the last volley clears the street
      for (const p of people(s)) if (p.hostile && p.alive) {
        const a = nearestAgent(s, p.x)
        a.mode = 'idle'
        a.attack(p, 'minigun', now)
        p.damage(99, 500, a)
      }
      for (const a of d.agents) a.boostUntil = 0
      d.mode = 'done'
      d.doneUntil = now + 6000
      d.tailSide = -(d.face || 1)
      setTimeout(() => {
        missionComplete(s, NOW())
        // back to back, weapons up
        for (const a of d.agents) {
          a.dir = a.i < 2 ? -1 : 1
          a.holdUntil = a.poseUntil = NOW() + 4000
        }
        s.poke()
      }, 900)
    },
    onNap(s) {
      for (const a of s.actors) if (a instanceof Rocket) a.dead = true
    },
    relayout(s) {
      const d = s.data
      const k = d.W ? s.W / d.W : 1
      d.W = s.W
      buildCity(s)
      const m = 1.5 * SP + 8
      d.sx = Math.round(clamp(d.sx * k, m, s.W - m))
      for (const a of d.agents) {
        a.x = Math.round(clamp(d.sx + (a.i - 1.5) * SP, 6, s.W - 6))
        a.tx = a.x
      }
      for (const a of s.actors) {
        if (a instanceof Person) {
          if (a.state === 'leave') {
            a.x = clamp(a.x, -8, s.W + 8)
            a.tx = a.tx < 0 ? -10 : s.W + 10
          } else {
            a.x = Math.round(clamp(a.x * k, 4, s.W - 4))
            if (a.tx !== null) a.tx = Math.round(clamp(a.tx * k, 4, s.W - 4))
          }
        } else if (a instanceof Car) {
          a.x = clamp(a.x * k, -20, s.W + 20)
          if (a.stopX !== null) a.stopX = clamp(a.stopX * k, 24, s.W - 24)
        }
      }
      s.poke()
    },
    drawBehind(s, c) {
      if (s.data.city) c.drawImage(s.data.city, 0, 0)
    },
    drawFront(s, c) {
      const d = s.data
      const now = NOW()
      for (const b of d.beams) {
        const x0 = Math.round(Math.min(b.x0, b.x1))
        const w = Math.round(Math.abs(b.x1 - b.x0))
        c.fillStyle = b.col
        c.fillRect(x0, b.y - 1, w, 3)
        c.fillStyle = '#fff0f0'
        c.fillRect(x0, b.y, w, 1)
      }
      for (const f of d.flashes) {
        c.fillStyle = '#fff6a0'
        c.fillRect(Math.round(f.x) - 1, f.y - 1, 3, 3)
      }
      // persuader gun beams
      for (const a of d.agents) {
        if (a.mode !== 'beam') continue
        const t = a.target
        const x0 = Math.round(a.x + a.dir * 9)
        const x1 = Math.round(t.x)
        const dir = x1 > x0 ? 1 : -1
        const fr = Math.floor(now / 60)
        for (let x = x0, k = 0; x !== x1 && k < 300; x += dir, k++) {
          if ((k + fr) % 4 === 3) continue
          c.fillStyle = (k + fr) % 3 ? '#40ff80' : '#c0ffe0'
          c.fillRect(x, FLOOR - 18 + Math.round(Math.sin((k + fr * 2) * 0.7) * 2), 1, 1)
        }
      }
      // red target locks
      c.fillStyle = '#ff3030'
      for (const a of s.actors) {
        if (!(now < (a.lockUntil || 0)) || a.alive === false || a.dead) continue
        if (Math.floor(now / 150) % 4 === 3) continue
        const hw = a instanceof Car ? 19 : 7
        const top = FLOOR - (a instanceof Car ? 14 : a.role === 'rival' ? 27 : 23)
        const x0 = Math.round(a.x - hw)
        const x1 = Math.round(a.x + hw)
        for (const [x, y, sx, sy] of [[x0, top, 1, 1], [x1, top, -1, 1], [x0, FLOOR - 1, 1, -1], [x1, FLOOR - 1, -1, -1]]) {
          c.fillRect(Math.min(x, x + sx * 2), y, 3, 1)
          c.fillRect(x, Math.min(y, y + sy * 2), 1, 3)
        }
      }
      // the cursor is the agents' crosshair while you play
      const cur = s.cursor
      // the agent on the keys: a green caret over his head
      if (s.armed && d.agents) {
        const a = selected(s)
        const x = Math.round(a.x)
        c.fillStyle = '#40ff80'
        c.fillRect(x - 2, FLOOR - 33, 5, 1)
        c.fillRect(x - 1, FLOOR - 32, 3, 1)
        c.fillRect(x, FLOOR - 31, 1, 1)
      }
      if (cur && engaged(s, now) && !keyMode(s, now) && cur.y >= 0 && cur.y <= H) {
        const x = Math.round(cur.x)
        const y = Math.round(cur.y)
        c.fillStyle = '#ffe060'
        c.fillRect(x - 5, y, 3, 1)
        c.fillRect(x + 3, y, 3, 1)
        c.fillRect(x, y - 5, 1, 3)
        c.fillRect(x, y + 3, 1, 3)
      }
      // a ghost marker where a dragged squad will go
      if (d.dragX != null) {
        c.fillStyle = '#40ff80'
        c.fillRect(Math.round(d.dragX) - 4, FLOOR - 1, 9, 1)
      }
    },
  })
})()
