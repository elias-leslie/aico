;(() => {
  // Space Quest (Sierra On-Line, 1986). Roger Wilco, janitor, plays out a
  // two-episode adventure in the titlebar: a dry narrator box, a Sierra status
  // line for points, silly deaths that "restore", a parser line on hover.

  // 16-colour EGA palette (plus one skin tone; 'o' = shoe brown).
  const P = {
    k: '#000000', b: '#0000aa', g: '#00aa00', c: '#00aaaa', r: '#aa0000', m: '#aa00aa', n: '#aa5500', o: '#aa5500',
    a: '#aaaaaa', d: '#555555', B: '#5555ff', G: '#55ff55', C: '#55ffff', R: '#ff5555', M: '#ff55ff', Y: '#ffff55',
    w: '#ffffff', S: '#ffb48a', s: '#d98a5f',
  }
  const SAY_COL = { R: '#55ffff', C: '#ff55ff', B: '#55ff55', G1: '#ffff55', G2: '#ff55ff' }
  const SARIEN_COL = '#ff5555'
  const WALK = 30
  const RUN = 64
  const SNEAK = 16
  const CHARGE = 112 // an angry Sarien at full tilt
  const FONT = 'bold 7px "DejaVu Sans Mono", Menlo, monospace'
  const BOXED = H >= 36 // room for the white Sierra boxes above the heads
  const SPILL = typeof SPILL_UP === 'number' ? SPILL_UP : 0 // the stage reaches a little above the bar
  const dur = (t) => clamp(1300 + t.length * 65, 2500, 4500)
  // the user is playing: a click or drag in the last 9 s, or the cursor moving over the bar
  const engaged = (s, now) => now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (!!s.cursor && now - s.cursor.since < 2500) || keyed(s, now)
  // the keyboard is the game's (armed by a click on a character), or a game key went down lately
  const keyed = (s, now) => now - (s.keyAt ?? -1e9) < 9000
  const keyDir = (s) => (s.keys?.has('right') ? 1 : 0) - (s.keys?.has('left') ? 1 : 0)

  // ---- sprite helpers ----------------------------------------------------------
  const G = (w, h) => Array.from({ length: h }, () => '.'.repeat(w))
  function put(rows, part, ox, oy) {
    for (let j = 0; j < part.length; j++) {
      const y = oy + j
      if (y < 0 || y >= rows.length) continue
      const a = rows[y].split('')
      for (let i = 0; i < part[j].length; i++) {
        const ch = part[j][i]
        const x = ox + i
        if (ch !== '.' && x >= 0 && x < a.length) a[x] = ch
      }
      rows[y] = a.join('')
    }
    return rows
  }
  function dots(rows, list) {
    for (const [x, y, ch] of list) put(rows, [ch], x, y)
    return rows
  }
  const vline = (x, y0, y1, ch) => {
    const o = []
    for (let y = y0; y <= y1; y++) o.push([x, y, ch])
    return o
  }
  const shift = (list, dx, dy) => list.map(([x, y, ch]) => [x + dx, y + dy, ch])
  function fin(c, cx) {
    const o = outline(c)
    return { 1: o, '-1': mirror(o), w: o.width, h: o.height, cx }
  }
  const spr = (rows, cx) => fin(sprite(rows, P), cx)
  function rotCCW(c) {
    const o = document.createElement('canvas')
    o.width = c.height
    o.height = c.width
    const x = o.getContext('2d')
    x.translate(0, c.width)
    x.rotate(-Math.PI / 2)
    x.drawImage(c, 0, 0)
    return o
  }
  function trim(c) {
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    let x0 = c.width
    let y0 = c.height
    let x1 = -1
    let y1 = -1
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (data[(y * c.width + x) * 4 + 3]) {
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, y)
          y1 = Math.max(y1, y)
        }
    const o = document.createElement('canvas')
    o.width = x1 - x0 + 1
    o.height = y1 - y0 + 1
    o.getContext('2d').drawImage(c, -x0, -y0)
    return o
  }
  const lying = (rows) => {
    const t = trim(rotCCW(sprite(rows, P)))
    return fin(t, Math.floor(t.width / 2))
  }

  // ---- Roger Wilco (16×26, facing right, torso centred on column 6) -----------
  const R_HEAD = ['..nnnn...', '.nnnnnnn.', '.nnnnSSS.', 'nnnSSkSS.', 'nnnsSSSSS', '.nSSSSSS.', '..SSSrS..', '...SSS...']
  const HEAD_BLINK = R_HEAD.map((r) => r.replace('k', 'S'))
  const HEAD_SLEEP = R_HEAD.map((r) => r.replace('k', 's'))
  const R_TORSO = ['.awwwa.', 'daaaaaa', 'daaaaaa', 'daaaaaa', 'daaaaaa', 'daaaaaa', 'dkkYkkd', 'aaaaaaa']
  const R_TORSO_C = ['.awwwa.', 'daaaaaa', 'daaaaaa', 'dkkYkkd', 'aaaaaaa']
  const L_STAND = ['...aaaaaaa......', '....ddaaa.......', '....ddaaa.......', '....ddaaa.......', '....ddaaa.......', '....ddaaa.......', '....ddaaa.......', '....oooooo......', '....ooooooo.....']
  const L_A = ['...aaaaaaa......', '...ddd.aaa......', '...dd...aa......', '..ddd...aaa.....', '..dd.....aa.....', '..dd.....aa.....', '.dd.......aa....', 'ooo.......ooo...', 'oo........oooo..']
  const L_B = ['...aaaaaaa......', '...aaaaaaa......', '....ddaaa.......', '....dd.aa.......', '...dd..aa.......', '...dd..aa.......', '..ddo..aa.......', '..ooo..aa.......', '.......ooo......', '.......oooo.....']
  const L_C = ['...aaaaaaa......', '...aaa.ddd......', '...aa...dd......', '..aaa...ddd.....', '..aa.....dd.....', '..aa.....dd.....', '.aa.......dd....', 'ooo.......ooo...', 'oo........oooo..']
  const L_D = ['...aaaaaaa......', '...aaaaaaa......', '....aaddd.......', '....aa.dd.......', '...aa..dd.......', '...aa..dd.......', '..aao..dd.......', '..ooo..dd.......', '.......ooo......', '.......oooo.....']
  const L_CROUCH = ['..aaaaaaaa......', '..dd....aa......', '.ooo...oooo.....']

  const MOP_HEAD = (x, y) => [
    [x - 1, y, 'a'], [x, y, 'a'], [x + 1, y, 'a'],
    [x - 2, y + 1, 'w'], [x - 1, y + 1, 'a'], [x, y + 1, 'w'], [x + 1, y + 1, 'a'], [x + 2, y + 1, 'w'],
    [x - 2, y + 2, 'a'], [x - 1, y + 2, 'w'], [x, y + 2, 'a'], [x + 1, y + 2, 'w'], [x + 2, y + 2, 'a'],
    [x - 2, y + 3, 'w'], [x, y + 3, 'w'], [x + 2, y + 3, 'w'],
  ]
  const MOP_STAND = [...vline(12, 3, 21, 'n'), ...MOP_HEAD(12, 22)]
  const MOP_TAP = [...vline(12, 2, 20, 'n'), ...MOP_HEAD(12, 21)]
  const MOP_CARRY = [...vline(12, 4, 18, 'n'), ...MOP_HEAD(12, 19)]
  const MOP_CROUCH = [...vline(12, 2, 21, 'n'), ...MOP_HEAD(12, 22)]
  const MOP_CHEER = [...vline(12, 0, 14, 'n'), ...MOP_HEAD(12, 15)]
  const MOP_BACK = [...vline(2, 5, 21, 'n'), ...MOP_HEAD(2, 22)]
  const ARM_HOLD = [[7, 11, 'd'], [8, 12, 'd'], [9, 13, 'd'], [10, 13, 'a'], [11, 13, 'a'], [12, 13, 'S'], [12, 14, 'S']]
  const ARM_DOZE = [[8, 10, 'd'], [9, 10, 'a'], [10, 10, 'a'], [11, 10, 'S'], [12, 10, 'S'], [12, 9, 'S']]
  const ARM_REACH = [[7, 11, 'd'], [8, 11, 'd'], [9, 11, 'd'], [10, 11, 'a'], [11, 11, 'a'], [12, 11, 'a'], [13, 11, 'S'], [14, 11, 'S']]
  const ARM_CHEER = [[8, 10, 'd'], [9, 9, 'a'], [10, 9, 'a'], [11, 9, 'a'], [12, 8, 'S'], [12, 9, 'S']]
  const ARM_CROUCH = [[8, 19, 'd'], [9, 19, 'a'], [10, 19, 'a'], [11, 19, 'a'], [12, 19, 'S'], [12, 20, 'S']]
  const ARM_HANG = [[6, 11, 'd'], [6, 12, 'd'], [6, 13, 'd'], [6, 14, 'd'], [6, 15, 'S']]
  const ARM_CHEST = [[7, 11, 'd'], [8, 12, 'd'], [9, 12, 'S'], [9, 11, 'S']]
  function mopDiag(xTop, xBot) {
    const o = []
    const at = (y) => Math.round(xTop + ((xBot - xTop) * (y - 8)) / 13)
    for (let y = 8; y <= 21; y++) o.push([at(y), y, 'n'])
    return { mop: [...o, ...MOP_HEAD(xBot, 22)], arm: [[7, 11, 'd'], [8, 12, 'd'], [9, 12, 'd'], [at(12), 12, 'S'], [9, 14, 'd'], [at(15), 15, 'S']] }
  }
  const M1 = mopDiag(9, 13)
  const M2 = mopDiag(9, 10)
  const PACK = [[1, 8, 'w'], [0, 9, 'Y'], [1, 9, 'w'], [2, 9, 'Y'], ...[10, 11, 13, 14].flatMap((y) => [[0, y, 'Y'], [1, y, 'w'], [2, y, 'Y']]), [0, 12, 'R'], [1, 12, 'R'], [2, 12, 'R'], [0, 15, 'R'], [1, 15, 'R'], [2, 15, 'R'], [0, 16, 'a'], [1, 16, 'a'], [2, 16, 'a'], [1, 17, 'R'], [3, 10, 'n'], [4, 10, 'n']]
  const SUIT = { n: 'a', a: 'd', d: 'a', w: 'R', k: 'r', Y: 'Y', o: 'r' }

  function rog(o) {
    const g = G(16, 26)
    const bob = o.bob || 0
    if (o.crouch) {
      put(g, o.head || R_HEAD, 2, 10)
      put(g, R_TORSO_C, 3, 18)
      put(g, L_CROUCH, 0, 23)
    } else {
      const legs = o.legs || L_STAND
      put(g, o.head || R_HEAD, o.hx ?? 2, (o.hy ?? 1) - bob)
      put(g, R_TORSO, 3, 9 - bob)
      put(g, legs, 0, 26 - legs.length)
    }
    // recolour body and hair only (the face keeps its eye and mouth)
    const head = o.crouch ? [10, 17] : [(o.hy ?? 1) - bob, (o.hy ?? 1) - bob + 7]
    const rows = o.map ? g.map((r, y) => (y >= head[0] && y <= head[1] ? recolor([r], o.map.n ? { n: o.map.n } : {})[0] : recolor([r], o.map)[0])) : g
    const dy = o.crouch ? 8 : -bob
    if (o.pack) dots(rows, shift(PACK, 0, dy))
    if (o.medal) dots(rows, shift([[7, 11, 'r'], [7, 12, 'Y']], 0, dy))
    if (o.mop) dots(rows, shift(o.mop, 0, -bob))
    if (o.arm) dots(rows, shift(o.arm, 0, -bob).map(([x, y, ch]) => [x, y, o.map?.[ch] ?? ch]))
    return rows
  }
  const XRAY = { S: 'w', s: 'w', k: 'w', a: 'B', d: 'b', w: 'B', n: 'b', o: 'b', Y: 'B', r: 'B', R: 'B' }
  const BONES = [...vline(6, 10, 16, 'w'), [4, 11, 'w'], [5, 11, 'w'], [7, 11, 'w'], [8, 11, 'w'], [4, 13, 'w'], [5, 13, 'w'], [7, 13, 'w'], [8, 13, 'w'], ...vline(5, 18, 23, 'w'), ...vline(7, 18, 23, 'w')]
  const ASH = put(G(16, 26), ['.....a..........', '......a.........', '.....dad........', '...ddadda......a', '..dadddaddnnnnnw'], 0, 21)
  function rogerSet(base) {
    const mk = (o) => spr(rog({ ...base, ...o }), 6)
    const stand = rog({ ...base, mop: MOP_STAND, arm: ARM_HOLD })
    return {
      stand: spr(stand, 6),
      blink: mk({ head: HEAD_BLINK, mop: MOP_STAND, arm: ARM_HOLD }),
      tap: mk({ mop: MOP_TAP, arm: shift(ARM_HOLD, 0, -1) }),
      walk: [L_A, L_B, L_C, L_D].map((legs, i) => mk({ legs, bob: i % 2, mop: MOP_CARRY, arm: ARM_HOLD })),
      hide: mk({ crouch: true, mop: MOP_CROUCH, arm: ARM_CROUCH }),
      doze: mk({ head: HEAD_SLEEP, hx: 3, hy: 2, mop: MOP_STAND, arm: ARM_DOZE }),
      reach: mk({ mop: MOP_BACK, arm: ARM_REACH }),
      cheer: mk({ mop: MOP_CHEER, arm: ARM_CHEER }),
      mop: [mk(M1), mk(M2)],
      zap: [spr(stand.map((r) => r.replace(/[^.]/g, 'Y')), 6), spr(dots(recolor(stand, XRAY), BONES), 6)],
      ash: spr(ASH, 6),
    }
  }
  const ROG = {
    normal: rogerSet({}),
    jet: rogerSet({ pack: true }),
    suit: rogerSet({ map: SUIT }),
    medal: rogerSet({ medal: true }),
  }
  ROG.normal.crouch = ROG.normal.hide

  // the dying crewman: Roger's build in a blue uniform, no mop
  const CREW_MAP = { a: 'B', d: 'b', n: 'Y', o: 'd' }
  const crewStand = rog({ map: CREW_MAP, arm: ARM_CHEST })
  const CREW = {
    stand: spr(crewStand, 6),
    walk: [L_A, L_B, L_C, L_D].map((legs, i) => spr(rog({ map: CREW_MAP, legs, bob: i % 2, arm: ARM_CHEST }), 6)),
    dead: lying(rog({ map: CREW_MAP, arm: ARM_HANG })),
  }

  // ---- Sarien soldier (18×26) -------------------------------------------------------
  const S_HEAD = ['..dddd..', '.daaaad.', 'daaaaadd', 'ddkkkkkk', 'dkRRRRRk', 'ddkkkkkk', '.dddddd.', '..dddd..']
  const S_TORSO = ['...dddddd...', '.aaddddddaa.', 'aaadddddddaa', 'ad.dddddd...', 'ad.ddaadd...', 'dd.dddddd...', 'rr.dddddd...', '...rrrrrr...', '...dddddd...']
  const SL_STAND = ['.....dddddd.......', '.....ddd.dda......', '.....dad.dad......', '.....dd...da......', '.....dd...da......', '.....dd...da......', '.....dd...da......', '....rrrr..rrrr....', '....rrrrr.rrrrr...']
  const SL_A = ['.....dddddd.......', '....ddd...dda.....', '....dad....dad....', '...ddd.....dda....', '...dd.......da....', '...dd.......da....', '..dd.........da...', '.rrrr.......rrrr..', '.rrr........rrrrr.']
  const SL_B = ['.....dddddd.......', '.....dddddd.......', '.....ddd.da.......', '.....dad.da.......', '....dd...da.......', '....dd...da.......', '...ddr...da.......', '...rrr...da.......', '.........rrrr.....', '.........rrrrr....']
  const SL_C = ['.....dddddd.......', '....dda...ddd.....', '....dad....dad....', '...dda.....ddd....', '...da.......dd....', '...da.......dd....', '..da.........dd...', '.rrrr.......rrrr..', '.rrr........rrrrr.']
  const SL_D = ['.....dddddd.......', '.....dddddd.......', '.....dda.ddd......', '.....dad.dad......', '....da...dd.......', '....da...dd.......', '...dar...dd.......', '...rrr...dd.......', '.........rrrr.....', '.........rrrrr....']
  const S_HOLD = [[12, 11, 'd'], [12, 12, 'd'], [13, 13, 'd'], [14, 13, 'r'], [14, 12, 'a'], [15, 12, 'a'], [16, 12, 'a'], [14, 14, 'd']]
  const S_AIM = [[12, 10, 'a'], [13, 10, 'd'], [14, 10, 'd'], [15, 10, 'r'], [15, 9, 'a'], [16, 9, 'a'], [17, 9, 'a'], [16, 10, 'd']]
  function sar(legs, arm, bob = 0) {
    const g = G(18, 26)
    put(g, S_HEAD, 4, 1 - bob)
    put(g, S_TORSO, 2, 9 - bob)
    put(g, legs, 0, 26 - legs.length)
    return dots(g, shift(arm, 0, -bob))
  }
  const SAR = {
    stand: spr(sar(SL_STAND, S_HOLD), 7),
    walk: [SL_A, SL_B, SL_C, SL_D].map((l, i) => spr(sar(l, S_HOLD, i % 2), 7)),
    aim: spr(sar(SL_STAND, S_AIM), 7),
    fall: lying(sar(SL_STAND, S_HOLD)),
  }

  // ---- Ulence Flats regulars ------------------------------------------------------
  const BART_ROWS = ['...g.....g...', '...G.....G...', '...gGGGGGg...', '..gGGGGGGGg..', '..GwkGGGwkG..', '..GGGGGGGGG..', '..gGGkkkGGg..', '...gGGGGGg...', '....gGGGg....', '..mmmwwwmmm..', '.GmmmwRwmmmG.', '.GmmmwwwmmmG.', '.GmmmwwwmmmG.', 'GG.mmwwwmm.GG', '...mmmmmmm...', '...mmmmmmm...']
  const BART = {
    stand: spr(BART_ROWS, 6),
    talk: spr(put(BART_ROWS.slice(), ['..gGkkkkkGg..', '...gGkkkGg...'], 0, 6), 6),
    polish: spr(put(BART_ROWS.slice(), ['...........wC', '...........GC', '...........G.', 'GG.mmwwwmm...'], 0, 10), 6),
  }
  const GUY1_ROWS = ['..nnnn..', '.nnnnnn.', '.nSSSSn.', '.SkSSkS.', '.SSSSSS.', '.nnrrnn.', '..nnnn..', '.RRRRRR.', 'RRRRRRRR', 'RRRRRRRR', 'SRRRRRRS', 'RRRRRRRR', 'RRRRRRRR', 'RRRRRRRR']
  const GUY2_ROWS = ['..dddd..', '.dddddd.', '.dSSSSd.', '.aCaaCa.', '.SSSSSS.', '..SrrS..', '..SSSS..', '.BBBBBB.', 'BBBBBBBB', 'BBBBBBBB', 'SBBBBBBS', 'BBBBBBBB', 'BBBBBBBB', 'BBBBBBBB']
  const GUY1 = {
    stand: spr(GUY1_ROWS, 3),
    talk: spr(put(GUY1_ROWS.slice(), ['.nnkknn.'], 0, 5), 3),
    sip: spr(put(GUY1_ROWS.slice(), ['.nnYYnn.', '..nYYn..', '.RRYYRR.'], 0, 5), 3),
  }
  const GUY2 = {
    stand: spr(GUY2_ROWS, 3),
    talk: spr(put(GUY2_ROWS.slice(), ['..SkkS..'], 0, 5), 3),
    sip: spr(put(GUY2_ROWS.slice(), ['.aCaaCa.'.replace(/C/g, 'w')], 0, 3), 3),
  }
  const SETS = { roger: ROG.normal, sarien: SAR, crew: CREW, bartender: BART, guy1: GUY1, guy2: GUY2 }

  // ---- props --------------------------------------------------------------------------
  const POD_ROWS = ['.......aaaaaa.........', '.....aawwwwwwaa.......', '....awwaaaaacccaa.....', '...awaaaaaacccccaa....', 'r.awaaaaaaaccccccaa...', 'rrdaaaaaaaaaccccaaaa..', 'rrdaaaaaaaaaaaaaaaaaa.', 'rrdaaaaaaaaaaaaaaaaaad', 'rrddaaaaaaaaaaaaaaaadd', 'r..dddaaaaaaaaaaaaddd.', '....ddddddddddddddd...', '.....dd.........dd....', '....dddd.......dddd...']
  const POD = outline(sprite(POD_ROWS, P))
  const POD_IN = outline(sprite(put(POD_ROWS.slice(), ['nnn.', 'nSkS', '.SSS', '.SS.'], 12, 2), P))
  const SHIP = outline(sprite(['..........dddddddd................', '.......dddaaaaaaaadddd............', '....dddaaaaRaRaRaaaaaaddddd.......', '..ddaaaaaaaaaaaaaaaaaaaaaaaddddd..', 'rddddddddddddddddddddddddddddddddd', '..dddkkkkkkkkkkkkkkkkkkkkkkkkkdd..', '....dddddddddddddddddddddddddd....', '.......rr.........rr..............'], P))
  const BOLT = { 1: sprite(['rRYYww'], P), '-1': sprite(['wwYYRr'], P) }
  const REEL = {
    seven: sprite(['rrr', '..r', '.r.', '.r.'], P),
    cherry: sprite(['..g', '.g.', 'R.R', 'R.R'], P),
    bar: sprite(['...', 'nnn', 'nnn', '...'], P),
    skull: sprite(['ddd', 'kdk', 'ddd', 'd.d'], P),
  }
  const REEL_ORDER = ['seven', 'cherry', 'bar', 'skull', 'cherry', 'seven', 'bar']
  // Astro Chicken (the arcade game inside Space Quest III), flapping through as a cameo
  const CHICK_DOWN = ['........rr....', '.......rwwr...', '.......wwkwYY.', '.......wwwwYYY', '..ww...wwwwr..', '.wwwwwwwwww...', 'wwaawwwwwww...', '.waaawwwwww...', '..waaawwww....', '....Y...Y.....', '...YY..YY.....']
  const CHICK_UP = ['........rr....', '..aa...rwwr...', '..aaa..wwkwYY.', '...aaa.wwwwYYY', '..wwaa.wwwwr..', '.wwwwwwwwww...', 'wwwwwwwwwww...', '.wwwwwwwwww...', '..wwwwwwww....', '....Y...Y.....', '...YY..YY.....']
  const CHICK = [spr(CHICK_DOWN, 7), spr(CHICK_UP, 7)]
  const EGG = sprite(['.w.', 'www', 'www', '.w.'], P)
  const SOCK = sprite(['RR.', 'aa.', 'aa.', 'aaa', '.aa'], P)

  // ---- actors -------------------------------------------------------------------------
  class Char {
    constructor(s, key, type, x, dir) {
      this.s = s
      this.key = key
      this.type = type
      this.set = SETS[type]
      this.x = x
      this.dir = dir
      this.pose = 'stand'
      this.tx = null
      this.speed = WALK
      this.ft = 0
      this.yOff = 0
      this.z = 2
      this.hidden = false
      this.anim = null
      this.fly = null
      this.fall = null
      this.cb = null
      this.fid = null
      this.fidAt = 0
      this.fidPoses = null
      this.asleep = false
      this.outfit = 'normal'
    }
    get moving() {
      return this.tx !== null || !!this.fly || !!this.fall || !!this.held
    }
    get grabbable() {
      return this.type === 'roger' && canGrab(this.s)
    }
    setOutfit(o) {
      this.outfit = o
      this.set = ROG[o]
    }
    goto(x, speed = WALK, cb = null) {
      this.tx = Math.round(x)
      this.speed = speed
      this.cb = cb
      this.fid = null
    }
    play(frames, ms, fps = 6, then = null) {
      this.anim = { frames, t: 0, dur: ms / 1000, fps, then }
      this.fid = null
    }
    stop() {
      this.tx = null
      this.cb = null
      this.anim = null
      this.fly = null
      this.fall = null
      if (this.type === 'roger') {
        this.held = false
        this.s.data.grabbed = false
      }
    }
    cur() {
      const set = this.set
      if (this.held && set.walk) return set.walk[Math.floor(this.ft * 9) % set.walk.length]
      if (this.anim) return this.anim.frames[Math.floor(this.anim.t * this.anim.fps) % this.anim.frames.length]
      if (this.tx !== null && set.walk) return set.walk[Math.floor(this.ft * (this.speed > 40 ? 11 : this.speed < 20 ? 4.5 : 7)) % set.walk.length]
      if (this.fid && set[this.fid]) return set[this.fid]
      const ln = this.s.data.line
      if (set.talk && ln && ln.who === this.key && performance.now() < ln.until) return set.talk
      return set[this.pose] || set.stand
    }
    update(dt, now, s) {
      let want = Infinity
      if (this.held) {
        this.ft += dt // legs kicking in the air
        return FAST
      }
      if (this.anim) {
        this.anim.t += dt
        if (this.anim.t >= this.anim.dur) {
          const a = this.anim
          this.anim = null
          if (a.then) a.then()
        }
        want = FAST
      }
      if (this.fall) {
        const f = this.fall
        f.vy += 260 * dt
        this.yOff += f.vy * dt
        if (this.yOff >= 0) {
          this.yOff = 0
          this.fall = null
          if (f.then) f.then()
        }
        want = FAST
      }
      if (this.fly) {
        const f = this.fly
        const dx = f.tx - this.x
        const step = f.spd * dt
        if (Math.abs(dx) > step) {
          this.x += Math.sign(dx) * step
          this.dir = Math.sign(dx)
        } else this.x = f.tx
        const dy = f.alt - this.yOff
        this.yOff += Math.sign(dy) * Math.min(Math.abs(dy), 16 * dt)
        s.particle({ img: pix(pick(['y', 'r', 'O'])), x: this.x - this.dir * 5, y: FLOOR - 8 + this.yOff, vx: rand(-4, 4), vy: 34, life: 0.25, fade: true })
        if (this.x === f.tx && Math.abs(this.yOff - f.alt) < 0.5) {
          this.yOff = f.alt
          this.fly = null
        }
        return FAST
      }
      if (this.tx !== null) {
        const d = this.tx - this.x
        const step = this.speed * dt
        if (Math.abs(d) <= step + 0.01) {
          this.x = this.tx
          this.tx = null
          this.ft = 0
          const cb = this.cb
          this.cb = null
          if (cb) cb()
        } else {
          this.dir = d > 0 ? 1 : -1
          this.x += this.dir * step
          this.ft += dt
        }
        return FAST
      }
      // idle fidgets: a blink, a mop tap, a glass polished; static in between
      if (this.fidPoses && !this.anim && !this.hidden && this.pose === 'stand' && s.lively(now) && s.data.mode === 'story') {
        if (this.fid) {
          if (now < this.fidEnd) return Math.min(want, this.fidEnd - now)
          this.fid = null
          this.fidAt = now + rand(3500, 7500)
        }
        if (!this.fidAt) this.fidAt = now + rand(2500, 6000)
        if (now >= this.fidAt) {
          this.fid = pick(this.fidPoses)
          this.fidEnd = now + (this.fid === 'blink' ? 170 : this.fid === 'tap' ? 450 : 1400)
          return Math.min(want, this.fidEnd - now)
        }
        return Math.min(want, this.fidAt - now)
      }
      this.fid = null
      return want
    }
    draw(c) {
      if (this.hidden) return
      const sp = this.cur()
      const w0 = sp.w - 2
      const cx = this.dir > 0 ? sp.cx : w0 - 1 - sp.cx
      const x = Math.round(this.x - cx) - 1
      const y = FLOOR - (sp.h - 2) + Math.round(this.yOff) - 1
      c.drawImage(sp[this.dir] || sp[1], x, y)
      if (this.pose === 'doze' && !this.anim && this.tx === null) c.drawImage(ZZ, Math.round(this.x + this.dir * 5), Math.max(0, y - 4))
    }
    hit(px, py) {
      if (this.hidden) return false
      const sp = this.cur()
      const h = sp.h - 2
      const half = h < 14 ? (sp.w - 2) / 2 + 3 : this.type === 'roger' ? 8 : 9
      return Math.abs(px - this.x) <= half && py >= FLOOR - h + this.yOff - 3 && py <= FLOOR + this.yOff + 2
    }
    verb() {
      return VERBS[this.type] ? VERBS[this.type](this) : 'look'
    }
    onClick(p) {
      charClick(this.s, this, p)
    }
    // Roger can be picked up by the collar (the plot waits until he lands)
    grab(p) {
      const s = this.s
      const d = s.data
      d.grabAt = performance.now()
      if (this.type !== 'roger' || !canGrab(s)) return
      if (d.mode === 'story' && d.run && d.pending && d.pendWho === 'R') {
        d.run.ip = d.run.cur
        d.pending = null
      }
      const pose = this.pose
      this.stop()
      this.heldPose = pose === 'doze' || pose === 'hide' ? pose : 'stand'
      this.pose = this.heldPose === 'hide' ? 'hide' : 'stand'
      this.held = true
      this.ft = 0
      d.grabbed = true
      this.spotKey = null
      this.drag(p)
      if (d.mode === 'story') aside(s, null, pick(GRAB_N))
    }
    drag(p) {
      const s = this.s
      s.data.grabAt = performance.now()
      if (!this.held) return
      const nx = clamp(p.x, 6, s.W - 7)
      if (Math.abs(nx - this.x) > 1.5) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.yOff = clamp(p.y - (FLOOR - 24), -10 - SPILL, 0)
    }
    drop() {
      const s = this.s
      const d = s.data
      d.grabAt = performance.now()
      if (!this.held) return
      this.held = false
      this.pose = 'stand'
      const was = this.heldPose
      this.fall = {
        vy: 0,
        then: () => {
          d.grabbed = false
          s.burst(this.x, FLOOR - 1, 5, ['a', 'w'])
          if (d.mode === 'action' && d.act) d.act.userUntil = performance.now() + 4000
          // a sleeping janitor sleeps through it
          if (was === 'doze' && d.mode === 'story') {
            this.pose = 'doze'
            s.say('He sleeps through it. A gift.', this.x, 11, { life: 2.4 })
          } else s.say(pick(LAND_R), this.x, 11, { color: SAY_COL.R, life: 2.2 })
        },
      }
    }
  }
  const VERBS = {
    roger: () => 'look at self',
    sarien: () => 'talk to Sarien',
    crew: (ch) => (ch.pose === 'dead' ? 'search body' : 'talk to man'),
    bartender: () => 'order drink',
    guy1: () => 'talk to guys',
    guy2: () => 'talk to guys',
  }

  class Bolt {
    constructor(x, dir, lethal, onHit) {
      this.x = x
      this.x0 = x
      this.y = FLOOR - 17
      this.dir = dir
      this.lethal = lethal
      this.onHit = onHit
      this.z = 4
      this.passed = false
      this.moving = true
    }
    update(dt, now, s) {
      const R = s.data.cast.R
      const nx = this.x + this.dir * 250 * dt
      if (!this.passed && R && !R.hidden && R.pose !== 'ash' && !R.held && (R.x - this.x) * (R.x - nx) <= 0) {
        this.passed = true
        if (this.lethal && R.pose !== 'hide') {
          this.dead = true
          this.onHit(s)
          return FAST
        }
        if (this.lethal && s.data.mode === 'action' && s.data.act && !s.data.act.dying) {
          // the killing shot, ducked: the user saw it coming
          points(s, 3)
          showLine(s, null, pick(DODGE), now, false)
        }
      }
      this.x = nx
      if (Math.abs(this.x - this.x0) > 20)
        for (const f of s.fix)
          if (f.kind !== 'title' && this.x >= f.x && this.x <= f.x + f.w && this.y >= f.y && this.y <= f.y + f.h) {
            s.burst(this.x, this.y, 6, ['y', 'r', 'w'])
            this.dead = true
            return FAST
          }
      if (this.x < -10 || this.x > s.W + 10) this.dead = true
      return FAST
    }
    draw(c) {
      c.drawImage(BOLT[this.dir], Math.round(this.x) - 3, this.y)
    }
  }

  // Astro Chicken flaps across the top of the bar. Click it for an egg (and a point).
  class Chicken {
    constructor(s) {
      this.s = s
      this.dir = Math.random() < 0.5 ? 1 : -1
      this.x = this.dir > 0 ? -12 : s.W + 12
      this.y0 = rand(14, 20)
      this.y = this.y0
      this.t = rand(0, 6)
      this.vy = 0
      this.z = 5
      this.moving = true
      this.spooked = false
    }
    hit(px, py) {
      return Math.abs(px - this.x) < 11 && Math.abs(py - (this.y - 5)) < 9
    }
    onClick() {
      const s = this.s
      s.data.clickAt = performance.now()
      if (this.spooked) return
      this.spooked = true
      s.say('BAWK!', this.x, Math.max(0, this.y - 18), { color: '#ffff55', life: 1.2 })
      s.particle({ img: EGG, x: this.x - 1, y: this.y - 2, vy: 10, g: 160, life: 0.8 })
      s.burst(this.x, this.y - 5, 6, ['w', 'w', 'y'])
      points(s, 1)
    }
    update(dt, now, s) {
      this.t += dt
      const spd = this.spooked ? 120 : 62
      this.x += this.dir * spd * dt
      if (this.spooked) this.y -= 14 * dt
      else this.y = this.y0 + Math.sin(this.t * 2.2) * 4
      // Roger notices it fly over
      const R = s.data.cast.R
      if (!this.seen && R && !R.hidden && !R.moving && !R.anim && R.pose === 'stand' && Math.abs(R.x - this.x) < 30) {
        this.seen = true
        R.dir = this.x > R.x ? 1 : -1
        s.particle({ img: BUBBLE['!'], x: R.x - 2, y: FLOOR - 33, life: 1, vy: -3, fade: true })
        if (Math.random() < 0.5) s.say(pick(CHICK_R), R.x, 11, { color: SAY_COL.R, life: 2.6 })
      }
      if (this.x < -20 || this.x > s.W + 20 || this.y < -4) {
        this.dead = true
        if (s.data.chicken === this) s.data.chicken = null
      }
      return FAST
    }
    draw(c) {
      const sp = CHICK[Math.floor(this.t * (this.spooked ? 12 : 7)) % 2]
      c.drawImage(sp[this.dir], Math.round(this.x) - sp.cx - 1, Math.round(this.y) - sp.h + 1)
    }
  }

  // Props are scenery actors drawn with plain rects or prebuilt sprites.
  const fr = (c, k, x, y, w, h) => {
    c.fillStyle = P[k] || k
    c.fillRect(Math.round(x), Math.round(y), w, h)
  }
  const PROP_Z = { crate: 3, counter: 1, table: 1, pod: 1 }
  const PROP_BOX = { closet: [11, 28], console: [7, 18], crate: [8, 15], pod: [11, 13], acid: [8, 15], slot: [7, 22], counter: [20, 11], table: [12, 8], hamper: [5, 12], gen: [8, 22], ship: [17, 22] }
  const PROP_VERB = {
    closet: () => 'enter closet',
    console: (d) => (d.flags.cart ? 'look at console' : 'take cartridge'),
    crate: () => 'hide behind crate',
    pod: () => 'enter pod',
    acid: () => 'drink water',
    slot: () => 'play slots',
    counter: () => 'order drink',
    table: () => 'sit down',
    hamper: () => 'search hamper',
    gen: () => 'push button',
    ship: () => 'look at ship',
  }
  const PROP_DRAW = {
    closet(c, s, p) {
      const h = Math.min(28, H - 8)
      const x0 = Math.round(p.x) - 11
      const y0 = FLOOR - h
      fr(c, 'k', x0 + 2, y0 + 2, 18, h - 2)
      fr(c, 'n', x0 + 3, y0 + 7, 16, 1)
      fr(c, 'B', x0 + 4, y0 + 4, 3, 3)
      fr(c, 'a', x0 + 13, FLOOR - 4, 4, 4)
      fr(c, 'd', x0 + 13, FLOOR - 4, 4, 1)
      fr(c, 'a', x0, y0, 22, 2)
      fr(c, 'a', x0, y0, 2, h)
      fr(c, 'a', x0 + 20, y0, 2, h)
      fr(c, 'd', x0 + 2, y0 + 2, 1, h - 2)
      fr(c, 'd', x0 + 19, y0 + 2, 1, h - 2)
    },
    console(c, s, p) {
      const x0 = Math.round(p.x) - 7
      fr(c, 'a', x0, FLOOR - 10, 14, 10)
      fr(c, 'd', x0 + 2, FLOOR - 7, 10, 1)
      fr(c, 'd', x0 + 2, FLOOR - 4, 10, 1)
      fr(c, 'd', x0 + 1, FLOOR - 19, 12, 9)
      fr(c, 'k', x0 + 2, FLOOR - 18, 10, 7)
      if ((p.fxUntil || 0) > performance.now()) {
        // poked: it scrolls a screenful of panic
        const t = Math.floor(performance.now() / 90)
        for (let i = 0; i < 3; i++) fr(c, (t + i) % 3 ? 'C' : 'R', x0 + 3, FLOOR - 17 + i * 2, 2 + ((t * 5 + i * 3) % 7), 1)
      } else {
        fr(c, 'G', x0 + 3, FLOOR - 17, 6, 1)
        fr(c, 'G', x0 + 3, FLOOR - 15, 4, 1)
        fr(c, 'G', x0 + 3, FLOOR - 13, 7, 1)
      }
      fr(c, 'R', x0 + 2, FLOOR - 9, 1, 1)
      fr(c, 'G', x0 + 4, FLOOR - 9, 1, 1)
      fr(c, 'k', x0 + 8, FLOOR - 9, 4, 1)
      if (!s.data.flags.cart) fr(c, 'Y', x0 + 9, FLOOR - 12, 2, 3)
    },
    crate(c, s, p) {
      const x0 = Math.round(p.x) - 8
      fr(c, 'n', x0, FLOOR - 15, 16, 15)
      fr(c, 'k', x0, FLOOR - 15, 16, 1)
      fr(c, 'k', x0, FLOOR - 8, 16, 1)
      fr(c, 'k', x0, FLOOR - 15, 1, 15)
      fr(c, 'k', x0 + 15, FLOOR - 15, 1, 15)
      for (let i = 1; i < 7; i++) {
        fr(c, 'k', x0 + 1 + i * 2, FLOOR - 15 + i, 1, 1)
        fr(c, 'k', x0 + 14 - i * 2, FLOOR - 15 + i, 1, 1)
      }
      fr(c, 'Y', x0 + 3, FLOOR - 5, 10, 1)
    },
    pod(c, s, p) {
      const img = p.inside ? POD_IN : POD
      c.drawImage(img, Math.round(p.x) - 12, FLOOR - img.height + 1 + Math.round(p.yOff))
      if (p.wreck) {
        fr(c, 'a', Math.round(p.x) - 4, FLOOR - 17, 3, 2)
        fr(c, 'd', Math.round(p.x) - 2, FLOOR - 20, 3, 2)
        fr(c, 'd', Math.round(p.x) - 5, FLOOR - 23, 2, 2)
      }
    },
    acid(c, s, p) {
      const x0 = Math.round(p.x) - 7
      fr(c, 'g', x0, FLOOR - 2, 14, 2)
      fr(c, 'G', x0 + 1, FLOOR - 2, 12, 1)
      fr(c, 'w', x0 + 4, FLOOR - 3, 1, 1)
      fr(c, 'w', x0 + 9, FLOOR - 3, 1, 1)
      fr(c, 'n', x0 + 16, FLOOR - 12, 1, 12)
      fr(c, 'w', x0 + 13, FLOOR - 15, 7, 4)
      fr(c, 'r', x0 + 14, FLOOR - 14, 1, 2)
      fr(c, 'r', x0 + 16, FLOOR - 14, 1, 2)
      fr(c, 'r', x0 + 18, FLOOR - 14, 1, 2)
    },
    slot(c, s, p) {
      const x0 = Math.round(p.x) - 7
      const y0 = FLOOR - 22
      fr(c, 'r', x0, y0 + 3, 14, 18)
      fr(c, 'Y', x0, y0, 14, 3)
      for (let i = 0; i < 7; i++) fr(c, i % 2 ? 'R' : 'w', x0 + 1 + i * 2, y0 + 1, 1, 1)
      fr(c, 'k', x0 + 1, y0 + 5, 12, 6)
      const now = performance.now()
      for (let i = 0; i < 3; i++) {
        fr(c, 'w', x0 + 2 + i * 4 - (i ? 0 : 0), y0 + 6, 3, 4)
        let k = ['seven', 'cherry', 'bar'][i]
        if (p.spin && now < p.spin.until - i * 250) k = REEL_ORDER[(Math.floor(now / 70) + i * 3) % REEL_ORDER.length]
        else if (p.show === 'win') k = 'seven'
        else if (p.show === 'skull') k = 'skull'
        c.drawImage(REEL[k], x0 + 2 + i * 4, y0 + 6)
      }
      fr(c, 'k', x0 + 3, y0 + 15, 8, 2)
      if (p.show === 'win') fr(c, 'Y', x0 + 4, y0 + 15, 6, 1)
      const pulled = !!p.spin
      fr(c, 'a', x0 + 14, y0 + (pulled ? 9 : 5), 1, pulled ? 6 : 10)
      fr(c, 'R', x0 + 14, y0 + (pulled ? 8 : 3), 2, 2)
      fr(c, 'd', x0 - 1, FLOOR - 2, 16, 2)
    },
    counter(c, s, p) {
      const x0 = Math.round(p.x) - 20
      fr(c, 'n', x0, FLOOR - 11, 40, 11)
      fr(c, 'a', x0 - 1, FLOOR - 12, 42, 2)
      for (let i = 1; i < 5; i++) fr(c, 'r', x0 + i * 8, FLOOR - 9, 1, 9)
      fr(c, 'Y', x0 + 30, FLOOR - 15, 3, 3)
      fr(c, 'w', x0 + 30, FLOOR - 16, 3, 1)
    },
    table(c, s, p) {
      const x0 = Math.round(p.x) - 12
      fr(c, 'n', x0, FLOOR - 8, 24, 2)
      fr(c, 'Y', x0, FLOOR - 8, 24, 1)
      fr(c, 'n', x0 + 3, FLOOR - 6, 2, 6)
      fr(c, 'n', x0 + 19, FLOOR - 6, 2, 6)
      fr(c, 'a', x0 + 9, FLOOR - 11, 2, 3)
      fr(c, 'a', x0 + 14, FLOOR - 11, 2, 3)
    },
    hamper(c, s, p) {
      const x0 = Math.round(p.x) - 5
      if (!s.data.flags.suit) {
        fr(c, 'd', x0 + 2, FLOOR - 12, 6, 3)
        fr(c, 'R', x0 + 3, FLOOR - 10, 4, 1)
      }
      fr(c, 'a', x0, FLOOR - 9, 10, 9)
      for (let y = 0; y < 4; y++) fr(c, 'd', x0 + 1 + (y % 2) * 2, FLOOR - 7 + y * 2, 1, 1)
      fr(c, 'd', x0 + 6, FLOOR - 5, 1, 1)
      fr(c, 'w', x0, FLOOR - 9, 10, 1)
    },
    gen(c, s, p) {
      const x0 = Math.round(p.x) - 7
      fr(c, 'a', x0, FLOOR - 22, 14, 3)
      fr(c, 'm', x0 + 2, FLOOR - 19, 10, 15)
      fr(c, 'M', x0 + 4, FLOOR - 19, 4, 15)
      fr(c, 'w', x0 + 5, FLOOR - 19, 1, 15)
      fr(c, 'd', x0 - 1, FLOOR - 4, 16, 4)
      fr(c, 'd', x0 + 13, FLOOR - 13, 4, 6)
      fr(c, 'Y', x0 + 14, FLOOR - 12, 2, 2)
      fr(c, 'R', x0 + 14, FLOOR - 9, 2, 2)
    },
    ship(c, s, p) {
      c.drawImage(SHIP, Math.round(p.x) - 17, FLOOR - 22)
    },
  }
  const PROP_UPD = {
    pod(p, dt, now, s) {
      const R = s.data.cast.R
      if (p.launch) {
        p.launch.v = Math.min(260, p.launch.v + 170 * dt)
        p.x += p.launch.v * dt
        p.yOff = Math.max(-5, p.yOff - 3 * dt)
        s.particle({ img: pix(pick(['y', 'r', 'O'])), x: p.x - 13, y: FLOOR - 6 + p.yOff + rand(-1, 1), vx: -30, vy: rand(-6, 6), life: 0.35, fade: true })
        if (p.inside) R.x = p.x
        if (p.x > s.W + 40) {
          p.launch = null
          p.hidden = true
        }
        p.moving = !!p.launch
        return FAST
      }
      if (p.landing) {
        const L = p.landing
        L.t += dt
        const u = Math.min(1, L.t / L.dur)
        p.x = L.x0 + (L.tx - L.x0) * u
        p.yOff = -16 * (1 - u) * (1 - u)
        s.particle({ img: pix(pick(['a', 'y'])), x: p.x - 13, y: FLOOR - 6 + p.yOff, vx: -12, vy: -4, life: 0.4, fade: true })
        if (p.inside) R.x = p.x
        if (u >= 1) {
          p.landing = null
          p.yOff = 0
          p.wreck = true
          s.burst(p.x, FLOOR - 2, 18, ['y', 'O', 'n'])
          s.data.shakeUntil = now + 500
        }
        p.moving = !!p.landing
        return FAST
      }
      p.moving = false
      return Infinity
    },
    slot(p, dt, now, s) {
      if (!p.spin) return Infinity
      if (now >= p.spin.until) {
        p.show = p.spin.result
        const user = p.spin.user
        p.spin = null
        if (p.show === 'win') s.burst(p.x, FLOOR - 7, 12, ['y', 'Y', 'w'])
        if (user) {
          if (p.show === 'win') points(s, 1)
          else s.burst(p.x, FLOOR - 14, 8, ['r', 'w'])
          s.say(p.show === 'win' ? 'Three sevens! One whole point.' : 'Three skulls. Good thing nobody sat down.', p.x, 11, { life: 2.6 })
        }
        return FAST
      }
      return FAST
    },
  }
  class Prop {
    constructor(s, kind, at) {
      this.s = s
      this.kind = kind
      this.at = at
      this.x = 0
      this.yOff = 0
      this.z = PROP_Z[kind] ?? 0
      this.prop = true
      this.moving = false
      this.hidden = false
    }
    update(dt, now, s) {
      const own = PROP_UPD[this.kind] ? PROP_UPD[this.kind](this, dt, now, s) : Infinity
      return (this.fxUntil || 0) > now ? FAST : own
    }
    draw(c, s) {
      if (this.hidden) return
      const now = performance.now()
      const jig = (this.fxUntil || 0) > now && this.kind === 'crate' ? (Math.floor(now / 60) % 2 ? 1 : -1) : 0
      if (jig) c.translate(jig, 0)
      PROP_DRAW[this.kind](c, s, this)
      if (jig) c.translate(-jig, 0)
    }
    hit(x, y) {
      const b = PROP_BOX[this.kind]
      if (this.hidden || !(Math.abs(x - this.x) <= b[0] + 3 && y >= FLOOR + this.yOff - b[1] - 3 && y <= FLOOR + this.yOff + 2)) return false
      // a character standing in front wins the click
      const cast = this.s.data.cast
      for (const k in cast) if (cast[k].hit(x, y)) return false
      return true
    }
    verb() {
      return PROP_VERB[this.kind](this.s.data)
    }
    onClick() {
      propClick(this.s, this)
    }
  }

  // ---- the story ----------------------------------------------------------------
  // Steps: ['n', text] narrator box, ['say', who, text], ['go', who, spot, speed],
  // ['pose', who, pose], ['pts', n], ['label', k] / ['restore', from, to] for the
  // death-and-restore gag, plus a few set pieces (pod, slots, jetpack, zaps).
  // Spots: 'L.5' / 'R.5' = fraction of the open stretch left/right of the title,
  // 'T' = title centre, '<' '>' = offstage, 'slot+13' = relative to a prop or cast key.
  const T1 = 'Thank you for playing Space Quest.'
  const T2 = "As usual, you've been a big help."
  // a death: one of several messages, the famous sign-off, then a restore
  const DIE = (alts, from, to) => [['box', alts, 4200], ['box', [T1, T2, '#restore'], 4600], ['restore', from, to]]

  const EP1 = [
    { // 1. the broom closet
      set: 'arcada', props: [['closet', 'L.3']], R: ['closet+0', 1, 'doze'],
      steps: [
        ['wait', 900],
        ['n', 'SPACE QUEST: The Sarien Encounter'],
        ['n', 'You are Roger Wilco, janitor of the Arcada.'],
        ['n', ['You are asleep in a broom closet. Again.', 'You are napping in a broom closet. As usual.', 'You are asleep. On duty. In a closet.']],
        ['sfx', '*KA-THOOM*', true],
        ['pose', 'R', 'stand'],
        ['say', 'R', ["Huh? Wha? I wasn't sleeping!", "I'm up! I'm up! Who's asking?", 'Five more minutes, Mom...']],
        ['say', 'R', ['I was... inspecting the mop. Closely.', 'I was resting my eyes. Professionally.']],
        ['n', ['The ship shudders. That is probably fine.', 'Alarms blare. That is probably a drill.']],
        ['go', 'R', 'R.3'],
        ['say', 'R', ['Hello? Is it lunch? Did I miss lunch?', 'Hello? Anybody? Is this a fire drill?']],
        ['go', 'R', '>'],
      ],
    },
    { // 2. the dying crewman
      set: 'arcada', R: ['<', 1],
      steps: [
        ['go', 'R', 'L.5'],
        ['mop', 'R', 1800],
        ['n', 'You mop the corridor. It is the most work'],
        ['n', 'anyone on the Arcada has done all week.'],
        ['enter', 'C', 'crew', '>', -1],
        ['go', 'C', 'R.25', 18],
        ['say', 'C', 'Sariens... took the Star Generator...'],
        ['say', 'C', 'Tell... Astral Body... the cartridge...'],
        ['pose', 'C', 'dead'],
        ['sfx', '*thud*'],
        ['face', 'R', 'C'],
        ['say', 'R', 'Astral what? Can you spell that?'],
        ['n', "He's dead, Roger. You were a great comfort."],
        ['say', 'R', 'Gee. I should probably tell someone.'],
        ['say', 'R', 'Right after I finish this bit of floor.'],
        ['mop', 'R', 1500],
        ['pts', 1],
        ['go', 'R', '<'],
      ],
    },
    { // 3. the Sarien patrol and the sneeze
      set: 'arcada', props: [['crate', 'L.25']], R: ['<', 1],
      steps: [
        ['go', 'R', 'L.7'],
        ['enter', 'S', 'sarien', '>', -1],
        ['go&', 'S', 'R.6'],
        ['say', 'R', "Uh oh. Those aren't crew."],
        ['go', 'R', 'crate+0', RUN],
        ['pose', 'R', 'hide'],
        ['go', 'S', 'R.15'],
        ['say', 'S', 'Search every deck. Find the cartridge.'],
        ['say', 'S', ['And somebody mop this floor. Disgusting.', 'Ugh. Who leaves a wet floor on a raid?']],
        ['n', 'You hide behind a crate. Your mop does not.'],
        ['go', 'S', 'crate+24'],
        ['say', 'S', 'Hm. A mop. Sticking out of a crate.'],
        ['say', 'S', ['...Nah.', '...Crates do that sometimes.']],
        ['exit', 'S', '>'],
        ['label', 'sneak'],
        ['pose', 'R', 'stand'],
        ['say', 'R', 'Phew. Okay. Tiptoe, Roger. Tiptoe.'],
        ['go', 'R', 'L.9', SNEAK],
        ['say', 'R', 'Ah... ahh...'],
        ['say', 'R', 'AH-CHOO!'],
        ['enter', 'S', 'sarien', '>', -1],
        ['go', 'S', 'R.5', RUN],
        ['say', 'S', 'Bless you.'],
        ['zap', 'S'],
        ...DIE([['You sneezed at a Sarien. He said "bless', 'you", then vaporized you. Manners!'], ['Sneezing near armed Sariens is a', 'popular way to stop sneezing forever.']], 'sneak', 'sneak2'),
        ['label', 'sneak2'],
        ['pose', 'R', 'stand'],
        ['go', 'R', 'L.9', SNEAK],
        ['say', 'R', 'Ah... ahh...'],
        ['say', 'R', '*mmmf*'],
        ['n', 'You pinch your nose. Character growth!'],
        ['pts', 5],
        ['go', 'R', '>', SNEAK],
      ],
    },
    { // 4. the data archive
      set: 'arcada', props: [['console', 'R.6']], R: ['<', 1],
      steps: [
        ['go', 'R', 'console-13'],
        ['face', 'R', 'console'],
        ['n', 'The data archive. A cartridge sits in the'],
        ['n', "reader. It is labelled 'DO NOT TAKE'."],
        ['say', 'R', ['Finders keepers.', 'It says DO NOT. It does not say WHY.']],
        ['pose', 'R', 'reach'],
        ['take'],
        ['wait', 700],
        ['pose', 'R', 'stand'],
        ['pts', 10],
        ['n', 'You take the cartridge. Somewhere, a clerk'],
        ['n', 'feels a disturbance in the paperwork.'],
        ['say', 'R', 'Now, where do they keep the escape pods?'],
        ['say', 'R', '...I really should read the safety card.'],
        ['go', 'R', '>'],
      ],
    },
    { // 5. the escape pod
      set: 'arcada', props: [['pod', 'R.6']], R: ['<', 1],
      steps: [
        ['go', 'R', 'pod-17'],
        ['say', 'R', 'An escape pod! Ha! Take that, Sariens.'],
        ['board'],
        ['n', 'You climb in. There are four red buttons.'],
        ['n', 'A sign says: DO NOT PUSH THE RED BUTTON.'],
        ['say', 'R', ["Which one? ...I'll push all of them.", 'Eeny, meeny, miny... all of them.']],
        ['launch'],
        ['flash'],
        ['sfx', '*KA-BOOM*', true],
        ['n', 'The Arcada explodes behind you.'],
        ['n', ['Good news: you remembered the mop.', 'You saved the most important thing: the mop.']],
        ['pts', 5],
      ],
    },
    { // 6. Kerona and the acid
      set: 'desert', props: [['pod', '<'], ['acid', 'R.5']], R: ['<', 1, 'stand', 'normal', 'boarded'],
      steps: [
        ['land', 'L.2'],
        ['unboard'],
        ['n', 'You crash-land on Kerona. It is a desert.'],
        ['n', 'It is hot. You did not pack sunscreen.'],
        ['say', 'R', "Well, at least it can't get any worse."],
        ['label', 'acid'],
        ['go', 'R', 'acid-11'],
        ['say', 'R', 'Water! Oh, thank goodness.'],
        ['pose', 'R', 'hide'],
        ['wait', 800],
        ['zap', 'acid'],
        ...DIE([['That was acid. The sign said ACID.', "You can't read Keronian. Or English."], ['You are now mostly dissolved. Next time,', 'maybe drink from the clear puddle.']], 'acid', 'acid2'),
        ['label', 'acid2'],
        ['go', 'R', 'acid-11'],
        ['say', 'R', 'Water! Oh, thank goodnes-'],
        ['say', 'R', '...Why is it bubbling? And hissing?'],
        ['n', 'You decide not to drink the acid.'],
        ['pts', 5],
        ['n', "A smart move. Don't get used to it."],
        ['say', 'R', 'A town over the dune! Ulence Flats!'],
        ['go', 'R', '>'],
      ],
    },
    { // 7. the Ulence Flats bar
      set: 'bar', props: [['slot', 'L0'], ['table', 'L1'], ['counter', 'R.6']],
      cast: [['B', 'bartender', 'counter+0', 1], ['G1', 'guy1', 'table-6', 1], ['G2', 'guy2', 'table+6', -1]],
      R: ['<', 1],
      steps: [
        ['go', 'R', 'counter-25'],
        ['say', 'B', ["What'll it be, stranger?", 'Name your poison. Not literally.']],
        ['say', 'R', 'Something wet. Not acid.'],
        ['say', 'B', 'Keronian ale. Two buckazoids.'],
        ['say', 'R', '...Do you take mops?'],
        ['say', 'B', 'No.'],
        ['say', 'G1', "Psst. Isn't that the janitor from our game?"],
        ['say', 'G2', "Shh. Act natural. We're just a cameo."],
        ['n', 'You are broke. A slot machine blinks at you.'],
        ['go', 'R', 'slot+14'],
        ['face', 'R', 'slot'],
        ['label', 'slots'],
        ['spin', 'win'],
        ['say', 'R', ['I won! Fifty buckazoids!', 'Three sevens! I am rich!']],
        ['n', 'You could quit while you are ahead.'],
        ['say', 'R', "Nah. I'm on a roll."],
        ['spin', 'skull'],
        ['zap', 'slot'],
        ...DIE([['Three skulls. The house always wins,', 'and the house has a disintegrator.'], ['The slot machine pays out in', 'disintegration. Read the small print.']], 'slots', 'slots2'),
        ['label', 'slots2'],
        ['spin', 'win'],
        ['say', 'R', 'I won! I could do this all d-'],
        ['say', 'R', '...You know what? I quit.'],
        ['n', 'You quit while ahead. Sierra is stunned.'],
        ['pts', 10],
        ['go', 'R', 'counter-25'],
        ['say', 'R', 'One ale! And a ride off this rock.'],
        ['say', 'B', 'The guys in the corner sell a jetpack.'],
        ['face', 'R', 'G1'],
        ['say', 'G1', 'Barely used. Ignore the scorch marks.'],
        ['say', 'G2', 'Forty buckazoids. No refunds. No helmet.'],
        ['say', 'R', 'Deal!'],
        ['pts', 5],
        ['go', 'R', '>'],
      ],
    },
    { // 8. the jetpack
      set: 'desert', R: ['L.4', 1, 'stand', 'jet'],
      steps: [
        ['n', 'You strap on the jetpack. The Sarien ship'],
        ['n', 'Deltaur is up there. Somewhere.'],
        ['say', 'R', 'How do you steer this thing?'],
        ['fly', 'R', 'T', -7],
        ['fly', 'R', 'R.4', 0],
        ['n', 'Mostly by screaming, it turns out.'],
        ['say', 'R', 'Look out, Sariens! Here comes Roger Wil-'],
        ['fly', 'R', '>', -16],
        ['pts', 5],
        ['n', 'To be continued in Episode Two.'],
      ],
    },
  ]

  const EP2 = [
    { // 1. aboard the Deltaur, the laundry hamper
      set: 'deltaur', props: [['hamper', 'L.4']], R: ['>', -1, 'stand', 'jet', 'air'],
      steps: [
        ['fly', 'R', 'R.5', 0],
        ['n', 'SPACE QUEST, Episode Two: The Deltaur'],
        ['n', 'You are aboard the Sarien ship Deltaur.'],
        ['n', 'It smells of armpits and evil.'],
        ['say', 'R', 'I need a disguise. Something Sarien-y.'],
        ['go', 'R', 'hamper+12'],
        ['face', 'R', 'hamper'],
        ['n', 'A laundry hamper. Inside: Sarien armour.'],
        ['pose', 'R', 'hide'],
        ['wait', 700],
        ['outfit', 'suit'],
        ['pose', 'R', 'stand'],
        ['pts', 5],
        ['say', 'R', ['How do I look? Menacing? Evil?', 'Grr. Evil. Very evil. Grr.']],
        ['n', 'Like a janitor in a Sarien suit. With a mop.'],
        ['go', 'R', '>'],
      ],
    },
    { // 2. the checkpoint
      set: 'deltaur', R: ['<', 1, 'stand', 'suit'],
      steps: [
        ['go', 'R', 'L.3'],
        ['enter', 'S', 'sarien', '>', -1],
        ['go', 'S', 'R+24'],
        ['say', 'S', 'Halt. Your ID, soldier.'],
        ['say', 'R', 'I left it in my... other armour.'],
        ['say', 'S', 'Why are you carrying a mop?'],
        ['say', 'R', ['Mop duty. Deck nine. Big spill. Gross.', 'Mop duty. Somebody had space chili.']],
        ['say', 'S', 'Ugh. Carry on, soldier.'],
        ['exit', 'S', '<'],
        ['n', 'He lets you pass. A mop opens every door.'],
        ['pts', 10],
        ['go', 'R', '>'],
      ],
    },
    { // 3. the Star Generator
      set: 'deltaur', props: [['gen', 'R.6']], R: ['<', 1, 'stand', 'suit'],
      steps: [
        ['go', 'R', 'gen-15'],
        ['n', 'The Star Generator. It hums with menace.'],
        ['say', 'R', 'A keypad: ENTER SELF-DESTRUCT CODE.'],
        ['label', 'gen'],
        ['say', 'R', 'Hmm. Or I could push the big button.'],
        ['pose', 'R', 'reach'],
        ['zap', 'gen'],
        ...DIE([['The button fired the Star Generator. At', 'you. From two inches away. Impressive.'], ['You pushed the big button. That is', 'exactly what big buttons are for.']], 'gen', 'gen2'),
        ['label', 'gen2'],
        ['say', 'R', 'No buttons. Code it is. Uh... 1-2-3-4?'],
        ['pose', 'R', 'reach'],
        ['wait', 700],
        ['pose', 'R', 'stand'],
        ['n', 'Correct. Sarien security is just like'],
        ['n', "the Arcada's. Self-destruct armed."],
        ['pts', 20],
        ['sfx', '*WHOOP* *WHOOP*'],
        ['say', 'R', 'Sixty seconds? I can do sixty seconds.'],
        ['go', 'R', '>', RUN],
      ],
    },
    { // 4. the chase: the mop pays off
      set: 'deltaur', R: ['<', 1, 'stand', 'suit'],
      steps: [
        ['go', 'R', 'L.5', RUN],
        ['enter', 'S', 'sarien', '>', -1],
        ['enter', 'S2', 'sarien', '>', -1],
        ['go&', 'S2', 'R.9'],
        ['go', 'S', 'R.3'],
        ['say', 'S', 'Stop that janitor!'],
        ['say', 'R', 'How did they know?!'],
        ['say', 'S2', 'You are carrying a MOP.'],
        ['mop', 'R', 1500, true],
        ['say', 'R', 'Careful! Floor is wet!'],
        ['charge', 'S'],
        ['charge', 'S2'],
        ['pts', 15],
        ['n', 'Both Sariens slip on your clean floor.'],
        ['n', 'Janitorial science prevails.'],
        ['go', 'R', '>', RUN],
      ],
    },
    { // 5. boom
      set: 'space', props: [['ship', 'L.3']], R: ['ship+20', 1, 'stand', 'jet', 'air'],
      steps: [
        ['fly', 'R', 'R.5', -4],
        ['explode', 'ship'],
        ['sfx', '*KA-BOOOOM*', true],
        ['n', 'The Deltaur explodes. Spectacularly.'],
        ['n', ['You saved the galaxy. With a mop.', 'The galaxy is saved. Mostly by accident.']],
        ['pts', 25],
        ['fly', 'R', '>', -15],
      ],
    },
    { // 6. home again (loops into the closet nap of episode one)
      set: 'arcada', props: [['closet', 'L.3']], R: ['>', -1, 'stand', 'medal'],
      steps: [
        ['go', 'R', 'R.4'],
        ['n', 'Back home, they give you a medal.'],
        ['n', '...and a brand-new broom closet.'],
        ['say', 'R', 'Hero of the galaxy. Time for a nap.'],
        ['go', 'R', 'closet+0'],
        ['face', 'R', 1],
        ['pose', 'R', 'doze'],
        ['n', T1],
        ['n', T2],
        ['wait', 2500],
      ],
    },
  ]
  const BAR_PROPS = [['slot', 'L0'], ['table', 'L1'], ['counter', 'R.6']]
  const BAR_CAST = [['B', 'bartender', 'counter+0', 1], ['G1', 'guy1', 'table-6', 1], ['G2', 'guy2', 'table+6', -1]]
  const EP3 = [
    { // 1. the kidnapping
      set: 'bar', props: BAR_PROPS, cast: BAR_CAST, R: ['<', 1, 'stand', 'medal'],
      steps: [
        ['go', 'R', 'counter-25'],
        ['n', 'SPACE QUEST, Episode Three: Two Guys'],
        ['say', 'R', ["One ale, please. I'm a hero now.", 'Barkeep! An ale for the hero!']],
        ['say', 'B', ['Heroes pay double.', 'Hero discount: full price.']],
        ['say', 'G1', 'Roger! We need a janitor. Our game has bugs.'],
        ['say', 'R', 'Literal bugs?'],
        ['say', 'G2', ['Space bugs. Also regular bugs.', 'Mostly in the parser.']],
        ['enter', 'S', 'sarien', '>', -1],
        ['go', 'S', 'table+24'],
        ['say', 'S', 'The Two Guys are coming with us.'],
        ['say', 'S', ['Vohaul wants a sequel. By Friday.', 'Our evil overlord needs a game. A hit.']],
        ['beamout', 'G1', 'G2'],
        ['exit', 'S', '>'],
        ['n', 'The Two Guys have been kidnapped.'],
        ['n', ['Their next game is in grave danger.', 'Their release date is in grave danger.']],
        ['say', 'R', ["Don't worry, guys. I'll mop... er, save you!", 'Hang on, guys! Janitor to the rescue!']],
        ['pts', 5],
        ['go', 'R', '>'],
      ],
    },
    { // 2. fixing the old pod
      set: 'desert', props: [['pod', 'L.3'], ['acid', 'R.8']], R: ['>', -1],
      steps: [
        ['wreck'],
        ['go', 'R', 'pod+18'],
        ['face', 'R', 'pod'],
        ['n', 'Your old escape pod. It has seen better days.'],
        ['n', ['It has also seen worse janitors. Not many.', 'Most of those days, you were not in it.']],
        ['label', 'fix'],
        ['say', 'R', ['Maybe it just needs a good kick.', 'Percussive maintenance. Here goes.']],
        ['zap', 'boom'],
        ...DIE([['You kicked the reactor. Kicking is not', 'a recognised repair technique.'], ['The pod disagreed with your kick.', 'Violently. At close range.']], 'fix', 'fix2'),
        ['label', 'fix2'],
        ['say', 'R', 'No kicking. Mop strings as hull patch?'],
        ['face', 'R', 'pod'],
        ['mop', 'R', 1500],
        ['n', 'You patch the hull with mop strings.'],
        ['n', ['It holds. Let us not test it further.', 'It holds. Sierra quality assurance.']],
        ['pts', 10],
        ['board'],
        ['say', 'R', 'Next stop: the Sarien ship!'],
        ['launch'],
        ['n', 'The pod wobbles into orbit, held together'],
        ['n', 'by mop strings and optimism.'],
      ],
    },
    { // 3. the crate, again
      set: 'deltaur', props: [['crate', 'L.3']], R: ['<', 1],
      steps: [
        ['go', 'R', 'L.8'],
        ['n', "The Sarien cargo deck. It smells familiar."],
        ['enter', 'S', 'sarien', '>', -1],
        ['go&', 'S', 'R.5'],
        ['say', 'R', 'A crate! Crate crate crate!'],
        ['go', 'R', 'crate+0', RUN],
        ['pose', 'R', 'hide'],
        ['go', 'S', 'crate+24'],
        ['say', 'S', 'A crate. With a mop sticking out.'],
        ['say', 'S', '...Again?'],
        ['say', 'S', "I'm not falling for that tw-"],
        ['say', 'S', ['...Nah. Crates are crates.', '...Wait. Is it lunch?']],
        ['exit', 'S', '>'],
        ['n', ['Sarien training has not improved.', 'Sarien security: still a crate away.']],
        ['pts', 5],
        ['pose', 'R', 'stand'],
        ['go', 'R', '>'],
      ],
    },
    { // 4. the cell console
      set: 'deltaur', props: [['table', 'L.5'], ['console', 'R.6']],
      cast: [['G1', 'guy1', 'table-6', 1], ['G2', 'guy2', 'table+6', -1]], R: ['<', 1],
      steps: [
        ['go', 'R', 'console-13'],
        ['face', 'R', 'console'],
        ['say', 'G1', 'Roger! Over here! Get us out!'],
        ['say', 'G2', ['Vohaul makes us write Sarien help files.', 'They want a game about evil. In EGA.']],
        ['say', 'R', 'Hang on. Which button opens the cell?'],
        ['label', 'cell'],
        ['say', 'R', ['Red means go, right?', 'Eeny, meeny, miny... red.']],
        ['pose', 'R', 'reach'],
        ['zap', 'console'],
        ...DIE([['That button vented the room. Mostly', 'you. The Two Guys had seatbelts.'], ["Red meant 'self-defence'. The console", 'defended itself. Thoroughly.']], 'cell', 'cell2'),
        ['label', 'cell2'],
        ['pose', 'R', 'stand'],
        ['say', 'R', 'No buttons. I know what to do.'],
        ['mop', 'R', 1500],
        ['n', 'You mop the console. It shorts out and'],
        ['n', 'the cell opens. Water: the universal key.'],
        ['flash'],
        ['pts', 15],
        ['say', 'G1', ['Free! Roger, you magnificent janitor!', 'Free! We owe you a cameo!']],
        ['say', 'G2', 'Quick, before they make us do a remake!'],
        ['beamout', 'G1', 'G2'],
        ['n', 'The Two Guys sprint for your pod.'],
        ['go', 'R', '>', RUN],
      ],
    },
    { // 5. the chase, again
      set: 'deltaur', R: ['<', 1],
      steps: [
        ['go', 'R', 'L.5', RUN],
        ['enter', 'S', 'sarien', '>', -1],
        ['enter', 'S2', 'sarien', '>', -1],
        ['go&', 'S2', 'R.9'],
        ['go', 'S', 'R.3'],
        ['say', 'S', ['After that janitor!', 'Stop, in the name of Vohaul!']],
        ['say', 'R', 'Not again. Okay. Floor. Mop. Go.'],
        ['mop', 'R', 1500, true],
        ['charge', 'S'],
        ['charge', 'S2'],
        ['pts', 15],
        ['n', ['Two Sariens, one wet floor. Again.', 'The Sariens never learn. You barely do.']],
        ['say', 'S2', 'Who keeps MOPPING during a chase?!'],
        ['go', 'R', '>', RUN],
      ],
    },
    { // 6. back at the bar
      set: 'bar', props: BAR_PROPS, cast: BAR_CAST, R: ['<', 1, 'stand', 'medal'],
      steps: [
        ['go', 'R', 'counter-25'],
        ['say', 'G1', 'To Roger! Best janitor in the galaxy!'],
        ['say', 'G2', ["We're putting you in our next game.", 'You get your own sequel, Roger!']],
        ['say', 'R', 'As the hero?'],
        ['say', 'G2', 'As the janitor.'],
        ['say', 'R', '...Fair.'],
        ['say', 'B', ['Drinks are on the house.', 'On the house. Kidding. Pay up.']],
        ['pts', 10],
        ['n', T1],
        ['n', T2],
        ['wait', 2500],
      ],
    },
  ]
  const EPISODES = [EP1, EP2, EP3]

  // lines for clicks, the hover parser and the raid
  const TALK = {
    roger: ["I'm Roger Wilco. Sanitation engineer.", 'Careful. This mop is loaded.', "I'm on my break. It's a long break.", 'I could really go for a nap.'],
    sarien: ['Move along, citizen.', '*heavy Sarien breathing*', 'I am not a mop salesman.'],
    bartender: ['No credit. No mops. No exceptions.', 'You look like a guy who mops.'],
    guy1: ["We're just here for the cameo.", 'Buy our next game!'],
    guy2: ["Don't look at us. We're in the credits.", 'Have you tried turning it off and on?'],
    crew: ['Help... me...'],
  }
  const PROP_SAY = {
    closet: "It's your closet. Home away from home.",
    console: 'A data console. It has more brains than you.',
    crate: 'A crate. Excellent for hiding. Mostly.',
    pod: 'An escape pod. Do NOT push the red button.',
    acid: 'The puddle hisses at you. Rude.',
    slot: "Slots: the galaxy's leading cause of death.",
    counter: 'A sticky bar. Literally.',
    table: 'The guys are busy being a cameo.',
    hamper: 'It smells like Sarien socks.',
    gen: 'It hums. You hum back. Nothing happens.',
    ship: 'The Deltaur. Big, ugly, about to explode.',
  }
  const FIX = {
    eyes: ['look at eyes', 'Two big eyes. They are judging you.'],
    title: ['clean title', 'You polish the sign. It still says aico.'],
    glyph: ['take diamond', "It's bolted down. Like everything nice."],
  }
  const DOT_SAY = {
    min: 'You minimize your expectations.',
    max: 'You maximize nothing. As usual.',
    close: "Don't. Seriously. We were having fun.",
  }
  const RAID = {
    S: ['Halt, earthling!', 'There! The janitor!', 'Hold still! I am vaporizing you!', 'Hand over the cartridge!', 'Who mops during an invasion?!'],
    R: ["I'm just the janitor!", 'Not the face!', 'Missed me! ...Right?', "I surrender! Wait, no I don't!"],
    N: ['You duck. It is your best skill.', 'Sarien marksmanship: not great.', 'Your mop offers no cover.', 'You hide behind nothing. It works.'],
  }
  const RAID_DEATHS = [
    ['You stood up at exactly the wrong', 'moment. A rare talent.'],
    ['You tried to reason with a blaster.', 'The blaster won the argument.'],
    ['Vaporized. Sariens 1, janitors 0.', 'Only your mop remains.'],
  ]
  const GRAB_N = ["You can't pick up Roger. ...Oh. You can.", 'You lift Roger by the collar. He is used to it.', 'Roger dangles. Sierra did not test this.', 'You take Roger. He was not nailed down.']
  const LAND_R = ['Ow. My everything.', 'I meant to do that.', 'Put me down gentl- ow.', 'Was that a puzzle? Did I solve it?']
  const DODGE = ['You duck just in time. Character growth!', 'The bolt parts your hair. Nice duck.', 'You duck. It is your best skill.']
  const TRAP = { S: ['Get him!', 'You and your MOP!', 'Charge!', 'Not the wet floor again...'], N: ['You mop the floor. Wet floors are a trap.', 'Janitorial tactics: mop, step back, wait.'], UP: ['Ow. My dignity.', 'Who mops during a raid?!', 'I am filing a complaint.'] }
  const DOZE_TALK = ['Zzz... the mop... my precious mop...', '*snore* ...not the red button...', 'Mmf. Five more minutes, Captain.', 'Zzz... I am awake. I am totally awake.']
  const DANCE = ['You found the secret janitor dance.', 'Roger dances. Nobody asked. 0 points.']
  const CHICK_R = ['Astro Chicken? Wrong game, pal.', 'Was that... a chicken? In space?', 'Is that chicken wearing a helmet?']
  const SET_TALK = {
    arcada: ['This deck is spotless. Thanks to me.', 'I should really check in with the captain.'],
    desert: ["I'd kill for a glass of water. Not acid.", 'Sand. In places sand should not be.'],
    deltaur: ['Act evil, Roger. Act evil.', 'Grr. Evil. Look at me being evil.'],
    bar: ['Nice place. Sticky, but nice.', 'Do they have a janitor? Asking for me.'],
    space: ['Space! It is very... big.', 'Note to self: never look down.'],
  }
  const QUIPS = ['You did something right. Shocking.', 'A puzzle, solved. Sierra is stunned.', 'Well done, Roger. Write that down.']

  // ---- layout ------------------------------------------------------------------
  // The open stretches left and right of the title, read fresh each time (the title
  // is the session name and changes width; pinned buttons may sit left of the glyph).
  // A stretch narrower than 48 px borrows space from the title side.
  function zones(s) {
    const e = s.fixture('eyes')
    const t = s.fixture('title')
    const tEnd = t.x + t.w
    let right = s.W - 4
    for (const f of [...s.fix, ...s.dots]) if (f.kind !== 'title' && f.x > tEnd - 2 && f.x < right) right = f.x
    const L = { a: e.x + e.w + 6, b: t.x - 6 }
    const R = { a: tEnd + 6, b: right - 6 }
    if (L.b - L.a < 48) L.b = L.a + 48
    if (R.b - R.a < 48) R.a = R.b - 48
    s.data.Z = { L, R }
    return s.data.Z
  }
  function makeStars(s) {
    const t = s.fixture('title')
    s.data.starKey = `${s.W}:${t.x}:${t.w}`
    // a fixed star field for the space scene, kept off the furniture
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const stars = []
    for (let i = 0; i < Math.round(s.W / 9); i++) {
      const x = Math.round(rnd() * s.W)
      const y = Math.round(10 + rnd() * (FLOOR - 12))
      if (!s.fix.some((f) => x >= f.x - 2 && x <= f.x + f.w + 2 && y >= f.y - 2 && y <= f.y + f.h + 2)) stars.push([x, y, rnd() < 0.3 ? 'w' : 'a'])
    }
    s.data.stars = stars
  }
  function findProp(d, kind) {
    return d.props.find((p) => p.kind === kind && !p.dead)
  }
  function spot(s, k) {
    const d = s.data
    if (typeof k === 'number') return k
    if (k === '<') return -18
    if (k === '>') return s.W + 18
    if (k === 'T') {
      const t = s.fixture('title')
      return Math.round(t.x + t.w / 2)
    }
    const z = /^([LR])(\d*\.?\d+)$/.exec(k)
    if (z) {
      const zone = zones(s)[z[1]]
      return Math.round(zone.a + 8 + parseFloat(z[2]) * Math.max(0, zone.b - zone.a - 16))
    }
    const r = /^([A-Za-z]\w*)([+-]\d+)$/.exec(k)
    if (r) {
      const base = d.cast[r[1]] || findProp(d, r[1])
      return Math.round((base ? base.x : s.W / 2) + parseInt(r[2], 10))
    }
    return s.W / 2
  }
  function targetX(s, k) {
    const d = s.data
    if (typeof k === 'number') return null
    const t = d.cast[k] || findProp(d, k)
    return t ? t.x : null
  }
  // open stretches where someone may rest without covering the furniture
  function overFurniture(s, x) {
    return s.fix.some((f) => x > f.x - 7 && x < f.x + f.w + 7)
  }
  function openSpot(s, x) {
    const Z = zones(s)
    const c = [Z.L.a + 8, Z.L.b - 8, Z.R.a + 8, Z.R.b - 8]
    let best = c[0]
    for (const v of c) if (Math.abs(v - x) < Math.abs(best - x)) best = v
    return best
  }

  // ---- cast & scenes ---------------------------------------------------------------
  function addCast(s, key, type, x, dir) {
    const d = s.data
    const ch = new Char(s, key, type, x, dir)
    if (type === 'bartender') {
      ch.z = 0.5
      ch.yOff = -5
      ch.fidPoses = ['polish']
    } else if (type === 'guy1' || type === 'guy2') {
      ch.z = 0.5
      ch.yOff = -4
      ch.fidPoses = ['sip']
    }
    d.cast[key] = ch
    s.spawn(ch)
    return ch
  }
  function removeCast(d, key) {
    if (d.cast[key]) {
      d.cast[key].dead = true
      delete d.cast[key]
    }
  }
  function addProp(s, kind, at) {
    const p = new Prop(s, kind, at)
    p.x = spot(s, at)
    s.data.props.push(p)
    s.spawn(p)
    return p
  }
  function resetRunner(d) {
    d.pending = null
    d.waitUntil = 0
    d.asideUntil = 0
    d.hold = null
    d.locked = false
    d.box = null
    d.beam = null
    d.puddle = null
  }
  function startScene(s, i) {
    const d = s.data
    const sc = EPISODES[d.ep][i]
    d.sceneIx = i
    for (const k of Object.keys(d.cast)) if (k !== 'R') removeCast(d, k)
    for (const p of d.props) p.dead = true
    d.props = []
    d.flags = {}
    d.snaps = {}
    d.awarded = new Set()
    d.line = null
    d.set = sc.set
    resetRunner(d)
    for (const [kind, at] of sc.props || []) addProp(s, kind, at)
    const R = d.cast.R
    const [rx, rdir, rpose, routfit, rmode] = sc.R
    R.stop()
    R.x = spot(s, rx)
    R.spotKey = rx
    R.dir = rdir
    R.pose = rpose || 'stand'
    R.setOutfit(routfit || 'normal')
    R.hidden = false
    R.boarded = false
    R.yOff = rmode === 'air' ? -12 : 0
    R.restPose = null
    if (rmode === 'boarded') {
      const pod = findProp(d, 'pod')
      pod.inside = true
      pod.x = -30
      R.hidden = true
      R.boarded = true
      R.x = pod.x
    }
    for (const [key, type, at, dir] of sc.cast || []) addCast(s, key, type, spot(s, at), dir).spotKey = at
    d.run = { steps: sc.steps, ip: 0, cur: 0 }
    // now and then Astro Chicken wanders in from the wrong game
    if (['space', 'desert', 'deltaur'].includes(sc.set) && Math.random() < 0.3) d.chickenAt = performance.now() + rand(5000, 16000)
    s.poke()
  }
  function nextScene(s) {
    const d = s.data
    let i = d.sceneIx + 1
    if (i >= EPISODES[d.ep].length) {
      d.played++
      if (d.played < EPISODES.length) d.ep = d.played
      else {
        let e = d.ep
        while (e === d.ep) e = Math.floor(Math.random() * EPISODES.length)
        d.ep = e
      }
      i = 0
      if (d.score > 150) d.score = 0
    }
    startScene(s, i)
  }
  function snapshot(d) {
    const cast = {}
    for (const k in d.cast) {
      const c = d.cast[k]
      cast[k] = { type: c.type, x: c.x, dir: c.dir, pose: c.pose, hidden: c.hidden, yOff: c.yOff, outfit: c.outfit }
    }
    return { cast, flags: { ...d.flags } }
  }
  function applySnap(s, snap) {
    const d = s.data
    for (const k of Object.keys(d.cast)) if (!snap.cast[k]) removeCast(d, k)
    for (const k in snap.cast) {
      const v = snap.cast[k]
      const c = d.cast[k] || addCast(s, k, v.type, v.x, v.dir)
      c.stop()
      Object.assign(c, { x: v.x, dir: v.dir, pose: v.pose, hidden: v.hidden, yOff: v.yOff })
      if (c.type === 'roger') c.setOutfit(v.outfit)
    }
    d.flags = { ...snap.flags }
    for (const p of d.props) if (p.kind === 'slot') p.show = null
    d.beam = null
  }
  function points(s, n) {
    const d = s.data
    const now = performance.now()
    d.score += n
    d.status = { add: n, until: now + 2500 }
    const R = d.cast.R
    if (R && !R.hidden) {
      for (let i = 0; i < 3; i++) s.particle({ img: BUBBLE['♪'], x: R.x + R.dir * 6 - 4 + i * 5, y: FLOOR - 24 + R.yOff, vx: (i - 1) * 5, vy: -9 - i * 2, life: 1.4, fade: true })
      if (R.pose === 'stand' && !R.moving && !R.anim) R.play([R.set.cheer], 1000, 1)
    }
  }
  function zapRoger(s) {
    const R = s.data.cast.R
    R.tx = null
    R.cb = null
    R.play(R.set.zap, 900, 10, () => {
      R.pose = 'ash'
      s.burst(R.x, FLOOR - 4, 10, ['a', 'A', 'w'])
    })
  }

  // ---- the script runner -------------------------------------------------------------
  const LOCKING = new Set(['zap', 'spin', 'board', 'unboard', 'launch', 'land', 'fly', 'charge', 'box', 'restore', 'explode'])
  function showLine(s, who, text, now, wait = true) {
    const d = s.data
    if (Array.isArray(text)) text = pick(text)
    d.line = { who, text, until: now + dur(text) }
    if (wait) d.waitUntil = d.line.until
  }
  function exec(s, st, now) {
    const d = s.data
    const [op, a, b, c4, e5] = st
    const ch = typeof a === 'string' ? d.cast[a] : null
    if (LOCKING.has(op)) d.locked = true
    switch (op) {
      case 'n':
        return showLine(s, null, a, now)
      case 'say':
        return showLine(s, a, b, now)
      case 'sfx':
        d.line = { who: null, sfx: true, text: a, until: now + 1400 }
        d.waitUntil = now + 1400
        if (b) d.shakeUntil = now + 600
        return
      case 'wait':
        d.waitUntil = now + a
        return
      case 'go':
      case 'go&': {
        ch.goto(spot(s, b), c4 || WALK)
        ch.spotKey = b
        if (op === 'go') {
          d.pending = () => !ch.moving
          d.pendWho = a
        }
        return
      }
      case 'exit':
        ch.goto(spot(s, b), c4 || WALK)
        d.pending = () => {
          if (ch.moving) return false
          removeCast(d, a)
          return true
        }
        d.pendWho = a
        return
      case 'enter':
        if (!d.cast[a]) addCast(s, a, b, spot(s, c4), e5).spotKey = c4
        return
      case 'pose':
        ch.anim = null
        ch.pose = b
        return
      case 'face': {
        const x = typeof b === 'number' ? ch.x + b : targetX(s, b)
        if (x !== null && x !== ch.x) ch.dir = x > ch.x ? 1 : -1
        return
      }
      case 'mop':
        ch.play(ch.set.mop, b, 5)
        if (c4) d.puddle = { x0: ch.x - 44, x1: ch.x + 44 }
        d.pending = () => !ch.anim
        return
      case 'pts':
        if (!d.awarded.has(st)) {
          d.awarded.add(st)
          points(s, a)
        } else d.status = { add: a, until: now + 2500 }
        d.waitUntil = now + 2500
        return
      case 'label':
        d.snaps[a] = snapshot(d)
        return
      case 'restore': {
        if (d.snaps[a]) applySnap(s, d.snaps[a])
        const i = d.run.steps.findIndex((x) => x[0] === 'label' && x[1] === b)
        if (i >= 0) d.run.ip = i + 1
        d.flashUntil = now + 180
        d.waitUntil = now + 600
        return
      }
      case 'box':
        d.box = { lines: Array.isArray(a[0]) ? pick(a) : a, until: now + b, t0: now }
        d.waitUntil = now + b
        return
      case 'take':
        d.flags.cart = true
        s.burst(spot(s, 'console+9'), FLOOR - 11, 6, ['y', 'w'])
        return
      case 'outfit':
        d.cast.R.setOutfit(a)
        d.flags.suit = true
        d.flashUntil = now + 150
        return
      case 'flash':
        d.flashUntil = now + 260
        d.waitUntil = now + 300
        return
      case 'board': {
        const pod = findProp(d, 'pod')
        const R = d.cast.R
        pod.inside = true
        R.hidden = true
        R.boarded = true
        R.x = pod.x
        return
      }
      case 'unboard': {
        const pod = findProp(d, 'pod')
        const R = d.cast.R
        pod.inside = false
        R.hidden = false
        R.boarded = false
        R.x = pod.x + 18
        R.dir = 1
        return
      }
      case 'launch': {
        const pod = findProp(d, 'pod')
        pod.launch = { v: 0 }
        d.pending = () => !pod.launch
        return
      }
      case 'land': {
        const pod = findProp(d, 'pod')
        pod.landing = { x0: -30, tx: spot(s, a), t: 0, dur: 1.8 }
        pod.yOff = -16
        d.pending = () => !pod.landing
        return
      }
      case 'fly':
        ch.fly = { tx: spot(s, b), alt: c4, spd: 60 }
        d.pending = () => !ch.fly
        return
      case 'spin': {
        const slot = findProp(d, 'slot')
        const R = d.cast.R
        slot.spin = { until: now + 1500, result: a }
        slot.show = null
        R.pose = 'reach'
        d.pending = () => {
          if (slot.spin) return false
          R.pose = 'stand'
          return true
        }
        return
      }
      case 'zap': {
        const R = d.cast.R
        R.anim = null
        if (R.pose !== 'reach' && R.pose !== 'hide') R.pose = 'stand'
        if (a === 'acid') {
          s.burst(R.x + R.dir * 8, FLOOR - 3, 14, ['G', 'g', 'w'])
          zapRoger(s)
        } else if (a === 'boom') {
          s.burst(R.x + R.dir * 10, FLOOR - 8, 18, ['r', 'y', 'O', 'w'])
          d.shakeUntil = now + 500
          zapRoger(s)
        } else if (findProp(d, a)) {
          const src = findProp(d, a)
          const col = { gen: P.M, console: P.C }[a] || P.Y
          d.beam = { x0: src.x + (a === 'gen' ? -6 : a === 'console' ? -6 : 7), x1: R.x, y: FLOOR - (a === 'gen' ? 12 : a === 'console' ? 14 : 17), color: col, until: now + 500 }
          zapRoger(s)
        } else {
          const S = d.cast[a]
          S.dir = R.x > S.x ? 1 : -1
          S.pose = 'aim'
          const at = now + 600
          let fired = false
          d.pending = (t) => {
            if (!fired && t >= at) {
              fired = true
              S.pose = 'stand'
              s.spawn(new Bolt(S.x + S.dir * 11, S.dir, true, zapRoger))
            }
            return R.pose === 'ash' && !R.anim
          }
          return
        }
        d.pending = () => R.pose === 'ash' && !R.anim
        return
      }
      case 'charge': {
        const R = d.cast.R
        const side = ch.x > R.x ? 1 : -1
        // a second Sarien from the same side trips a little further out
        const reach = 30 + 18 * Object.values(d.cast).filter((o) => o.down && Math.sign(o.x - R.x) === side).length
        ch.goto(R.x + side * 12, CHARGE)
        d.pending = () => {
          if (!ch.down && Math.abs(ch.x - R.x) <= reach) slip(s, ch)
          return ch.down && !ch.fall
        }
        return
      }
      case 'explode': {
        const p = findProp(d, a)
        p.dead = true
        d.props = d.props.filter((x) => x !== p)
        for (let i = 0; i < 3; i++) s.burst(p.x - 10 + i * 10, FLOOR - 17, 16, ['r', 'y', 'O', 'w'])
        d.flashUntil = now + 300
        d.shakeUntil = now + 800
        d.waitUntil = now + 500
        return
      }
      case 'beamout':
        for (const k of st.slice(1)) {
          const g = d.cast[k]
          if (g) s.burst(g.x, FLOOR - 14, 10, ['c', 'w', 'y'])
          removeCast(d, k)
        }
        d.flashUntil = now + 220
        d.waitUntil = now + 500
        return
      case 'wreck':
        findProp(d, 'pod').wreck = true
        return
      case 'fx':
        return a(s, d, now)
      case 'next':
        return nextScene(s)
    }
  }
  function slip(s, S) {
    S.down = true
    S.tx = null
    S.cb = null
    S.pose = 'fall'
    S.yOff = -7
    S.fall = { vy: -30, then: () => s.burst(S.x, FLOOR - 2, 10, ['c', 'w', 'b']) }
  }
  function endRun(s) {
    const d = s.data
    const run = d.run
    if (run.then) {
      d.run = null
      run.then(s)
    } else if (run.ret) d.run = run.ret
    else nextScene(s)
  }
  function holdTick(s, now) {
    const d = s.data
    const R = d.cast.R
    const h = d.hold
    if (R.moving || R.anim) return FAST
    if (!h.called) {
      h.called = true
      if (h.then) h.then()
      if (R.moving || R.anim) return FAST
    }
    if (!h.at) h.at = now
    if (now < h.at + 400) return h.at + 400 - now
    d.hold = null
    return 0
  }
  function runTick(s, now) {
    const d = s.data
    if (d.grabbed || d.keyWalk) return FAST // the plot waits while Roger is in your hand, or walking under your keys
    for (let guard = 0; guard < 40; guard++) {
      if (d.hold) {
        const w = holdTick(s, now)
        if (w > 0) return w
      }
      if (now < d.asideUntil) return d.asideUntil - now
      if (now < d.waitUntil) return d.waitUntil - now
      if (d.pending) {
        if (!d.pending(now)) return FAST
        d.pending = null
      }
      d.locked = false
      d.box = null
      const run = d.run
      if (!run) return Infinity
      const st = run.steps[run.ip]
      if (!st) {
        endRun(s)
        continue
      }
      run.cur = run.ip++
      exec(s, st, now)
    }
    return FAST
  }

  // ---- rest: the story waits while Roger naps on his mop -------------------------------
  function enterRest(s, now) {
    const d = s.data
    d.resting = true
    d.restWalked = false
    if (d.run && (d.waitUntil > now || d.asideUntil > now)) {
      d.run.ip = d.run.cur
      d.waitUntil = 0
    }
    d.asideUntil = 0
    d.line = null
    d.box = null
    d.status = null
    d.hold = null
    for (const k in d.cast) d.cast[k].asleep = true
  }
  function restTick(s) {
    const d = s.data
    const R = d.cast.R
    if (R.moving || R.anim || R.hidden || R.boarded) return
    if (['ash', 'dead', 'hide', 'doze'].includes(R.pose)) return
    if (R.yOff !== 0) return
    if (overFurniture(s, R.x) && !d.restWalked) {
      d.restWalked = true
      R.goto(openSpot(s, R.x))
      return
    }
    R.restPose = R.pose
    R.pose = 'doze'
    R.fid = null
  }
  function leaveRest(s) {
    const d = s.data
    d.resting = false
    for (const k in d.cast) d.cast[k].asleep = false
    const R = d.cast.R
    if (R.pose === 'doze' && R.restPose) R.pose = R.restPose
    R.restPose = null
    if (d.restartScene && d.mode !== 'action') {
      d.restartScene = false
      startScene(s, d.sceneIx)
    }
  }

  // ---- the raid (agent busy): Sariens patrol and shoot, Roger ducks ------------------------
  function startAction(s) {
    const d = s.data
    const now = performance.now()
    if (d.mode === 'action') return
    if (d.resting) leaveRest(s)
    d.mode = 'action'
    resetRunner(d)
    d.run = null
    d.status = null
    const R = d.cast.R
    R.stop()
    R.yOff = 0
    R.hidden = false
    R.boarded = false
    R.pose = 'stand'
    R.restPose = null
    R.x = clamp(R.x, 8, s.W - 9)
    const pod = findProp(d, 'pod')
    if (pod) pod.inside = false
    d.bolts = []
    d.act = { keys: ['A1', 'A2'], talkAt: now + 4500, moveAt: now + 1500, upAt: 0, duckAt: 0, deathAt: now + rand(12000, 20000), safe: [R.x], trailAt: now + 1000, dying: false, who: 0, userUntil: 0, trapAt: now + rand(9000, 16000) }
    if (Math.random() < 0.35) d.chickenAt = now + rand(6000, 20000)
    removeCast(d, 'A1')
    removeCast(d, 'A2')
    addCast(s, 'A1', 'sarien', s.W + 16, -1).ai = { st: 'enter', t: now, fireAt: now + 2500 }
    addCast(s, 'A2', 'sarien', -16, 1).ai = { st: 'enter', t: now + 1800, fireAt: now + 4200 }
    showLine(s, null, 'Red alert! Sariens on this deck!', now, false)
  }
  function endAction(s) {
    const d = s.data
    removeCast(d, 'A1')
    removeCast(d, 'A2')
    for (const b of d.bolts || []) b.dead = true
    d.bolts = []
    d.mode = 'story'
    d.puddle = null
    d.act = null
    d.run = null
    resetRunner(d)
  }
  function patrolSpot(s, S) {
    for (let i = 0; i < 6; i++) {
      const x = spot(s, `${pick(['L', 'R'])}${rand(0, 1).toFixed(2)}`)
      const rx = s.data.cast.R.x
      if (Math.abs(x - S.x) > 30 && Math.abs(x - rx) > 30 && (x - rx) * (S.x - rx) > 0) return x
    }
    return awayFrom(s, S)
  }
  // step to the far side of Roger's own spot so a Sarien never stands on him
  function awayFrom(s, S) {
    const rx = s.data.cast.R.x
    const side = S.x === rx ? (rx < s.W / 2 ? 1 : -1) : Math.sign(S.x - rx)
    const x = rx + side * 34
    const lo = spot(s, 'L0')
    const hi = spot(s, 'R1')
    return x >= lo && x <= hi ? x : Math.max(lo, Math.min(hi, rx - side * 34))
  }
  function sees(s, S, now) {
    const R = s.data.cast.R
    const dx = R.x - S.x
    return !R.hidden && R.pose !== 'ash' && Math.sign(dx) === S.dir && Math.abs(dx) > 16 && Math.abs(dx) < 170 && (R.pose !== 'hide' || Math.abs(dx) < 26) && now > S.ai.fireAt
  }
  function sarienAI(s, S, now) {
    const d = s.data
    const ai = S.ai
    if (S.down) {
      // slipped on the mopped floor: up again after a moment, sore and cross
      if (ai.st === 'down' && now >= ai.t && !S.fall) {
        S.down = false
        S.yOff = 0
        S.pose = 'stand'
        ai.st = 'look'
        ai.t = now + 900
        ai.fireAt = now + 2600
        if (!d.line || now > d.line.until) showLine(s, S.key, pick(TRAP.UP), now, false)
      }
      return
    }
    if (ai.st === 'charge') {
      if (S.tx === null || now > ai.t) {
        S.tx = null
        ai.st = 'look'
        ai.t = now + 900
        ai.fireAt = now + 1500
      }
      return
    }
    if (ai.st === 'enter') {
      if (now >= ai.t) {
        S.goto(patrolSpot(s, S))
        ai.st = 'walk'
      }
    } else if (ai.st === 'walk' || ai.st === 'look') {
      if (sees(s, S, now) && S.x > 4 && S.x < s.W - 4) {
        S.tx = null
        S.pose = 'aim'
        ai.st = 'aim'
        ai.t = now + 650
        ai.lethal = now > d.act.deathAt && Math.random() < 0.6
        if (!d.line || now > d.line.until) showLine(s, S.key, pick(RAID.S), now, false)
      } else if (Math.abs(S.x - d.cast.R.x) < 24 && (S.tx === null || Math.sign(S.tx - S.x) === Math.sign(d.cast.R.x - S.x))) {
        S.goto(awayFrom(s, S))
        ai.st = 'walk'
      } else if (ai.st === 'walk' && S.tx === null) {
        ai.st = 'look'
        ai.t = now + rand(1200, 2600)
      } else if (ai.st === 'look' && now >= ai.t) {
        if (Math.random() < 0.35 && now > (ai.turnAt || 0)) {
          S.dir = -S.dir
          ai.turnAt = now + 2500
          ai.t = now + rand(900, 1800)
        } else {
          S.goto(patrolSpot(s, S))
          ai.st = 'walk'
        }
      }
    } else if (ai.st === 'aim') {
      if (now >= ai.t) {
        const b = new Bolt(S.x + S.dir * 11, S.dir, ai.lethal, killRoger)
        s.spawn(b)
        d.bolts.push(b)
        s.burst(S.x + S.dir * 11, FLOOR - 17, 3, ['y', 'w'])
        if (ai.lethal) d.act.deathAt = now + rand(40000, 70000)
        ai.st = 'cool'
        ai.t = now + 600
      }
    } else if (ai.st === 'cool' && now >= ai.t) {
      S.pose = 'stand'
      ai.st = 'look'
      ai.t = now + rand(900, 1800)
      ai.fireAt = now + rand(2600, 4200)
    }
  }
  function rogerAI(s, now, sars) {
    const d = s.data
    const A = d.act
    const R = d.cast.R
    if (A.dying || R.pose === 'ash' || R.anim) return
    if (R.held || R.fall) return
    const user = engaged(s, now)
    if (user) {
      // the user steers: Roger tiptoes after the cursor and the autopilot stands back
      A.userUntil = Math.max(A.userUntil, now + 800)
      const c = s.cursor
      if (c && c.y >= 0 && c.y <= H && R.pose === 'stand' && !keyed(s, now)) {
        const tx = clamp(c.x, 6, s.W - 7)
        if (Math.abs(tx - R.x) > 10) R.goto(tx, SNEAK + 14)
      }
    }
    const threat = sars.find((S) => S.ai.st === 'aim' && Math.sign(R.x - S.x) === S.dir)
    if (threat) {
      if (!threat.ai.lethal && R.pose !== 'hide') {
        if (!A.duckAt) A.duckAt = now + 200
        if (now >= A.duckAt) {
          R.tx = null
          R.pose = 'hide'
          A.upAt = now + 1500
          A.duckAt = 0
        }
      }
      return
    }
    A.duckAt = 0
    if (R.pose === 'hide' && now >= A.upAt) {
      R.pose = 'stand'
      A.moveAt = Math.max(A.moveAt, now + 500)
    }
    // autopilot trap: a Sarien heading his way gets a freshly mopped floor
    if (!user && now >= A.trapAt && now >= A.userUntil && R.tx === null && R.pose === 'stand') {
      A.trapAt = now + rand(14000, 24000)
      const S = sars.find((o) => !o.down && o.ai.st === 'walk' && o.tx !== null && Math.abs(o.x - R.x) < 140 && Math.sign(o.tx - o.x) === Math.sign(R.x - o.x))
      if (S && mopTrap(s, S)) return
    }
    if (R.tx === null && R.pose === 'stand' && now >= A.moveAt && now >= A.userUntil) {
      let near = sars[0]
      for (const S of sars) if (!near || Math.abs(S.x - R.x) < Math.abs(near.x - R.x)) near = S
      const side = near && near.x > s.W / 2 ? 'L' : 'R'
      R.goto(spot(s, `${side}${rand(0.1, 0.9).toFixed(2)}`), SNEAK + 6)
      A.moveAt = now + rand(4500, 8000)
      A.hideAfter = true
    }
    if (R.tx === null && A.hideAfter) {
      A.hideAfter = false
      if (Math.random() < 0.5) {
        R.pose = 'hide'
        A.upAt = now + rand(1800, 3200)
      }
    }
  }
  /** Roger mops the floor toward a Sarien, who charges across it and slips. */
  function mopTrap(s, S) {
    const d = s.data
    const R = d.cast.R
    const now = performance.now()
    if (!d.act || d.act.dying || d.run || R.pose === 'ash' || R.held || R.fall || R.anim || S.down || !S.ai || S.ai.st === 'charge') return false
    if (S.x < 4 || S.x > s.W - 4) return false
    R.tx = null
    R.cb = null
    R.pose = 'stand'
    R.dir = S.x > R.x ? 1 : -1
    R.play(R.set.mop, 900, 5)
    const a = R.x + R.dir * 8
    const b = R.x + R.dir * 64
    d.puddle = { x0: Math.min(a, b), x1: Math.max(a, b), until: now + 9000 }
    S.ai.st = 'charge'
    S.ai.t = now + 1500 + (Math.abs(S.x - R.x) / CHARGE) * 1000
    S.pose = 'stand'
    S.dir = -R.dir
    S.goto(clamp(R.x + R.dir * 14, 6, s.W - 7), CHARGE)
    d.act.userUntil = Math.max(d.act.userUntil, now + 1500)
    showLine(s, S.key, pick(TRAP.S), now, false)
    return true
  }
  function killRoger(s) {
    const d = s.data
    if (!d.act || d.act.dying) return zapRoger(s)
    d.act.dying = true
    for (const b of d.bolts) b.dead = true
    zapRoger(s)
    d.line = null
    const [l1, l2] = pick(RAID_DEATHS)
    d.run = {
      steps: [['wait', 1300], ['box', [l1, l2], 4000], ['box', [T1, T2, '#restore'], 4400], ['fx', restoreRaid]],
      ip: 0,
      cur: 0,
      then: (s2) => {
        s2.data.run = null
        if (s2.data.act) s2.data.act.dying = false
      },
    }
  }
  function restoreRaid(s, d, now) {
    const R = d.cast.R
    R.stop()
    R.pose = 'stand'
    R.x = d.act.safe[0]
    for (const k of d.act.keys) {
      const S = d.cast[k]
      if (!S) continue
      S.stop()
      S.pose = 'stand'
      S.x = k === 'A1' ? s.W + 16 : -16
      S.dir = k === 'A1' ? -1 : 1
      S.ai = { st: 'enter', t: now + (k === 'A1' ? 1200 : 2700), fireAt: now + 3500 }
    }
    d.act.deathAt = now + rand(40000, 70000)
    d.flashUntil = now + 180
  }
  function actionTick(s, dt, now) {
    const d = s.data
    const A = d.act
    const R = d.cast.R
    if (now > A.trailAt) {
      if (R.pose !== 'ash') A.safe.push(R.x)
      if (A.safe.length > 4) A.safe.shift()
      A.trailAt = now + 1000
    }
    d.bolts = d.bolts.filter((b) => !b.dead)
    const sars = A.keys.map((k) => d.cast[k]).filter(Boolean)
    if (d.puddle && d.puddle.until && now > d.puddle.until) d.puddle = null
    for (const S of sars) {
      if (!S.down && d.puddle && S.tx !== null && S.x >= d.puddle.x0 && S.x <= d.puddle.x1) {
        slip(s, S)
        S.ai.st = 'down'
        S.ai.t = now + 3200
        points(s, 2)
        if (Math.random() < 0.5) showLine(s, null, pick(TRAP.N), now, false)
      }
    }
    for (const S of sars) sarienAI(s, S, now)
    rogerAI(s, now, sars)
    if (now > A.talkAt && (!d.line || now > d.line.until)) {
      A.who = (A.who + 1) % 3
      const S = pick(sars)
      if (A.who === 0 && S) showLine(s, S.key, pick(RAID.S), now, false)
      else if (A.who === 1) showLine(s, 'R', pick(RAID.R), now, false)
      else showLine(s, null, pick(RAID.N), now, false)
      A.talkAt = now + rand(6000, 9000)
    }
    return FAST // the raid is the busy show: keep it at full rate
  }
  // done during the raid: the mop finally pays off, then on to the next scene
  function finishRaid(s) {
    const d = s.data
    const R = d.cast.R
    for (const b of d.bolts) b.dead = true
    const sars = d.act.keys.filter((k) => d.cast[k])
    d.puddle = null
    for (const k of sars) {
      const S = d.cast[k]
      S.stop()
      S.down = false
      S.yOff = 0
      if (S.ai.st === 'enter') S.x = k === 'A1' ? s.W - 10 : 10
      S.pose = 'stand'
      S.ai.st = 'frozen'
    }
    R.stop()
    R.pose = 'stand'
    if (d.act.dying) R.x = d.act.safe[0]
    d.act.dying = true
    d.line = null
    d.box = null
    resetRunner(d)
    let near = sars[0]
    for (const k of sars) if (Math.abs(d.cast[k].x - R.x) < Math.abs(d.cast[near].x - R.x)) near = k
    const steps = [['say', 'R', 'Hold it! Wet floor! Let me just...'], ['mop', 'R', 1400, true]]
    if (near) steps.push(['face', 'R', near], ['say', near, 'Got you now, janitor!'])
    for (const k of sars) steps.push(['charge', k])
    steps.push(['pts', 15], ['n', 'The Sariens slip on your freshly mopped'], ['n', 'floor. Janitorial science prevails.'])
    if (near) steps.push(['say', near, 'Ow. My dignity.'])
    steps.push(['wait', 600])
    d.run = { steps, ip: 0, cur: 0, then: (s2) => {
      endAction(s2)
      nextScene(s2)
    } }
    d.awarded = new Set()
  }
  // done outside the raid: a quick puzzle-solved beat, then the story resumes
  function storyBeat(s) {
    const d = s.data
    const now = performance.now()
    points(s, 5)
    if (!d.run || d.box) return
    const prev = d.run
    if (d.waitUntil > now) {
      prev.ip = prev.cur
      d.waitUntil = 0
    }
    d.run = { steps: [['wait', 2400], ['n', pick(QUIPS)]], ip: 0, cur: 0, ret: prev }
  }

  // ---- clicks, asides and the parser line --------------------------------------------
  function nextLine(d, key, list) {
    d.talkIx[key] = ((d.talkIx[key] ?? -1) + 1) % list.length
    return list[d.talkIx[key]]
  }
  function aside(s, who, text) {
    const d = s.data
    const now = performance.now()
    if (Array.isArray(text)) text = pick(text)
    const top = d.box || (d.status && now < d.status.until) || (d.line && now < d.line.until && !d.line.aside)
    if (top) {
      // the plot is talking: the aside floats just under it and the plot carries on
      const x = who ? speakerX(s, who) : s.W / 2
      s.say(text, x, 11, { color: who ? SAY_COL[who] || SARIEN_COL : '#ffffff', life: dur(text) / 1000 })
      return
    }
    showLine(s, who, text, now, false)
    d.line.aside = true
    // a short pause so the line can be read, at most once every 10 s: never a stall
    if (d.mode === 'story' && d.run && now > (d.asideOkAt || 0)) {
      if (d.waitUntil > now) {
        d.run.ip = d.run.cur
        d.waitUntil = 0
      }
      d.asideUntil = d.line.until
      d.asideOkAt = now + 10000
    }
    s.poke()
  }
  function canWalk(s) {
    const d = s.data
    const R = d.cast.R
    if (R.hidden || R.boarded || R.fly || R.fall || R.anim || R.yOff !== 0 || R.pose === 'ash') return false
    if (d.mode === 'action') return !d.run
    return !d.locked && !d.box && !d.resting
  }
  function userWalk(s, x, then) {
    const d = s.data
    const R = d.cast.R
    if (!canWalk(s)) return false
    if (d.pending && d.pendWho === 'R') {
      d.run.ip = d.run.cur
      d.pending = null
    }
    if (R.pose === 'doze' || R.pose === 'hide' || R.pose === 'reach') R.pose = 'stand'
    R.goto(clamp(x, 6, s.W - 7), d.mode === 'action' ? RUN : WALK)
    R.spotKey = null
    if (d.mode === 'story') d.hold = { then }
    else d.act.userUntil = performance.now() + 5000
    return true
  }
  function canGrab(s) {
    const d = s.data
    const R = d.cast.R
    if (!R || R.hidden || R.boarded || R.fly || R.fall || R.held || R.pose === 'ash' || d.resting) return false
    if (d.mode === 'action') return !d.run
    return !d.locked && !d.box
  }
  function charClick(s, ch, p) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    if (ch.type === 'roger') {
      d.rogerClicks = (d.rogerClicks || []).filter((t) => now - t < 2500)
      d.rogerClicks.push(now)
      if (ch.pose === 'doze') return aside(s, 'R', nextLine(d, 'doze', DOZE_TALK))
      if (d.rogerClicks.length >= 5 && !ch.moving && !ch.anim && canGrab(s)) {
        // easter egg: poke him enough and he breaks into the secret janitor dance
        d.rogerClicks.length = 0
        if (ch.pose !== 'stand' && ch.pose !== 'hide') return
        ch.pose = 'stand'
        ch.play([ch.set.walk[0], ch.set.cheer, ch.set.walk[2], ch.set.cheer, ch.set.reach, ch.set.cheer], 2200, 6)
        for (let i = 0; i < 3; i++) s.particle({ img: BUBBLE['♪'], x: ch.x - 6 + i * 6, y: FLOOR - 28, vx: (i - 1) * 6, vy: -8, life: 1.6, fade: true })
        return aside(s, null, pick(DANCE))
      }
      if (d.mode === 'action' && d.act && !d.act.dying && !d.run && !ch.held && !ch.fall && ch.pose !== 'ash') {
        // in the raid a click on Roger ducks him (just in time, if you watched the aim)
        ch.tx = null
        ch.cb = null
        ch.anim = null
        ch.pose = 'hide'
        d.act.upAt = now + 1600
        d.act.userUntil = now + 3000
        return
      }
      return aside(s, 'R', nextLine(d, 'roger', [...TALK.roger, ...(SET_TALK[d.set] || [])]))
    }
    if (ch.type === 'crew' && ch.pose === 'dead') {
      d.crewPokes = (d.crewPokes || 0) + 1
      if (d.crewPokes % 3 === 0) return aside(s, null, "A note on him: 'Roger owes me 5 buckazoids.'")
      return aside(s, null, "He's still dead. You're very thorough.")
    }
    if (ch.type === 'sarien' && d.mode === 'action' && ch.ai && mopTrap(s, ch)) return
    if (ch.down) return aside(s, ch.key, 'Ow. The floor is SO clean.')
    if (ch.type === 'bartender') {
      // a drink slides down the counter toward Roger
      const R = d.cast.R
      const dir = R && R.x < ch.x ? -1 : 1
      s.particle({ img: pix('Y'), x: ch.x, y: FLOOR - 13, vx: dir * 45, life: 0.9 })
      s.particle({ img: pix('w'), x: ch.x, y: FLOOR - 14, vx: dir * 45, life: 0.9 })
    }
    if ((ch.type === 'guy1' || ch.type === 'guy2') && !ch.moving) {
      ch.fid = 'sip'
      ch.fidEnd = now + 1400
    }
    if (ch.type === 'sarien') s.particle({ img: BUBBLE['!'], x: ch.x - 2, y: Math.max(0, FLOOR - 33), life: 1, vy: -3, fade: true })
    aside(s, ch.key, nextLine(d, ch.type, TALK[ch.type]))
  }
  function propClick(s, p) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    switch (p.kind) {
      case 'slot':
        if (!p.spin && !d.locked) {
          p.spin = { until: now + 1300, result: Math.random() < 0.35 ? 'win' : 'skull', user: true }
          p.show = null
          return
        }
        break
      case 'acid':
        s.burst(p.x - 1, FLOOR - 3, 8, ['G', 'g', 'w'])
        break
      case 'console':
      case 'crate':
        p.fxUntil = now + (p.kind === 'crate' ? 400 : 1200)
        break
      case 'gen':
        s.burst(p.x, FLOOR - 14, 8, ['m', 'p', 'w'])
        d.shakeUntil = now + 250
        break
      case 'hamper':
        s.particle({ img: SOCK, x: p.x, y: FLOOR - 12, vx: rand(-25, 25), vy: -55, g: 150, life: 1.3 })
        break
      case 'pod':
        s.burst(p.x - 13, FLOOR - 6, 6, ['y', 'r', 'O'])
        break
      case 'ship':
        s.burst(p.x + rand(-12, 12), FLOOR - 17, 6, ['r', 'y', 'O'])
        break
    }
    aside(s, null, PROP_SAY[p.kind])
  }
  function fixAt(s, p) {
    for (const f of s.fix) if (FIX[f.kind] && p.x >= f.x - 1 && p.x <= f.x + f.w + 1 && p.y >= f.y - 1 && p.y <= f.y + f.h + 1) return f
    return null
  }
  function hoverVerb(s) {
    const c = s.cursor
    if (!c || c.y < 0 || c.y > H || c.x < 0 || c.x > s.W) return null
    for (let i = s.actors.length - 1; i >= 0; i--) {
      const a = s.actors[i]
      if (!a.dead && a.verb && a.hit(c.x, c.y)) return a.verb()
    }
    for (const f of s.dots) if (c.x >= f.x - 2 && c.x <= f.x + f.w + 2 && c.y >= f.y - 2 && c.y <= f.y + f.h + 2) return 'push button'
    const f = fixAt(s, c)
    return f ? FIX[f.kind][0] : 'walk here'
  }

  // ---- the keyboard: A/D walk Roger, W uses or talks to whatever's nearest, S mops
  // (ducks in the raid), Space skips the current line (mop trap in the raid) ----------
  function keyTick(s, now) {
    const d = s.data
    const R = d.cast.R
    const kx = keyDir(s)
    const raid = d.mode === 'action'
    if (raid && d.act && s.keys?.has('down') && canWalk(s)) {
      // S held: he stays down
      R.tx = null
      R.pose = 'hide'
      d.act.upAt = now + 300
      d.act.userUntil = now + 3000
      d.keyWalk = false
      return
    }
    if (kx && canWalk(s)) {
      if (!raid && d.pending && d.pendWho === 'R') {
        d.run.ip = d.run.cur
        d.pending = null
      }
      if (['doze', 'hide', 'reach'].includes(R.pose)) R.pose = 'stand'
      const tx = clamp(R.x + kx * 16, 6, s.W - 7)
      if (Math.abs(tx - R.x) > 0.5) R.goto(tx, raid ? SNEAK + 14 : WALK)
      else {
        R.tx = null
        R.dir = kx
      }
      R.spotKey = null
      d.keyWalk = !raid
      if (raid && d.act) d.act.userUntil = now + 3000
    } else if (d.keyWalk || (kx === 0 && d.keyWalked)) {
      // released: he stops where he is and the plot picks up from there
      if (R.tx !== null && !R.cb) R.tx = null
      d.keyWalk = false
    }
    d.keyWalked = !!kx
  }
  function nearestThing(s) {
    const d = s.data
    const R = d.cast.R
    let best = null
    let bd = 40
    for (const k in d.cast) {
      const c = d.cast[k]
      if (c === R || c.hidden) continue
      const dd = Math.abs(c.x - R.x)
      if (dd < bd) {
        bd = dd
        best = c
      }
    }
    for (const p of d.props) {
      if (p.hidden || p.dead) continue
      const dd = Math.abs(p.x - R.x) - 4
      if (dd < bd) {
        bd = dd
        best = p
      }
    }
    return best
  }
  function onKey(s, key, down) {
    const d = s.data
    if (!down || !d.started) return
    const now = performance.now()
    const R = d.cast.R
    if (d.resting) leaveRest(s)
    if (d.mode === 'action') {
      if (!d.act || d.act.dying || d.run) return
      if (key === 'fire') {
        // the mop trap, at the nearest Sarien
        let best = null
        for (const k of d.act.keys) {
          const S = d.cast[k]
          if (S && !S.down && S.x > 4 && S.x < s.W - 4 && (!best || Math.abs(S.x - R.x) < Math.abs(best.x - R.x))) best = S
        }
        if (!best || !mopTrap(s, best)) s.say('*squeak*', R.x, 11, { color: SAY_COL.R, life: 1 })
      } else if (key === 'up' && R.pose !== 'ash') showLine(s, 'R', pick(RAID.R), now, false)
      else if (key === 'down' && R.pose !== 'ash' && canWalk(s)) {
        R.tx = null
        R.pose = 'hide'
        d.act.upAt = now + 1600
      }
      return
    }
    if (key === 'fire') {
      // skip the line being said (Sierra's Enter)
      if (d.box && now < d.box.until) {
        d.box.until = now
        d.waitUntil = Math.min(d.waitUntil, now)
        return
      }
      if (d.line && now < d.line.until) {
        d.line.until = now
        if (d.waitUntil > now) d.waitUntil = now
        if (d.asideUntil > now) d.asideUntil = now
        return
      }
      key = 'up' // nothing to skip: use whatever's nearest
    }
    if (key === 'up') {
      const t = nearestThing(s)
      if (t && t.kind) return propClick(s, t)
      if (t) {
        if (R.tx === null && !R.anim) R.dir = t.x > R.x ? 1 : -1
        return charClick(s, t)
      }
      return aside(s, 'R', nextLine(d, 'roger', [...TALK.roger, ...(SET_TALK[d.set] || [])]))
    }
    if (key === 'down' && canWalk(s) && R.tx === null && R.pose !== 'doze') {
      R.pose = 'stand'
      R.play(R.set.mop, 1000, 5)
    }
  }

  // ---- concept hooks ---------------------------------------------------------------
  function setup(s) {
    const d = s.data
    d.W = s.W
    d.cast = {}
    d.props = []
    d.bolts = []
    d.flags = {}
    d.snaps = {}
    d.talkIx = {}
    d.score = 0
    d.ep = 0
    d.played = 0
    d.mode = 'story'
    d.shakeUntil = 0
    d.flashUntil = 0
    d.clickAt = -1e9
    d.grabAt = -1e9
    d.chicken = null
    d.chickenAt = 0
    zones(s)
    makeStars(s)
    const R = new Char(s, 'R', 'roger', 0, 1)
    R.fidPoses = ['blink', 'blink', 'tap']
    d.cast.R = R
    s.actors.push(R)
    startScene(s, 0)
    d.started = true
  }
  function update(s, dt, now) {
    const d = s.data
    if (!d.started) return Infinity
    if (!s.lively(now)) {
      if (!d.resting) enterRest(s, now)
      restTick(s)
      return Infinity
    }
    if (d.resting) leaveRest(s)
    keyTick(s, now)
    let wait = d.mode === 'action' && !d.run ? actionTick(s, dt, now) : runTick(s, now)
    if (s.keys?.size) wait = FAST
    const R = d.cast.R
    const c = s.cursor
    if (c && c.y >= 0 && c.y <= H && now > (d.glanceAt || 0)) {
      // the cast glance at the cursor now and then (the raiders keep their eyes on Roger)
      let turned = false
      for (const k in d.cast) {
        const ch = d.cast[k]
        if (ch.hidden || ch.moving || ch.anim || ch.down || (ch.type === 'sarien' && d.mode === 'action')) continue
        if (ch.pose !== 'stand' || ch.type === 'crew' || Math.abs(c.x - ch.x) <= 14) continue
        if (ch !== R && !engaged(s, now)) continue
        const want = c.x > ch.x ? 1 : -1
        if (want !== ch.dir) {
          ch.dir = want
          turned = true
        }
      }
      if (turned) d.glanceAt = now + 1500
      // hover right over Roger and he notices you
      if (Math.abs(c.x - R.x) < 9 && c.y > FLOOR - 28 && !R.hidden && !R.held && now > (d.noticeAt || 0) && engaged(s, now)) {
        d.noticeAt = now + 8000
        s.particle({ img: BUBBLE['?'], x: R.x - 2, y: Math.max(0, FLOOR - 35 + R.yOff), life: 1.1, vy: -3, fade: true })
      }
    }
    if (d.chickenAt && now >= d.chickenAt) {
      d.chickenAt = 0
      if (!d.chicken) d.chicken = s.spawn(new Chicken(s))
    } else if (d.chickenAt) wait = Math.min(wait, d.chickenAt - now)
    for (const t of [d.line?.until, d.status?.until, d.box?.until, d.flashUntil, d.beam?.until]) if (t && t > now) wait = Math.min(wait, t - now)
    if (d.shakeUntil > now) wait = FAST
    if (d.box && d.box.lines[2] === '#restore' && now < d.box.t0 + 1500) wait = Math.min(wait, d.box.t0 + 1500 - now)
    if (!s.busy) wait = Math.min(wait, Math.max(50, s.lastTouch + REST_AFTER + 20 - now))
    return wait
  }

  // ---- drawing -------------------------------------------------------------------------
  const SET_COL = { arcada: ['d', 'b', 'C'], deltaur: ['r', 'r', 'R'], bar: ['n', 'n', 'Y'], desert: ['n', null, null] }
  function drawBehind(s, c) {
    const d = s.data
    const now = performance.now()
    c.save()
    if (d.shakeUntil > now) c.translate(Math.round(rand(-1.4, 1.4)), 0)
    if (d.set === 'space') {
      const t = s.fixture('title')
      if (d.starKey !== `${s.W}:${t.x}:${t.w}`) makeStars(s)
      for (const [x, y, k] of d.stars || []) fr(c, k, x, y, 1, 1)
    } else {
      const [floor, seam, light] = SET_COL[d.set] || SET_COL.arcada
      fr(c, floor, 0, FLOOR - 1, s.W, 1)
      const Z = zones(s)
      for (const z of [Z.L, Z.R]) {
        if (d.set === 'desert') {
          for (let x = z.a + 4, i = 0; x < z.b - 10; x += 19 + ((i * 13) % 17), i++) {
            const w = 6 + ((i * 7) % 9)
            fr(c, 'n', x, FLOOR - 2, w, 1)
            if (i % 2) fr(c, 'Y', x + 2, FLOOR - 3, w - 4, 1)
          }
          continue
        }
        c.globalAlpha = 0.45
        for (let x = z.a + 4; x < z.b - 2; x += 26) {
          fr(c, seam, x, FLOOR - 22, 1, 20)
          fr(c, light, x + 9, FLOOR - 22, 2, 1)
        }
        c.globalAlpha = 1
      }
    }
    if (d.puddle) {
      fr(c, 'c', d.puddle.x0, FLOOR - 1, d.puddle.x1 - d.puddle.x0, 1)
      for (let x = d.puddle.x0 + 3; x < d.puddle.x1; x += 7) fr(c, 'C', x, FLOOR - 1, 2, 1)
    }
    if (d.beam && d.beam.until > now) {
      const x0 = Math.min(d.beam.x0, d.beam.x1)
      c.fillStyle = d.beam.color
      c.fillRect(Math.round(x0), d.beam.y, Math.round(Math.abs(d.beam.x1 - d.beam.x0)), 1)
      c.fillStyle = '#ffffff'
      c.fillRect(Math.round(x0), d.beam.y + 1, Math.round(Math.abs(d.beam.x1 - d.beam.x0)), 1)
    }
  }
  function txt(c, str, x, y, color, stroke) {
    if (stroke) {
      c.lineWidth = 2
      c.strokeStyle = stroke
      c.strokeText(str, x, y)
    }
    c.fillStyle = color
    c.fillText(str, x, y)
  }
  function speakerX(s, who) {
    const d = s.data
    const ch = d.cast[who]
    if (!ch) return s.W / 2
    if (ch.boarded) return findProp(d, 'pod')?.x ?? ch.x
    return ch.x
  }
  function drawBox(c, s, lines, t0, now) {
    const lh = 8
    let w = 0
    for (const l of lines) w = Math.max(w, c.measureText(l === '#restore' ? 'Restore   Restart   Quit' : l).width)
    w = Math.ceil(w) + 12
    const h = lines.length * lh + 6
    const x = Math.round(s.W / 2 - w / 2)
    const y = Math.max(0, Math.round((H - h) / 2) - 3)
    fr(c, 'w', x, y, w, h)
    fr(c, 'r', x + 1, y + 1, w - 2, 1)
    fr(c, 'r', x + 1, y + h - 2, w - 2, 1)
    fr(c, 'r', x + 1, y + 1, 1, h - 2)
    fr(c, 'r', x + w - 2, y + 1, 1, h - 2)
    lines.forEach((l, i) => {
      const ty = y + 3 + i * lh
      if (l !== '#restore') return txt(c, l, x + 6, ty, '#000000')
      const parts = ['Restore', 'Restart', 'Quit']
      const gap = c.measureText('   ').width
      let tx = Math.round(s.W / 2 - c.measureText('Restore   Restart   Quit').width / 2)
      parts.forEach((p, j) => {
        const pw = c.measureText(p).width
        const on = j === 0 && now > t0 + 1500
        if (on) fr(c, 'k', tx - 1, ty - 1, Math.ceil(pw) + 2, lh)
        txt(c, p, tx, ty, on ? '#ffffff' : '#000000')
        tx += pw + gap
      })
    })
  }
  function drawFront(s, c) {
    c.restore()
    const d = s.data
    const now = performance.now()
    if (d.flashUntil > now) {
      c.fillStyle = 'rgba(255,255,255,.55)'
      c.fillRect(0, 0, s.W, H)
    }
    c.font = FONT
    c.textBaseline = 'top'
    if (d.box && now < d.box.until) return drawBox(c, s, d.box.lines, d.box.t0, now)
    if (d.status && now < d.status.until) {
      fr(c, 'w', 0, 0, s.W, 9)
      txt(c, `Score: ${d.score} of 202`, 3, 1, '#000000')
      const sw = c.measureText('Sound: on').width
      txt(c, 'Sound: on', Math.round(s.W - sw - 3), 1, '#000000')
      const add = `+${d.status.add} point${d.status.add === 1 ? '' : 's'}`
      txt(c, add, Math.round(s.W / 2 - c.measureText(add).width / 2), 1, '#aa0000')
      return
    }
    const ln = d.line
    if (ln && now < ln.until) {
      const w = Math.ceil(c.measureText(ln.text).width)
      if (ln.who === null && !ln.sfx) {
        const bw = w + 8
        const x = Math.round(clamp(s.W / 2 - bw / 2, 1, s.W - bw - 1))
        if (BOXED) {
          fr(c, 'w', x, 0, bw, 10)
          fr(c, 'r', x, 0, bw, 1)
          fr(c, 'r', x, 9, bw, 1)
          fr(c, 'r', x, 0, 1, 10)
          fr(c, 'r', x + bw - 1, 0, 1, 10)
          txt(c, ln.text, x + 4, 2, '#000000')
        } else txt(c, ln.text, x + 4, 0, '#ffffff', 'rgba(0,0,0,.9)')
        return
      }
      const cx = ln.sfx ? s.W / 2 : speakerX(s, ln.who)
      const x = Math.round(clamp(cx - w / 2, 1, s.W - w - 1))
      const col = ln.sfx ? '#ffff55' : SAY_COL[ln.who] || SARIEN_COL
      txt(c, ln.text, x, 1, col, 'rgba(0,0,0,.92)')
      return
    }
    const v = hoverVerb(s)
    if (v) {
      const str = `>${v}_`
      const w = Math.ceil(c.measureText(str).width)
      const x = Math.round(clamp(s.cursor.x - 6, 1, s.W - w - 3))
      c.fillStyle = 'rgba(0,0,0,.88)'
      c.fillRect(x - 2, 0, w + 4, 9)
      txt(c, str, x, 1, '#ffffff')
    }
  }

  registerConcept({
    key: 'spacequest',
    title: 'Space Quest',
    sub: 'Sierra On-Line, 1986',
    blurb:
      'Roger Wilco, janitor, plays out three looping episodes scene by scene: the Arcada and Kerona, the Deltaur, and a bar kidnapping of the Two Guys from Andromeda. A narrator box, a score line and silly deaths that restore a moment earlier; lines and death gags vary on repeat, and Astro Chicken sometimes flaps through from the wrong game. The plot runs by itself: hover for the parser line, click Roger, the cast or the props for a line or a little nudge (spin the slots, poke the console, sock from the hamper, a drink down the bar), pick Roger up by the collar and drop him somewhere else, poke him five times for the secret dance, click the chicken for an egg. While the agent works, Sariens patrol and shoot while Roger ducks and lays mop traps; engaged, Roger tiptoes after your cursor, a click on him ducks (in time for the killing shot, if you watch the aim) and a click on a Sarien mops the floor so he charges and slips. Done ends the raid with a mopped floor and points. When idle he falls asleep on his mop and the story waits.',
    setup,
    update,
    drawBehind,
    drawFront,
    onBusy(s) {
      startAction(s)
    },
    onDone(s) {
      if (s.data.mode === 'action') finishRaid(s)
      else storyBeat(s)
      s.poke()
    },
    onNap(s) {
      const d = s.data
      if (d.mode === 'action') {
        endAction(s)
        d.restartScene = true
      }
    },
    onKey,
    onBonk(s, rect, kind) {
      if (DOT_SAY[kind]) aside(s, null, DOT_SAY[kind])
    },
    onBarClick(s, p) {
      const d = s.data
      if (!d.started) return
      const f = fixAt(s, p)
      if (!f) return userWalk(s, p.x)
      const [, line] = FIX[f.kind]
      const R = d.cast.R
      const tx = f.kind === 'eyes' ? f.x + f.w + 10 : f.x + f.w / 2
      userWalk(s, tx, () => {
        R.dir = f.x + f.w / 2 > R.x ? 1 : f.kind === 'eyes' ? -1 : R.dir
        if (f.kind === 'title') R.play(R.set.mop, 1300, 5, () => {
          aside(s, null, line)
          R.goto(openSpot(s, R.x))
        })
        else aside(s, null, line)
      })
    },
    relayout(s) {
      const d = s.data
      if (!d.started) return
      const k = d.W ? s.W / d.W : 1
      d.W = s.W
      zones(s)
      makeStars(s)
      for (const p of d.props) if (!p.launch && !p.landing && !(p.kind === 'pod' && p.at === '<')) p.x = spot(s, p.at)
      for (const key in d.cast) {
        const c = d.cast[key]
        if (c.tx !== null) c.tx = Math.round(c.tx * k)
        if (c.spotKey && !c.moving && !c.boarded && d.mode === 'story') c.x = spot(s, c.spotKey)
        else c.x = Math.round(c.x * k)
      }
      s.poke()
    },
  })
})()
