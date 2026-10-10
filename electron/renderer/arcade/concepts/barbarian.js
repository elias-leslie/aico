;(() => {
  // Barbarian: The Ultimate Warrior (Palace Software, 1987), sold in the US as
  // Death Sword. Big version: two ~24 px barbarians duel along the floor of the
  // bar in front of the furniture. A lost head is kicked away by the goblin, who
  // then drags the body off; Princess Mariana comes to the winner's feet.

  // ---- palette -------------------------------------------------------------
  const BP = {
    Y: '#f2cc4e', y: '#b8862a', w: '#fff3a0', // hair
    S: '#e39a68', l: '#ffc996', s: '#a8603a', d: '#6e3a1e', // skin, light, shade, muscle line
    E: '#151515', m: '#7a2418', R: '#d8302a', // eye, mouth, headband
    L: '#c43426', M: '#76160f', // loincloth
    k: '#5a3414', g: '#f0c040', // belt, buckle
    B: '#8a5428', b: '#4e2c10', F: '#d8c090', // boots, fur
    A: '#eef3f8', a: '#7f8c9c', G: '#d8a830', h: '#5a3010', // sword
    r: '#c4161c', q: '#7a0a0e', // blood
    // goblin
    v: '#6fae3c', V: '#3c6e20', x: '#1f3d10', Q: '#ffe040', n: '#8a6034', N: '#5a3a1c', W: '#f2efe6',
    // princess
    P: '#f4f0f8', p: '#c9b4dc', o: '#8a6fae', c: '#ff7aa8',
  }
  // the challenger: dark hair, blue-black loincloth, grey headband
  const P2 = { Y: 'J', y: 'j', w: 'J', L: 'U', M: 'u', R: 'T' }
  Object.assign(BP, { J: '#4a2c16', j: '#24140a', U: '#3a5ec8', u: '#1c2a6e', T: '#e8e4dc' })

  // ---- frame grids (facing right) -----------------------------------------
  // Upper body: head to waist, 13 rows, body centre on column 7. 'H' marks the
  // sword hand (drawn as skin; the hilt passes through it). `oy` = rows above
  // the head (raised arms).
  const U = {
    guard: [
      '.....wYYY.......',
      '....YYRRRR......',
      '...YYYlSSE......',
      '...YYYSSSSl.....',
      '...yYYsSSm......',
      '...yYy.sSS......',
      '...yySSSSSs.....',
      '..sSSlSSSSlSs...',
      '.sSlllSSSlllSs..',
      '.SSSSSsSSSSsSSs.',
      '.sSSdSSdSSs.sSSs',
      '..sSdSSdSs...SHH',
      '..sSSSSSSs......',
    ],
    back: [
      '.....wYYY.......',
      '....YYRRRR......',
      '...YYYlSSE......',
      '...YYYSSSSl.....',
      '...yYYsSSm......',
      '..HHYy.sSS......',
      '.sSSSSSSSSs.....',
      '.sSSSSSSSSSSs...',
      '..ssssssslSSSs..',
      '..SSSSSdSSSsSs..',
      '..sSSdSSdSSs....',
      '...sSSdSdSs.....',
      '...sSSdSdSs.....',
    ],
    forward: [
      '.....wYYY..........',
      '....YYRRRR.........',
      '...YYYlSSE.........',
      '...YYYSSSSl........',
      '...yYYsSSm.........',
      '...yYy.sSS.........',
      '...yySSSSSSsss.....',
      '..sSSlSSSSlSSSSSSHH',
      '.sSlllSSSlllssssss.',
      '.SSSSSsSSSSs.......',
      '.sSSdSSdSSs........',
      '..sSSSSSSs.........',
      '..sSSSSSSs.........',
    ],
    raised: [
      '.......HH.......',
      '.....sSSSSs.....',
      '...sSs....sSs...',
      '..sS........Ss..',
      '.sS..wYYY...Ss..',
      '.SS.YYRRRR..SS..',
      '.SsYYYlSSE..Ss..',
      '.SsYYYSSSSl.SS..',
      '.sSyYYsSSm.sSs..',
      '.sSyYy.sSS.sS...',
      '.sSyySSSSSsSS...',
      '.sSSlSSSSlSSs...',
      '.sSlllSSlllSs...',
      '.SSSSSsSSSSsSs..',
      '.sSSdSSdSSs.....',
      '..sSSSSSSs......',
      '..sSSSSSSs......',
    ],
    chop: [
      '.....wYYY.......',
      '....YYRRRR......',
      '...YYYlSSE......',
      '...YYYSSSSl.....',
      '...yYYsSSm......',
      '...yYy.sSS......',
      '...yySSSSSss....',
      '..sSSlSSSSlSSs..',
      '.sSlllSSSlllSSs.',
      '.SSSSSsSSSSs.sSs',
      '.sSSdSSdSSs...sSH',
      '..sSSSSSSs.....H.',
      '..sSSSSSSs.......',
    ],
    low: [
      '......wYYY.......',
      '.....YYRRRR......',
      '....YYYlSSE......',
      '....YYYSSSSl.....',
      '....yYYsSSm......',
      '...yyYy.sSS......',
      '..yyySSSSSSs.....',
      '.sSSSlSSSSlSs....',
      '.sSlllSSSlllSs...',
      '.SSSSSsSSSSsSSs..',
      '.sSSdSSdSSs.sSSs.',
      '..sSdSSdSs...sSSHH',
      '..sSSSSSSs.......',
    ],
    block: [
      '.....wYYY.......',
      '....YYRRRR......',
      '...YYYlSSE......',
      '...YYYSSSSl.....',
      '...yYYsSSm......',
      '...yYy.sSS......',
      '...yySSSSSsSs...',
      '..sSSlSSSSlSHs..',
      '.sSlllSSSllsHs..',
      '.SSSSSsSSSSss...',
      '.sSSdSSdSSs.....',
      '..sSSSSSSs......',
      '..sSSSSSSs......',
    ],
    hurt: [
      '...wYYY.........',
      '..YYRRRR........',
      '.YYYlSSE........',
      '.YYYSSSSl.......',
      '.yYYsSmm........',
      '.yYy.sSS........',
      '..yySSSSSs......',
      '..sSlSSSSlSs....',
      '.sSlllSSllSSs...',
      '.SSSSdSSSSssSs..',
      '.sSdSdSdSs..sSs.',
      '..sSdSdSs....sH.',
      '..sSSSSSSs......',
    ],
    victory: [
      '..........HH....',
      '.........sSs....',
      '.........sSs....',
      '.....wYYYsS.....',
      '....YYRRRSs.....',
      '...YYYlSSESs....',
      '...YYYSSSSSs....',
      '...yYYsSSmS.....',
      '...yYy.sSSs.....',
      '...yySSSSSSs....',
      '..sSSlSSSSlSs...',
      '.sSlllSSSlllSs..',
      'sSSSSSdSSSSs....',
      'SS.SSdSdSs......',
      'sSSsdSSdSs......',
      '..sSSSSSSs......',
    ],
    butt: [
      '................',
      '................',
      '........wYYY....',
      '.......YYRRRR...',
      '......yYYYlSSE..',
      '.....yyYYYSSSSl.',
      '....yySSSyYsSm..',
      '..sSSSSSSSSSs...',
      '.sSlllSSlllSs...',
      '.SSSSSsSSSSsSs..',
      '.sSSdSSdSSs.sSs.',
      '..sSdSSdSs...SHH',
      '..sSSSSSSs......',
    ],
    spin: [
      '.....yYYYw......',
      '....RRRRRRR.....',
      '....YYYYYYY.....',
      '....YYwYYYY.....',
      '....yYYYYYy.....',
      '....yYYYYYy.....',
      '..sSyYYYYYySs...',
      '.sSSSyYYYySSSs..',
      '.SSSSSyyySSSSS..',
      '.sSSdSSSSSdSSs..',
      '..sSSdSSSdSSs...',
      '..sSSSdSdSSSs...',
      '...sSSSdSSSs....',
    ],
  }
  U.raised.oy = 4
  U.victory.oy = 3
  // doze: chin dropped, eye shut
  U.doze = U.guard.map((r, i) => (i === 0 ? '................' : i <= 6 ? `.${U.guard[i - 1].slice(0, 15)}` : r).replace('E', 's'))
  // headless: the guard body with a bloody stump
  U.headless = U.guard.map((r, i) => (i < 5 ? '' : i === 5 ? '......rr........' : i === 6 ? '...sSqSSSs......' : r))

  // Lower body: belt to boots, 11 rows (shorter ones sit on the floor).
  const L = {
    stance: [
      '...kkkgkkk.....',
      '...LLLLLLLL....',
      '...sLLLLLMSs...',
      '..sSSLLLMSSSs..',
      '..SSs.LM..sSSs.',
      '.sSs.......SSs.',
      '.SSs.......sSS.',
      '.FFF.......FFFF',
      '.BBb.......BBBB',
      '.BBb.......BBBB',
      '.BBBB......BBBBB',
    ],
    w0: [
      '...kkkgkkk.....',
      '...LLLLLLLL....',
      '...sLLLLLMSs...',
      '..sSSLLLMSSs...',
      '..SSs.LM.sSSs..',
      '.sSs......SSs..',
      '.Ss.......sSS..',
      'FFF.......FFFF.',
      'BBb.......BBBB.',
      'BBb.......BBBB.',
      'BBBB......BBBBB',
    ],
    w1: [
      '...kkkgkkk.....',
      '...LLLLLLLL....',
      '...sLLLLLMS....',
      '..ssSLLLMSS....',
      '.ssSS.LMsSS....',
      'sss.....SSs....',
      'ss......SSs....',
      'bFF.....FFFF...',
      'bBBb....BBBB...',
      '.bb.....BBBB...',
      '........BBBBB..',
    ],
    w2: [
      '...kkkgkkk.....',
      '...LLLLLLLL....',
      '...sLLLLLMss...',
      '..sSSLLLMsss...',
      '..SSs.LM.sssS..',
      '.sSs......sss..',
      '.SS.......sss..',
      'FFF.......FFFF.',
      'BBb.......bBBB.',
      'BBb.......bBBB.',
      'BBBB......bBBBB',
    ],
    w3: [
      '...kkkgkkk.....',
      '...LLLLLLLL....',
      '...sLLLLLMss...',
      '...sSLLLMssss..',
      '...SS.LM..sss..',
      '...SSs....sss..',
      '...sSS....bFF..',
      '...FFFF...bBB..',
      '...BBBB...bbB..',
      '...BBBB........',
      '...BBBBB.......',
    ],
    lunge: [
      '...kkkgkkk.......',
      '...LLLLLLLLSs....',
      '..sLLLLLLMSSSs...',
      '.sSSLLLLM..sSSs..',
      'sSSs..LM....sSS..',
      'SSs..........SSs.',
      'Ss...........FFFF',
      'FFF..........BBBB',
      'BBB..........BBBB',
      'BBBb.........BBBB',
      'BBBBB........BBBBB',
    ],
    kick: [
      '...kkkgkkk.......',
      '...LLLLLLLLSSSSFBB',
      '...sLLLLLMSSSSSFBBB',
      '..sSSLLLM.ssssFbBB.',
      '..SSs.LM..........',
      '.sSs..............',
      '.SSs..............',
      '.FFF..............',
      '.BBb..............',
      '.BBb..............',
      '.BBBB.............',
    ],
    tuck: [
      '...kkkgkkk...',
      '...LLLLLLLSs.',
      '..sLLLLLSSSSs',
      '..SSSLLM..SSS',
      '..sSSSs..FFFB',
      '...FFFBB.BBBB',
      '...BBBBBB.BB.',
    ],
    crouch: [
      '...kkkgkkk......',
      '..sLLLLLLLSSs...',
      '.sSSLLLMSSSSSSs.',
      'sSSs.LM....sSSs.',
      'FFFB.......FFFF.',
      'BBBBBb.....BBBBB',
    ],
    kneel: [
      '...kkkgkkk.....',
      '...LLLLLLLSSs..',
      '..sSLLLLMSSSSs.',
      '.sSSS.LM...SSs.',
      'sSSSs......FFFB',
      'BBBBbb.....BBBBB',
    ],
    sit: [
      '..kkkgkkk...ss....',
      '.LLLLLLLMsSSSSs...',
      '.LLLLLLMsSs..sSs..',
      '..MMMMMMs.....FBB.',
      '..............BBBBB',
    ],
  }

  // whole-body grids
  const DOWN = [
    '.......................ss.........',
    '......................sSSs........',
    '..yYYR....sSSSSs.....sSSSSs.......',
    '.yYYYRSl.sSlllSSs...LsSs.sSs......',
    'yYYYYRSEssSSSSSlSkLLLs.....sSFFB..',
    'yYYYYRSSSlSSSdSdSkLLMSSSSSSsFBBBb.',
    '.yYYYRSmsSSSSdSdSkLMMSSSSSSSFBBBb.',
    '..yy..ssssssssssskkMMsssssssbBBBBB',
  ]
  const DOWNLESS = [
    '.......................ss.........',
    '......................sSSs........',
    '..........sSSSSs.....sSSSSs.......',
    '.........sSlllSSs...LsSs.sSs......',
    '.......qrsSSSSSlSkLLLs.....sSFFB..',
    '.......rqlSSSdSdSkLLMSSSSSSsFBBBb.',
    '.......qrSSSSdSdSkLMMSSSSSSSFBBBb.',
    '..rrrrrrrsssssssskkMMsssssssbBBBBB',
  ]
  const BALL = [
    '....yYYYw....',
    '..yYYYRRRS...',
    '.yYYYYSSESs..',
    '.YYYYSSSSSSs.',
    'sSyySSlSSSSSs',
    'SSSSSlllSSkSS',
    'SSlSSSSSSkLLS',
    'SSSSdSSSkLLMS',
    'sSSSSSSkLLMsS',
    '.SSSSSSSsSSs.',
    '.FBBBsSSSSs..',
    '..BBBBFFs....',
    '....BBBB.....',
  ]
  const HEAD = ['..wYYY.', '.YYRRRR', 'YYYlSES', 'YYYSSSS', 'yYYsSm.', '.yy.rr.']

  // ---- composer -------------------------------------------------------------
  const FW = 52 // frame canvas; feet on the last row, body centre on AX
  const FH = 40
  const AX = 22
  const UY = FH - 24 // top of the head in a standing pose
  const LY = FH - 11 // the belt line

  function compose(o) {
    const m = Array.from({ length: FH }, () => Array(FW).fill('.'))
    const hands = []
    const put = (X, Y, ch) => {
      X = Math.round(X)
      Y = Math.round(Y)
      if (X >= 0 && Y >= 0 && X < FW && Y < FH) m[Y][X] = ch
    }
    const stamp = (g, x0, y0) =>
      g.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch === '.') return
          if (ch === 'H') {
            hands.push([x0 + x, y0 + y])
            put(x0 + x, y0 + y, 'S')
          } else put(x0 + x, y0 + y, ch)
        }),
      )
    const sword = () => {
      if (o.sw === undefined || !hands.length) return
      const [hx, hy] = hands[0]
      const a = (o.sw * Math.PI) / 180
      const cx = Math.cos(a)
      const cy = Math.sin(a)
      const px = -cy
      const py = cx
      const sx = py > 0.01 || (Math.abs(py) <= 0.01 && px > 0) ? px : -px
      const sy = py > 0.01 || (Math.abs(py) <= 0.01 && px > 0) ? py : -py
      const len = o.len ?? 14
      put(hx - cx * 3, hy - cy * 3, 'G')
      for (let t = 0.5; t <= 2.5; t += 0.5) put(hx - cx * t, hy - cy * t, 'h')
      for (let t = 2.5; t <= len; t += 0.5) put(hx + cx * t + sx, hy + cy * t + sy, 'a')
      for (let t = 2; t <= len + 1; t += 0.5) put(hx + cx * t, hy + cy * t, 'A')
      for (let k = -2; k <= 2; k++) put(hx + cx * 1.5 + px * k, hy + cy * 1.5 + py * k, 'G')
    }
    if (o.full) {
      stamp(o.full, AX - (o.fx ?? 7), FH - o.full.length)
      if (o.sw !== undefined) {
        hands.push([AX + o.hand[0], FH - 1 + o.hand[1]])
        sword()
      }
    } else {
      const up = U[o.u]
      const [udx, udy] = o.ud || [0, 0]
      const [ldx, ldy] = o.ld || [0, 0]
      const lo = L[o.l]
      const ux = AX - 7 + udx
      const uy = UY + udy - (up.oy || 0) + (13 - up.length + (up.oy || 0))
      // pre-scan the hand so a sword drawn behind the body can go first
      const tmp = []
      up.forEach((row, y) => [...row].forEach((ch, x) => ch === 'H' && tmp.push([ux + x, uy + y])))
      if (!o.front) {
        hands.push(...tmp)
        sword()
        hands.length = 0
      }
      stamp(up, ux, uy)
      stamp(lo, AX - 7 + ldx, o.lfloor ? FH - lo.length : LY + ldy)
      if (o.front) sword()
      for (const [x, y] of hands) put(x, y, 'S')
    }
    return m.map((r) => r.join(''))
  }

  // pose table: upper/lower part, offsets, sword angle (deg, 0 = forward, + = down)
  const POSES = {
    idle0: { u: 'guard', l: 'stance', sw: -14 },
    idle1: { u: 'guard', ud: [0, 1], l: 'stance', sw: -11 },
    walk0: { u: 'guard', l: 'w0', sw: -14 },
    walk1: { u: 'guard', ud: [0, 1], l: 'w1', sw: -12 },
    walk2: { u: 'guard', l: 'w2', sw: -14 },
    walk3: { u: 'guard', ud: [0, 1], l: 'w3', sw: -12 },
    midW: { u: 'back', l: 'stance', sw: -155 },
    midS: { u: 'forward', ud: [1, 0], l: 'lunge', sw: -2 },
    midF: { u: 'forward', ud: [1, 1], l: 'lunge', sw: 30 },
    highW: { u: 'raised', l: 'stance', sw: 168 },
    highS1: { u: 'forward', ud: [1, -1], l: 'lunge', sw: -55 },
    highS2: { u: 'chop', ud: [1, 0], l: 'lunge', sw: 22 },
    highF: { u: 'guard', ud: [2, 2], l: 'lunge', sw: 72 },
    lowW: { u: 'back', ud: [-1, 5], l: 'crouch', lfloor: true, sw: 178 },
    lowS: { u: 'low', ud: [1, 5], l: 'crouch', lfloor: true, sw: 6 },
    lowF: { u: 'low', ud: [1, 5], l: 'crouch', lfloor: true, sw: 26 },
    neckW: { u: 'spin', l: 'stance' }, // back view; sword added in build()
    neckS: { u: 'forward', ud: [1, -1], l: 'lunge', sw: -6 },
    neckF: { u: 'forward', ud: [1, -1], l: 'lunge', sw: -42 },
    web0: { u: 'block', l: 'stance', sw: -90, front: true },
    web1: { u: 'forward', l: 'stance', sw: -25 },
    web2: { u: 'chop', l: 'stance', sw: 40 },
    web3: { u: 'guard', l: 'stance', sw: 115 },
    buttW: { u: 'guard', ud: [-1, 0], l: 'stance', sw: -40 },
    buttS: { u: 'butt', ud: [1, 0], l: 'lunge', sw: 40 },
    kickW: { u: 'guard', ud: [-1, 0], l: 'stance', sw: -44 },
    kickS: { u: 'guard', ud: [-2, 0], l: 'kick', sw: -50 },
    block: { u: 'block', l: 'stance', sw: -90, front: true },
    jump: { u: 'guard', l: 'tuck', sw: -40 },
    hit: { u: 'hurt', ud: [-1, 0], l: 'stance', sw: 115 },
    fall: { u: 'hurt', ud: [-4, 5], l: 'crouch', lfloor: true, sw: 150 },
    headless: { u: 'headless', l: 'stance', sw: 75 },
    sag: { u: 'headless', ud: [0, 5], l: 'kneel', lfloor: true, sw: 95 },
    victory: { u: 'victory', l: 'stance', sw: -40, len: 10 },
    kneel: { u: 'guard', ud: [0, 5], l: 'kneel', lfloor: true, sw: 82 },
    sit: { u: 'doze', ud: [0, 6], l: 'sit', lfloor: true, sw: -94, front: true },
    sitUp: { u: 'guard', ud: [0, 6], l: 'sit', lfloor: true, sw: -94, front: true },
    held: { u: 'hurt', l: 'w1', sw: 120 },
    down: { full: DOWN, fx: 17, sw: 180, hand: [-6, 0] },
    downless: { full: DOWNLESS, fx: 17, sw: 180, hand: [-6, 0] },
  }

  // quarter-turn a letter grid clockwise q times
  function rotGrid(rows, q) {
    let g = rows.map((r) => [...r])
    for (let i = 0; i < q; i++) {
      const h = g.length
      const w = Math.max(...g.map((r) => r.length))
      g = Array.from({ length: w }, (_, x) => Array.from({ length: h }, (_, y) => g[h - 1 - y][x] ?? '.'))
    }
    return g.map((r) => r.join(''))
  }
  const build = (map) => {
    const set = {}
    const rc = (g) => (map ? recolor(g, map) : g)
    for (const k in POSES) {
      const p = POSES[k]
      if (p.u === 'spin') {
        // the back view holds the sword across his front: draw it behind
        set[k] = pairOutlined(rc(withSword(compose({ ...p, sw: undefined }), AX + 6, UY + 8, 180)), BP)
        continue
      }
      set[k] = pairOutlined(rc(compose(p)), BP)
    }
    set.roll = [0, 1, 2, 3].map((q) => pairOutlined(rotGrid(rc(BALL), q), BP))
    set.head = [0, 1, 2, 3].map((q) => outline(sprite(rotGrid(rc(HEAD), q), BP)))
    return set
  }
  // a sword drawn beneath an existing frame (for the back view)
  function withSword(g, hx, hy, deg) {
    const base = Array.from({ length: FH }, () => Array(FW).fill('.'))
    const a = (deg * Math.PI) / 180
    const put = (X, Y, ch) => {
      X = Math.round(X)
      Y = Math.round(Y)
      if (X >= 0 && Y >= 0 && X < FW && Y < FH) base[Y][X] = ch
    }
    const cx = Math.cos(a)
    const cy = Math.sin(a)
    for (let t = 2.5; t <= 14; t += 0.5) put(hx + cx * t, hy + cy * t + 1, 'a')
    for (let t = 2; t <= 15; t += 0.5) put(hx + cx * t, hy + cy * t, 'A')
    for (let k = -2; k <= 2; k++) put(hx + cx * 1.5, hy + k, 'G')
    return g.map((row, y) => [...row].map((ch, x) => (ch === '.' ? base[y][x] : ch)).join(''))
  }
  const SETS = [build(null), build(P2)]
  const OX = { 1: AX + 1, '-1': FW - AX } // outlined-sprite anchor per facing

  // ---- goblin (Drax's servant) -----------------------------------------------
  const GOB_ROWS = {
    walk0: [
      '...V.vvv......',
      '...VvvvvvV....',
      '...xvvvQvvv...',
      '....vvvvvvvvv.',
      '....VvvvWWVv..',
      '..VvvVvvvVV...',
      '.VvvvvvvvV....',
      'VvvvvvvvvvV...',
      'VvvvvvvvvvvV..',
      '.VvnnnnnvvvV..',
      '..nnNnnn.VvV..',
      '..vvV..vV.vv..',
      '..vV....vV....',
      '.vV.....vvV...',
      'vvvV.....vvV..',
    ],
    walk1: [
      '...V.vvv......',
      '...VvvvvvV....',
      '...xvvvQvvv...',
      '....vvvvvvvvv.',
      '....VvvvWWVv..',
      '..VvvVvvvVV...',
      '.VvvvvvvvV....',
      'VvvvvvvvvvV...',
      'VvvvvvvvvvvV..',
      '.VvnnnnnvvvV..',
      '..nnNnnnVvV...',
      '...vvVvVvv....',
      '....vVvV......',
      '....vVvV......',
      '...vvVvvV.....',
    ],
    kick: [
      '..V.vvv.......',
      '..VvvvvvV.....',
      '..xvvvQvvv....',
      '...vvvvvvvvv..',
      '...VvvvWWVv...',
      '.VvvVvvvVV....',
      'VvvvvvvvvV....',
      'VvvvvvvvvvV...',
      'VvvvvvvvvvvV..',
      '.VvnnnnnvvvV..',
      '..nnNnnnvvvvvv',
      '..vvV....VvvvV',
      '..vV..........',
      '.vV...........',
      'vvvV..........',
    ],
    pull0: [
      '..............',
      '......V.vvv...',
      '......VvvvvvV.',
      '......xvvvQvvv',
      '.......vvvvvvvv',
      '....VvvVvvvWWV.',
      '..VvvvvvvvvV...',
      '.vVvvvvvvvvV...',
      'vvvVvvvvvvV....',
      'v..nnnnnvvV....',
      '...nNnnnvV.....',
      '...vvV..vV.....',
      '..vV.....vV....',
      '.vV.......vV...',
      'vvV.......vvV..',
    ],
    pull1: [
      '..............',
      '......V.vvv...',
      '......VvvvvvV.',
      '......xvvvQvvv',
      '.......vvvvvvvv',
      '....VvvVvvvWWV.',
      '..VvvvvvvvvV...',
      '.vVvvvvvvvvV...',
      'vvvVvvvvvvV....',
      'v..nnnnnvvV....',
      '...nNnnnvV.....',
      '....vvVvV......',
      '.....vVvV......',
      '.....vVvV......',
      '....vvVvvV.....',
    ],
  }
  const GOB = {}
  for (const k in GOB_ROWS) GOB[k] = pairOutlined(GOB_ROWS[k], BP)

  // ---- Princess Mariana -------------------------------------------------------
  const PR_ROWS = {
    walk0: [
      '...gYg....',
      '..YYYYY...',
      '.YYYlSE...',
      '.YYYSSSS..',
      '.YYYSSc...',
      'YYYYYSS...',
      'YYYYSPPPS.',
      'YYYPPPPPS.',
      'YYYPPPPS..',
      'YYYSgggS..',
      '.YYPPPPP..',
      '.YPPPPPPp.',
      '..PPPPPPp.',
      '..PPPpPPp.',
      '.PPPPpPPPp',
      '.PPPpPPPPp',
      'PPPPpPPPPp',
      'oPPpPPPPpo',
      '.S.....S..',
      'SS.....SS.',
    ],
    walk1: [
      '...gYg....',
      '..YYYYY...',
      '.YYYlSE...',
      '.YYYSSSS..',
      '.YYYSSc...',
      'YYYYYSS...',
      'YYYYSPPPS.',
      'YYYPPPPPS.',
      'YYYPPPPS..',
      'YYYSgggS..',
      '.YYPPPPP..',
      '.YPPPPPPp.',
      '..PPPPPPp.',
      '..PPPpPPp.',
      '..PPPpPPPp',
      '.PPPpPPPPp',
      '.PPPpPPPPo',
      '.oPpPPPPo.',
      '...S.S....',
      '..SS.SS...',
    ],
    kneel: [
      '...gYg.....',
      '..YYYYY....',
      '.YYYlSE....',
      '.YYYSSSS...',
      '.YYYSSc....',
      'YYYYYSS..S.',
      'YYYYSPPPSS.',
      'YYYPPPPPS..',
      'YYYPPPPP...',
      'YYYSgggP...',
      '.YPPPPPPP..',
      'YPPPPPPPPp.',
      'oPPPPpPPPpp',
      '.ooPPPPPPpo',
    ],
  }
  const PRINCESS = {}
  for (const k in PR_ROWS) PRINCESS[k] = pairOutlined(PR_ROWS[k], BP)

  // the health pips and the snake that eats them
  const PIP = sprite(['.r.', 'rRr', '.r.'], { r: '#e8302a', R: '#ff8a70' })
  const PIP_GONE = sprite(['.q.', 'q.q', '.q.'], { q: '#5a2a2a' })
  const SNAKE = sprite(['..vvv', 'vvvQv', 'v....'], BP)

  // ---- moves ----------------------------------------------------------------
  // each attack: [pose, seconds] frames; `hit` = frame index where the blow lands
  const MOVES = {
    mid: { f: [['midW', 0.22], ['midS', 0.14], ['midF', 0.14], ['idle0', 0.1]], hit: 1, reach: 30, dmg: 1 },
    high: { f: [['highW', 0.3], ['highS1', 0.08], ['highS2', 0.14], ['highF', 0.2]], hit: 2, reach: 28, dmg: 2 },
    low: { f: [['lowW', 0.2], ['lowS', 0.16], ['lowF', 0.14]], hit: 1, reach: 30, dmg: 1 },
    neck: { f: [['neckW', 0.12], ['neckW', 0.12], ['neckW', 0.12], ['neckW', 0.12], ['neckS', 0.14], ['neckF', 0.18]], hit: 4, reach: 30, dmg: 9 },
    butt: { f: [['buttW', 0.16], ['buttS', 0.2], ['idle0', 0.1]], hit: 1, reach: 18, dmg: 1 },
    kick: { f: [['kickW', 0.14], ['kickS', 0.22], ['idle0', 0.1]], hit: 1, reach: 21, dmg: 1 },
    web: { f: [['web0', 0.07], ['web1', 0.07], ['web2', 0.07], ['web3', 0.07], ['web0', 0.07], ['web1', 0.07], ['web2', 0.07], ['web3', 0.07], ['idle0', 0.1]], hit: -1, reach: 0, dmg: 0 },
  }
  for (const m of Object.values(MOVES)) {
    let t = 0
    m.at = m.f.map(([, d]) => (t += d) - d)
    m.dur = t
    m.wind = m.hit >= 0 ? m.at[m.hit] : 0
  }
  const FIGHT_MOVES = ['mid', 'mid', 'mid', 'high', 'high', 'high', 'low', 'low', 'low', 'neck']
  const SPAR_MOVES = ['mid', 'high', 'low']
  const HP = 6
  const NEAR = 16 // closer than this: back off (or butt/kick)
  const FAR = 27 // further than this: close in
  // states where a fighter can't be hit or asked to do anything else
  const AWAY = new Set(['down', 'fall', 'headless', 'sag', 'held', 'drop', 'kneel', 'sit', 'toSit', 'enter', 'goto', 'champ'])
  const lerp = (a, b, u) => a + (b - a) * u

  // nearest x whose span [x-hw, x+hw] stays clear of the furniture; if the bar is
  // too crowded, at least keep off the title and the window dots
  function openSpot(s, x, hw, avoid = []) {
    x = clamp(x, hw + 4, s.W - hw - 4)
    for (const kinds of [null, ['title', 'controls']]) {
      const blocks = s.fix.filter((f) => !kinds || kinds.includes(f.kind)).map((f) => [f.x - 3, f.x + f.w + 3]).concat(avoid)
      const ok = (c) => c - hw >= 4 && c + hw <= s.W - 4 && blocks.every(([a, b]) => c + hw <= a || c - hw >= b)
      for (let d = 0; d < s.W; d += 2) {
        if (ok(x - d)) return x - d
        if (ok(x + d)) return x + d
      }
    }
    return x
  }
  // where the duel likes to idle: the open stretch just right of Aico's eyes
  function homeX(s) {
    const e = s.fixture('eyes')
    return openSpot(s, e ? e.x + e.w + 40 : 60, 24)
  }

  class Fighter {
    constructor(s, id, cx, dir) {
      this.s = s
      this.id = id
      this.cx = cx
      this.dir = dir
      this.set = SETS[id]
      this.y = FLOOR
      this.yOff = 0
      this.hp = HP
      this.shownHp = HP
      this.state = 'guard'
      this.t = 0
      this.since = performance.now()
      this.anim = 0
      this.thinkAt = 0
      this.coolUntil = 0
      this.turnT = 0
      this.curT = 0
      this.hpUntil = 0
      this.lastZ = 0
      this.lookUntil = 0
      this.breathAt = 0
      this.breath = 0
      this.grabbable = true
    }
    get x() {
      return this.cx - 6
    }
    get moving() {
      return !['guard', 'sit', 'down', 'kneel', 'champ'].includes(this.state)
    }
    get asleep() {
      return this.state === 'sit' || this.ko
    }
    get free() {
      return this.state === 'guard' || this.state === 'walk'
    }
    go(state) {
      this.state = state
      this.t = 0
      this.since = performance.now()
    }
    hit(px, py) {
      if (this.ko) return false
      const y = this.y + this.yOff
      const tall = this.state === 'sit' ? 17 : ['kneel', 'sag', 'fall'].includes(this.state) ? 19 : this.state === 'roll' ? 13 : 24
      return Math.abs(px - this.cx) < 6 && py > y - tall && py < y + 1
    }
    grab() {
      this.go('held')
    }
    drag(p) {
      this.cx = clamp(p.x, 8, this.s.W - 8)
      this.y = clamp(p.y + 12, 24, FLOOR)
    }
    drop() {
      this.vy = 0
      this.go('drop')
    }
    onClick() {
      // a click sends him into the forward roll; a roll into the other one knocks him down
      if (this.state === 'sit') return this.wake()
      if (!this.free) return
      this.dir = Math.sign(this.foe.cx - this.cx) || this.dir
      this.go('roll')
    }
    onDblClick() {
      if (this.free || this.state === 'roll') this.attack('neck')
    }
    wake() {
      this.go('guard')
      this.yOff = 0
      this.dir = Math.sign(this.foe.cx - this.cx) || this.dir
      this.thinkAt = performance.now() + rand(400, 1000)
    }
    goto(x, then) {
      this.goal = x
      this.then = then
      this.go('goto')
    }
    look(x, bubble) {
      if (!this.free || this.ko) return
      this.dir = Math.sign(x - this.cx) || this.dir
      this.lookUntil = performance.now() + 1200
      this.thinkAt = Math.max(this.thinkAt, this.lookUntil)
      this.s.particle({ img: BUBBLE[bubble], x: this.cx - 2, y: Math.max(0, FLOOR - 33), life: 1, vy: -2 })
    }
    attack(type, atCursor = false) {
      this.type = type
      this.move = MOVES[type]
      this.atCursor = atCursor
      this.landed = false
      this.go('attack')
      if (!atCursor && this.move.hit >= 0) this.foe.react(this, type)
    }
    react(att, type) {
      if (!this.free) return
      if (Math.random() > (this.s.busy ? 0.45 : 0.9)) return
      this.dir = Math.sign(att.cx - this.cx) || this.dir
      this.guardFor = MOVES[type].wind + 0.35
      // jump the low sweep, raise the sword against the rest (butts and kicks get through)
      if (type === 'butt' || type === 'kick') return
      this.go(type === 'low' ? 'jump' : 'block')
    }
    strike() {
      const f = this.foe
      const s = this.s
      const m = this.move
      if (this.atCursor) return
      const gap = f.cx - this.cx
      if (Math.abs(gap) > m.reach || Math.sign(gap) !== this.dir || f.ko || AWAY.has(f.state) || f.state === 'roll') return
      if (f.state === 'block' && this.type !== 'low' && this.type !== 'butt' && this.type !== 'kick') {
        // clang
        const px = this.cx + this.dir * Math.min(Math.abs(gap) - 6, 14)
        const py = FLOOR - (this.type === 'high' ? 24 : 18)
        s.particle({ img: STAR, x: px - 1, y: py - 1, life: 0.3 })
        s.burst(px, py, 5, ['w', 'y'])
        this.cx -= this.dir * 2
        f.cx += this.dir * 2
        return
      }
      if (f.state === 'jump' && this.type === 'low') return
      f.wound(this)
    }
    wound(att) {
      const s = this.s
      this.dir = -att.dir
      if (!s.busy) {
        // sparring: a touch, no damage
        this.go('hit')
        return
      }
      this.hpUntil = performance.now() + 2600
      s.particle({ digits: att.type === 'neck' ? '500' : att.type === 'high' ? '250' : '100', x: att.cx - 6, y: Math.max(0, FLOOR - 34), vy: -6, life: 0.9 })
      if (att.type === 'neck') {
        this.hp = 0
        this.ko = this.decap = true
        this.go('headless')
        s.burst(this.cx, FLOOR - 19, 8, ['r', 'r', 'R'])
        s.data.head = s.spawn(new Head(s, this.cx - 3, FLOOR - 25, att.dir * rand(25, 40), -60, this.set.head))
        att.won()
        return
      }
      this.hp = Math.max(0, this.hp - att.move.dmg)
      s.burst(this.cx + att.dir * 2, FLOOR - (att.type === 'low' ? 6 : 16), 4, ['r'])
      if (this.hp <= 0) {
        this.ko = true
        this.go('fall')
        att.won()
      } else this.go('hit')
    }
    knock() {
      this.dir = -this.foe.dir
      this.go('fall')
      this.s.burst(this.cx, FLOOR - 1, 5, ['n', 'N'])
    }
    won() {
      this.pendingVictory = true
    }
    respawn(fromLeft) {
      const s = this.s
      this.ko = this.decap = false
      this.hp = this.shownHp = HP
      this.cx = fromLeft ? -10 : s.W + 10
      this.dir = fromLeft ? 1 : -1
      this.y = FLOOR
      this.go('enter')
      if (s.data.head) s.data.head.dead = true
      s.data.head = null
    }
    update(dt, now, s) {
      this.t += dt
      this.anim += dt
      const f = this.foe
      const d = s.data
      const fight = s.busy
      if (this.shownHp > this.hp && now > this.hpUntil - 2000) this.shownHp = this.hp
      if (!this.ko && !['enter', 'held'].includes(this.state)) this.cx = clamp(this.cx, 8, s.W - 8)
      switch (this.state) {
        case 'held':
          return SLOW
        case 'drop':
          this.vy += 260 * dt
          this.y += this.vy * dt
          if (this.y >= FLOOR) {
            this.y = FLOOR
            s.burst(this.cx, FLOOR - 1, 4, ['n', 'N'])
            this.wake()
          }
          return FAST
        case 'attack': {
          const m = this.move
          if (!this.landed && m.hit >= 0 && this.t >= m.wind) {
            this.landed = true
            this.strike()
          }
          if (this.t >= m.dur) {
            if (this.pendingVictory) {
              this.pendingVictory = false
              this.go('victory')
            } else {
              this.go('guard')
              this.thinkAt = now + (fight ? rand(250, 700) : rand(1000, 2400))
            }
          }
          return FAST
        }
        case 'block':
          if (this.t >= this.guardFor) this.go('guard')
          return FAST
        case 'jump':
          this.yOff = -Math.sin(Math.PI * Math.min(1, this.t / this.guardFor)) * 7
          if (this.t >= this.guardFor) {
            this.yOff = 0
            this.go('guard')
          }
          return FAST
        case 'hit':
          if (this.t < 0.15) this.cx -= this.dir * 22 * dt
          if (this.t >= 0.4) {
            this.go('guard')
            this.thinkAt = now + rand(200, 500)
          }
          return FAST
        case 'fall':
          if (this.t < 0.25) this.cx -= this.dir * 18 * dt
          if (this.t >= 0.4) this.go('down')
          return FAST
        case 'down':
          if (this.ko) return Infinity // the goblin takes it from here
          if (this.t >= 1) this.wake()
          return FAST
        case 'headless':
          // the body stands a moment, spurting, then the knees go
          if (Math.floor(this.t * 12) % 3 === 0) s.particle({ img: pix('r'), x: this.cx - this.dir + rand(-1, 1), y: FLOOR - 20, vx: rand(-12, 12), vy: rand(-40, -25), g: 140, life: 0.5 })
          if (this.t >= 1.0) this.go('sag')
          return FAST
        case 'sag':
          if (this.t >= 0.35) this.go('down')
          return FAST
        case 'roll':
          this.cx += this.dir * 42 * dt
          if (!f.ko && !AWAY.has(f.state) && f.state !== 'roll' && Math.abs(f.cx - this.cx) < 9) {
            f.knock()
            this.go('guard')
            this.thinkAt = now + 600
            return FAST
          }
          if (this.t >= 0.75) this.wake()
          return FAST
        case 'victory':
          if (this.t >= 1.4) {
            this.go('guard')
            this.thinkAt = now + rand(300, 900)
          }
          return FAST
        case 'kneel':
        case 'champ':
          return Infinity // the ceremony moves them on
        case 'enter': {
          this.cx += this.dir * 16 * dt
          const inside = this.cx > 14 && this.cx < s.W - 14
          if (inside && (Math.abs(f.cx - this.cx) < FAR + 6 || f.ko)) this.wake()
          return FAST
        }
        case 'goto': {
          this.goal = clamp(this.goal, 10, s.W - 10)
          const gd = this.goal - this.cx
          if (Math.abs(gd) < 1) {
            this.cx = this.goal
            this.go(this.then)
            if (this.then === 'kneel' || this.then === 'champ') this.dir = this.faceAfter ?? this.dir
            return FAST
          }
          this.dir = Math.sign(gd)
          this.cx += this.dir * Math.min(Math.abs(gd), 20 * dt)
          return FAST
        }
        case 'toSit': {
          // walk to the quiet spot, then sit back to back
          const gx = d.restX + this.side * 7
          const gd = gx - this.cx
          if (Math.abs(gd) < 1) {
            this.cx = gx
            this.dir = this.side
            this.go('sit')
            this.sleptAt = now
            this.lastZ = now - this.id * 900
            return FAST
          }
          this.dir = Math.sign(gd)
          this.cx += this.dir * Math.min(Math.abs(gd), 16 * dt)
          return FAST
        }
        case 'sit':
          if (d.mode !== 'rest') {
            this.standAt ||= now + rand(200, 900)
            if (now >= this.standAt) {
              this.standAt = 0
              this.wake()
              return FAST
            }
            return Math.max(FAST, this.standAt - now)
          }
          this.standAt = 0
          if (now - this.sleptAt < 7000) {
            if (now - this.lastZ > 1800) {
              this.lastZ = now
              s.particle({ img: ZZ, x: this.cx + this.dir * 4, y: FLOOR - 20, vx: 2, vy: -4, life: 2.4, fade: true })
            }
            return 900
          }
          return Infinity
      }

      // guard / walk: the duel itself
      const busyFoe = f.ko || AWAY.has(f.state)
      if (d.mode === 'rest' && !f.ko && !d.goblin && !['enter', 'held', 'drop', 'goto', 'champ', 'kneel'].includes(f.state)) {
        if (d.restX === undefined) d.restX = openSpot(s, (this.cx + f.cx) / 2, 18)
        this.side = this.cx < f.cx || (this.cx === f.cx && this.id === 0) ? -1 : 1
        this.go('toSit')
        return FAST
      }
      const cur = s.cursor
      const near = cur && cur.y > FLOOR - 26 && cur.y < H && Math.abs(cur.x - this.cx) < 28 && Math.abs(cur.x - this.cx) <= Math.abs(cur.x - f.cx)
      if (near) {
        // swing at a cursor that lingers within reach
        this.curT += dt
        if (this.curT > 0.35 && now > this.coolUntil && this.state === 'guard') {
          this.coolUntil = now + 1600
          this.curT = 0
          this.dir = Math.sign(cur.x - this.cx) || this.dir
          this.attack(pick(SPAR_MOVES), true)
          return FAST
        }
      } else this.curT = 0
      const breathe = () => {
        if (now >= this.breathAt) {
          this.breath ^= 1
          this.breathAt = now + (this.breath ? 500 : 700)
        }
        return this.breathAt - now
      }
      if (busyFoe) {
        // while the goblin clears the floor and a challenger walks in, the survivor
        // goes back to his spot by the eyes (facing the way the next one comes from)
        if ((f.ko || f.state === 'enter') && !d.ceremony && d.mode !== 'rest') {
          const from = f.state === 'enter' ? f.cx : f.cx < s.W / 2 ? -1 : s.W + 1
          const tx = clamp(homeX(s) + (this.cx > from ? 14 : -14), 10, s.W - 10)
          if (Math.abs(tx - this.cx) > 2) {
            if (this.state !== 'walk') this.go('walk')
            this.dir = Math.sign(tx - this.cx)
            this.cx += this.dir * 18 * dt
            return FAST
          }
          if (f.state === 'enter') this.dir = Math.sign(f.cx - this.cx) || this.dir
        }
        if (this.state === 'walk') this.go('guard')
        return near ? FAST : Math.min(600, breathe())
      }
      const want = Math.sign(f.cx - this.cx) || this.dir
      if (want !== this.dir && now > this.lookUntil) {
        this.turnT += dt
        if (this.turnT > 0.3) {
          this.dir = want
          this.turnT = 0
        }
        return FAST
      }
      this.turnT = 0
      const dd = Math.abs(f.cx - this.cx)
      if (this.state === 'walk') {
        this.cx += this.walkDir * 18 * dt
        const target = this.walkTo
        const arrived = target !== undefined ? Math.abs(this.cx - target) < 2 : this.walkDir === this.dir ? dd <= FAR - 3 : dd >= NEAR + 5 || this.t > 0.7
        if (arrived || this.t > 3) {
          this.walkTo = undefined
          this.go('guard')
          this.thinkAt = now + (fight ? rand(100, 400) : rand(600, 1500))
        }
        return FAST
      }
      if (now < this.thinkAt) return near ? FAST : Math.max(FAST, Math.min(this.thinkAt - now, breathe()))
      if (dd > FAR) {
        this.walkDir = this.dir
        this.go('walk')
        return FAST
      }
      if (dd < NEAR) {
        if (Math.random() < (fight ? 0.6 : 0.3)) this.attack(Math.random() < 0.5 ? 'butt' : 'kick')
        else {
          this.walkDir = -this.dir
          this.go('walk')
        }
        return FAST
      }
      // the pair drifts back off the title (and off the bar's edge) toward its spot
      // by Aico's eyes; mid-fight it only gives ground now and then
      if (Math.random() < (fight ? 0.2 : 0.5)) {
        const mid = (this.cx + f.cx) / 2
        const home = homeX(s)
        const spot = Math.abs(home - mid) > (fight ? 30 : 60) ? home : openSpot(s, mid, dd / 2 + 10)
        if (Math.abs(spot - mid) > 4 && Math.sign(spot - mid) === -this.dir) {
          this.walkDir = -this.dir
          this.walkTo = this.cx + clamp(spot - mid, -16, 16)
          this.go('walk')
          return FAST
        }
      }
      const r = Math.random()
      if (fight) {
        if (r < 0.65) this.attack(pick(FIGHT_MOVES))
        else this.thinkAt = now + rand(250, 600)
      } else if (r < 0.3) this.attack(pick(SPAR_MOVES))
      else if (r < 0.4 && now > (d.tauntAt || 0)) {
        // the web of death, for show; the other one may take offence
        d.tauntAt = now + rand(8000, 15000)
        this.attack('web')
        if (f.free && Math.random() < 0.5) f.thinkAt = now + 1000
      } else this.thinkAt = now + rand(1200, 2800)
      return FAST
    }
    pose() {
      const st = this.state
      const walk = () => `walk${Math.floor(this.anim * 9) % 4}`
      switch (st) {
        case 'walk':
        case 'enter':
        case 'toSit':
        case 'goto':
          return walk()
        case 'attack': {
          const m = this.move
          let i = m.at.length - 1
          while (i > 0 && this.t < m.at[i]) i--
          return m.f[i][0]
        }
        case 'block':
        case 'jump':
        case 'hit':
        case 'headless':
        case 'sag':
        case 'victory':
        case 'kneel':
        case 'held':
          return st
        case 'champ':
          return 'victory'
        case 'drop':
          return 'held'
        case 'fall':
          return this.t < 0.15 ? 'hit' : 'fall'
        case 'down':
          return this.decap ? 'downless' : 'down'
        case 'sit':
          return this.s.data.mode === 'rest' ? 'sit' : 'sitUp'
      }
      return this.breath ? 'idle1' : 'idle0'
    }
    draw(c) {
      const set = this.set
      const y = Math.round(this.y + this.yOff)
      if (this.state === 'roll') {
        const q = Math.floor(this.t * 12) % 4
        const r = set.roll[this.dir === 1 ? q : 3 - q]
        c.drawImage(r[1], Math.round(this.cx) - 7, y - 14)
        return
      }
      const p = this.pose()
      let dir = this.dir
      // the neck chop starts with a full spin
      if (p === 'neckW') dir = Math.floor(this.t / 0.12) % 2 ? dir : -dir
      c.drawImage(set[p][dir], Math.round(this.cx) - OX[dir], y - FH - 1)
      if (!this.ko && performance.now() < this.hpUntil) {
        // the game's health: a row of pips, and the snake that eats them
        const py = Math.max(0, FLOOR - 32)
        const x0 = Math.round(this.cx) - 9
        c.drawImage(SNAKE, x0 - 6, py)
        for (let i = 0; i < HP; i++) c.drawImage(i < this.shownHp ? PIP : PIP_GONE, x0 + i * 4, py)
      }
    }
  }

  class Head {
    constructor(s, x, y, vx, vy, frames) {
      Object.assign(this, { s, x, y, vx, vy, frames })
      this.spin = 0
      this.prop = true
      this.z = 2
    }
    kick(dir) {
      this.kicked = true
      this.rest = false
      this.vx = dir * 85
      this.vy = -55
      this.s.particle({ img: STAR, x: this.x + 2, y: this.y - 2, life: 0.25 })
    }
    update(dt, now, s) {
      if (this.rest) return Infinity
      this.vy += 200 * dt
      this.x += this.vx * dt
      this.y += this.vy * dt
      if (this.y >= FLOOR - 8) {
        this.y = FLOOR - 8
        if (Math.abs(this.vy) > 18) {
          this.vy = -this.vy * 0.45
          this.vx *= 0.75
          s.particle({ img: pix('r'), x: this.x + 3, y: FLOOR - 1, life: 4, fade: true })
        } else {
          this.vy = 0
          if (!this.kicked) {
            this.vx *= 0.85 ** (dt * 12)
            if (Math.abs(this.vx) < 2) this.rest = true
          }
        }
      }
      this.spin += this.vx * dt * 0.35
      if (this.x < -10 || this.x > s.W + 4) this.dead = true
      return FAST
    }
    draw(c) {
      const q = ((Math.floor(this.spin) % 4) + 4) % 4
      c.drawImage(this.frames[this.rest ? 0 : q], Math.round(this.x), Math.round(this.y))
    }
  }

  // Drax's goblin: kicks the head away, then drags the loser off by the feet
  class Goblin {
    constructor(s, body) {
      this.s = s
      this.body = body
      const left = body.cx < s.W / 2
      this.fromLeft = left
      this.cx = left ? -10 : s.W + 10
      this.dir = left ? 1 : -1
      this.state = 'in'
      this.anim = 0
      this.y = FLOOR
      this.z = 1
      this.moving = true
    }
    get x() {
      return this.cx - 6
    }
    update(dt, now, s) {
      this.anim += dt
      const head = s.data.head
      const b = this.body
      const kickHead = head && !head.kicked && !head.dead
      // approach side is fixed per target so the goal doesn't flip with his facing
      const goal = kickHead ? head.x + 3 : b.cx
      const key = kickHead ? 'head' : 'body'
      if (this.goalKey !== key) {
        this.goalKey = key
        this.side = Math.sign(this.cx - goal) || -this.dir
      }
      const target = goal + this.side * (kickHead ? 6 : 20)
      if (this.state === 'in') {
        if (Math.abs(target - this.cx) < 2) {
          this.state = kickHead ? 'kick' : 'grab'
          this.t = 0
          if (kickHead) this.dir = Math.sign(head.x + 3 - this.cx) || this.dir
          return FAST
        }
        this.dir = target > this.cx ? 1 : -1
        this.cx += this.dir * 24 * dt
      } else if (this.state === 'kick') {
        this.t += dt
        if (this.t > 0.12 && head && !head.kicked) head.kick(this.dir)
        if (this.t > 0.45) {
          this.state = 'in'
          this.goalKey = null
        }
      } else if (this.state === 'grab') {
        this.t += dt
        if (this.t > 0.5) {
          this.state = 'out'
          this.dir = this.fromLeft ? -1 : 1
        }
      } else {
        this.cx += this.dir * 15 * dt
        b.dir = this.dir
        b.cx = this.cx - this.dir * 20
        if (b.cx < -20 || b.cx > s.W + 20) {
          this.dead = true
          s.data.goblin = null
          b.respawn(this.fromLeft)
        }
      }
      return FAST
    }
    draw(c) {
      const step = Math.floor(this.anim * 7) % 2
      const sp = this.state === 'out' ? GOB[step ? 'pull1' : 'pull0'] : this.state === 'kick' ? GOB.kick : this.state === 'in' ? GOB[step ? 'walk1' : 'walk0'] : GOB.walk0
      const w = sp.w - 2
      c.drawImage(sp[this.dir], Math.round(this.cx) - (this.dir === 1 ? 6 : w - 6) - 1, FLOOR - sp.h + 1)
    }
  }

  // Princess Mariana comes to the winner's feet
  class Princess {
    constructor(s, champ) {
      this.s = s
      this.champ = champ
      this.side = champ.dir // she settles in front of him
      this.fromLeft = this.side < 0
      this.cx = this.fromLeft ? -8 : s.W + 8
      this.dir = this.fromLeft ? 1 : -1
      this.state = 'in'
      this.anim = 0
      this.lastHeart = 0
      this.moving = true
    }
    get x() {
      return this.cx - 4
    }
    update(dt, now, s) {
      this.anim += dt
      const target = this.champ.cx + this.side * 11
      if (this.state === 'in' && !s.data.ceremony) {
        // the ceremony ended before she got there
        this.state = 'out'
        this.dir = this.fromLeft ? -1 : 1
      }
      if (this.state === 'in') {
        const gd = target - this.cx
        if (Math.abs(gd) < 1 && this.champ.state === 'champ') {
          this.state = 'adore'
          this.dir = -this.side
          this.moving = false
        } else if (Math.abs(gd) >= 1) {
          this.dir = Math.sign(gd)
          this.cx += this.dir * Math.min(Math.abs(gd), 28 * dt)
        }
      } else if (this.state === 'adore') {
        if (!s.data.ceremony) {
          this.state = 'out'
          this.moving = true
          this.dir = this.fromLeft ? -1 : 1
        } else if (now - this.lastHeart > 1300) {
          this.lastHeart = now
          s.particle({ img: BUBBLE['♥'], x: this.cx - 3, y: Math.max(0, FLOOR - 24), vy: -4, life: 1.2, fade: true })
        }
        if (this.state === 'adore') return Math.max(FAST, Math.min(1300 - (now - this.lastHeart), s.data.ceremonyEnd - now))
      } else {
        this.cx += this.dir * 16 * dt
        if (this.cx < -10 || this.cx > s.W + 10) this.dead = true
      }
      return FAST
    }
    draw(c) {
      const sp = this.state === 'adore' ? PRINCESS.kneel : Math.floor(this.anim * 6) % 2 ? PRINCESS.walk1 : PRINCESS.walk0
      const w = sp.w - 2
      c.drawImage(sp[this.dir], Math.round(this.cx) - Math.floor(w / 2) - 1, FLOOR - sp.h + 1)
    }
  }

  function endCeremony(s) {
    const d = s.data
    if (!d.ceremony) return
    d.ceremony = false
    for (const f of d.fighters) {
      if (['champ', 'kneel', 'goto'].includes(f.state)) f.wake()
      if (!f.ko) f.hp = f.shownHp = HP
    }
  }

  registerConcept({
    key: 'barbarian',
    title: 'Barbarian (Death Sword) — big',
    sub: 'Palace Software, 1987',
    blurb:
      "Two barbarians spar along the bar and fight properly while the agent works: mid swings, overhead chops, low sweeps the other one jumps, blocks that clang, head-butts and kicks, and the spinning neck chop that takes the head off. The goblin kicks the head away and drags the body out by the feet, and a new challenger walks in. Hits show the health pips and the snake. Your <b>cursor</b> gets a swing if it lingers near one of them. Click a barbarian to roll him into the other, double-click for the neck chop, or drag one. Done: the winner stands victorious, the loser kneels and Princess Mariana comes to the winner's feet. When it's quiet they sit back to back and doze.",
    setup(s) {
      const mid = homeX(s)
      const a = new Fighter(s, 0, mid - 12, 1)
      const b = new Fighter(s, 1, mid + 12, -1)
      a.foe = b
      b.foe = a
      s.data = { W: s.W, fighters: [a, b], mode: 'spar', goblin: null, head: null, ceremony: false }
      s.actors.push(a, b)
    },
    update(s, dt, now) {
      const d = s.data
      d.mode = s.busy ? 'fight' : s.lively(now) ? 'spar' : 'rest'
      if (d.mode !== 'rest') d.restX = undefined
      const body = d.fighters.find((f) => f.ko && f.state === 'down')
      if (body && !d.goblin) {
        if (now - body.since > 900) d.goblin = s.spawn(new Goblin(s, body))
        else return Math.max(FAST, body.since + 900 - now)
      }
      if (d.ceremony) {
        if (now >= d.ceremonyEnd) endCeremony(s)
        else return Math.max(FAST, d.ceremonyEnd - now)
      }
      return Infinity
    },
    onBusy(s) {
      endCeremony(s)
    },
    onNap(s) {
      endCeremony(s)
    },
    onDone(s) {
      const d = s.data
      const alive = d.fighters.filter((f) => !f.ko && !['held', 'drop', 'enter'].includes(f.state))
      if (!alive.length) return
      const [a, b] = alive
      const win = !b ? a : a.hp === b.hp ? pick(alive) : a.hp > b.hp ? a : b
      const lose = win.foe
      // the champion takes an open stretch; the princess comes in from the
      // nearer edge to his feet, the loser kneels on his other side
      const spot = openSpot(s, win.cx, 20)
      const face = spot < s.W / 2 ? -1 : 1
      win.faceAfter = face
      win.goto(spot, 'champ')
      if (!lose.ko && !AWAY.has(lose.state)) {
        const ls = openSpot(s, spot - face * 44, 9, [[spot - 26, spot + 26]])
        lose.faceAfter = Math.sign(spot - ls) || face
        lose.goto(ls, 'kneel')
      }
      d.ceremony = true
      d.ceremonyEnd = performance.now() + 8000
      const champ = { dir: face, get cx() { return win.state === 'goto' ? win.goal : win.cx }, get state() { return win.state } }
      if (d.princess && !d.princess.dead) {
        // she's still about: send her back to the (new) champion
        Object.assign(d.princess, { champ, side: face, state: 'in', moving: true })
      } else d.princess = s.spawn(new Princess(s, champ))
    },
    onBarClick(s, p) {
      for (const f of s.data.fighters) f.look(p.x, '?')
    },
    onBonk(s, r) {
      for (const f of s.data.fighters) f.look(r.x + r.w / 2, '!')
    },
    relayout(s) {
      const d = s.data
      const k = s.W / (d.W || s.W)
      d.W = s.W
      // keep their spacing, move the pair with the bar
      const fs = d.fighters || []
      const mid = fs.reduce((n, f) => n + f.cx, 0) / (fs.length || 1)
      for (const f of fs) if (!f.ko) f.cx = clamp(f.cx + mid * (k - 1), 8, s.W - 8)
      // sleepers wake where they sat; re-seat them in an open stretch of the new bar
      if (d.restX !== undefined) {
        d.restX = openSpot(s, d.restX * k, 18)
        for (const f of fs) if (f.state === 'sit') f.cx = d.restX + f.side * 7
      }
      for (const f of fs) if (f.state === 'champ' || f.state === 'kneel') f.cx = clamp(f.cx, 10, s.W - 10)
    },
  })
})()
