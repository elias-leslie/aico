;(() => {
  // Pirate adventure, big: a three-part point-and-click tavern adventure that
  // plays out scene by scene in the titlebar and loops with shuffled scenes
  // and alternate lines. The would-be pirate hero, the three important-looking
  // pirates, a fast-talking ship salesman, the swordmaster, a ghost pirate,
  // the governor and (at last) a three-headed monkey each speak in their own
  // colour; the voodoo priestess is only heard.
  // Busy = a short insult swordfight, done = a win or the scene's punchline,
  // rest = the hero naps and the story waits.

  // ---- pixel painter ---------------------------------------------------------
  const GW = 24
  const GH = 27 // rows 0-2 hats, 3-10 head, 11-18 torso, 19-26 legs
  const grid = () => Array.from({ length: GH }, () => Array(GW).fill('.'))
  const put = (g, x, y, ch) => {
    if (y >= 0 && y < GH && x >= 0 && x < GW && ch && ch !== '.') g[y][x] = ch
  }
  const stamp = (g, x, y, art) => art.forEach((r, j) => [...r].forEach((ch, i) => put(g, x + i, y + j, ch)))
  function line(g, x0, y0, x1, y1, ch, th = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n)
      const y = Math.round(y0 + ((y1 - y0) * i) / n)
      for (let a = 0; a < th; a++) for (let b = 0; b < th; b++) put(g, x + a, y + b, ch)
    }
  }
  const rowsOf = (g) => g.map((r) => r.join(''))

  // ---- palettes ----------------------------------------------------------------
  const BASE = { E: '#1a1210', S: '#f2b48a', s: '#c8805a', w: '#ffffff', M: '#aab2c4', m: '#e4e8f0', h: '#6b4220', y: '#f2d14b' }
  const PG = { ...BASE, Y: '#f4d66b', z: '#c49a3a', T: '#f6f4ee', t: '#aeb3c8', A: '#f6f4ee', a: '#aeb3c8', b: '#6b4220', P: '#2d3557', p: '#1c2240', K: '#8a5426', k: '#4e2e14' }
  const PG_BLUE = { ...PG, S: '#8fb6ff', s: '#5a7fd0' } // holding his breath
  const PP1 = { ...BASE, H: '#202028', T: '#b8322c', t: '#7e1f1c', A: '#b8322c', a: '#7e1f1c', W: '#ece8dc', B: '#2a2224', b: '#3a2410', P: '#5a4030', p: '#3c2a1e', K: '#2a2224', k: '#141016', C: '#b8322c', c: '#7e1f1c' }
  const PP2 = { ...BASE, H: '#3a5fd0', T: '#3c8a3c', t: '#255c25', A: '#ece8dc', a: '#b8b4a6', W: '#ece8dc', B: '#7a4a22', b: '#3a2410', P: '#3a3a4a', p: '#26263a', K: '#5a3317', k: '#341c0c', C: '#3c8a3c', c: '#255c25' }
  const PP3 = { ...BASE, S: '#e8a07a', s: '#b87050', T: '#6a3fa0', t: '#452670', A: '#6a3fa0', a: '#452670', W: '#ece8dc', B: '#d0602a', b: '#2a1a10', P: '#8a8f98', p: '#5e636c', K: '#3a2410', k: '#1e120a', C: '#6a3fa0', c: '#452670' }
  const PST = { ...BASE, H: '#2a2030', T: '#4f62d8', t: '#b9c4ff', A: '#4f62d8', a: '#2c3a96', W: '#f2efe6', r: '#d9473f', b: '#2a2030', P: '#3a3f8a', p: '#262a66', K: '#1e1e26', k: '#0e0e14' }
  const PCA = { ...BASE, S: '#e9b08a', H: '#3a2216', T: '#8a3fa0', t: '#5c2670', A: '#8a3fa0', a: '#5c2670', W: '#ece8dc', b: '#c8a040', P: '#4a3020', p: '#32200f', K: '#1e1416', k: '#0c080a' }
  const PEL = { ...BASE, S: '#f4c0a0', R: '#c0502a', r: '#8a3418', T: '#8a1f3a', t: '#5e1428', A: '#8a1f3a', a: '#5e1428', W: '#f2efe6', D: '#8a1f3a', d: '#5e1428', b: '#e0b040', K: '#2a1a14', k: '#2a1a14' }
  const PLC = {
    E: '#ffffff', e: '#ffffff', S: '#bfffc8', s: '#6ad88a', H: '#0f3a1e', h: '#1d5a32', B: '#17602e', T: '#3ab865', t: '#24834a', A: '#3ab865', a: '#24834a',
    W: '#b8ffc8', b: '#1d5a32', P: '#2a8a50', p: '#1d6a3c', K: '#1d5a32', k: '#123d22', C: '#3ab865', c: '#24834a', y: '#c8ff7a', M: '#9ff0b0', m: '#d8ffe0',
  }

  // ---- heads (profile, facing right; stamped at x=3,y=3) ------------------------
  // e = eye, o = mouth (recoloured per frame)
  const HEAD_GUY = ['....YYYYY...', '..YYYYYYYYY.', '.zYYYYYYYYYY', '.zYYYYSSYYY.', 'zzYYSSSSeSS.', 'z.zYSSSSSSSS', 'z..zSSSSSos.', 'z....SSSSS..']
  const HEAD_P1 = ['....HHHH....', '..HHHHHHHH..', 'HHHHHHHHHHHH', '...HSSSSS...', '...HSSSSeS..', '...HSSSSSSS.', '...BBSSoBB..', '...BBBBBBB..', '....BBBBB...', '.....BBB....']
  const HEAD_P2 = ['............', '....HHHHH...', '..HHHHHHHH..', '.HHHHSSSSS..', 'H.HSSSESeS..', 'H..SSSSSSSS.', '...SSBBBo...', '....SSSSS...']
  const HEAD_P3 = ['............', '....SSSSS...', '...SSSSSSS..', '..ySSSSSeS..', '..SSSSSSSSS.', '...BSSSSo...', '...BBBBBBB..', '....BBBBB...']
  const HEAD_ST = ['.....HHHH...', '...HHHHHHH..', '...HHSSSSSS.', '...HSSSSeSS.', '...HSSSSSSSS', '....SSwwwwS.', '....SSSSSS..', '.....SSSS...']
  const HEAD_CA = ['...HHHHHH...', '..HHHHHHHH..', '.HHHHHSSSS..', 'HHHHSSSSeS..', 'HH.HSSSSSSS.', '.H..SSSSSs..', '.....SSSo...', '.....SSSS...']
  const HEAD_EL = ['...RRRRRR...', '..RRRRRRRRR.', '.RRRRRRSSSS.', '.RRRRSSSSeS.', '.RRRRSSSSSSS', 'RRRRrSSSSS..', 'RRRR..SSSo..', 'RRRr...SSS..']
  const HEAD_LC = ['....HHHHH...', '.yHHHHHHHHH.', 'HHHHHHHHHHHH', '..hhSSSSS...', '..hSSSSSeS..', '..hSSSSSSSS.', '..BBBSSoBB..', '..BBBBBBBBB.', '...BBBBBBBB.', '....BBBBBB..', '.....BBBB...']

  // ---- torsos (stamped at x=3,y=11) ---------------------------------------------
  const TOR_PUFFY = ['.....sSS...', '...TTTTTTT.', '..TTTTTTTTT', '..TTTtTTTTT', '..TTTtTTTTt', '...TTtTTTT.', '...TTTTTTT.', '...bbbbbbb.']
  const TOR_COAT = ['.....sSS...', '...TTWWTT..', '..TTTWWTTT.', '..TTTWWTTTT', '..TTtWWTTTT', '..TTtWWTTT.', '..TTTWWTTT.', '..TbbbbbbT.']
  const TOR_FAT = ['.....sSS....', '...TTWWWTT..', '..TTTTWWTTT.', '..TTTTWWTTTT', '..TTtTWWTTTT', '..TTtTWWTTTT', '..TTTTWWTTT.', '..TbbbbbbbT.']
  const TOR_JACKET = ['.....sSS...', '...TTWWTT..', '..TTTWrTTT.', '..TTTWrTTTT', '..TTTTrTTTT', '..TTTTTTTT.', '..TTTTTTTT.', '..TTTTTTTT.']
  const TOR_TUNIC = ['.....sSS...', '...TTTTTT..', '..TTTTTTTT.', '..TTTtTTTT.', '..TTTtTTT..', '...TTtTTT..', '...TTTTTT..', '...bbbbbb..']
  const TOR_DRESS = ['.....sSS...', '...TWWWTT..', '...TTWTTTT.', '...TTTTTTT.', '...TTtTTT..', '....TtTTT..', '....TTTT...', '...bbbbbb..']
  const TOR_LC = ['....BBBB....', '..TTBBBBTT..', '.TTTTWWTTTT.', '.TTTTWWTTTTT', '.TTtTWWTTTTT', '.TTtTWWTTTT.', '.TTTTWWTTTT.', '.TbbbbybbbT.']

  // ---- legs ----------------------------------------------------------------------
  // [footDx, liftRows] for back and front leg, relative to hip centre col 9
  const STAND_LEGS = [[-1, 0], [1, 0]]
  const WALK_LEGS = [
    [[-5, 0], [4, 0], 0],
    [[-3, 0], [2, 0], 1],
    [[-1, 2], [0, 0], 0],
    [[4, 0], [-5, 0], 0],
    [[2, 0], [-3, 0], 1],
    [[0, 0], [-1, 2], 0],
  ]
  function legs(g, [[bx, bl], [fx, fl]], back = 'p', front = 'P') {
    const leg = (hx, dx, l, ch, boot, sole) => {
      const fxp = 9 + dx
      const ky = 22 - (l ? 1 : 0)
      const kx = Math.round((hx + fxp) / 2) + (l ? 2 : 0)
      line(g, hx, 19, kx, ky, ch, 2)
      line(g, kx, ky, fxp, 24 - l, ch, 2)
      put(g, fxp, 25 - l, boot)
      put(g, fxp + 1, 25 - l, boot)
      put(g, fxp, 26 - l, sole)
      put(g, fxp + 1, 26 - l, sole)
      put(g, fxp + 2, 26 - l, sole)
    }
    leg(8, bx, bl, back, 'k', 'k')
    leg(9, fx, fl, front, 'K', 'k')
  }

  // ---- arms ------------------------------------------------------------------------
  // hand positions (grid coords) for the front arm; shoulder at (8,13)
  const ARM = { down: [8, 17], swing0: [6, 17], swing1: [10, 17], talk: [13, 15], up: [9, 1], out: [14, 12], hold: [12, 16], hi: [13, 14], lo: [13, 16], chin: [12, 10], back: [5, 16] }
  function arm(g, pose, puffy) {
    const [hx, hy] = ARM[pose]
    const sx = 8
    const sy = 13
    const ex = Math.round((sx + hx) / 2)
    const ey = Math.round((sy + hy) / 2)
    line(g, sx, sy, ex, ey, 'a', puffy ? 3 : 2)
    line(g, sx, sy, ex, ey, 'A', puffy ? 2 : 1)
    line(g, ex, ey, hx, hy, 'a', 2)
    line(g, ex, ey, hx, hy, 'A', 1)
    put(g, hx, hy, 'S')
    put(g, hx + (hx >= sx ? 1 : 0), hy, 'S')
  }
  // a two-segment limb (shoulder → elbow → hand) with a sleeve edge
  function limb(g, sx, sy, ex, ey, hx, hy, puffy) {
    line(g, sx, sy, ex, ey, 'a', puffy ? 3 : 2)
    line(g, sx, sy, ex, ey, 'A', puffy ? 2 : 1)
    line(g, ex, ey, hx, hy, 'a', 2)
    line(g, ex, ey, hx, hy, 'A', 1)
    put(g, hx, hy, 'S')
    put(g, hx + 1, hy, 'S')
    put(g, hx, hy + 1, 'S')
  }
  // raised-arm poses: the back arm goes behind the head, the front arm in front
  const RAISE = {
    // both hands gripping one point above the head, elbows out: hanging from a rope
    hang: { back: [7, 13, 3, 7, 8, 0], front: [9, 13, 15, 7, 11, 0] },
    // arms flung up and out in a V: the salesman selling
    wave: { back: [7, 13, 3, 9, 1, 4], front: [9, 13, 15, 9, 17, 4] },
    // arms out wide, palms up
    wave2: { back: [7, 13, 3, 13, 0, 11], front: [9, 13, 14, 13, 18, 10] },
  }
  function sword(g, pose) {
    const [hx, hy] = ARM[pose]
    put(g, hx + 1, hy, 'h')
    put(g, hx + 2, hy - 1, 'y')
    put(g, hx + 2, hy + 1, 'y')
    if (pose === 'hi') line(g, hx + 3, hy - 1, hx + 9, hy - 6, 'm')
    else line(g, hx + 3, hy, hx + 10, hy + 1, 'm')
  }

  // ---- figure builder ---------------------------------------------------------------
  /**
   * def: { head, headY, torso, tw, legs:true|'skirt'|'tails'|'ghost', puffy, shade }
   * o:   { legs, bob, arm, talk, blink, sword, hairBack }
   */
  function figure(def, o = {}) {
    const g = grid()
    if (def.under) def.under(g, o)
    if (def.legs === 'skirt') skirt(g, o.frame ?? -1)
    else legs(g, o.legs || STAND_LEGS)
    const raise = RAISE[o.arm]
    // back arm, behind the body (or raised behind the head)
    if (raise) limb(g, ...raise.back, def.puffy)
    else {
      line(g, 7, 13, 6, 17, 'a', 2)
      put(g, 6, 18, 's')
    }
    stamp(g, def.tx ?? 3, 11, def.torso)
    if (def.tails) stamp(g, 3, 19, def.tails)
    let head = def.head
    head = head.map((r) => r.replace('e', o.blink ? (def.eyeShut || 'S') : 'E').replace('o', o.talk ? 'E' : def.mouth || 'S'))
    stamp(g, 3, def.headY ?? 3, head)
    if (def.after) def.after(g, o)
    if (raise) limb(g, ...raise.front, def.puffy)
    else arm(g, o.arm || 'down', def.puffy)
    if (o.sword) sword(g, o.arm)
    return rowsOf(g)
  }
  function skirt(g, f) {
    const hem = f < 0 ? 0 : f % 2 ? 1 : -1
    for (let y = 17; y <= 25; y++) {
      const k = Math.floor((y - 17) * 0.6)
      const x0 = 6 - k + (y > 22 ? hem : 0)
      const x1 = 12 + k + (y > 22 ? hem : 0)
      for (let x = x0; x <= x1; x++) put(g, x, y, x === x0 + 2 || (x === x0 + 5 && y > 20) ? 'd' : 'D')
    }
    const fx = f < 0 ? 9 : f % 2 ? 11 : 7
    put(g, fx, 26, 'K')
    put(g, fx + 1, 26, 'K')
  }
  // the salesman's checked jacket: 2×2 checks over T
  const checks = (g) => {
    for (let y = 12; y < 19; y++) for (let x = 0; x < GW; x++) if (g[y][x] === 'T' && ((x >> 1) + (y >> 1)) % 2) g[y][x] = 't'
  }

  const DEFS = {
    G: { head: HEAD_GUY, torso: TOR_PUFFY, puffy: true, after: (g) => { put(g, 4, 11, 'z'); put(g, 4, 12, 'z'); put(g, 3, 11, 'z') } },
    P1: { head: HEAD_P1, headY: 0, torso: TOR_COAT, tails: ['.cc......C', '.cc......C', '.c.........'], mouth: 'B' },
    P2: { head: HEAD_P2, torso: TOR_COAT, tails: ['.cc.......', '.c........'], mouth: 'B' },
    P3: { head: HEAD_P3, torso: TOR_FAT, tails: ['.ccc.....CC', '.cc......C.', '.c.........'], mouth: 'B' },
    ST: { head: HEAD_ST, torso: TOR_JACKET, after: checks, tails: ['..TT....TT', '..t......t'] },
    CA: { head: HEAD_CA, torso: TOR_TUNIC, after: (g) => { put(g, 3, 9, 'H'); put(g, 3, 10, 'H'); put(g, 2, 10, 'H') } },
    EL: { head: HEAD_EL, torso: TOR_DRESS, legs: 'skirt', after: (g) => { for (let y = 11; y < 16; y++) { put(g, 3, y, 'R'); put(g, 4, y, 'r') } } },
    LC: { head: HEAD_LC, headY: 0, torso: TOR_LC, tx: 2, tails: ['.cc......CC', '.cc......CC', '.c.......C.'], mouth: 'B' },
  }
  const PALS = { G: PG, P1: PP1, P2: PP2, P3: PP3, ST: PST, CA: PCA, EL: PEL, LC: PLC }

  const GLOW = 'rgba(90,255,130,.55)'
  function mk(rows, pal, ghost) {
    const base = sprite(rows, pal)
    const c = ghost ? outline(outline(base, GLOW), 'rgba(90,255,130,.22)') : outline(base)
    const off = ghost ? 2 : 1
    return { 1: c, '-1': mirror(c), w: c.width, h: c.height, off }
  }
  function buildSet(key) {
    const def = DEFS[key]
    const pal = PALS[key]
    const ghost = key === 'LC'
    const f = (o, p = pal) => mk(figure(def, o), p, ghost)
    const set = {
      stand: f({}),
      blink: f({ blink: true }),
      talk: f({ talk: true, arm: 'talk' }),
      walk: WALK_LEGS.map(([b, fr, bob], i) => Object.assign(f({ legs: [b, fr], arm: i < 3 ? 'swing0' : 'swing1', frame: i }), { bob })),
      hi: f({ arm: 'hi', sword: true, legs: [[-4, 0], [3, 0]] }),
      lo: f({ arm: 'lo', sword: true, legs: [[-4, 0], [4, 0]] }),
      hiTalk: f({ arm: 'hi', sword: true, talk: true, legs: [[-4, 0], [3, 0]] }),
      out: f({ arm: 'out', talk: true }),
      hold: f({ arm: 'hold' }),
      holdTalk: f({ arm: 'hold', talk: true }),
      chin: f({ arm: 'chin' }),
    }
    if (key === 'G') {
      set.blue = f({ blink: true }, PG_BLUE)
      set.hang = f({ arm: 'hang', legs: [[-3, 2], [2, 2]] })
      set.sit = mk(sitGuy(), pal)
      set.front = mk(frontGuy(false), pal)
      set.frontTalk = mk(frontGuy(true), pal)
    }
    if (key === 'ST') {
      set.wave = f({ arm: 'wave', talk: true, legs: [[-2, 0], [2, 0]] })
      set.wave2 = f({ arm: 'wave2', talk: true, legs: [[-2, 0], [2, 0]] })
    }
    return set
  }

  function frontGuy(talk) {
    const g = grid()
    // legs apart, boots
    for (let y = 19; y < 25; y++) {
      put(g, 7, y, 'P'); put(g, 8, y, 'P'); put(g, 11, y, 'P'); put(g, 12, y, 'p')
    }
    stamp(g, 6, 25, ['KKK..KKK', 'kkk..kkk'])
    stamp(g, 4, 3, [
      '...YYYYYY...', '..YYYYYYYY..', '.YYYYYYYYYY.', '.YYSSYYSSYY.', '.zYSESSESYz.', '.z.SSSsSS.z.', '.z.SS' + (talk ? 'EE' : 'ss') + 'SS.z.', '....SSSS....',
    ])
    stamp(g, 3, 11, [
      '......SS......', '..TTTTTTTTTT..', '.TTTTTTTTTTTT.', 'aTTTTtTTtTTTTa', 'aTTTTtTTtTTTTa', '.aTTTTTTTTTTa.', '..SSTTTTTTSS..', '..SSbbbbbbSS..',
    ])
    return rowsOf(g)
  }
  function sitGuy() {
    const g = grid()
    // sitting on the floor, legs out front, back against nothing, a mug in hand
    stamp(g, 3, 9, HEAD_GUY.map((r) => r.replace('e', 's').replace('o', 's')))
    stamp(g, 3, 17, ['.....sSS...', '...TTTTTTT.', '..TTTTTTTTT', '..TTTtTTTTT', '..TTTTTTTTT', '...bbbbbbb.'])
    put(g, 4, 17, 'z'); put(g, 4, 18, 'z')
    line(g, 9, 23, 18, 23, 'p', 2)
    line(g, 9, 24, 18, 24, 'P', 2)
    stamp(g, 18, 21, ['KK', 'KK', 'Kk', 'kk'])
    line(g, 8, 19, 12, 21, 'a', 2)
    line(g, 8, 19, 12, 21, 'A', 1)
    stamp(g, 13, 19, ['MMM', 'MMMh', 'SSS', '.S.'])
    return rowsOf(g)
  }

  // ---- props ------------------------------------------------------------------
  const PI = { ...BASE, G: '#7fe05a', g: '#3a9a2a', r: '#d9473f', O: '#f08a2c', Y: '#f2d14b', D: '#e8f6ff', d: '#7fd8ff', B: '#6a3a14', b: '#3a1e08', W: '#f2efe6', n: '#9a7b5c' }
  const MUG = [
    sprite(['GgGG.', 'MMMM.', 'MmMMM', 'MmMM.M', 'MmMMMM', 'MMMM.'], PI),
    sprite(['GgGG.', 'MMMM.', 'MmMMM', 'MmMMMM', 'M.MM.', 'G..G.'], PI),
    sprite(['GgGG.', 'MMMM.', 'MmMMM', 'M..M.', 'G....', '...G.'], PI),
    sprite(['.....', 'G.G..', 'M..M.', '.....', '.G...', 'G...G'], PI),
  ]
  const PUDDLE = sprite(['.GgGGg.', 'gGGGGGg'], PI)
  const CHICKEN = sprite(['..r.....', '.YYY....', 'OYEY..MM.', '.YYYYMmMY', '..YYYYMMYY', '...YYYYYY.', '....O..O..'], PI)
  const DIAMOND = sprite(['..d..', '.dDd.', 'dDDDd', '.dDd.', '..d..'], PI)
  const ROOTBEER = sprite(['.W.', '.b.', 'BBB', 'BWB', 'BWB', 'BBB'], PI)
  const BANANA = sprite(['...YY', '..YY.', '.YY..', 'YY...', 'n....', 'n....'], PI)
  const ITEMS = { mug: MUG[0], chicken: CHICKEN, diamond: DIAMOND, rootbeer: ROOTBEER, banana: BANANA }
  const GREEN = ['G', 'g', 'c', 'w']

  // The three-headed monkey (finally real, in part three). Body centred on col 9.
  const PMK = { K: '#8a5426', k: '#5a3317', N: '#e8b890', E: '#1a1210', r: '#d9473f' }
  const MK_TOP = ['...KKK.KKK.KKK', '...KNE.KNE.KNE', '...KNN.KNN.KNN', '....K...K...K.', '....KKKKKKKKK.', '.k..KKKNNNKKK.', '.k.KKKKNNNKKKK', '..kKKKKKKKKK..']
  const MK_LEGS = [
    ['.....KK...KK..', '.....KK...KK..', '....kk...kk...'],
    ['......KK.KK...', '.....KK...KK..', '....kk.....kk.'],
    ['....KK.....KK.', '....KK.....KK.', '...kk.....kk..'],
  ]
  const mkMonkey = (legs, talk) => {
    const top = talk ? MK_TOP.map((r, i) => (i === 2 ? r.replace(/KNN/g, 'KNr') : r)) : MK_TOP
    const rows = [...top, ...legs]
    return mk(Array(GH - rows.length).fill('').concat(rows), PMK, false)
  }

  // ---- cast ------------------------------------------------------------------------
  const CAST = {
    G: { name: 'Guybrush', color: '#ffffff' },
    P1: { name: 'important-looking pirate', color: '#ffff55' },
    P2: { name: 'important-looking pirate', color: '#55ffff' },
    P3: { name: 'important-looking pirate', color: '#ffaa55' },
    ST: { name: 'Stan', color: '#ff7fff' },
    CA: { name: 'the Sword Master', color: '#ff6a6a' },
    LC: { name: 'LeChuck', color: '#55ff55' },
    EL: { name: 'Elaine', color: '#ffb0d0' },
    MK: { name: 'three-headed monkey', color: '#ffd27f' },
    VL: { name: 'Voodoo Lady', color: '#c8a0ff' },
  }
  const SENTENCE = '#8f8cff'
  const CARD = '#d8d8ff'
  const FONT = 'bold 8px "DejaVu Sans Mono", Menlo, monospace'
  const WALK = 30
  const SETS = {}
  const ROPE = '#a8865c'

  class Char {
    constructor(key) {
      this.key = key
      this.set = SETS[key]
      this.color = CAST[key].color
      this.on = false
      this.x = -20
      this.y = FLOOR
      this.dir = 1
      this.tx = null
      this.speed = WALK
      this.ft = 0
      this.pose = 'stand'
      this.item = null
      this.yOff = 0
      this.ghost = key === 'LC'
      this.small = key === 'MK'
      this.z = key === 'G' ? 3 : key === 'MK' ? 4 : 2
      this.turnAt = 0
      this.cb = null
      this.at = null
      this.ride = null
    }
    get moving() {
      return this.on && this.tx !== null
    }
    hit(x, y) {
      if (!this.on || this.x < -4 || this.x > (this.s?.W ?? 1e9) + 4) return false
      const top = FLOOR + this.yOff - (this.small ? 13 : this.pose === 'sit' ? 18 : 27)
      return Math.abs(x - this.x) <= (this.small ? 9 : 8) && y >= top && y <= FLOOR + this.yOff + 1
    }
    // only the hero can be picked up, and only when he isn't busy on a rope or in a fight
    get grabbable() {
      const d = this.s?.data
      return this.key === 'G' && !!d && this.on && !d.zip && !d.fight && !d.resting && !this.ride
    }
    grab(p) {
      grabGuy(this.s, this, p)
    }
    drag(p) {
      if (!this.held) return
      this.s.data.grabAt = performance.now()
      this.x = clamp(p.x, 6, this.s.W - 6)
      const sp = this.set.hang
      this.yOff = clamp(Math.round(p.y - 1 - (FLOOR - sp.h + sp.off)), -9, 0)
      if (this.s.cursor) this.dir = this.s.cursor.x >= this.x ? 1 : -1
    }
    drop() {
      dropGuy(this.s, this)
    }
    onDblClick() {
      dblChar(this.s, this)
    }
    /** Walk to x. Long crossings of a wide bar get a brisker pace. */
    goto(x, cb = null, at = null, speed = 0) {
      this.at = at
      this.tx = Math.round(x)
      this.cb = cb
      const dist = Math.abs(this.tx - this.x)
      this.speed = speed || (dist > 180 ? Math.min(78, (WALK * dist) / 180) : WALK)
      if (!['hang', 'hold'].includes(this.pose)) this.pose = 'stand'
    }
    face(x, now = 0, cool = 0) {
      const want = x > this.x ? 1 : -1
      if (want !== this.dir && (!cool || now - this.turnAt >= cool)) {
        this.dir = want
        this.turnAt = now
      }
    }
    update(dt, now, s) {
      if (!this.on) return Infinity
      if (this.held) return FAST // dangling from the cursor: no walking
      if (this.fallV !== undefined) {
        // let go: a short drop back to the floor
        this.fallV += 400 * dt
        this.yOff = Math.min(0, this.yOff + this.fallV * dt)
        if (this.yOff >= 0) {
          this.fallV = undefined
          s.burst(this.x, FLOOR - 1, 4, ['n', 'w'])
        }
        return FAST
      }
      if (this.keyWalk) {
        // A/D: you walk him (a cutscene walk resumes when you let go)
        this.dir = this.keyWalk
        this.x = clamp(this.x + this.keyWalk * WALK * 1.6 * dt, 6, s.W - 6)
        this.ft += dt * 1.6
        return FAST
      }
      let want = Infinity
      if (this.ride) {
        // the monkey sits on the ghost pirate's hat
        if (!this.ride.on) {
          this.ride = null
          this.yOff = 0
          return FAST
        }
        this.x = this.ride.x
        this.dir = this.ride.dir
        this.yOff = this.ride.yOff - 25
        return s.lively(now) ? SLOW : Infinity
      }
      if (this.ghost && s.lively(now) && !s.data.resting) {
        const b = Math.round(Math.sin(now / 420) * 1.5) - 1
        if (b !== this.yOff) this.yOff = b
        want = SLOW
      }
      if (this.tx === null) return want
      const d = this.tx - this.x
      if (Math.abs(d) <= this.speed * dt + 0.01) {
        this.x = this.tx
        this.tx = null
        this.ft = 0
        const cb = this.cb
        this.cb = null
        cb?.()
        return FAST
      }
      this.dir = d > 0 ? 1 : -1
      this.x += this.dir * this.speed * dt
      this.ft += dt * Math.min(1.6, this.speed / WALK)
      return FAST
    }
    sprite(s) {
      const set = this.set
      if ((this.tx !== null || this.keyWalk) && this.pose !== 'hang') return set.walk[Math.floor(this.ft * 8) % set.walk.length]
      const L = s.data.line
      const talking = L && L.who === this && performance.now() < L.until
      let p = this.pose
      if (talking) {
        if (p === 'stand' || p === 'blink' || p === 'chin') p = 'talk'
        else if (p === 'hold') p = 'holdTalk'
        else if (p === 'hi') p = 'hiTalk'
        else if (p === 'front') p = 'frontTalk'
      }
      return set[p] || set.stand
    }
    draw(c, s) {
      if (!this.on) return
      const sp = this.sprite(s)
      const cx = 9 + sp.off
      const left = this.dir > 0 ? this.x - cx : this.x - (sp.w - 1 - cx)
      const top = FLOOR - sp.h + sp.off + this.yOff - (sp.bob || 0)
      if (this.ghost) c.globalAlpha = 0.86
      c.drawImage(sp[this.dir], Math.round(left), Math.round(top))
      c.globalAlpha = 1
      if (this.item && this.pose === 'hold' && this.tx === null) {
        const it = this.item === 'mug' ? MUG[clamp(s.data.melt | 0, 0, 3)] : ITEMS[this.item]
        const hx = this.dir > 0 ? this.x + 4 : this.x - 3 - it.width
        c.drawImage(it, Math.round(hx), Math.round(top + 16 - it.height))
      }
      if (this.zz) c.drawImage(ZZ, Math.round(this.x + 4), Math.round(top + 4))
    }
    onClick() {
      clickChar(this.s, this)
    }
  }

  // The bar's loose props: the grog puddle and the washing line. Clickable for a remark.
  class Props {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = 1
    }
    update() {
      return Infinity
    }
    draw() {}
    which(x, y) {
      const d = this.s.data
      if (d.puddle && Math.abs(x - d.puddle.x) <= 8 && y >= FLOOR - 6) return 'puddle'
      if (d.rope && !d.zip) {
        const r = rope(this.s)
        if (x >= r.x0 && x <= r.x1 && Math.abs(y - ropeY(this.s, x)) <= 4) return 'rope'
      }
      return null
    }
    hit(x, y) {
      return !!this.which(x, y)
    }
    verbAt(p) {
      const w = this.which(p.x, p.y)
      return w ? PROP_LINES[w].verb : null
    }
    onClick(p) {
      const s = this.s
      const d = s.data
      const w = this.which(p.x, p.y)
      s.data.clickAt = performance.now()
      if (!w || !d.cast.G.on || d.resting) return
      const list = PROP_LINES[w].lines
      d.look[w] = ((d.look[w] ?? -1) + 1) % list.length
      aside(s, 'G', list[d.look[w]])
    }
  }

  // ---- staging -------------------------------------------------------------------
  // Two little stages read from the live furniture each time: L just left of the
  // title (guests: the salesman, the swordmaster, the governor) and R just right of it (the
  // pirates' corner). Tight bars fall back to the widest open spans.
  const MARGIN = 12
  function freeSpans(s) {
    const rs = [...s.fix, ...s.dots].map((f) => [f.x, f.x + f.w]).sort((a, b) => a[0] - b[0])
    const out = []
    let x = 0
    for (const [a, b] of rs) {
      if (a > x) out.push([x + MARGIN, a - MARGIN])
      x = Math.max(x, b)
    }
    if (x < s.W) out.push([x + MARGIN, s.W - MARGIN])
    return out.filter(([a, b]) => b >= a)
  }
  function stages(s) {
    const t = s.fixture('title')
    const spans = freeSpans(s)
    const ok = (sp, min) => sp && sp[1] - sp[0] >= min
    let L = t ? spans.filter(([, b]) => b <= t.x).pop() : null
    let R = t ? spans.find(([a]) => a >= t.x + t.w) : null
    if (!ok(L, 34) || !ok(R, 44)) {
      const wide = spans.slice().sort((p, q) => q[1] - q[0] - (p[1] - p[0]))
      if (ok(wide[1], 44)) [L, R] = [wide[0], wide[1]].sort((p, q) => p[0] - q[0])
      else if (ok(wide[0], 110)) {
        const [a, b] = wide[0]
        const m = (a + b) / 2
        L = [a, m - 8]
        R = [m + 8, b]
      } else {
        // a very tight bar: share the room in front of the title
        const e = s.fixture('eyes')
        const a = e ? e.x + e.w + MARGIN : MARGIN
        const nxt = [...s.fix, ...s.dots].filter((f) => t && f.x >= t.x + t.w).sort((p, q) => p.x - q.x)[0]
        const b = Math.max(a + 60, nxt ? nxt.x - MARGIN : s.W - MARGIN)
        const m = (a + b) / 2
        L = [a, m - 6]
        R = [m + 6, b]
      }
    }
    // keep each group together, close to the title
    return { L: [Math.max(L[0], L[1] - 100), L[1]], R: [R[0], Math.min(R[1], R[0] + 112)], spans }
  }
  /** 'L0'..'L4', 'R0'..'R4', 'offL', 'offR', '@KEY±n' (relative to a character), or a number. */
  function spot(s, name) {
    if (typeof name === 'number') return name
    if (name === 'offL') return -16
    if (name === 'offR') return s.W + 16
    if (name[0] === '@') {
      const m = /^@(\w+?)([+-]\d+)$/.exec(name)
      const c = s.data.cast[m[1]]
      return clamp(c.x + +m[2] * c.dir, 6, s.W - 6)
    }
    const st = stages(s)[name[0]]
    const k = +name.slice(1) / 4
    return Math.round(st[0] + (st[1] - st[0]) * k)
  }
  function openX(s, x) {
    // nearest x in an open stretch (for resting)
    let best = clamp(x, 6, s.W - 6)
    let bd = 1e9
    for (const [a, b] of stages(s).spans) {
      const v = clamp(x, a, b)
      if (Math.abs(v - x) < bd) {
        bd = Math.abs(v - x)
        best = v
      }
    }
    return best
  }
  function overFurniture(s, x) {
    return [...s.fix, ...s.dots].some((f) => f.kind !== 'eyes' && x > f.x - 6 && x < f.x + f.w + 6)
  }

  // ---- the story -------------------------------------------------------------------
  // Ops: card, on (who, spot, from, nowait), go (who, spot, nowait), sync, off,
  // face, say (text or [alternatives]), pose, item, wait, fx, appear, vanish,
  // ride, punch (where "done" jumps to), duel (opponent, rounds).
  const S = {
    trials: [
      ['card', 'Part One: The Three Trials'],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'G', "Hi! My name's Guybrush Threepwood..."],
      ['say', 'G', '...and I want to be a pirate!'],
      ['say', 'P1', ['Threepwood? Sounds like a cough.', 'Threepwood? Is that a type of lumber?']],
      ['say', 'P2', ["You don't look like a pirate.", 'You look like a cabin boy who got lost.']],
      ['say', 'G', ['I have a very piratey personality.', "I'm told I have a pirate's spirit."]],
      ['say', 'G', 'And I can hold my breath for ten minutes!'],
      ['say', 'P3', ['Can you hold your tongue for five?', 'Handy. The bar smells like that.']],
      ['say', 'P1', 'To be a pirate, ye must pass three trials.'],
      ['say', 'P2', 'Swordplay. Thievery.'],
      ['say', 'P3', 'And treasure huntery.'],
      ['punch'],
      ['say', 'G', ['Can I do them in any order?', 'Is there a written exam?']],
      ['say', 'P1', ['Preferably somewhere else.', 'Go away, kid.']],
      ['wait', 900],
    ],
    grog: [
      ['say', 'P2', ['But first, a pirate must drink grog.', 'First things first. Grog!']],
      ['go', 'P2', 'R1'], ['face', 'P2', 'G'], ['item', 'G', 'mug'], ['pose', 'G', 'hold'], ['fx', 'melt', 0], ['go', 'P2', 'R3'], ['face', 'P2', 'G'],
      ['say', 'G', ["It's fizzing. Is grog supposed to fizz?", 'Why is it glowing?']],
      ['say', 'P2', 'Kerosene, acid, rum, axle grease...'],
      ['say', 'P3', ['...red dye, pepperoni, and one secret.', '...propylene glycol, and a secret.']],
      ['say', 'G', "What's the secret ingredient?"],
      ['say', 'P3', ['Nobody finishes a mug to find out.', 'If I told ye, it would melt the secret.']],
      ['fx', 'melt', 1], ['wait', 1200], ['fx', 'melt', 2],
      ['say', 'G', ['Er. My mug is melting.', 'Is my mug supposed to drip like that?']],
      ['say', 'P1', ['Then drink faster, lad!', 'That is how ye know it is good.']],
      ['punch'],
      ['fx', 'melt', 3], ['wait', 900], ['fx', 'puddle'],
      ['say', 'G', ['Could I have the next one in a barrel?', 'Does it come in an iron mug?']],
      ['say', 'P2', ["Har! He's got spirit. Mostly on his boots.", 'The floor liked it, anyway.']],
      ['pose', 'G', 'stand'], ['item', 'G', null],
    ],
    stan: [
      ['go', 'G', 'L3'], ['face', 'G', 'L'],
      ['on', 'ST', 'L1', 'offL'], ['pose', 'ST', 'wave'], ['face', 'G', 'ST'],
      ['say', 'ST', ["Hey there, sailor! Stan's Used Ships!", 'Stan! Stan! Over here! Stan!']],
      ['say', 'ST', ['Looking for a ship? Look no further!', 'Every ship a bargain, every bargain a ship!']],
      ['say', 'G', ['Do you always wave your arms like that?', 'Do you ever stand still?']],
      ['say', 'ST', ['Only when I breathe, friend!', 'Standing still loses sales, friend!']],
      ['say', 'ST', ['This beauty is practically new. Barely sunk!', 'This one has only been sunk twice!']],
      ['say', 'G', ['"Barely" sunk?', '"Only" twice?']],
      ['say', 'ST', 'Hardly at all! And a lifetime warranty!'],
      ['say', 'G', 'Whose lifetime?'],
      ['say', 'ST', ["Let's not get technical!", 'Details, details!']],
      ['punch'],
      ['say', 'G', ["I'm a little short of money.", 'I left my money in my other pants.']],
      ['say', 'ST', ['Then you are a little short of a ship!', 'Come back with pants! Any pants!']],
      ['off', 'ST', 'offL'], ['pose', 'ST', 'stand'],
    ],
    pockets: [
      ['face', 'G', 'R'], ['pose', 'G', 'chin'],
      ['say', 'G', ["Let's see what I've got in my pockets.", 'Time to check my inventory.']],
      ['item', 'G', 'chicken'], ['pose', 'G', 'hold'],
      ['say', 'G', 'A rubber chicken with a pulley in the middle.'],
      ['say', 'G', ['What possible use could that have?', 'Who designs these things?']],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'P3', ['Every pirate carries one. Just in case.', 'Keep that. Ye never know.']],
      ['say', 'G', 'In case of what?'],
      ['say', 'P3', ["Ye'll know when ye know.", 'Laundry emergencies, mostly.']],
      ['punch'],
      ['say', 'G', ["I'll hang on to it. Somehow that feels apt.", 'Into the pocket it goes. Squeak.']],
      ['item', 'G', null], ['pose', 'G', 'stand'],
    ],
    swordmaster: [
      ['say', 'P1', ['The swordplay trial: beat the Sword Master.', 'Swordplay! Go and beat the Sword Master.']],
      ['go', 'G', 'L3'],
      ['on', 'CA', 'L1', 'offL'], ['face', 'G', 'CA'], ['face', 'CA', 'G'],
      ['say', 'CA', ["I'm the Sword Master. You wanted a lesson?", 'Another one? Fine. Make it quick.']],
      ['say', 'G', ["I've been practising. On a chicken.", "I've learned all the insults!"]],
      ['say', 'CA', ['Did the chicken win?', 'All of them? Adorable.']],
      ['pose', 'G', 'hi'], ['pose', 'CA', 'hi'],
      ['duel', 'CA', 2],
      ['punch'],
      ['say', 'CA', 'You fight like a dairy farmer!'],
      ['say', 'G', 'How appropriate. You fight like a cow.'],
      ['fx', 'clash'],
      ['pose', 'CA', 'stand'],
      ['say', 'CA', ["Hmph. You've passed. Barely.", 'Fine. You pass. Tell no one.']],
      ['pose', 'G', 'front'],
      ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"],
      ['say', 'CA', ['Sure you are, sweetie.', 'Whatever helps you sleep.']],
      ['off', 'CA', 'offL'], ['pose', 'G', 'stand'],
    ],
    thievery: [
      ['go', 'G', 'R0'], ['face', 'G', 'P2'],
      ['say', 'P2', ['The thievery trial: steal that diamond.', 'Thievery! Fetch us that diamond.']],
      ['say', 'G', 'The one on the wall, way up there?'],
      ['say', 'P2', ["Nobody's ever reached it. Too high.", 'Too high for any honest man.']],
      ['say', 'G', ['Hmm. Too high. There must be a way...', 'Good thing I am not an honest man.']],
      ['go', 'G', 'L1'], ['face', 'G', 'R'], ['fx', 'rope'],
      ['item', 'G', 'chicken'], ['pose', 'G', 'hold'],
      ['say', 'G', 'Use rubber chicken with washing line!'],
      ['punch'],
      ['fx', 'zip'],
      ['say', 'P3', ['He used the chicken!', 'Well, blow me down. The chicken!']],
      ['say', 'G', ['I KNEW it had a use!', 'Squeak of victory!']],
      ['fx', 'land'],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
    ],
    ghost: [
      ['say', 'VL', ['Child... LeChuck is coming.', 'Child... the dead are restless tonight.']],
      ['say', 'G', ['Who said that?', 'Is that... the Voodoo Lady?']],
      ['say', 'VL', ['The Voodoo Lady. Long story. Duck.', 'Do not worry. Worry later.']],
      ['appear', 'LC', 'L2'], ['face', 'LC', 'G'], ['face', 'G', 'LC'],
      ['say', 'LC', ['Who dares steal from MY bar?', 'Who dares wake LeChuck?']],
      ['say', 'G', ['It... is a public bar?', 'Not me. Probably.']],
      ['say', 'LC', ['I seek the Governor. She will be my bride!', 'Elaine Marley will be my bride!']],
      ['on', 'EL', 'L0', 'offL'], ['face', 'EL', 'LC'],
      ['say', 'EL', ['Not in this life or the next, LeChuck.', 'I would sooner marry Stan.']],
      ['face', 'G', 'EL'],
      ['say', 'G', ['Uh... I... um... Guybrush... uh...', 'Hi. I mean. Uh. Guybrush. Hi.']],
      ['say', 'EL', ['Is he always like this?', 'Does he come with subtitles?']],
      ['face', 'G', 'LC'],
      ['say', 'G', 'Look behind you! A three-headed monkey!'],
      ['face', 'LC', 'L'],
      ['say', 'LC', 'Where?!'],
      ['punch'],
      ['face', 'LC', 'G'],
      ['say', 'LC', ['Arrr! You have not seen the last of me!', 'I will be back, Threepwood!']],
      ['vanish', 'LC'],
      ['say', 'EL', ["Don't mind him. He's dead.", 'He does that. Being dead.']],
      ['off', 'EL', 'offL'],
    ],
    finale: [
      ['face', 'G', 'P1'], ['item', 'G', 'diamond'], ['pose', 'G', 'hold'],
      ['say', 'G', ['One diamond. Do I pass?', 'Diamond, as ordered. Well?']],
      ['say', 'P1', 'Swordplay? Aye.'],
      ['say', 'P2', 'Thievery? Aye.'],
      ['say', 'P3', ['Treasure? ...It is our own diamond.', 'Treasure? ...That is off our wall.']],
      ['say', 'G', ['Finders keepers. That is piracy, right?', 'I found it. Up a wall.']],
      ['say', 'P1', ['...He has us there.', 'Ye know, that counts.']],
      ['punch'],
      ['item', 'G', null], ['pose', 'G', 'front'],
      ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"],
      ['say', 'P2', ['We know. Ye keep saying.', 'Aye, aye. Sit down.']],
      ['pose', 'G', 'stand'],
      ['card', 'To be continued...'],
      ['wait', 2500],
    ],

    return2: [
      ['card', 'Part Two: The Root of All Evil'],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'P1', ['Back again, mighty pirate?', 'Well, if it is not the mighty pirate.']],
      ['say', 'G', 'Mighty pirates need a ship. And a crew.'],
      ['say', 'P2', ['And a bath.', 'And a shave. Ye missed a bit.']],
      ['say', 'G', 'I can hold my breath for ten minutes!'],
      ['pose', 'G', 'blue'], ['wait', 2600],
      ['say', 'P3', ['...that is not a crew, lad.', 'He is going a funny colour.']],
      ['punch'],
      ['pose', 'G', 'stand'],
      ['say', 'G', ['Gasp! Six minutes. A personal worst.', 'Gasp! Was that ten minutes?']],
    ],
    stan2: [
      ['go', 'G', 'L3'],
      ['on', 'ST', 'L1', 'offL'], ['pose', 'ST', 'wave'], ['face', 'G', 'ST'],
      ['say', 'ST', ['My favourite repeat customer!', 'You came back! They always come back!']],
      ['say', 'G', 'I never bought anything.'],
      ['say', 'ST', ['Repeat NON-customer! Even better!', 'Then today is the day!']],
      ['say', 'ST', ['Today only: a slightly haunted ship!', 'Special offer: a ghost ship, low miles!']],
      ['say', 'G', 'Is the ghost optional?'],
      ['say', 'ST', ['The ghost is load-bearing, friend!', 'The ghost comes free! Free ghost!']],
      ['item', 'G', 'diamond'], ['pose', 'G', 'hold'],
      ['say', 'G', 'Would you take a diamond?'],
      ['punch'],
      ['item', 'G', null], ['pose', 'G', 'stand'],
      ['say', 'ST', ['SOLD! No refunds, no returns, no lifeboats!', 'SOLD! Pleasure doing business! Run!']],
      ['off', 'ST', 'offL'], ['pose', 'ST', 'stand'],
    ],
    voodoo: [
      ['face', 'G', 'L'],
      ['say', 'VL', ['Child... LeChuck has taken Elaine.', 'Child... your Governor is in danger.']],
      ['say', 'G', ['Again? Does she not lock her door?', 'Again? This week?']],
      ['say', 'VL', 'Only one thing destroys a ghost.'],
      ['say', 'VL', 'Root beer.'],
      ['say', 'G', 'Root beer?'],
      ['say', 'VL', ['Do not ask a voodoo priestess why.', 'The fizz confuses the dead.']],
      ['punch'],
      ['say', 'G', ['I was going to ask where.', 'Diet or regular?']],
    ],
    rootbeer: [
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'G', ['Barkeep! One root beer, please.', 'Got any root beer?']],
      ['say', 'P1', ['Root beer?! This is a PIRATE bar.', 'We do not serve that muck here.']],
      ['say', 'P2', ['We serve grog. And more grog.', 'Grog or nothing, lad.']],
      ['say', 'G', 'Look behind you! A three-headed monkey!'],
      ['face', 'P1', 'R'], ['face', 'P2', 'R'],
      ['say', 'P1', 'Where?!'],
      ['say', 'P3', ['Psst. Back shelf. Tell nobody.', 'Psst. I keep a bottle. For my nerves.']],
      ['punch'],
      ['item', 'G', 'rootbeer'], ['pose', 'G', 'hold'],
      ['face', 'P1', 'G'], ['face', 'P2', 'G'],
      ['say', 'P2', 'Hey! There is no monkey!'],
      ['say', 'G', ['There was. He left. All three heads.', 'You just missed him.']],
    ],
    duel2: [
      ['go', 'G', 'L4'], ['face', 'G', 'L'],
      ['appear', 'LC', 'L1'], ['face', 'LC', 'G'],
      ['say', 'LC', ['Threepwood! Elaine is mine!', 'Threepwood! You again!']],
      ['say', 'G', ['She did not seem very keen.', 'Have you tried flowers? Living ones?']],
      ['item', 'G', null], ['pose', 'G', 'hi'], ['pose', 'LC', 'hi'],
      ['duel', 'LC', 2],
      ['punch'],
      ['pose', 'LC', 'stand'], ['pose', 'G', 'stand'],
      ['say', 'LC', ['Enough! I will crush you myself!', 'Enough games! Prepare to die!']],
      ['item', 'G', 'rootbeer'], ['pose', 'G', 'hold'],
      ['say', 'G', ['Root beer, LeChuck? On the house!', 'Fancy a drink, LeChuck?']],
      ['fx', 'spray'],
      ['say', 'LC', ['Nooo! Not... root... beeeer!', 'It fizzes! It FIZZES!']],
      ['vanish', 'LC', true],
      ['item', 'G', null], ['pose', 'G', 'stand'],
    ],
    elaine: [
      ['on', 'EL', 'L2', 'offL'], ['face', 'EL', 'G'], ['face', 'G', 'EL'],
      ['say', 'EL', ['I had it handled, you know.', 'I was about to rescue myself.']],
      ['say', 'G', ['I... uh... I am sure you did.', 'Of course. I was just... helping.']],
      ['say', 'EL', ['But the fireworks were a nice touch.', 'Still. Nice fizz.']],
      ['punch'],
      ['pose', 'G', 'front'],
      ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"],
      ['say', 'EL', ['Yes, dear. Everyone knows.', 'You say that a lot.']],
      ['pose', 'G', 'stand'],
      ['off', 'EL', 'offL', true],
    ],
    end2: [
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'P3', 'So. A ship, a ghost, and a governor.'],
      ['say', 'P1', ['Not bad for a lad named after a cough.', 'Not bad for a cabin boy.']],
      ['say', 'G', 'Next: the Secret of Monkey Island!'],
      ['say', 'P2', 'What is the secret?'],
      ['punch'],
      ['say', 'G', ["I'll tell you when I'm older.", 'If I told you, it would not be a secret.']],
      ['card', 'THE END. Probably.'],
      ['wait', 2500],
    ],

    monkey1: [
      ['card', 'Part Three: Look Behind You'],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['pose', 'G', 'front'],
      ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"],
      ['pose', 'G', 'stand'], ['face', 'G', 'P1'],
      ['say', 'P1', ['We KNOW.', 'Still?']],
      ['say', 'P2', ['Ye have said that every day for a week.', 'Ye said it at breakfast. Twice.']],
      ['say', 'G', 'So what is the next adventure?'],
      ['say', 'P3', 'Nobody has seen a real three-headed monkey.'],
      ['say', 'G', "I've used it as a distraction for years!"],
      ['say', 'P1', ['Find one, and grog is free for life.', 'Find one and we will name the bar after ye.']],
      ['punch'],
      ['say', 'G', ["Free grog? That's practically treasure!", "Deal! How hard can it be?"]],
      ['say', 'P2', ['It melts treasure, mind.', 'Very hard. That is the point.']],
    ],
    detector: [
      ['go', 'G', 'L3'],
      ['on', 'ST', 'L1', 'offL'], ['pose', 'ST', 'wave'], ['face', 'G', 'ST'],
      ['say', 'ST', ['Monkey hunting? You need a Monkey Detector!', "Stan's Monkey Detector! Act now!"]],
      ['item', 'G', 'banana'], ['pose', 'G', 'hold'],
      ['say', 'G', 'That is a banana on a stick.'],
      ['say', 'ST', ['A PREMIUM banana on a stick!', 'A hand-polished banana on a stick!']],
      ['say', 'G', 'How does it detect monkeys?'],
      ['say', 'ST', ['Monkeys come to it! Detection!', 'You will know! The banana will be gone!']],
      ['punch'],
      ['say', 'ST', ['Batteries not included! No refunds!', 'Stan thanks you! Stan does not refund!']],
      ['off', 'ST', 'offL'], ['pose', 'ST', 'stand'],
      ['say', 'G', ['What did I pay with? Never mind.', 'I think I just bought a banana.']],
    ],
    voodoo3: [
      ['face', 'G', 'L'],
      ['say', 'VL', ['Child... the monkey you seek is close.', 'Child... I see heads. Three of them.']],
      ['say', 'G', 'How close?'],
      ['say', 'VL', 'Look behind you.'],
      ['face', 'G', 'R'], ['wait', 900], ['face', 'G', 'L'],
      ['say', 'G', ['...Nothing there.', 'Ha. Very funny.']],
      ['say', 'VL', ['Not now. Later. Voodoo is not punctual.', 'Patience. The future runs late.']],
      ['punch'],
      ['say', 'G', ["I'll put it in my calendar.", 'Later. Got it. Thanks, I think.']],
    ],
    behind: [
      ['go', 'G', 'R0'], ['face', 'G', 'P1'], ['item', 'G', 'banana'], ['pose', 'G', 'hold'],
      ['say', 'G', ['This detector will find any monkey.', 'Behold! The Monkey Detector!']],
      ['on', 'MK', '@G-15', 'offL'], ['face', 'MK', 'G'],
      ['say', 'P2', 'Look behind you! A three-headed monkey!'],
      ['say', 'G', ['Ha! I invented that trick.', "Nice try. I'm not falling for that."]],
      ['say', 'P3', ['No, really. Behind you.', 'Lad. LAD. Behind ye.']],
      ['say', 'G', 'Next you will tell me it has three heads.'],
      ['say', 'P1', 'It does! It has three heads!'],
      ['say', 'MK', 'Eek! Eek! Eek!'],
      ['punch'],
      ['item', 'G', null], ['pose', 'G', 'stand'],
      ['off', 'MK', 'offL', true],
      ['say', 'G', 'Hey! Who took my banana?'],
      ['face', 'G', 'L'],
      ['say', 'G', '...Was that a three-headed monkey?'],
      ['say', 'P1', ['Nah.', 'Ye missed it.']],
    ],
    lcmonkey: [
      ['go', 'G', 'L4'], ['face', 'G', 'L'],
      ['appear', 'LC', 'L1'], ['face', 'LC', 'G'],
      ['say', 'LC', ['Threepwood! That monkey is MINE!', 'The monkey belongs to LeChuck!']],
      ['say', 'G', ['You want a monkey? Get in line.', 'Finders keepers. I found it. Sort of.']],
      ['say', 'LC', 'Its heads will look grand on my mast!'],
      ['pose', 'G', 'hi'], ['pose', 'LC', 'hi'],
      ['duel', 'LC', 2],
      ['punch'],
      ['pose', 'G', 'stand'], ['pose', 'LC', 'stand'],
      ['on', 'MK', '@LC-14', 'offL'],
      ['say', 'G', 'LeChuck! Look behind you!'],
      ['say', 'LC', ["Ha! I'm not falling for th-", 'Fool! Nobody falls for th-']],
      ['ride', 'MK', 'LC'],
      ['say', 'MK', 'Eek!'],
      ['say', 'LC', ['Get it off! Get it OFF!', 'It is biting my hat!']],
      ['vanish', 'LC'],
      ['say', 'MK', 'Eek eek.'],
      ['off', 'MK', 'offL', true],
    ],
    end3: [
      ['on', 'EL', 'L2', 'offL'], ['face', 'EL', 'G'], ['face', 'G', 'EL'],
      ['say', 'EL', ['So the monkey was real.', 'Was that a monkey on his hat?']],
      ['say', 'G', ['Told you. For years.', 'Three heads. I counted.']],
      ['say', 'EL', 'You only ever used it to distract people.'],
      ['say', 'G', 'And it worked. Every time.'],
      ['go', 'G', 'R0'], ['face', 'G', 'P1'],
      ['say', 'P3', ['Free grog for life, as promised.', 'Grog is on the house. Forever.']],
      ['punch'],
      ['say', 'G', ['Could I get it in a to-go mug?', 'In a mug that will survive it?']],
      ['pose', 'G', 'front'],
      ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"],
      ['say', 'EL', ['Nice title. Ever thought of a new one?', 'Yes, dear.']],
      ['pose', 'G', 'stand'],
      ['card', 'THE END. Until next time.'],
      ['off', 'EL', 'offL', true],
      ['wait', 2500],
    ],
  }
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  // Each episode is rebuilt when it starts: the middle scenes shuffle where the plot allows.
  const EPISODES = [
    () => [S.trials, ...shuffle([S.grog, S.stan, S.pockets]), ...shuffle([S.swordmaster, S.thievery]), S.ghost, S.finale],
    () => [S.return2, ...shuffle([S.stan2, S.voodoo]), S.rootbeer, S.duel2, S.elaine, S.end2],
    () => [S.monkey1, ...shuffle([S.detector, S.voodoo3]), S.behind, S.lcmonkey, S.end3],
  ]

  // Insult swordfighting: [insult, comeback]. G_INS are the hero's openers.
  const DUEL_LINES = {
    CA: [
      ['My sword is famous across the Caribbean!', 'Famous for staying in its sheath?'],
      ["I've spoken with apes more polite than you.", 'Glad you made the family reunion.'],
      ['Every word you say is stupid!', 'I wanted you to feel at home.'],
      ['I once beat ten pirates before breakfast!', 'Was breakfast also a pirate?'],
      ['You have the manners of a wet sock!', 'And you have the charm of a dry one.'],
      ['I will run you through like a herring!', 'Herrings are famously hard to hit.'],
      ['You are no match for my skill!', 'Then let us call it a draw and get grog.'],
      ['My blade is sharper than your wit!', 'Then why are you holding it wrong?'],
    ],
    LC: [
      ['I will pluck you like a rubber chicken!', 'Funny. I brought one.'],
      ['Even death fears me, boy!', 'Death has excellent taste, then.'],
      ['Your bones will decorate my ship!', 'Your ship already looks like a skeleton.'],
      ['I have sailed the seas of the dead!', 'That explains the smell.'],
      ['My crew is legion!', 'Your crew is mostly fog.'],
      ['I am the terror of the Caribbean!', 'You are the terror of the dentists.'],
      ['Fear my ghostly wrath!', 'I would, if you were scarier than Stan.'],
      ['I will drag you to the depths!', 'I can hold my breath for ten minutes!'],
    ],
    P: [
      ['You fight like a dairy farmer!', 'How appropriate. You fight like a cow.'],
      ["I've got a long, sharp lesson for you!", "And I've got a little TIP for you."],
      ['People fall at my feet when I arrive!', 'Even BEFORE they smell your breath?'],
      ["Nobody's ever drawn blood from me!", 'You run THAT fast?'],
      ['My grandmother fights better than you!', 'Is she free? I need a crew.'],
      ['I have the reflexes of a cobra!', 'And the breath of one, too.'],
      ['Soon you will be begging for mercy!', 'I will be begging for grog, mostly.'],
      ['You are a disgrace to the bandana!', 'I am not even wearing one.'],
    ],
  }
  const G_INS = [
    ['My dog was smarter than you.', 'He must have taught you everything.'],
    ["I'm rubber and you're glue!", 'Ow. That one actually hurt.'],
    ['You fight like a sleepy grandmother!', 'Grandma taught me. She is not sleepy.'],
    ['Your hat is ridiculous!', 'At least I have a whole outfit.'],
    ["I've seen sponges with sharper swords!", 'Sponges? Out here? Show me.'],
    ['I can hold my breath for ten minutes!', 'Then hold it now. Please.'],
  ]
  // done during a busy duel: a last insult and the winning comeback
  const WIN = {
    CA: ['You fight like a dairy farmer!', 'How appropriate. You fight like a cow.'],
    LC: ['I will haunt you for all eternity!', 'Then I had better buy more root beer.'],
    P: ["You're no match for my brains, kid!", "Perhaps. If you'd use them first."],
  }
  const CONCEDE = {
    CA: ['Lucky stab. Go on, then.', 'Enough practice. Go away.'],
    LC: ['Arrr! This is not over!', 'Bah! I have haunting to do.'],
    P: ['Yikes! I give up!', 'I need a grog. Truce?'],
  }
  const QUIPS = ["I'm Guybrush Threepwood, mighty pirate!", 'Another fine piece of piracy.', 'Done! Somebody fetch me a grog.', 'Ta-da! No need to clap all at once.']

  // ---- click / hover lines --------------------------------------------------------
  const LOOKS = {
    G: ["I'm selling these fine leather jackets.", 'I want to be a pirate!', 'I can hold my breath for ten minutes!', 'Hey, quit poking me.'],
    P1: ['Arr. Go bother someone else.', 'Bring me a grog and we can talk.', 'This hat cost me three ships.'],
    P2: ['Har! You call that a mustache?', 'One eye. Twice the menace.', 'Stop clicking me, lubber.'],
    P3: ['I am the important-looking one.', 'The earring was a gift. From a shark.', 'Grog? Grog.'],
    ST: ['Stan! Stan! STAN!', 'Ask me about extended warranties!', 'Every ship is a bargain from far away!'],
    CA: ['Touch me again and you lose a finger.', 'Practice your insults, kid.'],
    LC: ['Do not poke the undead!', 'Arrr... I mean BOO!'],
    EL: ['Governor Marley. Nice to meet you.', 'Please stop staring at me.'],
    MK: ['Eek!', 'Eek! Eek! Eek!', 'Eek eek?'],
  }
  // what the hero says about whatever he is holding, when you click him
  const ITEM_LINES = {
    mug: ["It's melting my fingerprints off.", 'Sip? No. Survive? Yes.', 'Somebody hold this. Nobody? Fine.'],
    chicken: ['Squeak.', 'It squeaks in a meaningful way.', 'A pulley. In a chicken. Why not.'],
    diamond: ['Shiny. Possibly stolen.', 'Definitely stolen. By me. Hi.'],
    rootbeer: ['For ghosts only. Mostly.', 'Do NOT shake.'],
    banana: ['Here, monkey monkey monkey...', 'Detecting... detecting...'],
  }
  const DUEL_POKE = ['Hey! No help from the audience!', 'Who is poking me mid-insult?', 'Not now, I am being witty!']
  const GRAB_LINES = ['Whoa! Put me down!', 'I bruise like a peach!', 'Is this a pirate thing?', 'Higher! No, lower! No, DOWN!']
  const DROP_LINES = ['Oof. Thank you. I think.', 'I meant to land like that.', 'Mighty pirates always land on their feet.']
  const BREATH_END = ['Gasp! Nine minutes, fifty-nine!', 'Gasp! New record. Probably.', 'Gasp! Did anyone time that?']
  // a character notices the cursor hovering over them
  const NOTICE = {
    G: ['Can I help you?', 'Are you a ghost? Blink twice.'],
    P1: ['What are ye looking at?', 'Eyes front, swab.'],
    P2: ['Ye want a fight, pointer?', 'Arr. A floating hand. Seen worse.'],
    P3: ['Is that a new kind of parrot?', 'Hover any closer and ye buy the grog.'],
    ST: ['A customer! I can feel it!', 'Interested? You look interested!'],
    CA: ['Stop hovering. It is rude.', 'Want a lesson too?'],
    LC: ['You dare point at LeChuck?', 'I can see you, mortal.'],
    EL: ['Can I help you with something?', 'I see you there.'],
    MK: ['Eek?', 'Eek eek!'],
  }
  const PROP_LINES = {
    puddle: { verb: 'Look at puddle', lines: ["It's eating through the floorboards.", 'I think it just hissed at me.', 'Somewhere, a mug mourns.'] },
    rope: { verb: 'Look at washing line', lines: ['A washing line. Chicken-compatible.', 'Taut, sturdy, slightly damp.'] },
  }
  const SPOTS = {
    eyes: { verb: 'Look at strange eyes' },
    title: { verb: 'Read sign' },
    glyph: { verb: 'Look at diamond' },
    min: { verb: 'Push minimize button' },
    max: { verb: 'Push maximize button' },
    close: { verb: 'Use close button' },
  }

  // ---- runtime ---------------------------------------------------------------------
  function lineMs(text) {
    return clamp(1600 + text.length * 62, 2500, 4500)
  }
  function speak(s, key, text, fromStep = -1) {
    const d = s.data
    const now = performance.now()
    const who = key === 'VL' ? null : d.cast[key]
    const ms = lineMs(text)
    d.line = { who, key, text, until: now + ms, start: now, color: CAST[key].color, step: fromStep }
    // the salesman never stops moving: his arms change with every sentence
    if (who && who.key === 'ST' && (who.pose === 'wave' || who.pose === 'wave2')) who.pose = who.pose === 'wave' ? 'wave2' : 'wave'
    return ms
  }
  function card(s, text) {
    s.data.card = { text, until: performance.now() + 3200 }
    return 3400
  }
  const live = (s, k) => s.data.cast[k].on

  function startEpisode(s) {
    const d = s.data
    d.scenes = EPISODES[d.ep % EPISODES.length]()
    d.sc = 0
  }
  function nextScene(s) {
    const d = s.data
    d.sc++
    if (d.sc >= d.scenes.length) {
      d.ep = (d.ep + 1) % (EPISODES.length * 1000)
      startEpisode(s)
    }
    d.frames = [{ steps: d.scenes[d.sc], i: 0, base: true, variant: Math.floor(Math.random() * 6) }]
    d.puddle = null
    d.melt = 0
  }

  function whereOf(s, ref, me) {
    const d = s.data
    if (ref === 'L') return me.x - 50
    if (ref === 'R') return me.x + 50
    return d.cast[ref].x
  }

  /** Run one op; returns ms to wait (0 = continue now), or -1 to wait for walkers. */
  function exec(s, op, frame, idx) {
    const d = s.data
    const [k, a, b, c, e] = op
    const ch = d.cast[a]
    if (ch && (k === 'on' || k === 'go' || k === 'off')) ch.extra = false
    switch (k) {
      case 'card':
        return card(s, a)
      case 'on': {
        if (!ch.on) {
          ch.on = true
          ch.x = spot(s, c || 'offL')
          ch.pose = 'stand'
          ch.item = null
          ch.yOff = 0
          ch.ride = null
        }
        ch.goto(spot(s, b), null, b)
        d.waitWalk = !e
        return e ? 0 : -1
      }
      case 'go':
        if (!ch.on) {
          ch.on = true
          ch.x = spot(s, b) < s.W / 2 ? -16 : s.W + 16
        }
        ch.goto(spot(s, b), null, b)
        d.waitWalk = !c
        return c ? 0 : -1
      case 'off':
        ch.ride = null
        ch.goto(spot(s, b), () => {
          ch.on = false
        }, b)
        d.waitWalk = !c
        return c ? 0 : -1
      case 'sync':
        d.waitWalk = true
        return -1
      case 'face':
        if (ch.on) ch.face(whereOf(s, b, ch))
        return 0
      case 'pose':
        ch.pose = b
        return 0
      case 'item':
        ch.item = b
        return 0
      case 'wait':
        return a
      case 'say': {
        if (a !== 'VL' && !live(s, a)) return 0
        frame.say = idx
        // one variant per playthrough of a scene, so alternative lines stay a matching set
        const text = Array.isArray(b) ? b[frame.variant % b.length] : b
        return speak(s, a, text, idx) + 250
      }
      case 'punch':
        return 0
      case 'appear':
        ch.on = true
        ch.x = spot(s, b)
        ch.tx = null
        ch.pose = 'stand'
        ch.at = typeof b === 'string' ? b : null
        s.burst(ch.x, FLOOR - 14, 22, GREEN)
        return 900
      case 'vanish':
        if (ch.on) s.burst(ch.x, FLOOR - 14, b ? 46 : 22, b ? ['G', 'y', 'r', 'w', 'c', 'p'] : GREEN)
        ch.on = false
        return b ? 1600 : 700
      case 'ride':
        ch.tx = null
        ch.ride = d.cast[b]
        s.burst(ch.x, FLOOR - 26, 6, ['K', 'k', 'w'])
        return 300
      case 'duel':
        return startRounds(s, a, b)
      case 'fx':
        return fx(s, a, b)
    }
    return 0
  }

  // The washing line: from the hero's stage to the diamond, drawn as a smooth sagging line.
  function rope(s) {
    const x0 = spot(s, 'L1') - 4
    const gl = s.fixture('glyph')
    const x1 = gl && gl.x > x0 + 40 ? gl.x + gl.w / 2 : spot(s, 'R4')
    return { x0, x1, y0: 6, y1: 8 }
  }
  function ropeY(s, x) {
    const r = rope(s)
    const t = clamp((x - r.x0) / Math.max(1, r.x1 - r.x0), 0, 1)
    return r.y0 + (r.y1 - r.y0) * t + 4 * 2 * t * (1 - t)
  }
  function fx(s, name, arg) {
    const d = s.data
    const g = d.cast.G
    switch (name) {
      case 'melt':
        d.melt = arg
        if (arg > 0) s.burst(g.x + g.dir * 6, FLOOR - 9, 4, ['G', 'g'])
        return 300
      case 'puddle':
        d.puddle = { x: g.x + g.dir * 5 }
        d.melt = 0
        g.item = null
        g.pose = 'stand'
        return 300
      case 'clash':
        clashBurst(s)
        return 600
      case 'rope':
        d.rope = true
        return 600
      case 'zip': {
        // the hero hooks the chicken over the line and slides across to the diamond
        const r = rope(s)
        g.item = null
        g.pose = 'hang'
        g.x = r.x0 + 6
        d.zip = true
        g.goto(r.x1 - 3, () => {
          g.item = 'diamond'
          s.burst(r.x1, ropeY(s, r.x1) + 4, 10, ['c', 'w', 'b'])
        }, null, clamp((r.x1 - r.x0) / 3.5, 50, 160))
        d.waitWalk = true
        return -1
      }
      case 'land':
        d.zip = false
        d.rope = false
        g.yOff = 0
        g.pose = 'hold'
        return 400
      case 'spray': {
        const lc = d.cast.LC
        for (let i = 0; i < 18; i++)
          s.particle({ img: pix(pick(['K', 'k', 'N', 'w'])), x: g.x + g.dir * 7, y: FLOOR - 15, vx: Math.sign(lc.x - g.x) * rand(40, 90), vy: rand(-30, 4), g: 60, life: rand(0.5, 1), fade: true })
        return 900
      }
    }
    return 0
  }
  const hookY = (s, g) => Math.round(ropeY(s, g.x) + 2)
  function hangFrom(s) {
    // hands just under the chicken's pulley
    const g = s.data.cast.G
    const sp = g.set.hang
    g.yOff = hookY(s, g) + 3 - (FLOOR - sp.h + sp.off)
  }

  // Duels: a set number of scripted rounds, or a short bout while busy.
  function clashBurst(s) {
    const d = s.data
    const g = d.cast.G
    const o = d.duel?.opp || g
    s.burst((g.x + o.x) / 2, FLOOR - 14, 5, ['w', 'y', 'A'])
  }
  function duelSteps(s, oppKey, n) {
    const d = s.data
    const pool = DUEL_LINES[oppKey] || DUEL_LINES.P
    const out = []
    for (let r = 0; r < n; r++) {
      const oppTurn = d.duelTurn++ % 2 === 0
      const [ins, back] = oppTurn ? pool[Math.floor(Math.random() * pool.length)] : G_INS[Math.floor(Math.random() * G_INS.length)]
      out.push(['say', oppTurn ? oppKey : 'G', ins], ['clash'], ['say', oppTurn ? 'G' : oppKey, back], ['clash', oppTurn ? 'G' : oppKey])
    }
    return out
  }
  function startRounds(s, oppKey, n) {
    const d = s.data
    d.duel = { opp: d.cast[oppKey], key: oppKey }
    d.frames.push({ steps: duelSteps(s, oppKey, n), i: 0, duel: true, variant: 0 })
    return 300
  }
  function clash(s, winnerKey) {
    const d = s.data
    d.clash = { n: 0, at: performance.now(), winner: winnerKey ? d.cast[winnerKey] : null }
  }
  function stepClash(s, now) {
    const d = s.data
    const c = d.clash
    if (!c) return Infinity
    if (now - c.at < 170) return c.at + 170 - now
    c.at = now
    const g = d.cast.G
    const o = d.duel?.opp
    if (!o || !o.on) {
      d.clash = null
      return Infinity
    }
    c.n++
    g.pose = c.n % 2 ? 'lo' : 'hi'
    o.pose = c.n % 2 ? 'hi' : 'lo'
    if (c.n % 2) clashBurst(s)
    if (c.winner && c.n === 3) {
      // the winner presses forward a step, within reason
      const loser = c.winner === g ? o : g
      const away = loser.x > c.winner.x ? 1 : -1
      loser.x = clamp(loser.x + away * 3, 6, s.W - 6)
      c.winner.x = clamp(c.winner.x + away * 3, 6, s.W - 6)
      if (Math.abs(loser.x - c.winner.x) < 14) c.winner.x = loser.x - away * 14
    }
    if (c.n >= 6) {
      g.pose = 'hi'
      o.pose = 'hi'
      d.clash = null
      return Infinity
    }
    return FAST
  }

  // Between the insults of a busy bout the two keep fencing: parries, sparks and footwork.
  function spar(s, now) {
    const d = s.data
    const f = d.fight
    if (!f || !f.spar || f.after || d.clash || !d.duel) return Infinity
    const g = d.cast.G
    const o = d.duel.opp
    if (!o || !o.on || !g.on || g.held || g.moving || o.moving) return Infinity
    if (now < (d.sparAt || 0)) return d.sparAt - now
    d.sparAt = now + rand(160, 300)
    d.sparN = (d.sparN || 0) + 1
    const hi = Math.random() < 0.5
    g.pose = hi ? 'hi' : 'lo'
    o.pose = Math.random() < 0.7 ? (hi ? 'lo' : 'hi') : g.pose
    if (d.sparN % 3 === 0) clashBurst(s)
    if (d.sparN % 5 === 0) {
      // a lunge and a retreat, swapping who presses
      const toward = o.x > g.x ? 1 : -1
      const k = d.sparN % 10 === 0 ? 1 : -1
      g.x = clamp(g.x + toward * 2 * k, 6, s.W - 6)
      o.x = clamp(o.x + toward * 2 * k, 6, s.W - 6)
      g.face(o.x)
      o.face(g.x)
    }
    return FAST
  }

  // Busy: the bar is rowdy. Bystanders bounce on their heels, cheering any fight.
  const CROWD = ['P1', 'P2', 'P3', 'ST', 'CA', 'EL']
  function rowdy(s, now) {
    const d = s.data
    let any = false
    for (const [i, k] of CROWD.entries()) {
      const c = d.cast[k]
      const on = s.busy && c.on && !c.moving && !c.held && !c.ride && (!d.duel || d.duel.opp !== c) && c.x > 0 && c.x < s.W
      const b = on ? (Math.floor(now / 230 + i * 1.7) % 3 === 0 ? -1 : 0) : 0
      if (c.yOff !== b && (on || c.bobbing)) c.yOff = b
      c.bobbing = on
      any ||= on
    }
    return any ? FAST : Infinity
  }

  // Busy: a short insult-swordfight bout, then the story carries on.
  const BOUT_ROUNDS = 3
  function busyFight(s, now) {
    const d = s.data
    if (d.fight || now < d.fightCool) return
    rewindLine(s)
    const g = d.cast.G
    const ep = d.ep % EPISODES.length
    const options = ['P1', 'P2', 'P3'].filter((k) => live(s, k))
    if (ep === 0 || Math.random() < 0.4) options.push('CA')
    if (ep > 0) options.push('LC')
    if (live(s, 'CA')) options.push('CA', 'CA')
    if (live(s, 'LC')) options.push('LC', 'LC')
    const key = pick(options.length ? options : ['CA'])
    const opp = d.cast[key]
    const brought = !opp.on
    d.duel = { opp, key }
    d.fight = { key, brought, home: opp.x, homeAt: opp.at, homePose: opp.pose, gHome: g.on ? g.x : null, gAt: g.at, gPose: g.pose, gItem: g.item }
    g.item = null
    // stage it on whichever side has fewer bystanders
    const t = s.fixture('title')
    const mid = t ? t.x + t.w / 2 : s.W / 2
    const crowd = (left) => Object.values(d.cast).filter((c) => c.on && c !== g && c !== opp && c.x < mid === left).length
    const side = crowd(true) <= crowd(false) ? 'L' : 'R'
    const st = stages(s)[side]
    const span = Math.max(30, st[1] - st[0])
    const ox = Math.round(st[0] + span * 0.2)
    const gx = Math.round(Math.min(st[0] + span * 0.8, ox + 34))
    // already squared up nearby (the pirates' corner): fight right there, no walking
    const gap = Math.abs(opp.x - g.x)
    const inPlace = !brought && g.on && !g.moving && !opp.moving && gap >= 16 && gap <= 90 && g.x > 0 && g.x < s.W && opp.x > 0 && opp.x < s.W
    if (inPlace) d.fight.gHome = null
    const steps = [
      ...(inPlace ? [] : [['go', 'G', gx, true], key === 'LC' && brought ? ['appear', 'LC', ox] : ['on', key, ox, 'offL', true], ['sync']]),
      ['face', 'G', key], ['face', key, 'G'],
      ['say', key, key === 'LC' ? ['Threepwood! Draw your sword!', 'Time to die, Threepwood!'] : key === 'CA' ? ['Again? Fine. En garde!', 'Lesson time, kid.'] : ['En garde, landlubber!', 'Fancy a fight, mighty pirate?']],
      ['pose', 'G', 'hi'], ['pose', key, 'hi'],
      ['bout', key, d.bouts++ ? 2 : BOUT_ROUNDS], // later bouts in a long busy stretch are shorter
    ]
    d.frames.push({ steps, i: 0, fight: true, variant: Math.floor(Math.random() * 6) })
    d.nextAt = 0
  }
  /** won: done arrived mid-fight; otherwise the bout ran its course. */
  function endFight(s, won) {
    const d = s.data
    const f = d.fight
    if (!f || f.after) return
    f.after = true
    d.frames = d.frames.filter((x) => !x.fight && !x.duel)
    d.clash = null
    const g = d.cast.G
    const k = f.key
    const pool = k === 'LC' || k === 'CA' ? k : 'P'
    const steps = []
    if (won) {
      const [ins, back] = WIN[pool]
      steps.push(['say', k, ins], ['say', 'G', back], ['clash', 'G'])
    }
    steps.push(['say', k, CONCEDE[pool]])
    if (won) steps.push(['pose', 'G', 'front'], ['say', 'G', "I'm Guybrush Threepwood, mighty pirate!"])
    steps.push(['pose', 'G', f.gPose === 'hi' ? 'hi' : 'stand'], ['pose', k, f.homePose === 'hi' ? 'hi' : 'stand'])
    if (f.brought) steps.push(k === 'LC' ? ['vanish', 'LC'] : ['off', k, 'offL', true])
    else steps.push(['go', k, f.homeAt || f.home, true])
    if (f.gHome !== null) steps.push(['go', 'G', f.gAt || f.gHome, true])
    steps.push(['sync'], ['item', 'G', f.gItem], ['endfight'])
    d.frames.push({ steps, i: 0, fight: true, after: true, variant: Math.floor(Math.random() * 6) })
    d.nextAt = 0
    g.tx = null
  }

  /** Put an interrupted script line back to be said again (unless it was mostly heard). */
  function rewindLine(s, heard = Infinity) {
    const d = s.data
    const L = d.line
    const now = performance.now()
    if (L && now < L.until && L.step >= 0 && now - L.start < heard) {
      const fr = d.frames[d.frames.length - 1]
      if (fr && fr.say === L.step) fr.i = L.step
    }
    d.line = null
  }

  function runScript(s, now) {
    const d = s.data
    for (let guard = 0; guard < 60; guard++) {
      if (now < d.nextAt) return d.nextAt - now
      if (d.waitWalk) {
        if (Object.values(d.cast).some((c) => c.moving && !c.extra)) return Infinity // walkers tick FAST themselves
        d.waitWalk = false
      }
      if (d.clash) return Infinity
      const fr = d.frames[d.frames.length - 1]
      if (!fr) {
        nextScene(s)
        continue
      }
      if (fr.i >= fr.steps.length) {
        if (fr.base) nextScene(s)
        else d.frames.pop()
        continue
      }
      const idx = fr.i++
      const op = fr.steps[idx]
      if (idx >= (fr.hi ?? 0)) {
        // a new step (not a replay of an interrupted line): the story is back on time
        fr.hi = idx + 1
        d.plotDue = 0
      }
      if (op[0] === 'clash') {
        clash(s, op[1])
        d.nextAt = now + 900
        continue
      }
      if (op[0] === 'bout') {
        // a busy bout: a few rounds, then the opponent gives up
        if (d.fight) d.fight.spar = true
        d.frames.push({ steps: [...duelSteps(s, op[1], op[2]), ['outlasted']], i: 0, duel: true, variant: 0 })
        continue
      }
      if (op[0] === 'outlasted') {
        endFight(s, false)
        continue
      }
      if (op[0] === 'endfight') {
        d.fight = null
        d.duel = null
        // while the agent keeps working, another challenger turns up soon
        d.fightCool = now + (s.busy ? rand(14000, 22000) : 30000)
        continue
      }
      const ms = exec(s, op, fr, idx)
      if (op[0] === 'duel') continue
      if (ms < 0) {
        d.nextAt = 0
        return Infinity
      }
      d.nextAt = now + ms
    }
    return FAST
  }

  // ---- interaction --------------------------------------------------------------------
  function aside(s, key, text) {
    const d = s.data
    const now = performance.now()
    if (d.plotDue && now - d.plotDue > 3500) {
      // the story has waited long enough: remarks float up without holding it back
      const who = key === 'VL' ? null : d.cast[key]
      s.say(text, who ? who.x : s.W / 2, 9, { color: CAST[key].color, life: 2.4, size: 8 })
      return
    }
    const due = d.nextAt
    rewindLine(s, 1400)
    const ms = speak(s, key, text)
    // the story only steps aside briefly: its next line takes over after a couple of seconds
    d.nextAt = Math.max(d.nextAt, now + Math.min(ms + 300, 2400))
    if (d.nextAt > due && !d.plotDue) d.plotDue = Math.max(due, now)
  }
  // someone is playing: a click or drag in the last 9 s, or the cursor moving over the bar
  const engaged = (s, now) =>
    now - s.keyAt < 9000 || now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (s.cursor && now - s.cursor.since < 2500)

  // ---- keyboard: A/D walk the hero, W talks to whoever is nearest, S looks around, Space skips the line ----
  function keyWalkDir(s) {
    const d = s.data
    const g = d.cast.G
    const lr = (s.keys.has('right') ? 1 : 0) - (s.keys.has('left') ? 1 : 0)
    if (!lr || !g.on || g.held || d.zip || g.ride || d.resting || (d.fight && d.fight.spar && !d.fight.after)) return 0
    return lr
  }
  function onKey(s, k, down) {
    const d = s.data
    if (!down || !d.cast) return
    const now = performance.now()
    if (d.resting) leaveRest(s, now)
    const g = d.cast.G
    if (k === 'fire') {
      const L = d.line
      if (L && now < L.until) {
        // the classic adventure-game skip-line
        d.line = null
        if (L.step >= 0) d.nextAt = Math.min(d.nextAt, now + 150)
        return
      }
      if (!g.on || g.held || d.zip) return
      if (d.fight && d.fight.spar && !d.fight.after) {
        // a lunge of your own between insults
        g.pose = g.pose === 'hi' ? 'lo' : 'hi'
        clashBurst(s)
        return
      }
      if (!d.fight && ['stand', 'hold', 'chin', 'talk'].includes(g.pose)) {
        const prev = g.pose
        g.pose = 'front'
        aside(s, 'G', "I'm Guybrush Threepwood, mighty pirate!")
        d.timers.push({ at: now + 2800, fn: () => g.pose === 'front' && (g.pose = prev) })
      }
      return
    }
    if (!g.on) return
    if (k === 'up') {
      let best = null
      for (const c of Object.values(d.cast))
        if (c !== g && c.on && c.x > 0 && c.x < s.W && Math.abs(c.x - g.x) < 90 && (!best || Math.abs(c.x - g.x) < Math.abs(best.x - g.x))) best = c
      if (best) {
        g.face(best.x)
        clickChar(s, best)
      } else aside(s, 'G', pick(['Nobody to talk to. Story of my life.', 'Hello? Anyone? Pirates?']))
    } else if (k === 'down') {
      const props = s.actors.find((a) => a instanceof Props)
      if (d.puddle && Math.abs(d.puddle.x - g.x) < 24) props.onClick({ x: d.puddle.x, y: FLOOR - 1 })
      else clickChar(s, g)
    }
  }

  function clickChar(s, ch) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    if (d.resting) leaveRest(s, now)
    if (!ch.on) return
    // click whoever is talking and they hurry up (the classic adventure-game skip-line); the plot just moves on
    const L = d.line
    if (L && L.who === ch && now < L.until && L.step >= 0) {
      d.line = null
      d.nextAt = Math.min(d.nextAt, now + 150)
      return
    }
    if (ch.key === 'G') {
      d.gClicks = (d.gClicks || []).filter((t) => now - t < 2600)
      d.gClicks.push(now)
      if (d.gClicks.length >= 5 && !d.fight && !d.zip && !ch.held) {
        d.gClicks.length = 0
        return lookBehind(s)
      }
    }
    let list = LOOKS[ch.key]
    let tag = ch.key
    if (d.duel && (ch === d.duel.opp || ch.key === 'G') && ch.pose !== 'stand') [list, tag] = [DUEL_POKE, 'duel']
    else if (ch.key === 'G' && ch.pose === 'blue') [list, tag] = [['Mmmph!', 'Mmm-mmph mmph!'], 'blue']
    else if (ch.key === 'G' && ch.item && ITEM_LINES[ch.item]) [list, tag] = [ITEM_LINES[ch.item], ch.item]
    d.look[tag] = ((d.look[tag] ?? -1) + 1) % list.length
    aside(s, ch.key, list[d.look[tag]])
  }
  function dblChar(s, ch) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    const g = d.cast.G
    if (d.resting || !ch.on) return
    if (ch.key === 'G' && !ch.held && !d.fight && !d.zip && ['stand', 'hold', 'chin', 'front', 'talk'].includes(ch.pose)) {
      // "I can hold my breath for ten minutes!"
      const prev = ch.pose
      ch.pose = 'blue'
      aside(s, 'G', '(holds breath)')
      d.timers.push({ at: now + 2800, fn: () => {
        if (ch.pose !== 'blue') return
        ch.pose = prev
        aside(s, 'G', pick(BREATH_END))
      } })
      return
    }
    if (ch.key === 'LC' && g.on && !g.held && !d.zip && !g.ride && g.fallV === undefined) {
      // BOO: the hero jumps out of his boots
      aside(s, 'LC', 'BOO!')
      g.yOff = -6
      g.fallV = -30
      d.timers.push({ at: now + 900, fn: () => aside(s, 'G', pick(['Yikes!', 'I was NOT scared.', 'My boots! Where are my... oh.'])) })
      return
    }
    clickChar(s, ch)
  }
  // Five quick clicks on the hero: the oldest trick in the Caribbean, and this time it is real.
  function lookBehind(s) {
    const d = s.data
    const g = d.cast.G
    const now = performance.now()
    const l = 'Look behind you! A three-headed monkey!'
    aside(s, 'G', l)
    const t0 = now + lineMs(l) + 200
    const others = ['P1', 'P2', 'P3', 'ST', 'CA', 'EL', 'LC'].map((k) => d.cast[k]).filter((c) => c.on && c.x > 0 && c.x < s.W)
    d.timers.push({ at: t0, fn: () => {
      for (const c of others) if (c.on && !c.moving) c.dir = c.x > g.x ? 1 : -1
      if (others[0] && others[0].on) aside(s, others[0].key, 'Where?!')
    } })
    const mk = d.cast.MK
    const real = !mk.on && Math.random() < 0.6
    if (real)
      d.timers.push({ at: t0 + 700, fn: () => {
        if (mk.on || d.resting) return
        // it actually scampers across, behind everyone's backs
        const fromR = g.x < s.W / 2
        mk.on = true
        mk.ride = null
        mk.yOff = 0
        mk.x = fromR ? s.W + 16 : -16
        mk.goto(fromR ? -16 : s.W + 16, () => {
          mk.on = false
          mk.extra = false
        }, null, 150)
        mk.extra = true // a cameo: the script never waits on it
        aside(s, 'MK', 'Eek! Eek! Eek!')
      } })
    d.timers.push({ at: t0 + 3000, fn: () => {
      const o = others.find((c) => c.on)
      if (o) {
        o.face(g.x)
        aside(s, o.key, real ? pick(['...Did anyone else see that?', 'Blimey. There WAS one.']) : 'Hey! There is no monkey!')
      } else if (g.on) aside(s, 'G', real ? 'Huh. There really was one.' : 'Works every time.')
    } })
    if (d.timers.length > 24) d.timers.splice(0, d.timers.length - 24)
  }
  // pick the hero up by the scruff; the plot waits on him only if it needed him to walk somewhere
  function grabGuy(s, g, p) {
    const d = s.data
    const now = performance.now()
    d.grabAt = now
    if (!g.grabbable || g.held) return
    g.held = { pose: g.pose }
    g.fallV = undefined
    g.zz = false
    g.pose = 'hang'
    aside(s, 'G', pick(GRAB_LINES))
    g.drag(p)
  }
  function dropGuy(s, g) {
    const d = s.data
    const now = performance.now()
    d.grabAt = now
    if (!g.held) return
    if (g.pose === 'hang') g.pose = g.held.pose === 'hang' ? 'stand' : g.held.pose
    g.held = null
    g.fallV = 0
    d.timers.push({ at: now + 500, fn: () => g.on && aside(s, 'G', pick(DROP_LINES)) })
    // then wander back to his mark, if the scene has one for him
    d.timers.push({ at: now + 3200, fn: () => {
      if (!g.on || g.held || g.moving || d.fight || d.zip || d.resting) return
      if (typeof g.at === 'string' && !g.at.startsWith('off') && g.at[0] !== '@') {
        const x = spot(s, g.at)
        if (Math.abs(x - g.x) > 4) g.goto(x, null, g.at)
      }
    } })
  }
  function spotAt(s, p) {
    for (const f of s.dots) if (p.x >= f.x - 2 && p.x <= f.x + f.w + 2 && p.y >= f.y - 2 && p.y <= f.y + f.h + 2) return f
    for (const f of s.fix) if (f.kind !== 'controls' && p.x >= f.x - 1 && p.x <= f.x + f.w + 1 && p.y >= f.y - 1 && p.y <= f.y + f.h + 1) return f
    return null
  }
  function hoverVerb(s) {
    const c = s.cursor
    if (!c || c.y < 0 || c.y > H || c.x < 0 || c.x > s.W) return null
    const d = s.data
    const a = s.actorAt(c)
    if (a && a.verbAt) return a.verbAt(c)
    if (a && a.key) return a.key === 'G' ? (a.held ? 'Put down Guybrush' : 'Talk to Guybrush') : `Talk to ${CAST[a.key].name}`
    const f = spotAt(s, c)
    if (f && SPOTS[f.kind]) return SPOTS[f.kind].verb
    return d.cast.G.on ? 'Walk to' : null
  }

  // ---- rest ---------------------------------------------------------------------------
  function enterRest(s) {
    const d = s.data
    d.resting = true
    rewindLine(s)
    d.card = null
    d.clash = null
    if (d.fight && !d.fight.after) {
      // abandon the bout; tidy up when the bar wakes again
      d.frames = d.frames.filter((x) => !x.fight && !x.duel)
      d.restoreFight = d.fight
      d.fight = null
      d.duel = null
    }
    for (const c of Object.values(d.cast)) {
      if (!c.on) continue
      c.resume = c.tx !== null ? { tx: c.tx, cb: c.cb, speed: c.speed, at: c.at } : null
      c.tx = null
      c.cb = null
      if (c.ghost) c.yOff = 0
      if (['hi', 'lo', 'hiTalk', 'wave', 'wave2'].includes(c.pose)) c.pose = 'stand'
      if (c.ride) continue
      if (c.key === 'G' && d.zip) continue
      if (c.x < -4 || c.x > s.W + 4) continue // still in the wings
      if (overFurniture(s, c.x) || c.x < 4 || c.x > s.W - 4) c.goto(openX(s, clamp(c.x, 4, s.W - 4)), c.key === 'G' ? () => sitDown(s) : null, c.at)
    }
    const g = d.cast.G
    if (!g.on) {
      g.on = true
      g.x = -16
      g.pose = 'stand'
      g.goto(spot(s, 'L2'), () => sitDown(s), 'L2')
    } else if (!g.moving && !d.zip) sitDown(s)
  }
  function sitDown(s) {
    const g = s.data.cast.G
    if (g.pose !== 'sit') g.restPose = g.pose
    g.pose = 'sit'
    g.zz = true
  }
  function leaveRest(s, now) {
    const d = s.data
    d.resting = false
    const g = d.cast.G
    g.zz = false
    if (g.pose === 'sit') g.pose = g.restPose && g.restPose !== 'sit' && g.restPose !== 'blue' ? g.restPose : 'stand'
    for (const c of Object.values(d.cast)) {
      if (c.resume && c.on) {
        c.tx = c.resume.tx
        c.cb = c.resume.cb
        c.speed = c.resume.speed
        c.at = c.resume.at
      }
      c.resume = null
    }
    const f = d.restoreFight
    d.restoreFight = null
    if (f) {
      // the interrupted bout ends without a winner; everyone goes back
      d.fight = f
      endFight(s, false)
    }
    d.nextAt = now + 900
  }

  // ---- setup / update -------------------------------------------------------------------
  function setup(s) {
    for (const k of Object.keys(DEFS)) if (!SETS[k]) SETS[k] = buildSet(k)
    if (!SETS.MK) {
      const st = mkMonkey(MK_LEGS[0], false)
      SETS.MK = { stand: st, talk: mkMonkey(MK_LEGS[0], true), walk: [mkMonkey(MK_LEGS[1]), st, mkMonkey(MK_LEGS[2]), st] }
    }
    const d = s.data
    d.W = s.W
    d.cast = {}
    for (const k of [...Object.keys(DEFS), 'MK']) {
      const c = new Char(k)
      c.s = s
      d.cast[k] = c
      s.actors.push(c)
    }
    s.actors.push(new Props(s))
    d.ep = 0
    startEpisode(s)
    // the bar opens with the hero and the three pirates already in place
    for (const [k, at] of [['P1', 'R2'], ['P2', 'R3'], ['P3', 'R4'], ['G', 'R0']]) {
      const c = d.cast[k]
      c.on = true
      c.x = spot(s, at)
      c.at = at
      c.dir = k === 'G' ? 1 : -1
    }
    d.frames = [{ steps: d.scenes[d.sc], i: 0, base: true, variant: Math.floor(Math.random() * 6) }]
    d.nextAt = performance.now() + 600
    d.line = null
    d.card = null
    d.look = {}
    d.timers = []
    d.melt = 0
    d.duelTurn = 0
    d.fightCool = 0
    d.bouts = 0
    d.resting = false
    d.clickAt = -1e9
    d.grabAt = -1e9
    d.noticeAt = 0
    d.monkeyAt = 0
    d.startleAt = 0
  }

  function update(s, dt, now) {
    const d = s.data
    if (d.line && now >= d.line.until) d.line = null
    if (d.card && now >= d.card.until) d.card = null
    d.cast.G.keyWalk = s.lively(now) && !d.resting ? keyWalkDir(s) : 0
    if (!s.lively(now)) {
      if (!d.resting) enterRest(s)
      return Infinity
    }
    if (d.resting) leaveRest(s, now)
    if (d.cast.G.keyWalk && d.cast.G.pose === 'sit') d.cast.G.pose = 'stand'
    if (d.wantFight && !d.zip) {
      d.wantFight = false
      if (s.busy) busyFight(s, now)
    }
    // busy: the bar never stays peaceful for long
    if (s.busy && !d.fight && !d.zip && !d.card && !d.waitWalk && !d.clash && now > d.fightCool && !d.cast.G.held) busyFight(s, now)
    let wait = Infinity
    if (d.timers.length) {
      const due = d.timers.filter((t) => t.at <= now)
      d.timers = d.timers.filter((t) => t.at > now)
      for (const t of due) t.fn()
      for (const t of d.timers) wait = Math.min(wait, t.at - now)
    }
    wait = Math.min(wait, stepClash(s, now))
    wait = Math.min(wait, spar(s, now))
    wait = Math.min(wait, rowdy(s, now))
    wait = Math.min(wait, runScript(s, now))
    if (d.zip) hangFrom(s)
    // the hero glances at a lingering cursor (coarse updates: long cooldown);
    // while you are playing he keeps an eye on it properly
    const g = d.cast.G
    const c = s.cursor
    const user = engaged(s, now)
    if (g.on && !g.moving && !g.keyWalk && !g.held && !d.fight && !d.zip && c && c.y >= 0 && c.y <= H && !(d.line && d.line.who === g)) {
      if (user ? Math.abs(c.x - g.x) > 12 : Math.abs(c.x - g.x) > 30 && !(d.line && d.line.who)) g.face(c.x, now, user ? 700 : 2500)
    }
    if (c && c.y >= 0 && c.y <= H) wait = Math.min(wait, cursorReactions(s, now, c))
    if (d.line) wait = Math.min(wait, d.line.until - now)
    if (d.card) wait = Math.min(wait, d.card.until - now)
    if (!s.busy) wait = Math.min(wait, Math.max(50, s.lastTouch + 30000 + 20 - now))
    if (s.keys.size) wait = Math.min(wait, FAST)
    return Math.max(10, wait)
  }

  // characters notice the cursor: a hover gets a remark, the monkey bolts, a fast swipe startles the hero
  function cursorReactions(s, now, c) {
    const d = s.data
    if (d.resting || d.card) return Infinity
    const g = d.cast.G
    const mk = d.cast.MK
    if (mk.on && !mk.ride && mk.tx === null && Math.abs(c.x - mk.x) < 14 && now > d.monkeyAt) {
      d.monkeyAt = now + 1500
      const away = mk.x > c.x ? 1 : -1
      mk.x = clamp(mk.x + away * 12, 8, s.W - 8)
      mk.dir = -away
      s.burst(mk.x, FLOOR - 4, 3, ['k', 'w'])
      if (!d.line) speak(s, 'MK', 'Eek!')
      return FAST
    }
    if (g.on && !g.held && !d.zip && !g.ride && g.fallV === undefined && (c.speed || 0) > 450 && Math.abs(c.x - g.x) < 10 && now > d.startleAt) {
      d.startleAt = now + 12000
      g.yOff = -4
      g.fallV = -20
      if (!d.line) speak(s, 'G', pick(['Whoa!', 'Did a seagull just...?']))
      return FAST
    }
    if (d.line || (c.speed || 0) > 40 || now < d.noticeAt || now - c.since < 1100) return Infinity
    const who = Object.values(d.cast).find((ch) => ch.on && !ch.moving && !ch.held && ch.x > 0 && ch.x < s.W && Math.abs(c.x - ch.x) <= 8 && c.y > 6)
    if (!who) return Infinity
    d.noticeAt = now + 15000
    if (who !== g || !d.fight) who.face(c.x)
    aside(s, who.key, pick(NOTICE[who.key]))
    return Infinity
  }

  function textBox(c, s, str, x) {
    c.font = FONT
    const w = c.measureText(str).width
    const tx = Math.round(clamp(x - w / 2, 1, s.W - w - 1))
    return [tx, tx + w]
  }
  function text(c, s, str, x, y, color) {
    const [tx] = textBox(c, s, str, x)
    c.textBaseline = 'top'
    c.lineWidth = 2
    c.strokeStyle = 'rgba(0,0,0,.9)'
    c.strokeText(str, tx, y)
    c.fillStyle = color
    c.fillText(str, tx, y)
  }
  function drawRope(s, c) {
    const d = s.data
    const r = rope(s)
    c.strokeStyle = ROPE
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(r.x0, r.y0)
    if (d.zip) {
      // the line dips where the chicken hangs on it
      const g = d.cast.G
      c.lineTo(g.x, hookY(s, g))
      c.lineTo(r.x1, r.y1)
    } else c.quadraticCurveTo((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + 4, r.x1, r.y1)
    c.stroke()
    // pegs at both ends
    c.fillStyle = ROPE
    c.fillRect(Math.round(r.x0) - 1, r.y0 - 1, 2, 3)
    c.fillRect(Math.round(r.x1) - 1, r.y1 - 1, 2, 3)
  }

  registerConcept({
    key: 'pirateadventure',
    title: 'Pirate adventure',
    blurb:
      'A three-part adventure plays out in the bar by itself and keeps looping with shuffled scenes and new lines: the hero meets the three important-looking pirates, drinks mug-melting grog, dodges the ship salesman, passes the swordmaster, zip-lines over the sign on his rubber chicken to steal the diamond and faces the ghost pirate; part two ends with root beer, part three with a real three-headed monkey. Each character talks in their own colour. Hover for the sentence line; characters notice a lingering <b>cursor</b>, the monkey bolts from it and the hero keeps an eye on it. Click anyone for a remark that fits the moment (what the hero is holding, a poke mid-duel), click whoever is talking to hurry the line along, click the grog puddle or the washing line, pick the hero up and drop him somewhere, double-click him to hold his breath, double-click the ghost pirate for a BOO. Click the hero five times fast and he tries the old three-headed-monkey trick; sometimes it is real. The story never waits for you. Working turns the bar rowdy, with insult swordfights breaking out every so often; done wins the bout or brings on the scene’s punchline, and when idle the hero sits down for a nap and the story waits.',
    setup,
    update,
    onBusy(s) {
      s.data.bouts = 0
      s.data.wantFight = true
    },
    onDone(s) {
      const d = s.data
      d.wantFight = false
      if (d.fight && !d.fight.after) return endFight(s, true)
      if (d.resting || d.fight) return
      const fr = d.frames.find((x) => x.base)
      const p = fr.steps.findIndex((o) => o[0] === 'punch')
      const linesLeft = fr.steps.slice(fr.i, p).filter((o) => o[0] === 'say').length
      if (p > 0 && fr.i <= p && linesLeft <= 4 && !d.waitWalk && !d.zip) {
        // close to the punchline: deliver it now
        const duel = d.frames.find((x) => x.duel)
        if (duel) d.frames = d.frames.filter((x) => x !== duel)
        d.clash = null
        rewindLine(s)
        d.line = null
        fr.i = p
        d.nextAt = 0
      } else if (d.cast.G.on && !d.frames.some((x) => x.duel)) {
        d.quip = ((d.quip ?? -1) + 1) % QUIPS.length
        aside(s, 'G', QUIPS[d.quip])
      }
    },
    onKey,
    onNap(s) {
      s.data.wantFight = false
    },
    relayout(s) {
      const d = s.data
      if (!d.cast) return
      const k = d.W ? s.W / d.W : 1
      d.W = s.W
      // re-anchor to named stage spots so nobody ends up on the title or the dots
      for (const c of Object.values(d.cast)) {
        if (!c.on || c.ride) continue
        if (typeof c.at === 'string' && c.at[0] !== '@') {
          if (c.tx !== null) c.tx = spot(s, c.at)
          else c.x = spot(s, c.at)
        } else {
          c.x = Math.round(clamp(c.x * k, 6, s.W - 6))
          if (c.tx !== null) c.tx = Math.round(clamp(c.tx * k, -16, s.W + 16))
        }
      }
      if (d.puddle) d.puddle.x = clamp(d.puddle.x * k, 4, s.W - 8)
      s.poke()
    },
    drawBehind(s, c) {
      const d = s.data
      if (d.puddle) c.drawImage(PUDDLE, Math.round(d.puddle.x - 3), FLOOR - 2)
      if (d.rope) drawRope(s, c)
    },
    drawFront(s, c) {
      const d = s.data
      const now = performance.now()
      if (d.zip) {
        const g = d.cast.G
        c.drawImage(CHICKEN, Math.round(g.x - 4), hookY(s, g) - 3)
      }
      let band = null
      if (d.card && now < d.card.until) {
        text(c, s, d.card.text, s.W / 2, 0, CARD)
        band = textBox(c, s, d.card.text, s.W / 2)
      } else if (d.line && now < d.line.until) {
        const L = d.line
        const e = s.fixture('eyes')
        const x = L.who ? L.who.x : e ? e.x + e.w / 2 + 24 : 40
        text(c, s, L.text, x, 0, L.color)
        band = textBox(c, s, L.text, x)
      }
      // the sentence line shares the top band; it only shows where it doesn't touch the dialogue
      const v = hoverVerb(s)
      if (!v) return
      const [a, b] = textBox(c, s, v, s.cursor.x)
      if (!band || b + 8 < band[0] || a - 8 > band[1]) text(c, s, v, s.cursor.x, 0, SENTENCE)
    },
  })
})()
