;(() => {
  // Leisure Suit Larry in the Land of the Lounge Lizards (Sierra On-Line, 1987).
  // Larry Laffer, 38, works his way through one night in Lost Wages: Lefty's
  // bar, the "Ken sent me" door, a cab, the disco, the 24-hour store, the
  // casino and the wedding chapel. Each location lives in an open stretch of
  // the bar; Larry struts across the title between them. Narrator lines come in
  // Sierra message boxes, people talk in their own colours, the cursor shows a
  // parser line. Busy = the location's action loop, done = its small victory,
  // rest = Larry slumps (the story pauses and resumes where it left off).

  const Q = new URLSearchParams(location.search)
  // capture-only: keep the bar lively in headless long runs (?t=…&awake)
  const KEEP_AWAKE = Q.has('t') && Q.has('awake')

  // EGA-ish palette
  const P = {
    E: '#141414', W: '#fbfbf5', w: '#a6a6b2', S: '#f4b088', s: '#c07650', K: '#4e2e14', k: '#8a5a30',
    Y: '#ffe455', y: '#c89a10', R: '#b81c1c', r: '#ff5555', B: '#2236c0', b: '#6680ff', c: '#9fd8ff',
    P: '#8a1aa8', p: '#d85cf0', G: '#0f8a2a', g: '#5cf07a', N: '#9a5418', n: '#5e300c', A: '#4a4a56',
    a: '#9a9aa6', L: '#ffe680', l: '#d2a830', M: '#ffffff', m: '#ff2a6a', h: '#ff4d7a', O: '#ff9a2a',
  }
  const CLR = {
    L: '#7ff0ff', B: '#ffb35c', W: '#ff6b6b', D: '#d8c08a', M: '#e48cff', F: '#ffe680',
    C: '#7dff8a', K: '#9dffcf', T: '#ffd23f', P: '#c9c9ff',
  }
  const NAME = { L: 'Larry', B: 'bartender', W: 'woman in red', D: 'drunk', M: 'doorman', F: 'Fawn', C: 'clerk', K: 'dealer', T: 'cabbie', P: 'minister' }
  const WALK = 24
  const HURRY = 34

  // ---- sprite helpers --------------------------------------------------------
  const mk = (rows, cx) => {
    const p = pairOutlined(rows, P)
    p.cx = cx
    p.ow = p.w - 2
    return p
  }
  /** overlay: write str into rows[r] at column c ('_' keeps what is there) */
  function ov(rows, r, c, str) {
    const out = rows.slice()
    const row = (out[r] || '').padEnd(c + str.length, '.')
    out[r] = row.slice(0, c) + [...str].map((ch, i) => (ch === '_' ? row[c + i] : ch)).join('') + row.slice(c + str.length)
    return out
  }
  const shiftL = (rows, n = 1) => rows.map((r) => r.slice(n) + '.'.repeat(n))
  const shiftR = (rows, n = 1) => rows.map((r) => '.'.repeat(n) + r.slice(0, r.length - n))
  const rc = (rows, map) => recolor(rows, map)

  // ---- Larry -----------------------------------------------------------------
  // 14 wide, ~24 tall: comb-over, big nose, white leisure suit, wide lapels,
  // open shirt, gold chain, bell-bottoms.
  const H_BASE = [
    '.....SSSS.....',
    '....KSKSKS....',
    '...SKSKSSSS...',
    '..KSSSSSKKSS..',
    '..KKSSSSSESS..',
    '..KKSSSSSSSSS.',
    '..KsSSSSSSSSSS',
    '...KSSSSSSSSs.',
    '....SSSSSSEE..',
    '.....sSSSSs...',
  ]
  const H_TALK = ov(ov(H_BASE, 8, 4, 'SSSSSRRE'), 9, 5, 'sSSSRs')
  const H_BROW = ov(ov(H_BASE, 2, 3, 'KSSSSKKS'), 3, 2, 'KSSSSSSSSS')
  const H_LEER = ov(ov(H_BROW, 8, 4, 'SSSSSSEEE'), 9, 5, 'sSSSSE')
  const H_HIT = ov(ov(H_BASE, 4, 2, 'KKSSSSSKSS'), 6, 2, 'KsSSSrrrSSSS')
  const H_DOWN = ov(H_BASE, 4, 2, 'KKSSSSSsSS')

  const T_STAND = [
    '..WWWSkSSWWW..',
    '.WWWwSSYSwWWW.',
    '.WwWWwSYwWWwW.',
    '.WwWWWwYWWWwW.',
    '.WwWWWWwWWWwW.',
    '.WwWWWWWWWWwW.',
    '.SwEEEEYEEEwS.',
    '..WWWWWWWWWW..',
  ]
  const T_SWING = [
    '..WWWSkSSWWW..',
    '.WWWwSSYSwWWW.',
    '.WwWWwSYwWWwWW',
    'WwWWWWwYWWWwWS',
    'WwWWWWWwWWWw..',
    'SwWWWWWWWWWw..',
    '..wEEEEYEEEw..',
    '..WWWWWWWWWW..',
  ]
  const T_LAPEL = [
    '..WWWSkSSWWW..',
    '.WWWSSSYSSSWW.',
    '.WWwWwSYwWwWW.',
    '.WwWWWwYWWWwW.',
    '..WWWWWwWWWW..',
    '..WWWWWWWWWW..',
    '..wEEEEYEEEw..',
    '..WWWWWWWWWW..',
  ]
  const T_UP = [
    '..WWWSkSSWWWW.',
    '.WWWwSSYSwWWW.',
    '.WwWWwSYwWWW..',
    '.WwWWWwYWWWW..',
    '.WwWWWWwWWWW..',
    '.SwWWWWWWWWW..',
    '..wEEEEYEEEw..',
    '..WWWWWWWWWW..',
  ]
  const T_HOLD = [
    '..WWWSkSSWWW..',
    '.WWWwSSYSwWWW.',
    '.WwWWwSYwWWWWS',
    '.WwWWWwYWWWW..',
    '.WwWWWWwWWWW..',
    '.SwWWWWWWWWW..',
    '..wEEEEYEEEw..',
    '..WWWWWWWWWW..',
  ]
  const T_KNOCK = ov(T_UP, 0, 12, 'WS')
  const T_DANCE = [
    '.WWWWSkSSWWW..',
    '..WWwSSYSwWWW.',
    '..WWWwSYwWWwW.',
    '..WWWWwYWWWSW.',
    '..WWWWWwWWWSW.',
    '..WWWWWWWWWW..',
    '..wEEEEYEEEw..',
    '..WWWWWWWWWW..',
  ]
  const L_STAND = ['..WWWWWWWWWW..', '...WWWW.WWWW..', '...WWWw.WWWw..', '...WWWw.WWWw..', '..WWWWw.WWWWw.', '..EEEEE.EEEEEE']
  const L_A = ['..WWWWWWWWWW..', '..WWWW..WWWW..', '.WWWw....WWWw.', '.WWW......WWW.', 'WWWw......WWWw', 'EEE.......EEEE']
  const L_B = ['..WWWWWWWWWW..', '...WWWWWWWW...', '....WWWwWW....', '....WWWwWW....', '....WWWwWW....', '...WWWWwWWWW..', '...EEEEEEEEE..']
  const L_C = ['..WWWWWWWWWW..', '..wWWW..WWWw..', '.wWWW....WWWw.', '.WWW......wWW.', 'WWWW......wWWW', 'EEE.......EEEE']
  const L_D = ['..WWWWWWWWWW..', '...WWWWWWWW...', '...WWWW.WWW...', '...WWW..WWW...', '..WWWw..WWWW..', '..WWW...WWWW..', '..EEE...EEEEE.']
  const L_WIDE = ['..WWWWWWWWWW..', '..WWWW..WWWW..', '.WWWw....WWWw.', '.WWW......WWW.', 'WWWw......WWWw', 'EEE........EEE']
  const L_THRUST = ['...WWWWWWWWWWW', '....WWWWWWWWW.', '....WWW..WWWW.', '...WWW....WWW.', '..WWWw....WWWW', '..EEEE...EEEEE']
  const ARM_UP = ['S.............', 'W.............', '.W............']

  const SLUMP = [
    '..............',
    '....KKKK......',
    '...KSKSKK.....',
    '..KSSSSSSS....',
    '..KSSSSSSSS...',
    '..KKSSSSsSS...',
    '..KKSSSSSSSS..',
    '...KsSSSSSSSS.',
    '....SSSSSSSs..',
    '...WWsSSSEs...',
    '..WWWWSYSWW...',
    '.WWWWWwYWWWW..',
    '.WWWWWWwWWWSS.',
    '.WWWWWWWWWW...',
    '.wEEEEEEEEw...',
    '.WWWWWWWWWWWW.',
    '..RRRRRRRWWWW.',
    '...a...a..WWW.',
    '...a...a..WWW.',
    '...aaaaa..WWW.',
    '...a...a.EEEEE',
    '..aa...aa.....',
  ]
  const FLOOR_SIT = [
    '...KKKK.......',
    '..KSKSKK......',
    '.KSSSSSSS.....',
    '.KKSSSSsSS....',
    '.KKSSSSSSSS...',
    '..KSSSSSSSSS..',
    '...SSSSSSSs...',
    '..WWsSSSEWW...',
    '.WWWWWYWWWWWW.',
    '.WWWWWwYWWWWS.',
    '.WWWWWWwWWWWW.',
    '.WWWWWWWWWWWW.',
    '.wEEEEEEEWWWW.',
    'WWWWWWWWWWWWW.',
    'WWWWWWWW.EEEE.',
  ]
  const FLAT = [
    '...............KKK.....',
    'EE.WWWWWWWWWWWKSSSSS...',
    'EEWWWwWWWYWWWWKSSSESSSS',
    'EE.WWWWWWWWWWWKSSSSSS..',
    '.......SS.....SSSS.....',
  ]
  const ITEM_ROWS = {
    glass: ['a..a', 'aNNa', 'aNNa', '.aa.'],
    remote: ['EE', 'Er', 'EE', 'Eg', 'EE'],
    rose: ['.R.', 'RrR', '.R.', '.G.', 'GG.', '.G.'],
    pass: ['YYYY', 'YpYY', 'YYYY'],
    card: ['MMM', 'MRM', 'MMM'],
    wine: ['.E.', '.G.', 'GGG', 'GgG', 'GGG'],
  }
  const ITEM = {}
  for (const k in ITEM_ROWS) ITEM[k] = pairOutlined(ITEM_ROWS[k], P)

  // Larry variants: n = normal, m = mussed (hair up, lipstick), b = heart
  // boxers, x = burnt to a crisp.
  function larrySet(v) {
    const head = (h) => {
      if (v !== 'm') return h
      let r = ov(ov(h, 0, 2, '.K.K.KK.K.'), 1, 3, 'K.KSKSKK')
      r = ['...K..K..K....', ...r]
      r = ov(r, 3, 5, 'm')
      r = ov(r, 6, 6, 'm')
      return ov(r, 8, 10, 'm')
    }
    const torso = (t) => {
      if (v === 'm') return ov(ov(t, 0, 3, 'w'), 7, 4, 'cc')
      if (v !== 'b') return t
      return t.map((r, i) => (i >= 6 ? [...r].map((ch, j) => (ch === '.' ? '.' : (i + j) % 3 ? 'h' : 'M')).join('') : r.replace(/[Ww]/g, (ch) => (ch === 'W' ? 'M' : 'a')).replace(/Y/g, 'Y')))
    }
    const legs = (l) => {
      if (v !== 'b') return l
      return l.map((r, i) => (i === 0 ? [...r].map((ch, j) => (ch === '.' ? '.' : (i + j) % 3 ? 'h' : 'M')).join('') : r.replace(/W/g, 'S').replace(/w/g, 's')))
    }
    const fin = (rows) => (v === 'x' ? rc(rows, { W: 'A', w: 'E', S: 's', K: 'E', Y: 'y', M: 'A', k: 'E' }) : rows)
    const m = (rows) => mk(fin(rows), 6)
    const std = (h, t, l = L_STAND) => m([...head(h), ...torso(t), ...legs(l)])
    const set = {
      stand: std(H_BASE, T_STAND),
      talk: std(H_TALK, T_STAND),
      brow: std(H_LEER, T_LAPEL),
      lapel: std(H_BASE, T_LAPEL),
      hold: std(H_BASE, T_HOLD),
      knock: std(H_BASE, T_KNOCK),
      spray: std(ov(ov(ov(H_BASE, 7, 13, 'a'), 8, 12, 'Sa'), 9, 12, 'S'), T_UP),
      slapped: std(shiftL(H_HIT), T_STAND),
      dance1: m([...ARM_UP, ...ov(ov(head(H_TALK), 0, 1, 'W'), 1, 1, 'W'), ...torso(T_DANCE), ...legs(L_WIDE)]),
      dance2: m([...shiftL(head(H_LEER)), ...shiftL(torso(T_LAPEL)), ...legs(L_THRUST)]),
      walk: [
        std(H_BASE, T_SWING, L_A),
        std(H_BASE, T_STAND, L_B),
        std(H_BASE, T_SWING.map((r) => r), L_C),
        std(H_BASE, T_STAND, L_D),
      ],
      slump: m(v === 'm' ? head(SLUMP.slice(1, 10)).concat(SLUMP.slice(10)) : SLUMP),
      floor: m(FLOOR_SIT),
      flat: m(FLAT),
      down: std(H_DOWN, T_STAND),
    }
    return set
  }
  const LARRY = { n: larrySet('n'), m: larrySet('m'), b: larrySet('b'), x: larrySet('x') }

  // ---- the cast ----------------------------------------------------------------
  const npc = (top, legs, poses, cx = 5) => {
    const set = { stand: mk([...top, ...legs[0]], cx), walk: [mk([...top, ...legs[1]], cx), mk([...top, ...legs[0]], cx), mk([...top, ...legs[2]], cx), mk([...top, ...legs[0]], cx)] }
    for (const k in poses) set[k] = mk(poses[k].length > 20 ? poses[k] : [...poses[k], ...legs[0]], cx)
    return set
  }
  // woman in red (big 80s hair) — Fawn is the blonde in blue
  const LADY_TOP = [
    '...KKKKK....',
    '..KKKKKKK...',
    '.KKKKSSSSK..',
    '.KKKSSSSES..',
    'KKKKSSSSSSS.',
    'KKKKSSSSSS..',
    'KKKKKSSSmm..',
    '.KKKKKSSS...',
    '..KKKSSS....',
    '...RRRRRR...',
    '..RRRrRRRR..',
    '..SRRRrRRS..',
    '..SRRRRRRS..',
    '..S.RRRR.S..',
    '..S.RRRR.S..',
    '....RRRRR...',
    '...RRRRRR...',
    '...RRRRRRR..',
    '..RRRRRRRR..',
  ]
  const LADY_LEGS = [
    ['....SS.SS...', '....SS.SS...', '....SS.SS...', '....SS.SS...', '...RRR.RRR..'],
    ['...SS...SS..', '...SS...SS..', '..SS.....SS.', '..SS.....SS.', '.RRR.....RRR'],
    ['....SSSS....', '....SSSS....', '....SS.S....', '....SS.S....', '...RRRRRR...'],
  ]
  const ladyPoses = (top) => ({
    talk: ov(top, 6, 8, 'Em'),
    slap: ov(ov(ov(top, 10, 10, 'SSS'), 11, 9, 'S.'), 9, 11, 'S'),
    fan1: ov(ov(ov(ov(ov(top, 3, 12, 'Y'), 4, 11, 'YY'), 5, 11, 'Y'), 6, 11, 'S'), 10, 9, 'SS'),
    fan2: ov(ov(ov(ov(top, 4, 12, 'Y'), 5, 12, 'Y'), 6, 11, 'SY'), 10, 9, 'SS'),
    nails: ov(ov(top, 9, 8, 'S'), 8, 8, 'Sa'),
    dance1: ov(ov(ov(top, 0, 9, 'S'), 1, 9, 'S'), 2, 9, 'S'),
    dance2: shiftR(ov(top, 12, 10, 'SS')),
  })
  const LADY = npc(LADY_TOP, LADY_LEGS, ladyPoses(LADY_TOP))
  const FAWN_TOP = ov(ov(rc(LADY_TOP, { K: 'L', R: 'B', r: 'b' }), 9, 0, 'LLL'), 10, 0, '.LL')
  const FAWN = npc(FAWN_TOP, LADY_LEGS.map((l) => rc(l, { R: 'B' })), ladyPoses(FAWN_TOP))

  const BART_TOP = [
    '....SSSS....',
    '...SSSSSS...',
    '..nSSSSSSS..',
    '..nSSSSESS..',
    '..nsSSSSSSS.',
    '..nSSSSSSS..',
    '...SSnnnnn..',
    '....SSSSS...',
    '..WWWRRRWW..',
    '.WWEEWRWEEWW',
    '.WWEEEWEEEWW',
    '.WWEEEWEEEWW',
    '.SWEEEEEEEWS',
    '..WEEEEEEEW.',
    '...EEEEEEE..',
    '...AAAAAAA..',
  ]
  const PANTS = [['...AAA.AAA..', '...AAA.AAA..', '...AAA.AAA..', '...AAA.AAA..', '..EEEE.EEEE.'], ['..AAA...AAA.', '..AAA...AAA.', '.AAA.....AAA', '.AAA.....AAA', 'EEE.......EE'], ['....AAAAA...', '....AAAAA...', '....AA.AA...', '....AA.AA...', '...EEEEEE...']]
  const BART = npc(BART_TOP, PANTS, {
    talk: ov(BART_TOP, 7, 4, 'SSRS'),
    pour: ov(ov(ov(BART_TOP, 11, 11, 'S'), 10, 12, 'G'), 9, 12, 'G'),
    rest: ov(ov(BART_TOP, 3, 7, 's'), 12, 9, 'WMM'),
  })
  const DEAL_TOP = ov(ov(ov(BART_TOP, 0, 3, 'KKKKK'), 1, 1, 'gggggggggg'), 2, 2, 'K')
  const DEALER = npc(DEAL_TOP, PANTS, {
    talk: ov(DEAL_TOP, 7, 4, 'SSRS'),
    deal: ov(ov(DEAL_TOP, 11, 11, 'SM'), 12, 10, '..'),
  })
  const CLERK_TOP = [
    '...GGGGG....',
    '..GGGGGGGGG.',
    '..KSSSSSS...',
    '..KSEESEES..',
    '..KSSSSSSSS.',
    '...SSSSSS...',
    '...SSSRS....',
    '....SSSS....',
    '..OOOOOOOO..',
    '.OOOOOOOOOO.',
    '.OOOMOOOOOO.',
    '.OOOOOOOOOO.',
    '.SOOOOOOOOS.',
    '..OOOOOOOO..',
    '..AAAAAAAA..',
  ]
  const CLERK = npc(CLERK_TOP, PANTS, { talk: ov(CLERK_TOP, 6, 3, 'SSRRS'), shout: ov(ov(CLERK_TOP, 6, 3, 'SRRRS'), 1, 11, 'SS') })
  const MIN_TOP = [
    '....aaaa....',
    '...aaaaaa...',
    '..aSSSSSSS..',
    '..aSSSSESS..',
    '..aSSSSSSSS.',
    '...SSSSSSS..',
    '...SSSES....',
    '....SSSS....',
    '...EEMMEE...',
    '..EEEEEEEE..',
    '.EEEEEEEEEE.',
    '.EAEEEEEERRS',
    '.EAEEEEEERR.',
    '.SEEEEEEEE..',
    '..EEEEEEEE..',
    '..EEEEEEEE..',
  ]
  const MIN = npc(MIN_TOP, PANTS.map((l) => rc(l, { A: 'E' })), { talk: ov(MIN_TOP, 6, 3, 'SSRS') })
  const DRUNK_TOP = [
    '...aaaa.....',
    '..aKKKKa....',
    '..KSSSSSa...',
    '.aKSSESSS...',
    '..KSSSSSrr..',
    '..aSSaSrr...',
    '...aSaSa....',
    '...NNNNN....',
    '..NNNNnNN...',
    '.NNNNNnNNN..',
    '.NNNNNnNSSG.',
    '.NNNNNnNN.G.',
    '.NNNNNnNN...',
    '.NNNNNNNN...',
    '..NNNNNNN...',
    '..NNNNNNN...',
    '..AAA.AAA...',
  ]
  const DRUNK_LEGS = [['..AAA.AAA...', '..AA...AA...', '..AA...AA...', '.EEE..EEE...'], ['.AAA...AAA..', '.AA.....AA.', 'AA.......AA.', 'EEE.....EEE.'], ['...AAAAA....', '...AA.AA....', '...AA.AA....', '..EEEEEE....']]
  const DRUNK = npc(DRUNK_TOP, DRUNK_LEGS, {
    talk: ov(DRUNK_TOP, 5, 3, 'SaRSr'),
    sway: shiftL(DRUNK_TOP),
    drink: ov(ov(ov(DRUNK_TOP, 10, 8, 'SS.'), 4, 9, 'aNNa'), 5, 9, 'aNNa'),
    sleep: [
      '............',
      '............',
      '............',
      '............',
      '............',
      '............',
      '............',
      '............',
      '.....aaaa...',
      '....aKKKKa..',
      '....KSSSSSa.',
      '...aKSSsSSS.',
      '....KSSSSSrr',
      '....aSSaSrr.',
      '..NNNNNaSa..',
      '.NNNNNNNN...',
      'NNNNNNnNNN..',
      'NNNNNNnNNNG.',
      'NNNNNNNNNNG.',
      'AAAAAAAAAAG.',
      'AAAAAAAAAAAE',
      '.EE......EEE',
    ],
  })
  DRUNK.rest = DRUNK.sleep
  const DOOR_TOP = [
    '....PPPPP.....',
    '....PYYYP.....',
    '..PPPPPPPPP...',
    '....SSSSSS....',
    '...SSEEEEES...',
    '...SSSSSSSS...',
    '...SSSSSSS....',
    '....SSnnSS....',
    '...SSSSSS.....',
    '..PPPYSSYPP...',
    '.PPPPpYYpPPP..',
    '.PPPPPpPPPPPP.',
    '.PPpPPPPPPpPP.',
    '.PPpPPPPPPpPP.',
    '.PPpPPPPPPpPP.',
    '.SSpPPPPPPpSS.',
    '...pPPPPPPp...',
    '...PPPPPPPP...',
  ]
  const DOOR_LEGS = [
    ['...PPP..PPP...', '...PPP..PPP...', '...PPP..PPP...', '...PPP..PPP...', '...PPP..PPP...', '..EEEE..EEEE..'],
    ['..PPP....PPP..', '..PPP....PPP..', '.PPP......PPP.', '.PPP......PPP.', '.PPP......PPP.', 'EEEE......EEEE'],
    ['....PPPPPP....', '....PPPPPP....', '....PPP.PP....', '....PPP.PP....', '....PPP.PP....', '...EEEEEEE....'],
  ]
  const DOORMAN = npc(DOOR_TOP, DOOR_LEGS, {
    talk: ov(DOOR_TOP, 7, 4, 'SSRRS'),
    cheer: ov(ov(ov(ov(ov(DOOR_TOP, 15, 1, '..'), 15, 11, '..'), 6, 0, 'S'), 7, 0, 'P'), 8, 1, 'P').map((r, i) => (i >= 6 && i <= 8 ? r.slice(0, 12) + (i === 6 ? 'S.' : i === 7 ? 'P.' : 'P.') : r)),
  }, 6)

  // taxi (34 wide) with the cabbie in the front window; red sedan for traffic
  const TAXI_ROWS = [
    '..............EEEEEE..............',
    '..............EYYYYE..............',
    '..........YYYYYYYYYYYYYY..........',
    '.........YccccccYccccccY..........',
    '........YcccccccYcccccccY.........',
    '.......YYcccccccYccccccccY........',
    '..YYYYYYYYYYYYYYYYYYYYYYYYYYYYY...',
    '.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY.',
    'aYEYEYEYEYEYEYEYEYEYEYEYEYEYEYYYYa',
    'aYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYM',
    'aYYYYEEEYYYYYYYYYYYYYYYYEEEYYYYYYa',
    '.YYYEEaEEYYYYYYYYYYYYYYEEaEEYYYY..',
    '....EaaaE..............EaaaE......',
    '.....EEE................EEE.......',
  ]
  const withHead = (rows, c, art) => art.reduce((r, line, i) => ov(r, 3 + i, c, line), rows)
  const CABBIE = ['.AAA', 'AAAA', '.SSE', '.SSS']
  const LARRY_HEAD = ['KSK.', 'SSSS', 'SSES', '.SSS']
  const TAXI = withHead(TAXI_ROWS, 19, CABBIE)
  const TAXI_SPR = { empty: pairOutlined(TAXI, P), fare: pairOutlined(withHead(TAXI, 10, LARRY_HEAD), P) }
  const CAR_ROWS = rc(TAXI_ROWS.map((r, i) => (i < 2 ? '.'.repeat(r.length) : r)), { Y: 'R', E: 'R' }).map((r, i) => (i >= 10 ? r.replace(/RRR(?=R*a?$)/, 'RRR') : r))
  CAR_ROWS[10] = 'aRRRREEERRRRRRRRRRRRRRRREEERRRRRRa'
  CAR_ROWS[11] = '.RRREEaEERRRRRRRRRRRRRREEaEERRRR..'
  CAR_ROWS[12] = '....EaaaE..............EaaaE......'
  CAR_ROWS[13] = '.....EEE................EEE.......'
  const CAR = pairOutlined(CAR_ROWS, P)

  // ---- locations ---------------------------------------------------------------
  // Each lives in an open stretch of the bar (L: between eyes and title,
  // R: between title and the ◇ glyph); marks are fractions of that stretch.
  const LOCS = {
    street: { gap: 'L', name: "Outside Lefty's", marks: { home: 0.6, rest: 0.6, door: 0.16 }, cast: [] },
    bar: { gap: 'R', name: "Lefty's Bar", stool: true, marks: { home: 0.6, rest: 0.6, B: 0.28, W: 0.78, D: 0.97 }, cast: [['B', 'B', 1], ['W', 'W', -1], ['D', 'D', -1]] },
    backroom: { gap: 'L', name: 'Back room', marks: { home: 0.6, rest: 0.66, door: 0.2, doorR: 0.36, M: 0.42, tv: 0.88 }, cast: [['M', 'door', 1, true]] },
    disco: { gap: 'R', name: 'The disco', marks: { home: 0.42, rest: 0.25, F: 0.7, W: 0.7, curb: 0.5 }, cast: [['F', 'F', -1]] },
    store: { gap: 'L', name: '24-hour store', marks: { home: 0.88, rest: 0.88, C: 0.6 }, cast: [['C', 'C', 1]] },
    casino: { gap: 'R', name: 'Casino', marks: { home: 0.6, rest: 0.6, K: 0.27, table: 0.55, slot: 0.76 }, cast: [['K', 'K', 1]] },
    chapel: { gap: 'L', name: 'Wedding chapel', marks: { home: 0.72, rest: 0.8, P: 0.3, F: 0.52 }, cast: [['P', 'P', 1], ['F', 'F', 1]] },
  }

  // ---- the story ---------------------------------------------------------------
  // ['X', text] speech (N narrator box, X death box); text may be an array of
  // alternatives or a function of the story state. Lowercase = stage verbs.
  // Line pools, drawn from shuffle bags so repeats are rare over a day.
  const POOLS = {
    pickup: [
      'Want to see my polyester up close?', 'Is it hot in here, or is it my suit?', 'Your place or mine? Mine has a hot plate.',
      'They call me the Love Lizard. Ask anyone.', 'I lost my number. Can I have yours?', "I'm not a doctor, but I'll check you out.",
      'Nice dress. It would look great on my floor.', 'Do you like big tippers? I tip big.', "Are you a parking ticket? You've got FINE.",
      'My chain is real gold. Mostly. Ask me how.', "I may not be tall, but I lie down great.", "I'm like a fine wine. I come in a box.",
      'Want to see my etchings? I have one.', 'Do you believe in love at first squint?', 'Hi. Larry. I have a car. Well, a bus pass.',
      'Feel this lapel. Go on. Feel it.', "I'm not drunk. I'm intoxicated by you.", 'Excuse me, is this seat taken? By me?',
      'Is that a slot machine? Because I hit the jackpot.', "My hot tub seats two. Or one and a half if it's me.",
      "I'm not wearing underwear. I lost a bet. Twice.", "I'd buy you a drink, but I'd rather give you the money.",
      'They say I have the hips of a much younger man.', "Let's skip dinner. I already ate a breath mint.",
    ],
    brush: [
      'Not if you were the last man in Nevada.', 'My husband wrestles bears. For fun.', "I'd rather kiss the drunk.", 'Ew. And also: ew.',
      'Go home, Polyester.', 'Is that a chain or a leash?', 'Your breath could strip paint.', "I've had better offers from a slot machine.",
      'Sure. When pigs fly. In a leisure suit.', 'Does your mother know you dress like that?', "I'm waiting for someone. Anyone else.",
      'Back off, Saturday Night Fever.', 'You smell like a mint died.', 'Keep walking, Romeo. Keep. Walking.',
    ],
    rej: [
      (n) => `Rejections tonight: ${n}. A new record.`, (n) => `Rejections: ${n}. Who's counting? You are.`,
      (n) => `Rejection #${n}. Your ego files a complaint.`, (n) => `Rejections: ${n}. Your hairline left too.`,
      (n) => `That's ${n}. Your libido sends regrets.`, (n) => `Rejection #${n}. Still batting zero, slugger.`,
      (n) => `${n} no's. Statistically, a yes is due.`, (n) => `Rejection #${n}. Even your chain looks sad.`,
    ],
    look: [
      'Larry Laffer. Wide lapels. Wider hopes.', 'Your comb-over is holding. For now.', 'You check your fly. All systems go.',
      'A gold chain, an open shirt. Irresistible.', '38 and single. Mostly the single part.', 'Your equipment works. Probably.',
      'Chest hair: present. Dignity: pending.', 'You smell of breath spray and hope.',
      'The suit is tight in all the wrong places.', 'Your fly is open. It always is. Optimism.',
      'A ladies\' man. The ladies have not been told.', 'Larry Laffer: lover, fighter, mostly napper.',
    ],
    later: ['Some time later...', 'Several minutes later... okay, two.', 'Later. A little later. Not much.', 'Meanwhile, out of view...'],
    bye: ['Thank you for playing. Stay frisky.', 'Thanks for playing. Wash that suit.', 'The end. Larry will be back. He always is.', 'Game over. Larry, never.'],
    cursor: [
      'Hey there, pointer. Come here often?', 'Nice arrow. Is it pointing at me?', 'You clicked? I knew you would.', 'Easy, cursor. Buy me a drink first.',
      'Hover any closer and we are engaged.', "Careful, pointer. I'm a live wire down here.", 'Is that a cursor or are you happy to see me?',
      'You and me, mouse. Double-click and find out.',
    ],
    // clicking Larry again and again
    poke: [
      "Hey! Watch the polyester. It's dry-clean only.", "Poke me again. I dare you. Please.", "Ooh. Do that again, but lower.",
      "That tickles. And I'm not that kind of guy. Usually.", 'Careful. The chain is load-bearing.', "Easy, I'm saving myself. For anyone.",
      "You can touch the merchandise. That's what it's for.", 'I bruise like a peach. A sexy peach.',
    ],
    sprayL: ['Minty fresh. Ladies, form a line.', 'Kissable. Theoretically.', 'Now I taste like a candy cane. Ask me how.', 'Breath: 10. Rest of me: pending.'],
    pants: ['Your pants fall down. Nobody notices. Worse.', 'Pants: down. Dignity: also down.', 'The boxers have hearts. The hearts are hopeful.'],
    pantsUp: ['...Nobody saw that.', 'Air conditioning. Very refreshing.', 'That was on purpose. A preview.'],
    drag: ["Whoa! Put me down! ...Unless you're a lady.", 'Higher! I can see down her dress from here!', "I'm flying! Like a polyester eagle!", 'Easy! I bruise! Sexily!'],
    land: ['Stuck the landing. Ladies?', 'I meant to do that. Smooth.', 'Ow. My... everything.'],
  }
  // the cursor lingering on someone
  const HOVER = {
    B: ['Lookin\' or drinkin\', pal?', 'Hands off my bar rag.'],
    W: ['Eyes up here, pointer.', 'Hover somewhere else, creep.', 'Is that thing yours or his?'],
    D: ['Hic. Two arrowsh. Nishe.', 'Point at me again. I dare ya. Hic.'],
    M: ['You pointin\' at me?', 'No hovering. House rule.'],
    F: ['Ooh, a pointer. Is it rich?', 'Mm. Point that somewhere useful.'],
    C: ['Touch it, you bought it.', 'Pointing is free. Looking is a dollar.'],
    K: ['No pointing at the cards.', 'Cursors bet a dollar minimum.'],
    P: ['Pointing in church? Ten bucks.', 'Are you here to marry him? Somebody should.'],
    T: ["Meter's running, pointer."],
  }
  // what a click on someone makes them do (besides talking)
  const REPLY = {
    W: ['Keep your hands where I can see them, Larry.', 'Was that your elbow? It better be.', 'Try that again and lose it.'],
    F: ['Ooh, frisky. Do you have money?', 'Later, tiger. Bring wine.', 'Was that a pinch? Pinches cost extra.'],
  }
  const BAGS = {}
  function bag(name, arg) {
    let b = BAGS[name]
    if (!b || !b.length) {
      b = BAGS[name] = POOLS[name].slice()
      for (let i = b.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[b[i], b[j]] = [b[j], b[i]]
      }
    }
    const v = b.pop()
    return typeof v === 'function' ? v(arg) : v
  }
  const rejLine = (d) => bag('rej', d.rej)
  const sprayLine = (d) => (d.squirts > 0 ? `Breath spray: ${d.squirts} squirts. Ration them.` : 'Your breath spray is empty. An omen.')
  const EP1 = {
    name: 'Part 1: Land of the Lounge Lizards',
    scenes: [
      { loc: 'street', steps: [
        ['N', 'Lost Wages. Night. Larry Laffer, 38, arrives.'],
        ['N', 'Age check: who was Spiro Agnew?'],
        ['L', ['A cologne? A position?', 'A cologne? A lounge singer?']],
        ['N', 'Close enough. Welcome, adult.'],
        ['L', "Tonight's the night. Tonight, Larry scores."],
        ['spray'],
        ['N', sprayLine],
        ['pose', 'L', 'lapel'],
        ['L', 'White polyester. It breathes. Like me.'],
        ['N', 'The suit is flame retardant. Mostly.'],
        ['pose', 'L', 'stand'],
        ['leer', 'L', 1600],
        ['L', "Lefty's. Where the ladies are. Allegedly."],
        ['score', 1],
        ['N', 'You found a bar. +1. Easy, tiger.'],
      ] },
      { loc: 'bar', steps: [
        ['N', "Lefty's. Sticky floors. Stickier patrons."],
        ['B', "What'll it be, pal?"],
        ['L', 'Whiskey. Neat. Like me.'],
        ['B', "You're neither. Two bucks."],
        ['pose', 'B', 'pour', 900],
        ['pose', 'B', 'stand'],
        ['item', 'L', 'glass'],
        ['walk', 'L', '@W'],
        ['spray'],
        ['leer', 'L', 1600],
        ['L', ['Is that a mirror in your pocket?', 'Do you have a quarter? For my phone?', () => bag('pickup')]],
        ['L', ['Because I can see myself in your pants.', 'My mother said to call when I met the one.', 'No, really. Ask anyone. Ask the drunk.']],
        ['W', ['Not a chance, Polyester.', 'Your mother called. She wants the suit back.', () => bag('brush')]],
        ['slap'],
        ['rej'],
        ['L', 'She wants me. The slap says so.'],
        ['D', 'Pssst. Buddy. Thash a nice whiskey.'],
        ['walk', 'L', '@D'],
        ['L', "It's yours, friend. I'm driving."],
        ['give', 'D'],
        ['D', 'Bless ya. Here. I found thish remote.'],
        ['item', 'L', 'remote'],
        ['pose', 'L', 'hold', 900],
        ['pose', 'L', 'stand'],
        ['score', 3],
        ['N', 'You got a TV remote. Kinky? No. +3'],
        ['pose', 'D', 'sleep'],
        ['B', "Back room's through there. Need the word."],
      ] },
      { loc: 'backroom', steps: [
        ['N', 'A door with a peephole. Carved on it:'],
        ['N', '"KEN WAS HERE. KEN HAD A GREAT TIME."'],
        ['walk', 'L', 'doorR'],
        ['face', 'L', 'door'],
        ['knock'],
        ['peep', 1],
        ['M', 'Password.'],
        ['L', 'Uh... open sesame?'],
        ['M', 'Nope.'],
        ['L', "Big boy? Love machine? Larry's here?"],
        ['M', 'Double nope. Triple on "love machine."'],
        ['N', 'You recall the carving. Ken had fun.'],
        ['L', '...Ken sent me.'],
        ['peep', 0],
        ['door', 1],
        ['show', 'M'],
        ['walk', 'M', 'M'],
        ['M', "Ken sent ya? Ken's a legend."],
        ['M', "Nobody goes up, though. I'm watching TV."],
        ['tv', 1],
        ['face', 'M', 'tv'],
        ['walk', 'L', 'home'],
        ['L', "What's on Channel 4, big guy?"],
        ['item', 'L', 'remote'],
        ['pose', 'L', 'hold', 700],
        ['tv', 2],
        ['pose', 'L', 'stand'],
        ['N', 'You switch to "Late Night Aerobics."'],
        ['pose', 'M', 'cheer'],
        ['M', 'Whoa. Leg warmers. Nobody move.'],
        ['walk', 'L', 'door'],
        ['hide', 'L'],
        ['wait', 1800],
        ['show', 'L'],
        ['walk', 'L', 'home'],
        ['item', 'L', 'pass'],
        ['pose', 'L', 'hold', 0],
        ['score', 5],
        ['N', 'Upstairs: a disco pass and a dead plant. +5'],
        ['L', 'Disco. My natural habitat.'],
        ['pose', 'L', 'stand'],
        ['M', 'Feel the burn, ladies. FEEL IT.'],
      ] },
      { loc: 'street', steps: [
        ['N', 'Outside. Lost Wages never sleeps. Alone.'],
        ['L', 'Taxi!'],
        ['N', 'You step off the curb to wave...'],
        ['car', 'hit'],
        ['X', 'You were flattened by a Buick.'],
        ['X', 'Your best side is now your only side.'],
        ['restore'],
        ['N', 'Game restored. You stay on the curb.'],
        ['L', 'Taxi! ...From right here.'],
        ['cab', 'arrive'],
        ['T', 'Where to, mac?'],
        ['L', 'The disco. And step on it, baby.'],
        ['T', "Don't call me baby. Nice suit. Lose a bet?"],
        ['L', 'Ladies love polyester. It clings.'],
        ['T', 'So does that cologne. Get in.'],
        ['cab', 'board'],
        ['cab', 'drive', 'disco'],
      ] },
      { loc: 'disco', steps: [
        ['T', 'Twelve bucks. Open a window next time.'],
        ['cab', 'alight'],
        ['N', 'You tip him a wink. He is not amused.'],
        ['cab', 'leave'],
        ['N', 'The disco. The ball spins. So do your hips.'],
        ['walk', 'L', '@F'],
        ['spray'],
        ['leer', 'L', 1600],
        ['L', "Hey, baby. What's your sign?"],
        ['F', '"Not in this lifetime."'],
        ['L', "Ha! A Scorpio. I'm Larry. Larry Laffer."],
        ['F', 'Fawn. A girl gets thirsty, Larry.'],
        ['F', 'And roses make me... friendly.'],
        ['L', "Don't move, Fawn. I'll be right back!"],
        ['pose', 'F', 'nails'],
        ['N', "Fawn files her nails. She's seen your type."],
      ] },
      { loc: 'store', steps: [
        ['N', 'The 24-hour store. Friendly for none of them.'],
        ['C', 'Help ya?'],
        ['L', 'One rose. One wine. And, uh...'],
        ['leer', 'L', 1200],
        ['L', '...some protection. Discreetly.'],
        ['pose', 'C', 'shout'],
        ['C', 'RUBBERS! WHAT SIZE, PAL?'],
        ['pose', 'C', 'stand'],
        ['N', 'The whole store turns to look.'],
        ['L', '...Extra large?'],
        ['C', 'Ha! Sure. Regular it is.'],
        ['item', 'L', 'rose'],
        ['pose', 'L', 'hold', 0],
        ['score', 2],
        ['N', 'You bought a rose, wine and a "rubber." +2'],
        ['pose', 'L', 'stand'],
        ['N', 'Hope springs eternal. Mostly unused.'],
        ['C', 'Good luck, buddy. You need it.'],
      ] },
      { loc: 'disco', steps: [
        ['walk', 'L', '@F'],
        ['pose', 'F', 'stand'],
        ['item', 'L', 'rose'],
        ['pose', 'L', 'hold', 0],
        ['L', 'For you, Fawn. A rose for a rose.'],
        ['F', "Ooh, and wine? Aren't you sweet."],
        ['pose', 'L', 'stand'],
        ['score', 3],
        ['F', 'Okay, stud. Show me those hips.'],
        ['dance', 5000],
        ['fan', 'F', 2600],
        ['N', 'Fawn fans herself. Or wafts your cologne.'],
        ['L', 'Ow. My back. ...Nailed it.'],
        ['score', 10],
        ['N', 'She said yes to a dance! +10'],
        ['F', 'Now. A girl likes a man with money.'],
        ['L', 'Money. Sure. I have... a dollar.'],
        ['F', 'Then go win some, big spender.'],
      ] },
      { loc: 'casino', steps: [
        ['N', 'The casino. The house always wins.'],
        ['K', 'Blackjack. Dollar minimum.'],
        ['walk', 'L', 'table'],
        ['L', 'One dollar. My last. Deal, sugar.'],
        ['deal'],
        ['K', 'Twenty-two. You bust.'],
        ['L', 'Double or nothing. I bet... the suit.'],
        ['deal'],
        ['K', 'Nineteen. House wins. Strip, pal.'],
        ['suit', 'b'],
        ['N', 'Heart-print boxers. Bold choice, Larry.'],
        ['walk', 'L', 'slot'],
        ['N', 'You find a quarter in your sock.'],
        ['L', 'Come on, baby. Daddy needs pants.'],
        ['slot', 'win'],
        ['coins'],
        ['score', 15],
        ['N', 'JACKPOT! $500! +15'],
        ['suit', 'n'],
        ['K', 'Here. Put the suit back on. Please.'],
        ['L', "Fawn! Fawn, I'm rich!"],
      ] },
      { loc: 'chapel', steps: [
        ['N', 'The Quickie Wedding Chapel. Open 24 hours.'],
        ['F', 'Larry, darling. Marry me. Right now.'],
        ['L', 'Married? I... I do! Yes! Twice!'],
        ['P', 'Do you? Do you? Done. That is $100.'],
        ['score', 20],
        ['N', 'You are married! +20. The suite awaits.'],
        ['F', 'Honeymoon suite, tiger. Hot tub and all.'],
        ['leer', 'L', 1600],
        ['L', 'Hot tub? Hot DOG!'],
        ['walk', 'F', '@L'],
        ['censor', 5200],
        ['N', () => bag('later')],
        ['suit', 'm'],
        ['exit', 'F', 1],
        ['N', 'You are dishevelled. And alone.'],
        ['N', 'Fawn took the $400. And the bathrobe.'],
        ['rej'],
        ['L', 'She will be back. It was... magical.'],
        ['P', 'They never come back, son. Next!'],
        ['N', () => bag('bye')],
      ] },
    ],
  }
  const EP2 = {
    name: 'Part 2: Larry Gets Lucky (Maybe)',
    scenes: [
      { loc: 'street', steps: [
        ['N', 'Episode: Larry Gets Lucky (Maybe).'],
        ['N', 'The next night. Still married. Sort of.'],
        ['L', 'New night. New Larry. Same suit.'],
        ['fx', (d) => (d.squirts = 0)],
        ['spray'],
        ['N', sprayLine],
        ['L', "Who needs spray? I've got charisma."],
        ['N', 'You also have lipstick on your ear.'],
      ] },
      { loc: 'bar', cast: [['B', 'B', 1], ['W', 'W', -1], ['D', 'D', -1]], steps: [
        ['B', "You again? Where's the missus?"],
        ['L', "She's... getting the car."],
        ['B', 'Uh huh. Whiskey?'],
        ['L', 'Make it a double. Long night.'],
        ['walk', 'L', '@W'],
        ['leer', 'L', 1600],
        ['L', 'Your legs must be tired, baby.'],
        ['L', "You've been running through my mind."],
        ['W', "And now I'm running out the door."],
        ['exit', 'W', 1],
        ['rej'],
        ['D', "Hey! You're the whiskey guy!"],
        ['D', 'Hot tip: slot machine number three.'],
        ['score', 2],
        ['N', 'A tip from a drunk. Foolproof. +2'],
      ] },
      { loc: 'casino', steps: [
        ['K', 'Back so soon? Keep your pants on.'],
        ['walk', 'L', 'slot'],
        ['L', 'Machine number three. Come to papa.'],
        ['slot', 'lose'],
        ['N', 'Lemon. Lemon. Drunk.'],
        ['L', 'One more pull. Story of my life.'],
        ['slot', 'win'],
        ['coins'],
        ['score', 10],
        ['N', 'Three cherries! The drunk was right! +10'],
        ['K', "Lucky suit. Don't bet it this time."],
      ] },
      { loc: 'store', steps: [
        ['C', 'You again. Regular size?'],
        ['L', 'Breath spray. The big one. And more...'],
        ['L', '...supplies. Lots of supplies.'],
        ['C', 'Optimist. I love it.'],
        ['fx', (d) => (d.squirts = 20)],
        ['score', 2],
        ['N', sprayLine],
        ['spray'],
        ['C', '...Still need it, pal.'],
      ] },
      { loc: 'disco', cast: [['W', 'W', -1]], steps: [
        ['N', 'The disco. The woman in red. Again!'],
        ['L', 'Fate! Or a really small town!'],
        ['walk', 'L', '@W'],
        ['spray'],
        ['leer', 'L', 1600],
        ['L', "Care to dance? I'm a professional."],
        ['W', 'A professional what?'],
        ['L', '...Mover. Watch these hips!'],
        ['dance', 3600],
        ['fire'],
        ['X', "Polyester and disco lights don't mix."],
        ['X', 'You went up like a birthday candle.'],
        ['restore'],
        ['N', 'Restored. Dance with less... friction.'],
        ['dance', 3600],
        ['fan', 'W', 2600],
        ['W', 'Okay, Larry. That was... something.'],
        ['score', 10],
        ['N', 'She danced with you! Somebody tell Fawn.'],
        ['W', 'My place has a hot tub. Coming?'],
        ['L', 'I was born ready. In this suit.'],
        ['walk', 'W', '@L'],
        ['censor', 5200],
        ['N', () => bag('later')],
        ['suit', 'm'],
        ['N', ['Lipstick everywhere. +100!', 'Lipstick on your collar. And ear. +100!']],
        ['score', 100],
        ['L', 'I did it. I DID IT! Larry scores!'],
        ['dream'],
        ['B', "Hey. Pal. Wake up. We're closing."],
        ['suit', 'n'],
        ['pose', 'L', 'stand'],
        ['N', 'It was all a dream. The drool is real.'],
        ['L', 'Same time tomorrow, Lefty.'],
        ['N', () => bag('bye')],
      ] },
    ],
  }
  const EP3 = {
    name: 'Room for One',
    scenes: [
      { loc: 'street', steps: [
        ['N', 'Episode: Larry Laffer, Room for One.'],
        ['N', ['A new night. Same polyester. Fresh spray.', 'Another night. The suit has seen things.']],
        ['L', 'Lady Luck, here I come. Literally, I hope.'],
        ['N', 'Lady Luck has a restraining order.'],
        ['spray'],
        ['leer', 'L', 1400],
        ['L', ['Casino first. Romance later. Or during.', "Money first. Then the ladies. That's science."]],
      ] },
      { loc: 'casino', steps: [
        ['K', ['You. The boxers guy.', 'Oh no. Not the polyester again.']],
        ['walk', 'L', 'table'],
        ['L', 'Deal me in, sugar. I feel lucky.'],
        ['deal'],
        ['K', 'Twenty-one. Again. Who ARE you?'],
        ['coins'],
        ['score', 10],
        ['K', 'House prize: the honeymoon suite key.'],
        ['item', 'L', 'pass'],
        ['pose', 'L', 'hold', 0],
        ['N', 'You won a honeymoon suite. Now get a honey.'],
        ['L', 'Room for two. Applicants welcome.'],
        ['pose', 'L', 'stand'],
      ] },
      { loc: 'bar', steps: [
        ['B', ['The big winner! Drinks on you?', 'Look who got lucky. At cards, anyway.']],
        ['L', 'Drinks on me, Lefty. Not literally.'],
        ['walk', 'L', '@W'],
        ['spray'],
        ['leer', 'L', 1600],
        ['L', 'I have a suite. With a hot tub. And a key.'],
        ['W', 'You have a key. I have a husband.'],
        ['W', 'He works the back door. Big guy. Purple.'],
        ['L', '...How big?'],
        ['rej'],
        ['D', 'Psst. Ken shays the back way is shafer.'],
        ['N', 'The drunk is wrong. He is always wrong.'],
      ] },
      { loc: 'backroom', steps: [
        ['walk', 'L', 'doorR'],
        ['knock'],
        ['peep', 1],
        ['M', 'Password.'],
        ['L', 'Ken sent me?'],
        ['M', 'You the guy hitting on my wife?'],
        ['L', 'Hitting? No! Complimenting. Vigorously.'],
        ['peep', 0],
        ['door', 1],
        ['show', 'M'],
        ['walk', 'M', 'M'],
        ['pose', 'M', 'cheer'],
        ['M', 'Come here, Polyester.'],
        ['flee'],
        ['N', 'You run faster than you dance. Barely.'],
      ] },
      { loc: 'store', steps: [
        ['C', 'Why are you panting?'],
        ['L', 'Hide me. Big purple guy. Very big.'],
        ['C', "Buy something and you're a customer."],
        ['L', 'One... uh... rubber. Large.'],
        ['pose', 'C', 'shout'],
        ['C', 'LARGE? HA! ...Aisle two, champ.'],
        ['pose', 'C', 'stand'],
        ['score', 2],
        ['N', 'You bought time. And the regular size.'],
      ] },
      { loc: 'disco', steps: [
        ['F', 'Larry? Larry Laffer? My ex-husband!'],
        ['L', 'Fawn! You came back!'],
        ['F', 'I heard you won a suite, big spender.'],
        ['leer', 'L', 1600],
        ['L', 'Room for two. Hot tub. No refunds.'],
        ['F', 'One dance first. Then we talk.'],
        ['dance', 4000],
        ['fan', 'F', 2400],
        ['F', "Fine. But I'm holding the key."],
        ['walk', 'F', '@L'],
        ['censor', 5200],
        ['N', () => bag('later')],
        ['suit', 'm'],
        ['exit', 'F', 1],
        ['N', 'Fawn left. So did the key. Not the lipstick.'],
        ['rej'],
        ['L', 'Same time next year, Fawn!'],
        ['N', () => bag('bye')],
      ] },
    ],
  }
  const EPS = [EP1, EP2, EP3]

  // busy: each location's action loop; done: its small victory
  const GUESSES = ['Swordfish?', 'Bob sent me.', 'Kenny sent me?', 'Larry sent me. I am Larry.', 'Your mom sent me?', 'Big boy?', 'Abracadabra?']
  const NOPES = ['Nope.', 'Not even close.', 'She did NOT. ...Did she?', 'Try again, Romeo.']
  const ACTION = {
    street: (i) => [['L', ['Taxi!', 'TAXI!', 'Hey! I tip! Sometimes!', 'Taxi! I have cash! Some!']], ['car', 'pass'], ['wait', 500]],
    bar: (i) => [['walk', 'L', '@W'], ['spray'], ['leer', 'L', 900], ['L', () => bag('pickup')], ['W', () => bag('brush')], ['slap'], ['rej'], ['wait', 400]],
    backroom: (i) => [['walk', 'L', 'doorR'], ['knock'], ['peep', 1], ['M', 'Password.'], ['L', GUESSES[i % GUESSES.length]], ['M', NOPES[i % NOPES.length]], ['peep', 0], ['wait', 400]],
    disco: (i) => [['dance', 3200], [i % 2 ? 'F' : 'L', i % 2 ? ['Easy, tiger. Your back!', 'Is that a move or a cramp?'] : ['The Lost Wages Thrust!', 'Feel the polyester, baby!', 'Hips like a cement mixer!']], [i % 2 ? 'W' : 'L', ['Easy, tiger. You will pull something.', 'Did you just wink with your hips?']], ['wait', 300]],
    store: (i) => [['spray'], ['L', ['Mint. No. Cinnamon. No...', 'Do these come in ribbed?', 'Got anything in "irresistible"?']], ['pose', 'C', 'shout'], ['C', ['PRICE CHECK ON RIBBED!', 'Pick one or marry it, pal.', 'We are out of irresistible.']], ['pose', 'C', 'stand'], ['wait', 400]],
    casino: (i) => [['walk', 'L', 'table'], ['L', ['Hit me.', 'Hit me, sugar.', 'One more. Gently.']], ['deal'], ['K', ['Twenty-one. Again?!', 'Blackjack. Who ARE you?', 'You win. The pit boss is sweating.']], ['coins'], ['score', 1], ['wait', 400]],
    chapel: (i) => [['L', ['Are we married yet?', 'Do I kiss the bride now? Now?', 'How long is a quickie wedding?']], ['P', ['Hold still, son.', 'Patience. And fewer winks.', 'Four minutes. Five with vows.']], ['wait', 600]],
  }
  const WIN = {
    street: [['car', 'drive-by'], ['L', 'I hailed a cab! It slowed down!'], ['score', 2], ['N', 'It slowed down to laugh. +2. Still counts.']],
    bar: [['walk', 'L', '@W'], ['L', 'I also do card tricks. Watch my hands.'], ['W', '...Okay, that one was a little funny.'], ['score', 2], ['N', 'She smiled! At you! Probably. +2']],
    backroom: [['knock'], ['peep', 1], ['L', 'Ken sent me.'], ['M', 'Why didnt ya say so? Go on up.'], ['peep', 0], ['score', 5], ['N', 'Ken has a lot of friends. +5']],
    disco: [['dance', 2600], ['fan', 'F', 2000], ['F', 'Okay, stud. One more dance. Slow.'], ['score', 10], ['N', 'She said yes! Mark the calendar. +10']],
    store: [['C', 'Exact change? Nobody has exact change.'], ['score', 2], ['N', 'You count coins like a pro. +2']],
    casino: [['deal'], ['K', 'Blackjack. The house... loses.'], ['coins'], ['score', 15], ['N', 'You win! The suit was lucky after all. +15']],
    chapel: [['P', 'You may now... kiss the bride.'], ['kiss'], ['score', 20], ['N', 'Someone finally said "I do." +20']],
  }
  const TALK = {
    B: ["We're out of everything but whiskey.", 'Tip jar is right there, pal.', 'I seen guys like you. Mostly leaving.', "The ladies' room is for ladies, Larry.", 'Last guy in that suit got lucky. In a coma.'],
    W: ["Don't even think about it.", 'Eyes up here, Polyester.', 'Are you lost, or just ugly?', "I've seen bigger tips on a pencil.", "My last boyfriend was a Chippendale. You're a chip."],
    D: ["Hic. You're my besht friend.", 'I usedta be a lounge lizard too.', 'Thish bar spins. Ish nice.', 'Shecret: the hooker upstairs likesh roses.', 'I got lucky once. Nineteen shixty... shomething.'],
    M: ['Move along, sport.', 'Ken says hi.', 'Touch the TV and you die.', 'Leg warmers, man. Leg. Warmers.'],
    F: ['Gifts first, lover boy.', "Is that a chain or a cry for help?", 'Mmm. Do you have money?', 'A girl likes a big... wallet.', "Talk dirty to me. Say 'cash'."],
    C: ['Buy something or beat it.', "Don't touch the magazines.", 'Spray is aisle two. Go. Now.', 'The magazines are for reading, pal. READING.', "Rubbers don't come in 'hopeful'."],
    K: ['Place your bets.', 'No touching the cards.', 'Nice chain. Is it real? No.', "Keep your pants on this time, huh?"],
    T: ["Meter's running, mac.", 'Seatbelt. Please. For me.', "Don't do anything back there I'd have to clean."],
    P: ['Love is patient. I am not.', 'Cash or check?', 'Till death do you part. Or till checkout.', 'The bridal suite rents by the hour.'],
  }
  const SPOTS = {
    eyes: { verb: 'talk to eyes', say: ['The eyes follow you. Finally, interest!', 'They blink first. You win.'] },
    title: { verb: 'look at title', say: ['"aico · neri." Classy joint.', 'Sounds like a cologne. You would buy it.'] },
    glyph: { verb: 'take diamond', say: ["It's glass. So is your ring.", 'Too small. Story of your life.'] },
    min: { verb: 'shrink button', say: ["Don't. You're sensitive about shrinking."] },
    max: { verb: 'enlarge button', say: ['If only it were that easy, Larry.'] },
    close: { verb: 'close window', say: ['Closing time already? You just got here.'] },
  }

  // ---- actors ------------------------------------------------------------------
  const SETS = { L: LARRY.n, B: BART, W: LADY, D: DRUNK, M: DOORMAN, F: FAWN, C: CLERK, K: DEALER, P: MIN }
  const ZOF = { B: 0, C: 0, K: 0 }
  class Guy {
    constructor(s, key, x, dir) {
      this.s = s
      this.key = key
      this.set = SETS[key]
      this.x = x
      this.y = FLOOR
      this.dir = dir
      this.tx = null
      this.speed = WALK
      this.ft = 0
      this.pose = 'stand'
      this.cb = null
      this.hidden = false
      this.item = null
      this.talking = false
      this.resting = null
      this.anim = null // {kind, until}
      this.z = ZOF[key] ?? 2
      if (key === 'L') this.z = 3
    }
    get moving() {
      return this.tx !== null
    }
    hit(x, y) {
      if (this.hidden || (this.key === 'L' && this.s.data.censor)) return false
      const top = FLOOR - 27 - (this.lift || 0)
      return Math.abs(x - this.x) <= 9 && y >= top && y <= FLOOR + 1
    }
    get grabbable() {
      const d = this.s.data
      return this.key === 'L' && !this.hidden && !d.censor && !d.inCab && !d.paused
    }
    // Larry can be picked up by the collar and put down somewhere else
    grab(p) {
      const d = this.s.data
      d.grabAt = performance.now()
      this.held = true
      this.anim = null
      interject(this.s, 'L', bag('drag'))
      this.drag(p)
    }
    drag(p) {
      this.s.data.grabAt = performance.now()
      if (!this.held) return
      const nx = clamp(p.x, 8, this.s.W - 8)
      if (Math.abs(nx - this.x) > 1.5) this.dir = nx > this.x ? 1 : -1
      this.x = nx
      this.lift = clamp(FLOOR - (p.y + 16), 0, 11 + (typeof SPILL_UP === 'number' ? Math.min(7, SPILL_UP) : 0)) // a little past the top
    }
    drop() {
      const d = this.s.data
      d.grabAt = performance.now()
      if (!this.held) return
      this.held = false
      this.falling = true
      if (this.tx === null) d.strayed = true
    }
    land() {
      const s = this.s
      const d = s.data
      this.falling = false
      this.lift = 0
      for (let i = 0; i < 4; i++) s.particle({ img: pix('a'), x: this.x - 6 + i * 4, y: FLOOR - 2, vx: (i - 1.5) * 8, vy: -6, life: 0.4, fade: true })
      // dropped next to a lady: she does not appreciate it
      const w = [d.cast.W, d.cast.F].find((a) => a && !a.hidden && !a.moving && Math.abs(a.x - this.x) < 16)
      if (w && this.tx === null) {
        w.dir = this.x > w.x ? 1 : -1
        flash(s, w, 'slap', 900)
        flash(s, this, 'slapped', 900)
        s.say('SLAP!', (w.x + this.x) / 2, FLOOR - 25, { color: '#ffe455', life: 0.8, size: 7 })
        interject(s, w.key, pick(['Did you just fall on me?', 'Nice try, Polyester.', 'Hands. Off. Now.']))
        return
      }
      const dr = d.cast.D
      if (dr && !dr.hidden && Math.abs(dr.x - this.x) < 16) return interject(s, 'D', 'Hic. Ish raining men.')
      interject(s, 'L', bag('land'))
    }
    goto(x, speed = WALK, cb = null) {
      this.tx = Math.round(x)
      this.speed = speed
      this.cb = cb
      this.resting = null
      if (Math.abs(this.tx - this.x) < 1) {
        this.tx = null
        cb?.()
      }
    }
    update(dt, now) {
      if (this.held) return FAST
      if (this.falling) {
        this.lift = Math.max(0, (this.lift || 0) - 80 * dt)
        if (this.lift <= 0) this.land()
        return FAST
      }
      if (this.tx !== null) {
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
        this.ft += dt
        return FAST
      }
      if (this.anim) {
        if (now >= this.anim.until) {
          this.anim = null
          return FAST
        }
        const per = this.anim.per
        return Math.min(per - (now % per) + 1, this.anim.until - now)
      }
      return Infinity
    }
    sprite(now) {
      const st = this.set
      if (this.held || this.falling) return st.dance1 || st.stand // arms up, legs dangling
      if (this.tx !== null || this.kwalk) return st.walk[Math.floor(this.ft * (this.speed > 30 || this.kwalk ? 10 : 7)) % st.walk.length]
      if (this.resting) return st[this.resting] || st.stand
      if (this.anim) {
        const f = Math.floor(now / this.anim.per) % 2
        const k = this.anim.kind
        if (k === 'dance') return st[f ? 'dance1' : 'dance2'] || st.stand
        if (k === 'fan') return st[f ? 'fan1' : 'fan2'] || st.stand
        if (k === 'leer') return f ? st.brow || st.stand : st.lapel || st.stand
        if (k === 'sway') return f ? st.sway || st.stand : st.stand
      }
      if (this.talking && this.pose === 'stand' && st.talk) return st.talk
      return st[this.pose] || st.stand
    }
    draw(c) {
      if (this.hidden) return
      const now = performance.now()
      const sp = this.sprite(now)
      const left = this.dir > 0 ? this.x - sp.cx : this.x - (sp.ow - 1 - sp.cx)
      const lift = Math.round(this.lift || 0)
      c.drawImage(sp[this.dir], Math.round(left) - 1, FLOOR - sp.h + 1 - lift)
      if (lift) return
      if (this.item && this.pose === 'hold' && !this.tx) {
        const it = ITEM[this.item]
        const hx = this.dir > 0 ? this.x + 7 : this.x - 7 - (it.w - 2)
        c.drawImage(it[this.dir], Math.round(hx) - 1, FLOOR - 13 - (it.h - 2))
      }
    }
    onClick() {
      clickActor(this.s, this)
    }
  }

  class Cab {
    constructor(s, x, car = false) {
      this.s = s
      this.x = x // left edge
      this.y = FLOOR
      this.dir = -1
      this.tx = null
      this.speed = 90
      this.cb = null
      this.fare = false
      this.car = car
      this.z = car ? 4 : 1
      this.w = 34
      this.bob = 0
      this.key = 'T'
    }
    get moving() {
      return this.tx !== null
    }
    get cx() {
      return this.x + this.w / 2
    }
    hit(x, y) {
      return !this.car && x >= this.x && x <= this.x + this.w && y >= FLOOR - 15
    }
    goto(x, speed, cb) {
      this.tx = Math.round(x)
      this.speed = speed
      this.cb = cb
    }
    update(dt) {
      if (this.tx === null) return Infinity
      const d = this.tx - this.x
      this.dir = d > 0 ? 1 : -1
      this.bob += dt
      if (Math.abs(d) <= this.speed * dt + 0.01) {
        this.x = this.tx
        this.tx = null
        const cb = this.cb
        this.cb = null
        cb?.()
        return FAST
      }
      this.x += this.dir * this.speed * dt
      this.onMove?.(this)
      return FAST
    }
    draw(c) {
      const sp = this.car ? CAR : this.fare ? TAXI_SPR.fare : TAXI_SPR.empty
      const b = this.tx !== null && Math.floor(this.bob * 10) % 2 ? 1 : 0
      c.drawImage(sp[this.dir], Math.round(this.x) - 1, FLOOR - sp.h + 1 - b)
    }
    onClick() {
      clickActor(this.s, this)
    }
  }

  // front props (counters, tables) between the staff and the customers
  class Front {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = 1
    }
    update() {
      return Infinity
    }
    draw(c) {
      drawProps(this.s, c, true)
    }
  }

  // clickable scenery in the current room: TV, slot machine, disco ball, ...
  function zones(s) {
    const d = s.data
    if (!d.loc || !d.gaps) return []
    const X = (f) => gx(s, f)
    const F = FLOOR
    const z = (k, verb, x0, x1, y0, y1 = F) => ({ k, verb, x0: x0 - 2, x1: x1 + 2, y0: y0 - 2, y1 })
    switch (d.loc) {
      case 'street':
        return [z('door', "open Lefty's door", X(0.12), X(0.12) + 11, F - 17), z('sign', 'read sign', X(0.02), X(0.34), F - 26, F - 17), z('lamp', 'lean on lamp', X(0.96) - 3, X(0.96) + 3, F - 26)]
      case 'bar':
        return [z('bottles', 'take bottle', X(0.06), X(0.06) + 34, F - 27, F - 19), z('counter', 'ring for service', X(0.03), X(0.5), F - 12)]
      case 'backroom': {
        const dx = X(0.2) - 6
        const tx = X(0.88) - 6
        return [z('kdoor', 'knock on door', dx - 1, dx + 13, F - 23), z('tv', 'change channel', tx, tx + 12, F - 19)]
      }
      case 'disco':
        return [z('ball', 'spin ball', X(0.55) - 3, X(0.55) + 3, F - 28, F - 19), z('speaker', 'turn it up', X(0.99) - 3, X(0.99) + 4, F - 14)]
      case 'store':
        return [z('shelf', 'browse magazines', X(0.02), X(0.34), F - 21), z('till', 'ring register', X(0.44), X(0.44) + 8, F - 16, F - 9)]
      case 'casino': {
        const sx = X(0.94) - 5
        return [z('slot', 'pull lever', sx, sx + 12, F - 22), z('table', 'tap table', X(0.03), X(0.52), F - 14)]
      }
      case 'chapel':
        return [z('arch', 'ring the bells', X(0.3) - 11, X(0.3) + 12, F - 27)]
    }
    return []
  }
  class Hotspots {
    constructor(s) {
      this.s = s
      this.prop = true
      this.z = 0
    }
    at(x, y) {
      const d = this.s.data
      if (d.paused || d.inCab || d.censor) return null
      return zones(this.s).find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1) || null
    }
    hit(x, y) {
      return !!this.at(x, y)
    }
    verb(p) {
      return this.at(p.x, p.y)?.verb ?? null
    }
    update() {
      return Infinity
    }
    draw() {}
    onClick(p) {
      const q = this.at(p.x, p.y)
      if (q) clickSpot(this.s, q.k, p)
    }
  }

  // ---- layout helpers -------------------------------------------------------------
  // Each room is a "stage" in one of the open stretches beside the title:
  // 120-220 px wide, pulled toward the title (so walks stay short on wide
  // bars) and, when the stretch is too narrow, allowed to spill in front of
  // the title rather than leave the bar.
  const MIN_STAGE = 120
  const MAX_STAGE = 220
  function gaps(s) {
    const e = s.fixture('eyes')
    const t = s.fixture('title')
    const tc = t.x + t.w / 2
    let right = s.W
    for (const f of s.fix) if (f !== t && f.x > tc && f.x < right) right = f.x
    for (const f of s.dots) if (f.x > tc && f.x < right) right = f.x
    const lo = e.x + e.w + 4
    const hi = right - 4
    const stage = (a, b, nearRight) => {
      const gw = b - a
      const w = Math.min(clamp(gw, MIN_STAGE, MAX_STAGE), Math.max(60, hi - lo))
      let x0 = nearRight ? b - w : a
      if (gw < w) x0 = a + (gw - w) / 2
      x0 = clamp(x0, lo, Math.max(lo, hi - w))
      return { x0, x1: x0 + w, w }
    }
    s.data.gaps = { L: stage(e.x + e.w + 8, t.x - 8, true), R: stage(t.x + t.w + 8, right - 8, false), mid: tc, lo, hi }
  }
  const gapOf = (s, loc) => s.data.gaps[LOCS[loc].gap]
  const gx = (s, f, loc = s.data.loc) => {
    const g = gapOf(s, loc)
    return Math.round(g.x0 + f * g.w)
  }
  function markX(s, m, mover) {
    const d = s.data
    if (typeof m === 'number') return gx(s, m)
    if (m[0] === '@') {
      const a = m === '@L' ? d.larry : d.cast[m.slice(1)]
      if (!a) return null
      const side = mover && mover.x > a.x ? 1 : -1
      return a.x + side * (m === '@L' ? 9 : 15)
    }
    const f = LOCS[d.loc].marks[m]
    return f === undefined ? null : gx(s, f)
  }

  // ---- story runner ---------------------------------------------------------------
  const SPEAK = new Set(['L', 'B', 'W', 'D', 'M', 'F', 'C', 'K', 'T', 'P', 'N', 'X'])
  const REEXEC = new Set(['walk', 'wait', 'dance', 'fan', 'leer', 'knock'])
  const lineMs = (t) => clamp(1500 + t.length * 68, 2500, 4500)

  function present(s, k) {
    const d = s.data
    if (k === 'N' || k === 'X') return true
    if (k === 'L') return true
    if (k === 'T') return !!d.cab
    if (k === 'M' && LOCS[d.loc].marks.door !== undefined && d.loc === 'backroom') return true
    return !!d.cast[k]
  }
  function speakerX(s, k) {
    const d = s.data
    if (k === 'L') return d.larry.x
    if (k === 'T') return d.cab ? d.cab.cx + 4 : d.larry.x
    const a = d.cast[k]
    if (a && !a.hidden) return a.x
    if (k === 'M') return markX(s, 'door')
    return d.gaps.mid
  }
  function setLine(s, who, text, now, inter = false) {
    const d = s.data
    const ln = { who, text, until: now + lineMs(text) }
    for (const a of allGuys(s)) a.talking = false
    const sp = who === 'L' ? d.larry : d.cast[who]
    if (sp) {
      sp.talking = true
      const other = who === 'L' ? nearestCast(s, d.larry) : d.larry
      if (other && !sp.moving && !sp.anim && Math.abs(other.x - sp.x) < 70 && Math.abs(other.x - sp.x) > 2) sp.dir = other.x > sp.x ? 1 : -1
    }
    if (inter) d.inter = ln
    else d.line = ln
    return ln
  }
  function nearestCast(s, from) {
    let best = null
    for (const k in s.data.cast) {
      const a = s.data.cast[k]
      if (a.hidden) continue
      if (!best || Math.abs(a.x - from.x) < Math.abs(best.x - from.x)) best = a
    }
    return best
  }
  const allGuys = (s) => [s.data.larry, ...Object.values(s.data.cast)]

  function setLoc(s, loc, castDef) {
    const d = s.data
    const def = castDef || LOCS[loc].cast
    d.loc = loc
    const keep = {}
    for (const [k, mark, dir, hidden] of def) {
      let a = d.cast[k]
      const x = gx(s, LOCS[loc].marks[mark], loc)
      if (!a) {
        a = new Guy(s, k, x, dir)
        s.spawn(a)
      }
      a.x = x
      a.tx = null
      a.dir = dir
      a.pose = 'stand'
      a.hidden = !!hidden
      a.anim = null
      a.item = null
      keep[k] = a
    }
    for (const k in d.cast) if (!keep[k]) d.cast[k].dead = true
    d.cast = keep
    if (d.cab && !d.inCab) {
      d.cab.dead = true
      d.cab = null
    }
    d.peep = 0
    d.door = 0
    d.tv = 0
    d.cards = 0
    d.slot = { reels: [0, 1, 2], until: 0 }
    s.poke()
  }

  function startScene(s) {
    const d = s.data
    const sc = EPS[d.ep].scenes[d.si]
    gaps(s) // the title (session name) may have changed width since last time
    d.mode = 'script'
    d.prog = [['travel', sc.loc, sc.cast], ...sc.steps]
    d.pc = 0
    d.started = false
  }
  function nextScene(s) {
    const d = s.data
    d.si++
    if (d.si >= EPS[d.ep].scenes.length) {
      d.ep = pick(EPS.map((_, i) => i).filter((i) => i !== d.ep))
      d.si = 0
      d.score = 0
      d.squirts = 9
      d.episodes++
    }
    if (d.si === 0) larryVariant(s, 'n')
    startScene(s)
  }
  function larryVariant(s, v) {
    s.data.larry.set = LARRY[v]
    s.data.variant = v
  }

  function finishStep(s) {
    const d = s.data
    d.pc++
    d.started = false
    d.waitUntil = 0
    d.waitFor = null
  }

  function run(s, now) {
    const d = s.data
    for (let guard = 0; guard < 40; guard++) {
      if (d.started) {
        if (d.waitFor) {
          if (!d.waitFor(now)) return d.waitPoll || FAST
          d.waitFor = null
        }
        if (now < d.waitUntil) return d.waitUntil - now
        finishStep(s)
        continue
      }
      // a step boundary: mode switches happen here
      if (!d.inCab && !d.cabBusy) {
        if (d.wantWin) {
          d.wantWin = false
          d.mode = 'win'
          d.prog = WIN[d.loc]
          d.pc = 0
          continue
        }
        if (s.busy && d.mode === 'script' && d.pc > 0) {
          d.savedPc = d.pc
          d.mode = 'action'
          d.actionRuns = 0
          d.prog = ACTION[d.loc](d.actionN++)
          d.pc = 0
          continue
        }
        if (d.strayed && !engaged(s, now)) {
          d.strayed = false
          const hx = markX(s, 'home')
          if (Math.abs(d.larry.x - hx) > 30) {
            d.larry.goto(hx)
            d.started = true
            d.waitFor = () => !d.larry.moving
            continue
          }
        }
      }
      if (d.pc >= d.prog.length && !d.wantWin) {
        if (d.mode === 'action') {
          if (s.busy && ++d.actionRuns >= 3) {
            // the work pushes the plot on: this room's win, then the next scene
            d.wantWin = true
            d.prog = []
            d.pc = 0
          } else if (s.busy) {
            d.prog = ACTION[d.loc](d.actionN++)
            d.pc = 0
          } else {
            d.mode = 'script'
            d.prog = EPS[d.ep].scenes[d.si].steps
            d.pc = d.savedPc
          }
          continue
        }
        nextScene(s)
        continue
      }
      d.started = true
      exec(s, d.prog[d.pc], now)
    }
    return FAST
  }

  function walkTo(s, a, x, speed = WALK) {
    const d = s.data
    if (x === null || x === undefined || !a) return
    a.anim = null
    a.goto(clamp(x, -30, s.W + 30), speed)
    d.waitFor = () => !a.moving
  }

  function exec(s, st, now) {
    const d = s.data
    const k = st[0]
    const L = d.larry
    if (SPEAK.has(k)) {
      if (!present(s, k)) return
      let t = st[1]
      if (Array.isArray(t)) t = pick(t)
      if (typeof t === 'function') t = t(d)
      const ln = setLine(s, k, t, now)
      d.waitUntil = ln.until + 1000 // a beat between lines (the parser line shows here)
      return
    }
    const who = st[1] === 'L' ? L : d.cast[st[1]]
    switch (k) {
      case 'travel':
        travel(s, st[1], st[2])
        return
      case 'walk':
        if (!who) return
        walkTo(s, who, markX(s, st[2], who))
        return
      case 'face': {
        const x = st[2] === 'L' ? L.x : d.cast[st[2]] ? d.cast[st[2]].x : markX(s, st[2])
        if (who && x !== null) who.dir = x > who.x ? 1 : -1
        return
      }
      case 'pose':
        if (!who) return
        who.pose = st[2]
        who.anim = null
        d.waitUntil = now + (st[3] || 0)
        return
      case 'item':
        L.item = st[2]
        return
      case 'give': {
        const a = d.cast[st[1]]
        L.item = 'glass'
        L.pose = 'hold'
        if (a) a.pose = 'drink'
        d.waitUntil = now + 900
        d.after = () => {
          L.pose = 'stand'
          L.item = null
        }
        return
      }
      case 'leer':
        if (!who) return
        who.anim = { kind: 'leer', per: 200, until: now + st[2] }
        d.waitUntil = now + st[2]
        return
      case 'fan':
        if (!who) return
        who.anim = { kind: 'fan', per: 180, until: now + st[2] }
        d.waitUntil = now + st[2]
        return
      case 'spray':
        L.pose = 'spray'
        if (d.squirts > 0) {
          d.squirts--
          for (let i = 0; i < 5; i++) s.particle({ img: pix(i % 2 ? 'c' : 'w'), x: L.x + L.dir * 8, y: FLOOR - 16 + rand(-1, 1), vx: L.dir * rand(14, 26), vy: rand(-6, 2), life: rand(0.5, 0.9), fade: true })
        } else s.say('pfft', L.x + L.dir * 10, FLOOR - 22, { color: '#a6a6b2', life: 0.9, size: 6 })
        d.waitUntil = now + 900
        d.after = () => (L.pose = 'stand')
        return
      case 'slap': {
        const w = d.cast.W || d.cast.F
        if (!w) return
        w.dir = L.x > w.x ? 1 : -1
        w.pose = 'slap'
        L.pose = 'slapped'
        L.dir = w.x > L.x ? 1 : -1
        s.say('SLAP!', (w.x + L.x) / 2, FLOOR - 25, { color: '#ffe455', life: 0.8, size: 7 })
        for (let i = 0; i < 3; i++) s.particle({ img: STAR, x: L.x - 2 + i * 3, y: FLOOR - 26, vx: rand(-10, 10), vy: rand(-14, -6), life: 0.8, fade: true })
        d.waitUntil = now + 1100
        d.after = () => {
          w.pose = 'stand'
          L.pose = 'stand'
        }
        return
      }
      case 'kiss': {
        const f = d.cast.F || d.cast.W
        if (f) walkTo(s, f, L.x + (f.x > L.x ? 9 : -9))
        s.particle({ img: BUBBLE['♥'], x: L.x - 3, y: FLOOR - 25, vy: -1.5, life: 1.4, fade: true })
        d.waitUntil = now + 1400
        return
      }
      case 'rej':
        d.rej++
        setLine(s, 'N', rejLine(d), now)
        d.waitUntil = d.line.until
        return
      case 'score':
        d.score += st[1]
        jingle(s, st[1])
        d.waitUntil = now + 700
        return
      case 'wait':
        d.waitUntil = now + st[1]
        return
      case 'fx':
        st[1](d, s)
        return
      case 'hide':
        if (who) who.hidden = true
        return
      case 'show':
        if (who) who.hidden = false
        return
      case 'exit':
        if (!who) return
        walkTo(s, who, st[2] > 0 ? s.W + 20 : -20)
        d.after = () => {
          who.dead = true
          delete d.cast[st[1]]
        }
        return
      case 'knock':
        L.pose = 'knock'
        s.say('knock knock', L.x + L.dir * 12, FLOOR - 22, { color: '#d8c08a', life: 0.9, size: 6 })
        d.waitUntil = now + 900
        d.after = () => (L.pose = 'stand')
        return
      case 'peep':
        d.peep = st[1]
        return
      case 'door':
        d.door = st[1]
        return
      case 'tv':
        d.tv = st[1]
        return
      case 'deal':
        d.cards = Math.min(5, d.cards + 2)
        if (d.cast.K) {
          d.cast.K.pose = 'deal'
          d.after = () => d.cast.K && (d.cast.K.pose = 'stand')
        }
        s.particle({ img: ITEM.card[1], x: gx(s, LOCS.casino.marks.K), y: FLOOR - 16, vx: 40, vy: -10, g: 40, life: 0.5 })
        d.waitUntil = now + 800
        return
      case 'coins':
        s.burst(L.x, FLOOR - 18, 14, ['Y', 'y', 'O'])
        d.waitUntil = now + 600
        return
      case 'slot':
        d.slot = { reels: [0, 0, 0], until: now + 2200, result: st[1] }
        d.waitUntil = now + 2300
        d.waitPoll = FAST
        d.waitFor = (t) => t >= d.slot.until
        d.after = () => {
          d.waitPoll = 0
          d.slot.reels = st[1] === 'win' ? [3, 3, 3] : [1, 1, 4]
          if (st[1] === 'win') s.burst(gx(s, 0.92), FLOOR - 16, 10, ['Y', 'r', 'w'])
        }
        return
      case 'dance': {
        const p = d.cast.F || d.cast.W
        L.anim = { kind: 'dance', per: 220, until: now + st[1] }
        if (p) p.anim = { kind: 'dance', per: 260, until: now + st[1] }
        d.beatUntil = now + st[1]
        d.waitUntil = now + st[1]
        return
      }
      case 'fire':
        larryVariant(s, 'x')
        L.anim = null
        for (let i = 0; i < 10; i++) s.particle({ img: pix(i % 3 ? 'a' : 'O'), x: L.x + rand(-5, 5), y: FLOOR - rand(6, 22), vx: rand(-4, 4), vy: rand(-16, -8), life: rand(0.8, 1.5), fade: true })
        d.waitUntil = now + 1500
        return
      case 'car': {
        const hitIt = st[1] === 'hit'
        const fromL = hitIt ? L.x > s.W / 2 : Math.random() < 0.5
        const car = new Cab(s, fromL ? -40 : s.W + 6, st[1] !== 'pass' || Math.random() < 0.6)
        if (!car.car) car.z = 1
        if (!hitIt) car.z = 1
        car.speed = Math.max(hitIt ? 190 : 170, s.W / 5)
        let struck = false
        car.onMove = (cr) => {
          if (hitIt && !struck && Math.abs(cr.cx - L.x) < 8) {
            struck = true
            L.pose = 'flat'
            L.anim = null
            s.burst(L.x, FLOOR - 6, 12, ['w', 'Y', 'r'])
            s.say('SPLAT', L.x, FLOOR - 16, { color: '#ff5555', life: 1, size: 7 })
          }
        }
        s.spawn(car)
        d.carBusy = true
        car.goto(fromL ? s.W + 6 : -40, car.speed, () => {
          car.dead = true
          d.carBusy = false
        })
        if (st[1] !== 'drive-by') d.waitFor = () => !d.carBusy
        if (hitIt) d.waitUntil = now + 900
        return
      }
      case 'restore':
        larryVariant(s, d.variant === 'x' ? 'n' : d.variant)
        L.pose = 'stand'
        L.anim = null
        s.burst(L.x, FLOOR - 12, 10, ['c', 'w'])
        d.waitUntil = now + 700
        return
      case 'censor':
        d.censor = { until: now + st[1], x: L.x }
        d.waitUntil = now + st[1]
        d.waitPoll = 160
        d.waitFor = (t) => !d.censor || t >= d.censor.until
        d.after = () => {
          d.waitPoll = 0
          d.censor = null
        }
        return
      case 'suit':
        d.pants = null
        larryVariant(s, st[1])
        if (st[1] === 'b') s.burst(L.x, FLOOR - 14, 10, ['w', 'a'])
        return
      case 'dream':
        setLoc(s, 'bar', [['B', 'B', 1]])
        L.x = markX(s, 'rest')
        L.dir = -1
        L.pose = 'slump'
        larryVariant(s, 'n')
        d.waitUntil = now + 1400
        return
      case 'cab':
        cabStep(s, st, now)
        return
      case 'flee': {
        const g = gapOf(s, d.loc)
        const out = Math.max(-16, g.x0 - 26)
        L.anim = null
        L.goto(out, HURRY + 14)
        const m = d.cast.M
        if (m) {
          m.pose = 'stand'
          m.goto(Math.max(out + 18, g.x0), WALK)
        }
        d.waitFor = () => !L.moving
        return
      }
    }
  }

  function travel(s, loc, castDef) {
    const d = s.data
    const L = d.larry
    L.pose = 'stand'
    L.item = null
    L.anim = null
    if (d.loc === loc) {
      if (castDef) setLoc(s, loc, castDef)
      walkTo(s, L, markX(s, 'home'))
      return
    }
    const same = LOCS[loc].gap === LOCS[d.loc].gap
    d.travelDone = false
    const arrive = () => {
      setLoc(s, loc, castDef)
      L.goto(markX(s, 'home'), WALK, () => (d.travelDone = true))
    }
    if (same) {
      const g = gapOf(s, d.loc)
      const out = LOCS[d.loc].gap === 'L' ? Math.max(-16, g.x0 - 26) : Math.min(s.W + 16, g.x1 + 26)
      L.goto(out, HURRY, arrive)
    } else {
      L.goto(d.gaps.mid, HURRY, arrive)
    }
    d.waitFor = () => d.travelDone
  }

  function cabStep(s, st, now) {
    const d = s.data
    const L = d.larry
    const what = st[1]
    if (what === 'arrive') {
      const cab = new Cab(s, s.W + 6)
      d.cab = cab
      s.spawn(cab)
      d.cabBusy = true
      cab.goto(L.x + 7, 110, () => {
        d.cabBusy = false
        cab.dir = -1
      })
      d.waitFor = () => !d.cabBusy
    } else if (what === 'board') {
      if (!d.cab) return
      L.hidden = true
      d.inCab = true
      d.cab.fare = true
      d.waitUntil = now + 600
    } else if (what === 'drive') {
      const cab = d.cab
      if (!cab) return
      const loc = st[2]
      const same = LOCS[loc].gap === LOCS[d.loc].gap
      const target = () => gx(s, LOCS[loc].marks.curb ?? LOCS[loc].marks.home, loc) - 17
      d.cabBusy = true
      const swap = () => {
        setLoc(s, loc)
        L.x = target() + 10
        cab.goto(target(), 110, () => (d.cabBusy = false))
      }
      if (same) cab.goto(-40, 130, () => swap())
      else cab.goto(d.gaps.mid - 17, 130, swap)
      d.waitFor = () => !d.cabBusy
    } else if (what === 'alight') {
      if (!d.cab || !d.inCab) return
      L.x = Math.round(d.cab.x + 10)
      L.hidden = false
      L.dir = 1
      d.inCab = false
      d.cab.fare = false
      d.waitUntil = now + 500
    } else if (what === 'leave') {
      const cab = d.cab
      if (!cab) return
      d.cab = null
      cab.goto(s.W + 8, 120, () => (cab.dead = true))
    } else if (what === 'pass') {
      exec(s, ['car', 'pass'], now)
    }
  }

  function jingle(s, n) {
    const L = s.data.larry
    for (let i = 0; i < 3; i++) s.particle({ img: BUBBLE['♪'], x: L.x - 12 + i * 10, y: FLOOR - 19 + (i % 2) * 3, vx: rand(-2, 2), vy: -4, life: 1.2, fade: true })
    s.particle({ digits: `+${n}`, x: L.x + 9, y: FLOOR - 20, vy: -4, life: 1.3, fade: true })
  }

  // ---- interaction --------------------------------------------------------------
  // Clicks add lines and small nudges on top of the plot; the plot never waits.
  const engaged = (s, now) =>
    now - (s.keyAt ?? -1e9) < 9000 || now - (s.data.clickAt || -1e9) < 9000 || now - (s.data.grabAt || -1e9) < 9000 || (s.cursor && now - s.cursor.since < 2500)
  // ---- keyboard: A/D walk Larry, W talks to or uses whatever is nearest, S is Larry
  // himself (look, spray, leer, pickup line), Space skips the current line.
  const freeToWalk = (s) => {
    const d = s.data
    const L = d.larry
    return !L.hidden && !L.held && !L.falling && !d.inCab && !d.censor && !d.paused && !L.cb
  }
  function keyWalk(s, dt) {
    const d = s.data
    const L = d.larry
    const k = s.keys
    const dir = k && k.has('left') !== k.has('right') ? (k.has('left') ? -1 : 1) : 0
    if (!dir || !freeToWalk(s)) {
      if (L.kwalk) {
        L.kwalk = false
        d.strayed = true
      }
      return false
    }
    if (L.tx !== null) {
      // the player takes over a scripted walk; the plot carries on from wherever he ends up
      L.tx = null
      L.cb = null
    }
    L.anim = null
    L.pose = L.pose === 'hold' ? 'hold' : 'stand'
    L.dir = dir
    L.kwalk = true
    L.ft += dt
    L.x = clamp(L.x + dir * HURRY * 1.3 * dt, 8, s.W - 8)
    return true
  }
  function keyUse(s) {
    const d = s.data
    const L = d.larry
    if (L.hidden) return
    // the nearest person within reach, else the nearest bit of scenery, else Larry himself
    let best = null
    for (const a of Object.values(d.cast)) if (!a.hidden && Math.abs(a.x - L.x) < 40 && (!best || Math.abs(a.x - L.x) < Math.abs(best.x - L.x))) best = a
    if (!best && d.cab && Math.abs(d.cab.cx - L.x) < 40) best = d.cab
    if (best) {
      if (!L.moving && Math.abs(best.x - L.x) > 2) L.dir = (best.cx ?? best.x) > L.x ? 1 : -1
      return clickActor(s, best)
    }
    let spot = null
    let sd = 1e9
    for (const q of zones(s)) {
      const dd = Math.abs((q.x0 + q.x1) / 2 - L.x) - (q.x1 - q.x0) / 2
      if (dd < 40 && dd < sd) {
        sd = dd
        spot = q
      }
    }
    if (spot) return clickSpot(s, spot.k, { x: clamp(L.x, spot.x0 + 2, spot.x1 - 2), y: Math.max(spot.y0 + 2, FLOOR - 8) })
    clickLarry(s, performance.now())
  }
  function keySkip(s, now) {
    const d = s.data
    // Space: hurry the story along (the current line ends), or wave off an aside
    if (d.inter) return endInter(s)
    const st = d.prog?.[d.pc]
    if (d.line && d.started && st && SPEAK.has(st[0])) {
      d.waitUntil = Math.min(d.waitUntil, now + 150)
      d.line.until = Math.min(d.line.until, now + 150)
      return
    }
    if (d.started && st && st[0] === 'wait') return void (d.waitUntil = Math.min(d.waitUntil, now))
    clickLarry(s, now)
  }
  function interject(s, who, text, now = performance.now()) {
    const d = s.data
    const sp = who === 'L' ? d.larry : d.cast[who]
    if (sp) {
      sp.talking = true
      if (!sp.moving && !sp.anim && !sp.held && who !== 'L' && Math.abs(d.larry.x - sp.x) < 70 && Math.abs(d.larry.x - sp.x) > 2) sp.dir = d.larry.x > sp.x ? 1 : -1
    }
    d.inter = { who, text, until: now + lineMs(text) }
    s.poke()
  }
  function endInter(s) {
    const d = s.data
    const who = d.inter?.who
    d.inter = null
    const sp = who === 'L' ? d.larry : who && d.cast[who]
    if (sp && d.line?.who !== who) sp.talking = false
  }
  /** Do something after ms (bounded; runs at once if the bar settles). */
  function later(s, ms, fn) {
    const d = s.data
    if (d.timers.length >= 16) return
    d.timers.push({ at: performance.now() + ms, fn })
  }
  /** Strike a pose for a moment, unless the plot changes it meanwhile. */
  function flash(s, a, pose, ms) {
    if (!a || a.moving || a.anim || a.hidden || a.held) return false
    const prev = a.pose
    a.pose = pose
    later(s, ms, () => {
      if (a.pose === pose) a.pose = prev
    })
    return true
  }
  const small = (s, t, x, y = FLOOR - 27, color = '#e7e2d6') => s.say(t, x, y, { color, life: 1, size: 6, vy: -4 })
  function clickActor(s, a) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    if (a.key === 'L') return clickLarry(s, now)
    if (a instanceof Cab) {
      small(s, 'BEEP BEEP', a.cx, FLOOR - 20, '#ffe455')
      return interject(s, 'T', pick(TALK.T), now)
    }
    const k = a.key
    d.taps[k] = (d.taps[k] || 0) + 1
    const n = d.taps[k]
    switch (k) {
      case 'B':
        flash(s, a, 'pour', 900)
        break
      case 'D':
        if (n % 3 === 0 && flash(s, a, 'sleep', 4000)) {
          small(s, 'zzz', a.x, FLOOR - 16)
          return interject(s, 'N', 'The drunk passes out. A role model.', now)
        }
        if (!flash(s, a, 'drink', 900)) break
        small(s, 'hic!', a.x + a.dir * 6)
        break
      case 'W':
      case 'F': {
        const L = d.larry
        if (Math.abs(L.x - a.x) < 22 && !L.moving && Math.random() < 0.5 && flash(s, a, 'slap', 900)) {
          a.dir = L.x > a.x ? 1 : -1
          flash(s, L, 'slapped', 900)
          s.say('SLAP!', (a.x + L.x) / 2, FLOOR - 25, { color: '#ffe455', life: 0.8, size: 7 })
          return interject(s, k, pick(REPLY[k]), now)
        }
        if (!a.anim && !a.moving) a.anim = { kind: 'fan', per: 180, until: now + 1400 }
        break
      }
      case 'M':
        flash(s, a, 'cheer', 1000)
        break
      case 'C':
        flash(s, a, 'shout', 1000)
        if (n % 2 === 0) return interject(s, 'C', pick(['PRICE CHECK ON RIBBED!', 'HEY! THIS GUY WANTS THE BIG ONES!', 'CLEANUP ON AISLE LARRY!']), now)
        break
      case 'K':
        if (flash(s, a, 'deal', 700)) s.particle({ img: ITEM.card[a.dir], x: a.x + a.dir * 6, y: FLOOR - 16, vx: a.dir * 40, vy: -12, g: 50, life: 0.5 })
        break
    }
    const lines = TALK[k]
    if (lines) interject(s, k, pick(lines), now)
  }
  function clickLarry(s, now) {
    const d = s.data
    const L = d.larry
    d.lc = d.lc.filter((t) => now - t < 2500)
    d.lc.push(now)
    // easter egg: poke him five times quickly and the pants give up
    if (d.lc.length >= 5 && !d.pants && d.variant === 'n' && !L.hidden) {
      d.lc.length = 0
      d.pants = { prev: d.variant }
      larryVariant(s, 'b')
      s.burst(L.x, FLOOR - 8, 8, ['w', 'a'])
      small(s, 'whoosh', L.x, FLOOR - 10)
      interject(s, 'N', bag('pants'), now)
      later(s, 3600, () => {
        if (!d.pants) return
        if (d.variant === 'b') larryVariant(s, d.pants.prev)
        d.pants = null
        interject(s, 'L', bag('pantsUp'))
      })
      return
    }
    const n = (d.lcN = (d.lcN || 0) + 1) % 4
    if (n === 1) return interject(s, 'N', bag('look'), now)
    if (n === 2) {
      if (flash(s, L, 'spray', 800)) {
        if (d.squirts > 0) {
          d.squirts--
          for (let i = 0; i < 5; i++) s.particle({ img: pix(i % 2 ? 'c' : 'w'), x: L.x + L.dir * 8, y: FLOOR - 16 + rand(-1, 1), vx: L.dir * rand(14, 26), vy: rand(-6, 2), life: rand(0.5, 0.9), fade: true })
        } else small(s, 'pfft', L.x + L.dir * 10, FLOOR - 22, '#a6a6b2')
      }
      return interject(s, 'L', bag('sprayL'), now)
    }
    if (n === 3) {
      if (!L.moving && !L.anim && !L.held) L.anim = { kind: 'leer', per: 200, until: now + 1200 }
      return interject(s, 'L', bag('poke'), now)
    }
    // a pickup line at whoever is nearest, and her answer
    const w = [d.cast.W, d.cast.F].filter((a) => a && !a.hidden).sort((p, q) => Math.abs(p.x - L.x) - Math.abs(q.x - L.x))[0]
    interject(s, 'L', bag('pickup'), now)
    if (w) {
      later(s, 2300, () => {
        if (d.cast[w.key] === w && !w.hidden) interject(s, w.key, bag('brush'))
      })
    }
  }
  const CHANNELS = ['Channel 2: bowling. Riveting.', 'Channel 4: Late Night Aerobics. Leotards!', 'Channel 69: scrambled. You squint anyway.', 'Channel 7: a sermon on lust. You take notes.']
  function clickSpot(s, k, p) {
    const d = s.data
    const now = performance.now()
    d.clickAt = now
    const L = d.larry
    const N = (t) => interject(s, 'N', t, now)
    switch (k) {
      case 'door':
        return N(pick(["Lefty's. The door is sticky. Don't ask.", 'Locked? No. Just heavy with regret.', 'A sign says NO MINORS. You qualify, barely.']))
      case 'sign':
        d.neonOff = now + 700
        d.fxUntil = Math.max(d.fxUntil, now + 700)
        return N(pick(["LEFTY'S. The 'Y' flickers. So does your hope.", 'Neon. Like your suit, but tasteful.']))
      case 'lamp':
        if (!L.moving && !L.anim) L.anim = { kind: 'leer', per: 200, until: now + 1000 }
        return interject(s, 'L', pick(['Leaning on a lamp post. Classic cool.', "Hey, ladies. I'm by the lamp. Lit.", 'This post is the only thing holding me up.']), now)
      case 'bottles':
        if (d.cast.B) return interject(s, 'B', pick(['Hands off the top shelf, pal.', 'That one costs more than your suit.', "That's for customers who tip."]), now)
        return N('You eye the top shelf. It eyes you back.')
      case 'counter': {
        small(s, 'ding!', p.x, FLOOR - 18, '#ffe455')
        const b = d.cast.B
        if (b) {
          flash(s, b, 'pour', 900)
          return interject(s, 'B', pick(['Yeah, yeah. Another one?', 'Ring that again and wear it.', 'Whiskey. Neat. Like you aren\'t.']), now)
        }
        return
      }
      case 'kdoor':
        small(s, 'knock knock', p.x, FLOOR - 22, '#d8c08a')
        if (d.door) return N('The door is open. Upstairs, someone giggles.')
        d.peep = 1
        later(s, 1400, () => (d.peep = 0))
        return interject(s, 'M', pick(['Password.', 'We gave at the office.', 'If you ain\'t Ken, beat it.']), now)
      case 'tv':
        d.chan = ((d.chan || 0) + 1) % CHANNELS.length
        d.tv = [1, 2, 3, 1][d.chan]
        d.fxUntil = Math.max(d.fxUntil, now + 1200)
        if (d.cast.M && !d.cast.M.hidden && d.chan === 1) {
          flash(s, d.cast.M, 'cheer', 1600)
          return interject(s, 'M', 'Leg warmers! Nobody touch that dial!', now)
        }
        return N(CHANNELS[d.chan])
      case 'ball':
        d.beatUntil = Math.max(d.beatUntil || 0, now + 2600)
        if (!L.moving && !L.anim && !L.held && !L.hidden) L.anim = { kind: 'dance', per: 220, until: now + 2200 }
        for (let i = 0; i < 6; i++) s.particle({ img: pix(pick(['w', 'c', 'p', 'Y'])), x: p.x, y: FLOOR - 24, vx: rand(-40, 40), vy: rand(-10, 20), life: 0.7, fade: true })
        return interject(s, 'L', pick(['Disco! My hips have a mind of their own.', 'Feel the beat, baby! Feel the polyester!', 'Stayin\' alive! Barely!']), now)
      case 'speaker':
        d.beatUntil = Math.max(d.beatUntil || 0, now + 2000)
        for (let i = 0; i < 3; i++) s.particle({ img: BUBBLE['♪'], x: p.x - 4 + i * 4, y: FLOOR - 18, vx: rand(-6, 6), vy: -8, life: 1, fade: true })
        return N(pick(['The speaker is louder than your suit. Barely.', 'Bass so low it reaches your love life.']))
      case 'shelf':
        if (d.cast.C) flash(s, d.cast.C, 'shout', 1000)
        return interject(s, d.cast.C ? 'C' : 'N', pick(['HEY! Those magazines are for READING!', 'You touch it, you buy it, Romeo.', 'Aisle two is protection. You need it.']), now)
      case 'till':
        small(s, 'ka-ching', p.x, FLOOR - 20, '#5cf07a')
        return N(pick(['No sale. Story of your life.', 'The drawer opens. It has more than you.']))
      case 'slot':
        if (now < (d.slot?.until || 0)) return
        d.slot = { reels: [0, 0, 0], until: now + 1400 }
        d.fxUntil = Math.max(d.fxUntil, now + 1450)
        later(s, 1450, () => {
          if (d.loc !== 'casino') return
          const win = Math.random() < 0.18
          const r = Math.floor(rand(0, 5))
          d.slot.reels = win ? [r, r, r] : [r, (r + 1 + Math.floor(rand(0, 4))) % 5, Math.floor(rand(0, 5))]
          if (win) {
            s.burst(gx(s, 0.94), FLOOR - 16, 12, ['Y', 'y', 'O'])
            d.score++
            jingle(s, 1)
            interject(s, 'L', pick(['Jackpot! Ladies, Daddy bought new pants!', 'Three in a row! Like my dates. Never.']))
          } else interject(s, 'L', pick(['Come on, baby. Daddy needs pants.', 'Lemon. Lemon. My love life.', 'One more pull. My wrist is strong.']))
        })
        return
      case 'table':
        if (d.cast.K) {
          flash(s, d.cast.K, 'deal', 700)
          d.cards = Math.min(5, d.cards + 1)
          return interject(s, 'K', pick(['No tapping the felt.', 'Hit or stand, pal. Not both.', 'You tap it like you mean it. Sad.']), now)
        }
        return
      case 'arch':
        for (let i = 0; i < 3; i++) s.particle({ img: BUBBLE['♥'], x: p.x - 8 + i * 6, y: FLOOR - 26, vx: rand(-4, 4), vy: -6, life: 1.4, fade: true })
        return N(pick(['Wedding bells. Or is that tinnitus?', 'The arch is plastic. So is the minister.', 'Till death, or dawn, do you part.']))
    }
  }
  function spotAt(s, p) {
    for (const f of s.dots) if (p.x >= f.x - 2 && p.x <= f.x + f.w + 2 && p.y >= f.y - 2 && p.y <= f.y + f.h + 2) return f.kind
    for (const f of s.fix) if (f.kind !== 'controls' && p.x >= f.x - 1 && p.x <= f.x + f.w + 1 && p.y >= f.y - 1 && p.y <= f.y + f.h + 1) return f.kind
    return null
  }
  function hoverVerb(s) {
    const p = s.cursor
    if (!p || p.y > H) return null
    const a = s.actorAt(p)
    if (a && a.verb) return a.verb(p)
    if (a) return a.key === 'L' ? 'look at Larry' : a.key === 'T' ? 'talk to cabbie' : `talk to ${NAME[a.key]}`
    const sp = spotAt(s, p)
    if (sp && SPOTS[sp]) return SPOTS[sp].verb
    return ''
  }
  // background business between lines, so the room never freezes
  function ambient(s, now) {
    const d = s.data
    const L = d.larry
    const idle = (a) => a && !a.hidden && !a.moving && !a.anim && !a.talking && !a.held && a.pose === 'stand'
    const who = [L, ...Object.values(d.cast)].filter(idle)
    if (!who.length) return
    const a = pick(who)
    switch (a.key) {
      case 'L':
        if (Math.random() < 0.5) flash(s, a, 'down', 900) // checks his fly
        else a.anim = { kind: 'leer', per: 200, until: now + 900 }
        return
      case 'D':
        a.anim = { kind: 'sway', per: 260, until: now + 1600 }
        return small(s, 'hic', a.x + a.dir * 5)
      case 'B':
        flash(s, a, 'pour', 800)
        return
      case 'W':
        a.anim = { kind: 'fan', per: 180, until: now + 1200 }
        return
      case 'F':
        flash(s, a, 'nails', 1500)
        return
      case 'K':
        flash(s, a, 'deal', 600)
        return small(s, 'shuffle', a.x, FLOOR - 27, '#9dffcf')
      case 'C':
        return small(s, 'yawn', a.x)
      case 'P':
        return small(s, 'ahem', a.x)
      case 'M':
        return small(s, d.tv === 2 ? 'whoa' : 'hmph', a.x)
    }
  }
  // the cursor resting on someone: they notice
  function hoverReact(s, now) {
    const d = s.data
    const cur = s.cursor
    const a = cur && cur.y <= H ? s.actorAt(cur) : null
    if (!a || a.key === undefined || a.key === 'L' || !HOVER[a.key] || !d.hov || d.hov.a !== a) {
      d.hov = a && a.key && a.key !== 'L' && HOVER[a.key] ? { a, at: now } : null
      return d.hov ? 1300 : Infinity
    }
    if (now - d.hov.at < 1200) return d.hov.at + 1200 - now
    if (now - d.hovSaid < 12000 || d.inter) return Infinity
    d.hovSaid = now
    if (a.dir !== undefined && !a.moving && !a.anim) a.dir = cur.x > a.x ? 1 : -1
    interject(s, a.key, pick(HOVER[a.key]), now)
    return Infinity
  }
  // ---- drawing ------------------------------------------------------------------
  const FONT = 'bold 7px "DejaVu Sans Mono", Menlo, monospace'
  const SMALL = 'bold 6px "DejaVu Sans Mono", Menlo, monospace'
  const TEXT_Y = () => Math.max(0, FLOOR - 36)
  function textOut(c, text, x, y, color) {
    c.lineWidth = 2
    c.strokeStyle = 'rgba(0,0,0,.9)'
    c.strokeText(text, x, y)
    c.fillStyle = color
    c.fillText(text, x, y)
  }
  /** Draw a line in the text row; with `avoid` (the plot's line) it moves aside, or one row down. */
  function drawLine(s, c, ln, avoid = null) {
    const d = s.data
    c.font = FONT
    c.textBaseline = 'top'
    const w = Math.ceil(c.measureText(ln.text).width)
    const boxed = ln.who === 'N' || ln.who === 'X'
    const bw = boxed ? w + 8 : w
    const cx = boxed ? (d.gaps && d.loc ? gapOf(s, d.loc).x0 + gapOf(s, d.loc).w / 2 : s.W / 2) : speakerX(s, ln.who)
    let x = Math.round(clamp(cx - bw / 2, 1, s.W - bw - 1))
    let y = TEXT_Y()
    if (avoid && x < avoid.x1 + 4 && x + bw > avoid.x0 - 4) {
      const near = (v) => Math.abs(v + bw / 2 - cx)
      const opts = [avoid.x1 + 8, avoid.x0 - 8 - bw].filter((v) => v >= 1 && v <= s.W - bw - 1 && near(v) < 150)
      if (opts.length) x = Math.round(opts.sort((p, q) => near(p) - near(q))[0])
      else y += 10
    }
    if (boxed) {
      const die = ln.who === 'X'
      c.fillStyle = '#fbfbf5'
      c.fillRect(x, y, w + 8, 10)
      c.fillStyle = die ? '#b81c1c' : '#a01818'
      c.fillRect(x + 1, y + 1, w + 6, 1)
      c.fillRect(x + 1, y + 8, w + 6, 1)
      c.fillRect(x + 1, y + 1, 1, 8)
      c.fillRect(x + w + 6, y + 1, 1, 8)
      if (die) {
        c.fillRect(x, y, w + 8, 1)
        c.fillRect(x, y + 9, w + 8, 1)
      }
      c.fillStyle = die ? '#8a0f0f' : '#141414'
      c.fillText(ln.text, x + 4, y + 2)
    } else textOut(c, ln.text, x, y + 1, CLR[ln.who] || '#fff')
    return y > TEXT_Y() ? null : { x0: x, x1: x + bw }
  }


  function R(c, col, x, y, w, h) {
    c.fillStyle = col
    c.fillRect(Math.round(x), Math.round(y), w, h)
  }
  const TILE = ['#ff55ff', '#55ffff', '#ffe455', '#6680ff']
  const TILE_DIM = ['#5a2a62', '#24585e', '#5e5626', '#2a3466']
  const REEL = ['#ff5555', '#ffe455', '#5cf07a', '#ff2a6a', '#9fd8ff']
  function drawProps(s, c, front) {
    const d = s.data
    if (!d.loc || !d.gaps) return
    const F = FLOOR
    const X = (f) => gx(s, f)
    const now = performance.now()
    switch (d.loc) {
      case 'street':
        if (front) return
        R(c, '#3a2018', X(0), F - 25, X(0.34) - X(0), 25)
        for (let yy = F - 22; yy < F; yy += 4) R(c, '#2a160f', X(0), yy, X(0.34) - X(0), 1)
        R(c, '#9a5418', X(0.12), F - 17, 11, 17)
        R(c, '#120a06', X(0.12) + 1, F - 16, 9, 16)
        c.font = SMALL
        c.textBaseline = 'top'
        textOut(c, "LEFTY'S", X(0.03), F - 24, now < (d.neonOff || 0) && Math.floor(now / 90) % 2 ? '#5a2a62' : '#ff55ff')
        R(c, '#4a4a56', X(0.96), F - 24, 1, 24)
        R(c, '#ffe680', X(0.96) - 2, F - 25, 5, 2)
        R(c, '#4a4a56', X(-0.02), F - 1, X(1.02) - X(-0.02), 1)
        return
      case 'bar':
        if (!front) {
          R(c, '#5e300c', X(0.04), F - 21, X(0.5) - X(0.04), 1)
          const cols = ['#5cf07a', '#ffe455', '#ff5555', '#9fd8ff', '#c89a10', '#5cf07a', '#d85cf0']
          for (let i = 0; i < 7; i++) R(c, cols[i], X(0.06) + i * 5, F - 25, 2, 4)
          return
        }
        R(c, '#c8782a', X(0.03), F - 12, X(0.5) - X(0.03), 2)
        R(c, '#7a3e12', X(0.04), F - 10, X(0.49) - X(0.04), 10)
        for (let x = X(0.04) + 5; x < X(0.49) - 2; x += 9) R(c, '#5e300c', x, F - 9, 1, 8)
        if (!(d.larry.resting === 'slump' || d.larry.pose === 'slump')) {
          R(c, '#b81c1c', X(0.6) - 3, F - 9, 7, 2)
          R(c, '#9a9aa6', X(0.6), F - 7, 1, 7)
          R(c, '#9a9aa6', X(0.6) - 2, F - 1, 5, 1)
        }
        return
      case 'backroom': {
        if (front) return
        const dx = X(0.2) - 6
        R(c, '#5e300c', dx - 1, F - 23, 14, 23)
        if (d.door) R(c, '#0a0a0a', dx, F - 22, 12, 22)
        else {
          R(c, '#9a5418', dx, F - 22, 12, 22)
          R(c, '#7a3e12', dx + 2, F - 20, 8, 8)
          R(c, '#7a3e12', dx + 2, F - 10, 8, 8)
          R(c, '#ffe455', dx + 9, F - 11, 1, 1)
          R(c, '#141414', dx + 3, F - 18, 6, 2)
          if (d.peep) {
            R(c, '#fbfbf5', dx + 4, F - 18, 1, 1)
            R(c, '#fbfbf5', dx + 7, F - 18, 1, 1)
          }
          c.font = '5px "DejaVu Sans Mono", monospace'
          c.textBaseline = 'top'
          c.fillStyle = '#d8c08a'
          c.fillText('KEN', dx + 2, F - 9)
        }
        const tx = X(0.88) - 6
        R(c, '#7a3e12', tx + 1, F - 6, 10, 6)
        R(c, '#4a4a56', tx, F - 16, 12, 10)
        R(c, d.tv === 3 ? '#8b8f94' : d.tv === 2 ? '#ff55ff' : d.tv ? '#6680ff' : '#141414', tx + 1, F - 15, 10, 7)
        if (d.tv === 3) for (let i = 0; i < 8; i++) R(c, i % 2 ? '#fbfbf5' : '#4a4a56', tx + 1 + ((i * 7 + Math.floor(now / 90)) % 10), F - 15 + ((i * 3 + Math.floor(now / 70)) % 7), 1, 1)
        if (d.tv === 2) {
          R(c, '#ffe455', tx + 5, F - 14, 2, 2)
          R(c, '#ffe455', tx + 4, F - 12, 4, 3)
        }
        R(c, '#9a9aa6', tx + 3, F - 19, 1, 3)
        R(c, '#9a9aa6', tx + 8, F - 19, 1, 3)
        return
      }
      case 'disco': {
        if (front) return
        const x0 = X(0.04)
        const x1 = X(0.98)
        const lit = now < (d.beatUntil || 0) || s.busy
        const beat = Math.floor(now / 220)
        for (let x = x0, i = 0; x < x1; x += 6, i++) R(c, (lit ? TILE : TILE_DIM)[(i + (lit ? beat : 0)) % 4], x, F - 2, Math.min(5, x1 - x), 2)
        const bx = X(0.55)
        const by = F - 25
        R(c, '#9a9aa6', bx, by - 2, 1, 2)
        R(c, '#c7ccd4', bx - 2, by, 5, 5)
        R(c, '#8b8f94', bx - 2, by + 2, 5, 1)
        R(c, '#fbfbf5', bx - 1 + (lit ? beat % 3 : 0), by + 1, 1, 1)
        R(c, '#141414', X(0.99) - 3, F - 14, 7, 12)
        R(c, '#4a4a56', X(0.99) - 1, F - 12, 3, 3)
        R(c, '#4a4a56', X(0.99) - 1, F - 7, 3, 3)
        return
      }
      case 'store':
        if (!front) {
          const sx = X(0.02)
          const sw = X(0.34) - sx
          R(c, '#5e300c', sx, F - 21, sw, 21)
          const goods = ['#ff5555', '#5cf07a', '#ffe455', '#6680ff', '#ff9a2a', '#d85cf0']
          for (let r = 0; r < 3; r++) {
            R(c, '#c8782a', sx + 1, F - 14 + r * 7 - 7 + 6, sw - 2, 1)
            for (let i = 0; i * 4 + 2 < sw - 2; i++) R(c, goods[(i * 5 + r * 3) % 6], sx + 2 + i * 4, F - 18 + r * 7, 2, 3)
          }
          return
        }
        R(c, '#c7ccd4', X(0.4), F - 11, X(0.74) - X(0.4), 2)
        R(c, '#6a6a78', X(0.41), F - 9, X(0.73) - X(0.41), 9)
        R(c, '#4a4a56', X(0.44), F - 16, 8, 5)
        R(c, '#5cf07a', X(0.44) + 1, F - 15, 4, 1)
        return
      case 'casino': {
        if (!front) {
          const sx = X(0.94) - 5
          R(c, '#ffe455', sx, F - 22, 10, 2)
          R(c, '#b81c1c', sx, F - 20, 10, 20)
          R(c, '#141414', sx + 1, F - 17, 8, 5)
          const spin = now < (d.slot?.until || 0)
          for (let i = 0; i < 3; i++) {
            const k = spin ? Math.floor(now / 70 + i * 2) % 5 : d.slot?.reels[i] ?? i
            R(c, REEL[k], sx + 2 + i * 2 + (i ? 0 : 0), F - 16, 1, 3)
          }
          R(c, '#9a9aa6', sx + 10, F - 18, 1, 8)
          R(c, '#ff5555', sx + 10, F - 20, 2, 2)
          return
        }
        R(c, '#5e300c', X(0.03), F - 12, X(0.52) - X(0.03), 3)
        R(c, '#0f8a2a', X(0.04), F - 12, X(0.51) - X(0.04), 1)
        R(c, '#5e300c', X(0.08), F - 9, 2, 9)
        R(c, '#5e300c', X(0.46), F - 9, 2, 9)
        for (let i = 0; i < d.cards; i++) {
          R(c, '#fbfbf5', X(0.3) + i * 4, F - 14, 3, 2)
          R(c, '#b81c1c', X(0.3) + i * 4 + 1, F - 14, 1, 1)
        }
        return
      }
      case 'chapel': {
        if (front) return
        const ax = X(0.3)
        R(c, '#e7e2d6', ax - 11, F - 21, 2, 21)
        R(c, '#e7e2d6', ax + 10, F - 21, 2, 21)
        R(c, '#e7e2d6', ax - 11, F - 23, 23, 2)
        R(c, '#ff2a6a', ax - 1, F - 27, 1, 1)
        R(c, '#ff2a6a', ax + 1, F - 27, 1, 1)
        R(c, '#ff2a6a', ax - 2, F - 26, 5, 1)
        R(c, '#ff2a6a', ax - 1, F - 25, 3, 1)
        R(c, '#ff2a6a', ax, F - 24, 1, 1)
        return
      }
    }
  }

  function drawCensor(s, c, now) {
    const d = s.data
    const cz = d.censor
    if (!cz) return
    const jig = Math.floor(now / 160) % 2
    const x = Math.round(d.larry.x - 17)
    R(c, '#000000', x, FLOOR - 25 - jig, 36, 20)
    c.font = FONT
    c.textBaseline = 'top'
    textOut(c, 'CENSORED', x + 2, FLOOR - 19 - jig, '#ff5555')
    if (jig) {
      c.drawImage(BUBBLE['♥'], x + 37, FLOOR - 24)
    } else c.drawImage(BUBBLE['♥'], x - 9, FLOOR - 22)
  }

  function pause(s, now) {
    const d = s.data
    d.paused = true
    d.line = null
    d.inter = null
    // settle any pending nudges now, so nothing wakes the bar later
    const due = d.timers.splice(0)
    for (const t of due) t.fn()
    d.inter = null
    d.hov = null
    if (d.pants) {
      if (d.variant === 'b') larryVariant(s, d.pants.prev)
      d.pants = null
    }
    d.larry.held = false
    d.larry.kwalk = false
    d.larry.falling = false
    d.larry.lift = 0
    const st = d.prog?.[d.pc]
    if (d.started) {
      if (st && (REEXEC.has(st[0]) || SPEAK.has(st[0]) || st[0] === 'travel')) d.started = false
      else {
        d.after?.()
        d.after = null
        finishStep(s)
      }
    }
    d.waitFor = null
    d.waitUntil = 0
    d.beatUntil = 0
    const L = d.larry
    L.anim = null
    L.talking = false
    L.item = null
    L.pose = 'stand'
    for (const a of Object.values(d.cast)) {
      a.anim = null
      a.talking = false
      if (a.moving) {
        a.tx = null
        a.cb = null
      }
      a.asleep = true
      if (a.key === 'D') a.resting = 'sleep'
      else if (a.key === 'F' || a.key === 'W') a.resting = 'nails'
      else if (a.key === 'B') a.resting = 'rest'
    }
    const rx = markX(s, 'rest')
    L.goto(rx, WALK, () => {
      L.resting = LOCS[d.loc].stool ? 'slump' : 'floor'
      L.asleep = true
      L.dir = LOCS[d.loc].stool ? -1 : L.dir
      s.poke()
    })
  }
  function resume(s, now) {
    const d = s.data
    d.paused = false
    for (const a of allGuys(s)) {
      a.resting = null
      a.asleep = false
    }
    s.poke()
  }

  // ---- concept ------------------------------------------------------------------
  registerConcept({
    key: 'larry',
    title: 'Leisure Suit Larry',
    sub: 'Sierra On-Line, 1987',
    blurb:
      "Larry Laffer, 38, white polyester and a gold chain, works through long nights in Lost Wages, in three episodes that come back in a different order with different lines: Lefty's bar and the woman who slaps him, the drunk who trades a remote for a whiskey, the \"Ken sent me\" door, a Buick that flattens him (he restores), Fawn at the disco, a loud rubber purchase at the 24-hour store, the casino where he bets his suit, the wedding chapel, and censored hot-tub cutaways. The story runs on its own, and between lines the room keeps busy: the drunk sways and hics, the bartender polishes, Larry checks his fly. Narration comes in Sierra message boxes with a score; hovering shows a parser line and people notice your <b>cursor</b> (Larry turns to leer at it). Click anyone to make them talk or act (the drunk drinks until he passes out, the lady fans herself or slaps him), click Larry for a look, a breath-spray squirt, a leer and a pickup line, and poke him five times fast for an accident with his pants. Drag Larry by the collar and drop him somewhere (next to a lady is a bad idea). The scenery clicks too: Lefty's neon, the bar bell, the Ken door, the back-room TV's channels, the disco ball, the slot machine, the chapel bells. Working runs the room's action (pickup-line marathons, password guessing, a disco dance-off, a blackjack streak) and pushes the plot on; Done gives the room's small win with a score jingle. When it's quiet Larry slumps where he is and the story waits.",
    setup(s) {
      s.data = {
        ep: 0, si: 0, prog: [], pc: 0, started: false, mode: 'script', cast: {}, loc: null,
        score: 0, rej: 0, squirts: 9, episodes: 0, line: null, inter: null, waitUntil: 0, waitFor: null,
        paused: false, wantWin: false, strayed: false, actionN: 0, variant: 'n', hoverAt: 0, pickupAt: 0,
        clickAt: -1e9, grabAt: -1e9, timers: [], taps: {}, lc: [], lcN: 0, fxUntil: 0, hovSaid: 0, hov: null,
        ambAt: performance.now() + rand(6000, 9000), lookAt: 0, pants: null,
      }
      const d = s.data
      gaps(s)
      s.actors.push(new Hotspots(s))
      d.larry = new Guy(s, 'L', -14, 1)
      s.actors.push(d.larry)
      s.actors.push(new Front(s))
      // capture-only: start at a given episode/scene (?t=…&lep=1&lscene=4)
      if (Q.has('t') && Q.has('lscene')) {
        d.ep = +Q.get('lep') || 0
        d.si = +Q.get('lscene')
      }
      d.loc = EPS[d.ep].scenes[d.si].loc
      setLoc(s, d.loc, EPS[d.ep].scenes[d.si].cast)
      startScene(s)
    },
    relayout(s) {
      const d = s.data
      if (!d.larry) return
      gaps(s)
      for (const k in d.cast) {
        const def = (EPS[d.ep].scenes[d.si]?.cast || LOCS[d.loc].cast).find((e) => e[0] === k)
        const a = d.cast[k]
        if (def && !a.moving && !a.dead) a.x = gx(s, LOCS[d.loc].marks[def[1]])
      }
      if (!d.larry.moving && !d.inCab && !d.larry.held) {
        const hx = markX(s, d.paused ? 'rest' : 'home')
        if (hx !== null) d.larry.x = hx
      }
      for (const a of allGuys(s)) {
        a.x = clamp(a.x, -20, s.W + 20)
        if (a.tx !== null) a.tx = clamp(a.tx, -20, s.W + 20)
      }
      s.poke()
    },
    update(s, dt, now) {
      const d = s.data
      if (KEEP_AWAKE) s.lastTouch = now
      // run "after" hooks once their step's wait ends
      if (d.after && d.started && now >= d.waitUntil && (!d.waitFor || d.waitFor(now))) {
        const f = d.after
        d.after = null
        f()
      }
      if (d.line && now >= d.line.until) {
        d.line = null
        for (const a of allGuys(s)) a.talking = false
        if (d.inter) {
          const sp = d.inter.who === 'L' ? d.larry : d.cast[d.inter.who]
          if (sp) sp.talking = true
        }
      }
      if (d.inter && now >= d.inter.until) endInter(s)
      const locked = d.inCab || d.cabBusy || d.carBusy || d.censor
      if (!s.lively(now) && !locked && !d.larry.held) {
        if (!d.paused) pause(s, now)
        return Infinity
      }
      if (d.paused) resume(s, now)
      let want = Infinity
      // nudges from clicks
      if (d.timers.length) {
        const due = d.timers.filter((t) => t.at <= now)
        if (due.length) {
          d.timers = d.timers.filter((t) => t.at > now)
          for (const t of due) t.fn()
        }
        for (const t of d.timers) want = Math.min(want, t.at - now)
      }
      if (now < d.fxUntil || now < (d.slot?.until || 0)) want = FAST
      const L = d.larry
      const user = engaged(s, now)
      if (keyWalk(s, dt) || (s.keys && s.keys.size)) want = FAST
      // the cursor lingering on Larry gets a pickup line
      const cur = s.cursor
      if (cur && !d.inter && Math.abs(cur.x - L.x) < 14 && cur.y > FLOOR - 28 && !L.hidden && !L.held) {
        if (!d.hoverAt) d.hoverAt = now
        if (now - d.hoverAt > 1500 && now - d.pickupAt > 25000) {
          d.pickupAt = now
          if (!L.moving) L.anim = { kind: 'leer', per: 200, until: now + 1200 }
          interject(s, 'L', bag('cursor'), now)
        } else want = Math.min(want, Math.max(FAST, d.hoverAt + 1500 - now))
      } else d.hoverAt = 0
      if (cur) want = Math.min(want, hoverReact(s, now))
      else d.hov = null
      // while someone plays along, Larry keeps an eye on the cursor
      if (user && cur && !L.moving && !L.anim && !L.hidden && !L.held && !L.falling && !d.inCab && now > d.lookAt && (L.pose === 'stand' || L.pose === 'hold') && Math.abs(cur.x - L.x) > 8) {
        const dir = cur.x > L.x ? 1 : -1
        if (dir !== L.dir) {
          L.dir = dir
          d.lookAt = now + 700
        }
      }
      if (user) want = Math.min(want, SLOW)
      if (s.busy) want = FAST // busy: lights, lines and fidgets at full tilt
      // a little background business every few seconds
      if (!d.censor && !d.inCab) {
        if (now >= d.ambAt) {
          // the work keeps the whole room hopping
          d.ambAt = now + (s.busy ? rand(2200, 4000) : rand(6000, 11000))
          ambient(s, now)
        }
        want = Math.min(want, d.ambAt - now)
      }
      want = Math.min(want, run(s, now))
      // wake when the current lines run out, so they are erased on time
      if (d.line) want = Math.min(want, Math.max(1, d.line.until - now))
      if (d.inter) want = Math.min(want, Math.max(1, d.inter.until - now))
      return Math.max(1, want)
    },
    onBonk(s, r, kind) {
      if (SPOTS[kind]) interject(s, 'N', pick(SPOTS[kind].say))
    },
    onKey(s, key, down) {
      const d = s.data
      if (!d.larry) return
      const now = performance.now()
      if (!down) return
      if (d.paused) resume(s, now)
      if (key === 'left' || key === 'right') {
        // the first step happens now, not next frame
        if (freeToWalk(s)) {
          d.larry.dir = key === 'left' ? -1 : 1
          keyWalk(s, 1 / 12)
        }
      } else if (key === 'up') keyUse(s)
      else if (key === 'down') clickLarry(s, now)
      else if (key === 'fire') keySkip(s, now)
      s.poke()
    },
    onBusy(s) {
      const d = s.data
      const st = d.prog?.[d.pc]
      if (d.started && st && SPEAK.has(st[0]) && d.mode === 'script') {
        d.waitUntil = 0
        d.line = null
      }
    },
    onDone(s) {
      const d = s.data
      d.wantWin = true
      const st = d.prog?.[d.pc]
      if (d.started && st && (SPEAK.has(st[0]) || st[0] === 'wait') && !d.inCab) {
        d.waitUntil = 0
        d.line = null
      }
    },
    onNap(s) {},
    drawBehind(s, c) {
      drawProps(s, c, false)
    },
    drawFront(s, c) {
      const d = s.data
      const now = performance.now()
      drawCensor(s, c, now)
      if (d.paused && (d.larry.resting === 'slump' || d.larry.resting === 'floor')) {
        c.drawImage(ZZ, Math.round(d.larry.x + 3), FLOOR - 26)
      }
      let box = d.line ? drawLine(s, c, d.line) : null
      if (d.inter) {
        const b2 = drawLine(s, c, d.inter, box)
        if (b2) box = box ? { x0: Math.min(box.x0, b2.x0), x1: Math.max(box.x1, b2.x1) } : b2
      }
      const v = hoverVerb(s)
      if (v !== null) {
        c.font = FONT
        c.textBaseline = 'top'
        const t = `> ${v}_`
        const pw = c.measureText(t).width
        if (!box || box.x0 > 8 + pw + 8) {
          textOut(c, t, 8, TEXT_Y() + 1, '#e7e2d6')
          box = box ? { x0: 8, x1: box.x1 } : { x0: 8, x1: 8 + pw }
        }
      }
      c.font = SMALL
      c.textBaseline = 'top'
      const sc = `Score: ${d.score} of 222`
      const sw = c.measureText(sc).width
      const sx = Math.round(s.W - sw - 4)
      if (!box || box.x1 < sx - 4) {
        c.fillStyle = '#8b8f94'
        c.fillText(sc, sx, TEXT_Y() + 1)
      }
    },
  })

})()
