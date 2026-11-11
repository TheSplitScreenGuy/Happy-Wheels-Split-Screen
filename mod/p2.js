/* HWSS extra players (P2, P3, P4). Bundled after split.js (tools/install.js / release install.py).
 * - Pads: P1 = the first usable pad (the only one the game sees). Any other pad is a spare until Start is
 *   pressed on it at the main menu: that claims it for the next free player (P2-P4). Select+Start leaves
 *   and frees the pad. Spare and claimed pads are hidden from the game's navigator.getGamepads(), so they
 *   can never drive P1 (config p2Pad: a number pins P2's pad). P2-P4 use P1's button bindings; Start in a
 *   level pauses ("P<n> PAUSE"), Back alone respawns that player in separate worlds.
 * - Keys: F5 / F3 / F4 = test rider P2 / P3 / P4 (replays P1's controls 0.3 / 0.6 / 1.2 s late, overrides
 *   that player's pad until pressed again), F6 / F7 = no delay for P3 / P4, F8 = 0.5 s delay on P1,
 *   F9 = P1 on keyboard + mouse only, F10 = pass the controller P1 → P4, F1 = auto-ride (everyone full
 *   throttle + random lean taps + random A, for recording), F2 = hide / show the main-menu hint lines.
 * - Each extra player = another instance of P1's character class, created like the session creates P1
 *   (without keyboard listeners). The session's per-step/per-frame calls on P1 are mirrored onto them;
 *   contacts involving their bodies run "as" that player (asPlayer), so triggers and finishes see them.
 * - Riders don't collide with each other unless a "collide" world mode (or config playersCollide) says so.
 * - Also here: shirt / vehicle colours, character select (cursors, pedestals, per-player characters),
 *   co-op pause / level-complete menu toggles, scoreboard (with ◀ ▶ corrections), winner banner, menu
 *   cursors for controller players (+ "Player Cursors" checkbox) and the P1 cursor, trigger winners,
 *   Taken 3's intro rule (NPC weapon takes only P1), Box2D shape limit.
 * API: H.PL (list, byId, joinedIds, anyJoined, applyInput, tintShirt, charOf, atMainMenu, ...); H.P2 = player 2.
 */
(function () {
  'use strict';
  var H = window.__HWSS__;
  if (!H || H.p2Loaded) return;
  H.p2Loaded = true;
  var cfg = H.cfg, log = H.log;

  // shirt colours: P1 blue (co-op only), P2 red, P3 green, P4 yellow
  var HUES = { 1: 'p1ShirtHue', 2: 'p2ShirtHue', 3: 'p3ShirtHue', 4: 'p4ShirtHue' }, HUE_DEFAULT = { 1: 220, 2: 0, 3: 120, 4: 55 };
  var BOT_DELAY = { 2: 0.3, 3: 0.6, 4: 1.2 };       // seconds behind P1 (test riders)
  var LIST = [2, 3, 4].map(function (id) {
    return { id: id, name: 'P' + id, joined: id === 2 && !!cfg.forceSplit, padIndex: null, char: null, input: {},
             bot: false, prevStart: false, spawns: 0, bodies: new Set() };
  });
  var byId = {}; LIST.forEach(function (p) { byId[p.id] = p; });
  var PL = H.PL = { list: LIST, byId: byId, atMainMenu: false };
  var P2 = H.P2 = byId[2];
  PL.joinedIds = function () { return LIST.filter(function (p) { return p.joined; }).map(function (p) { return p.id; }); };
  PL.anyJoined = function () { return LIST.some(function (p) { return p.joined; }); };
  // character of player pid in session s (pid 1 = the game's own character), or null
  PL.charOf = function (pid, s) {
    if (pid === 1) return s ? s._character : null;
    var p = byId[pid];
    return p && p.char && (!s || p.char._session === s) ? p.char : null;
  };

  var bodyOwner = new Map(), owner = null;   // body -> player id (1-4); owner = whose code runs right now
  var curSession = null;

  // ---------- pads ----------
  // H.testPads (probes only): { index: fake pad } merged in, for testing controller features without pads
  var nav = navigator, origGetPads = nav.getGamepads, realPads = function () {
    var a = Array.from(origGetPads.call(nav) || []);
    if (H.testPads) Object.keys(H.testPads).forEach(function (i) { a[+i] = H.testPads[i]; });
    return a;
  };
  // Steam Input (Steam Deck / Linux): every controller appears as a Steam virtual pad (Valve vendor 28de)
  // AND, for some controllers, as its raw device too. When virtual pads exist, the raw ones are
  // duplicates: ignore them for the players and hide them from the game.
  var VALVE = /vendor:\s*28de/i;
  function isDuplicate(g, pads) { return !!g && !VALVE.test(g.id) && pads.some(function (q) { return q && VALVE.test(q.id); }); }
  // Controllers become players by pressing Start, not by their number: P1 = the first usable pad
  // (whatever Steam lists first); every other pad is a SPARE until Start is pressed on it at the main
  // menu, which claims it for the next free player (P2, P3, P4). Spare pads are hidden from the game, so
  // e.g. an unused Steam Deck (whose built-in controls can't be told apart from other pads under
  // Proton: all are "Xbox 360 Controller (XInput)") neither joins nor also drives P1.
  // cfg.p2Pad = a pad index pins P2 to that pad.
  function usable(g, pads) { return !!g && !isDuplicate(g, pads); }
  function claimedBy(i) { for (var k = 0; k < LIST.length; k++) if (LIST[k].padIndex === i) return LIST[k]; return null; }
  function p1PadIndex(pads) {
    if (PL.p1Keyboard) return null;                      // F9: P1 on keyboard + mouse, every controller is a spare
    for (var i = 0; i < pads.length; i++) if (usable(pads[i], pads) && !claimedBy(i) && i !== cfg.p2Pad) return i;
    return null;
  }
  PL.p1Keyboard = false;
  // F10 (testing with one controller): hand the first controller to the next player, P1 → P2 → P3 → P4 → P1.
  // The previous holder becomes a test rider (keeps moving); P1 goes keyboard + mouse while someone else has it.
  PL.controllerOwner = function () {
    if (!PL.p1Keyboard) return 1;
    for (var i = 0; i < LIST.length; i++) if (LIST[i].padIndex != null && LIST[i].hasPad && !LIST[i].bot) return LIST[i].id;
    return 0;
  };
  function cycleController() {
    var pads = realPads(), idx = null;
    for (var i = 0; i < pads.length; i++) if (usable(pads[i], pads)) { idx = i; break; }
    if (idx == null) { log('p2', 'F10: no controller connected'); return; }
    var cur = PL.controllerOwner() || 1, next = cur % 4 + 1;
    var holder = claimedBy(idx);
    if (holder) { holder.padIndex = null; holder.hasPad = false; holder.input = {}; if (holder.joined) holder.bot = true; }
    if (next === 1) { PL.p1Keyboard = false; }
    else {
      PL.p1Keyboard = true;
      var p = byId[next];
      p.padIndex = idx; p.bot = false; p.prevStart = true;
      if (!p.joined) join(p);
    }
    log('p2', 'F10: controller -> P' + next);
  }
  function freeSlot() {
    for (var k = 0; k < LIST.length; k++) if (!LIST[k].joined && LIST[k].padIndex == null) return LIST[k];
    for (k = 0; k < LIST.length; k++) if (LIST[k].bot && LIST[k].padIndex == null) return LIST[k];   // a pad replaces a test rider
    return null;
  }
  // P1's Back (Select) in separate worlds with other players: restart P1's own world only (world2.js); the
  // game's own Back action (switch camera) is hidden from it then.
  function p1BackOwned() {
    var s = H.session;
    return !!(H.inLevel && s && !s.paused && !s.hwssLevelDone && PL.anyJoined() && H.W2 && H.W2.isSeparate && H.W2.isSeparate() && H.W2.worlds && H.W2.worlds.length);
  }
  var NO_BTN = { pressed: false, touched: false, value: 0 };
  nav.getGamepads = H.disguise(function getGamepads() {
    var pads = realPads(), p1 = p1PadIndex(pads);
    for (var i = 0; i < pads.length; i++) if (i !== p1) pads[i] = null;   // the game only ever sees P1's pad
    // F1 auto-ride while riding: the game must not read P1's pad (its sticks/triggers would fight the auto
    // input); menus (pause, level complete) still get it
    var sAR = H.session;
    if (PL.autoRide && H.inLevel && sAR && !sAR.paused && !sAR.hwssLevelDone && p1 != null) pads[p1] = null;
    var g = p1 != null && pads[p1];
    if (g && p1BackOwned() && g.buttons[8] && g.buttons[8].pressed) {
      // same pad without Back (a Gamepad object can't be changed: a copy)
      var b = Array.prototype.slice.call(g.buttons); b[8] = NO_BTN;
      pads[p1] = { id: g.id, index: g.index, connected: g.connected, mapping: g.mapping, timestamp: g.timestamp, axes: g.axes, buttons: b, vibrationActuator: g.vibrationActuator };
    }
    return pads;
  }, origGetPads);
  var p1Back = { down: false, combo: false };
  function checkP1Back(g) {
    var back = !!(g && btn(g, 8)), start = !!(g && btn(g, 9));
    if (back) { if (!p1Back.down) { p1Back.down = true; p1Back.combo = false; } if (start) p1Back.combo = true; return; }
    if (!p1Back.down) return;
    p1Back.down = false;
    // pressed and released on its own (not Select+Start)
    if (!p1Back.combo && p1BackOwned()) H.W2.restartP1Only();
  }

  var DEAD = 0.5, sparePrev = {};
  // a key press as the game sees it (its keyboard listeners are on document/window)
  function pressKey(code, keyCode) {
    var o = { bubbles: true, cancelable: true, code: code, key: code, keyCode: keyCode, which: keyCode };
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', o));
      setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keyup', o)); }, 60);
    } catch (e) {}
  }
  PL.pressKey = pressKey;
  // game action → the character's key flag (secondaryAction1/2 are Shift/Ctrl: key codes 16/17)
  var ACTION_FLAG = { accelerate: 'up', decelerate: 'down', leanBack: 'left', leanForward: 'right',
                      primaryAction: 'space', secondaryAction1: 'shift', secondaryAction2: 'ctrl', eject: 'z' };
  var DEFAULT_BINDS = { b7: 'accelerate', b6: 'decelerate', b0: 'primaryAction', b4: 'secondaryAction1', b5: 'secondaryAction2',
                        b1: 'eject', b15: 'leanForward', b14: 'leanBack', 'a0+': 'leanForward', 'a0-': 'leanBack' };
  function btn(g, n) { return !!(g.buttons[n] && g.buttons[n].pressed); }
  function readPads() {
    var pads = realPads();
    if (typeof cfg.p2Pad === 'number' && usable(pads[cfg.p2Pad], pads) && P2.padIndex == null) { P2.padIndex = cfg.p2Pad; log('p2', 'P2 pad pinned to ' + cfg.p2Pad); }
    var p1 = PL.p1Pad = p1PadIndex(pads), spares = 0;
    try { checkP1Back(p1 != null ? pads[p1] : null); } catch (e) { log('p2-error', 'P1 back: ' + e); }
    pads.forEach(function (g, i) {
      if (!usable(g, pads) || i === p1 || claimedBy(i)) { sparePrev[i] = false; return; }
      spares++;
      var start = btn(g, 9);
      if (start && !sparePrev[i] && !btn(g, 8) && PL.atMainMenu) {
        var p = freeSlot();
        if (p) {
          p.padIndex = i; p.bot = false; p.prevStart = true;
          log('p2', p.name + ' pad = ' + i + ' (' + g.id + ')');
          if (!p.joined) join(p);
        }
      }
      sparePrev[i] = start;
    });
    PL.spares = spares;
    LIST.forEach(function (p) {
      var g = p.padIndex == null ? null : pads[p.padIndex];
      var I = p.input = {};
      if (!g) { p.prevStart = false; p.hasPad = false; return; }
      p.hasPad = true;
      var b = function (n) { return !!(g.buttons[n] && g.buttons[n].pressed); };
      // Same buttons as P1: the game's own controller bindings (Settings.gamepadBindings, rebindable;
      // defaults: RT accelerate, LT brake, A primary, LB/RB secondary 1/2, B eject, d-pad/stick lean).
      // Keys: "bN" = button N, "aN+" / "aN-" = axis N pushed positive / negative.
      var binds = (H.Settings && H.Settings.gamepadBindings) || DEFAULT_BINDS;
      for (var key in binds) {
        var flag = ACTION_FLAG[binds[key]], m = /^([ab])(\d+)([+-]?)$/.exec(key);
        if (!flag || !m) continue;
        var n = +m[2], on;
        if (m[1] === 'b') on = !!(g.buttons[n] && (g.buttons[n].pressed || g.buttons[n].value > 0.5));
        else { var v = g.axes[n] || 0; on = m[3] === '-' ? v < -DEAD : v > DEAD; }
        if (on) I[flag] = true;
      }
      var start = b(9), back = b(8);
      // main menu: LB / RB pick this player's character (applies when the level allows choosing)
      var lb = b(4), rb = b(5);
      if (PL.atMainMenu && p.joined) {
        if (lb && !p.prevLB) cycleChar(p, -1);
        if (rb && !p.prevRB) cycleChar(p, 1);
      }
      p.prevLB = lb; p.prevRB = rb;
      if (start && !p.prevStart && back && p.joined) leave(p);   // Select+Start leaves (anywhere); frees the pad
      // Start alone in a level: pause / resume, like P1 (the game's pause key is Escape)
      else if (start && !p.prevStart && !back && p.joined && H.inLevel) { if (H.session && !H.session.paused) PL.pausedBy = p.id; pressKey('Escape', 27); }
      // Back alone (pressed and released with no Start in between): respawn this player at the start —
      // separate worlds only (a fresh copy of the level for them; world2.js)
      if (back) { if (!p.backDown) { p.backDown = true; p.backCombo = false; } if (start) p.backCombo = true; }
      else if (p.backDown) {
        p.backDown = false;
        if (!p.backCombo && p.joined && H.inLevel && H.session && !H.session.paused && !H.session.hwssLevelDone && H.W2 && H.W2.respawn) H.W2.respawn(p.id);
      }
      p.prevStart = start;
    });
  }
  // cfg.diag: every 2 s write a status snapshot to localStorage 'hwss.diag' (readable from the game's
  // profile folder: Local Storage/leveldb) for debugging installs without the dev server (Steam Deck).
  var diagHist = [];   // one compact row per 2 s, last 60 (Chromium commits localStorage only ~once a minute)
  if (cfg.diag) (function diag() {
    try {
      var pf = H.split && H.split.takePerf ? H.split.takePerf() : null, Hw0 = window.Howler;
      if (pf) diagHist.push([new Date().toISOString().slice(11, 19), pf.views, pf.world, pf.mode, !!(H.split && H.split.active), pf.fps, pf.frameMs, pf.worstFrameMs,
        pf.slowFrames, pf.cullMs, pf.drawMs, pf.ghostMs, pf.physMs, Hw0 ? (Hw0._muted ? 'M' : '-') : '?',
        Hw0 && Hw0._howls ? Hw0._howls.reduce(function (n, h) { return n + (h._sounds || []).filter(function (s) { return !s._paused && !s._ended; }).length; }, 0) : null,
        H.audio ? H.audio.picksP2 : null]);
      if (diagHist.length > 60) diagHist.shift();
      var pads = realPads().map(function (g, i) {
        return g ? { i: i, id: g.id, map: g.mapping, btn: g.buttons.length, down: g.buttons.map(function (b, k) { return b.pressed ? k : -1; }).filter(function (k) { return k >= 0; }) } : null;
      });
      var snap = { t: new Date().toISOString(), atMainMenu: PL.atMainMenu, inLevel: !!H.inLevel, renderer: !!H.renderer,
        split: !!(H.split && H.split.active), pads: pads,
        players: LIST.map(function (p) { return { id: p.id, pad: p.padIndex, hasPad: !!p.hasPad, joined: p.joined, bot: p.bot }; }),
        p1Pad: PL.p1Pad, spares: PL.spares, perf: pf, hist: diagHist,
        audio: (function () {
          try {
            var A = H.audio || {}, c = A.controller, Hw = window.Howler, out = { picks: A.picksP2, patched: A.patchedClasses };
            if (c) {
              out.areas = c._areaSounds ? c._areaSounds.length : null;
              var s0 = c._areaSounds && c._areaSounds[0];
              if (s0) out.area0 = Object.keys(s0).filter(function (k) { return typeof s0[k] === 'number' || typeof s0[k] === 'boolean'; }).slice(0, 14).map(function (k) { return k + '=' + s0[k]; });
              out.ctrlNums = Object.keys(c).filter(function (k) { return typeof c[k] === 'number' || typeof c[k] === 'boolean'; }).slice(0, 14).map(function (k) { return k + '=' + c[k]; });
            }
            if (Hw) out.howler = { ctx: Hw.ctx && Hw.ctx.state, vol: Hw._volume, muted: Hw._muted, howls: Hw._howls && Hw._howls.length,
              playing: Hw._howls ? Hw._howls.reduce(function (n, h) { return n + (h._sounds || []).filter(function (s) { return !s._paused && !s._ended; }).length; }, 0) : null };
            return out;
          } catch (e) { return { err: String(e) }; }
        })(),
        chunk: H.chunkName, req: !!H.req, recent: (H.recent || []).slice(-30) };
      window.localStorage.setItem('hwss.diag', 'HWSSDIAG' + JSON.stringify(snap) + 'HWSSEND');
    } catch (e) {}
    setTimeout(diag, 2000);
  })();
  // ---------- character select screen: a cursor per extra player, coloured picks, start when all picked ----------
  // The screen (fields icons + iconHolder): hovering an icon sets Settings.characterIndex (P1's choice),
  // clicking makes the screen dispatch "characterselected", which starts the level. In co-op that event is
  // held back until every joined player with a controller has picked (A on an icon; B un-picks).
  var cs = { scr: null, checkAt: 0, cursors: {}, p1Pick: null, pending: null, ui: null };
  function findCharSelect() {
    var found = null;
    (function walk(px, d) {
      if (!px || d > 9 || found) return;
      var o = px._flashSprite;
      if (o && px.worldVisible && gopd(o, 'icons') && gopd(o, 'iconHolder')) { found = o; return; }
      (px.children || []).forEach(function (c) { walk(c, d + 1); });
    })(H.stage, 0);
    return found;
  }
  function csIcons() { return (cs.scr && cs.scr.icons || []).filter(function (ic) { return ic._selectable; }); }
  function iconIndex(ic) { return ic._index; }
  function iconRect(ic) { var b = ic._pixiSprite.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }
  // players who must pick: every joined player (each keeps a cursor until they pick; one without a controller
  // waits for it — F10 passes the controller around)
  function pickers() { return LIST.filter(function (p) { return p.joined; }); }
  function allPicked() { return pickers().every(function (p) { return !!p.charPick; }); }
  function hookCharSelect(scr) {
    if (scr.hwssHooked) return;
    scr.hwssHooked = true;
    var orig = scr.dispatchEvent;
    scr.dispatchEvent = function (ev) {
      var type = ev && (ev.type || ev.name);
      if (String(type).toLowerCase() === 'characterselected' && PL.anyJoined()) {
        cs.p1Pick = H.Settings ? H.Settings.characterIndex : null;
        if (!allPicked()) { cs.pending = { self: this, ev: ev, orig: orig }; log('p2', 'character select: P1 picked ' + cs.p1Pick + ', waiting for the others'); return true; }
        applyPicks();                                     // everyone had picked already: start now with their picks
      }
      return orig.apply(this, arguments);
    };
  }
  function startIfReady() {
    if (!cs.pending || !allPicked()) return;
    var pd = cs.pending; cs.pending = null;
    if (H.Settings && cs.p1Pick) H.Settings.characterIndex = cs.p1Pick;   // P1's click, not their last hover
    applyPicks();
    pd.orig.call(pd.self, pd.ev);
  }
  function applyPicks() {
    cs.started = cs.scr;                                 // the level is loading: overlay off (it stayed over "initializing")
    pickers().forEach(function (p) { if (p.charPick) p.charIndex = p.charPick; });
    log('p2', 'character select: everyone picked, starting (' + pickers().map(function (p) { return p.name + '=' + PL.charName(p.charIndex); }).join(', ') + ')');
  }
  function updateCharSelect(pads) {
    var now = performance.now();
    if (now - cs.checkAt > 300) {
      cs.checkAt = now;
      var scr = findCharSelect();
      if (scr !== cs.scr) {
        if (cs.scr) { try { restorePedestals(cs.scr); } catch (e) {} }
        pv.list = {}; pv.altarSaved = null; pv.spot = null; pv.slots = null; pv.altarLB = null;
        cs.scr = scr; cs.pending = null; cs.p1Pick = null; cs.started = null;
        LIST.forEach(function (p) { p.charPick = null; });
        cs.cursors = {};                                 // fresh cursors for this visit
        if (scr) { hookCharSelect(scr); log('p2', 'character select screen'); }
      }
    }
    if (!cs.scr || !PL.anyJoined() || cs.started === cs.scr) {
      if (cs.scr && pv.altarSaved && cs.started !== cs.scr) { try { restorePedestals(cs.scr); } catch (e) {} }
      if (cs.started === cs.scr) pv.mon = null;          // (2 monitors: no more per-monitor passes)
      drawCharSelect(false); return;
    }
    var icons = csIcons(), backed = false;
    pickers().forEach(function (p) {
      if (backed) return;
      var g = p.padIndex != null && !p.bot ? pads[p.padIndex] : null, c = cs.cursors[p.id];
      if (!c) { var r0 = icons[0] ? iconRect(icons[0]) : { x: 500, y: 120, w: 50, h: 50 }; c = cs.cursors[p.id] = { x: r0.x + 25 + (p.id - 2) * 60, y: r0.y + 190, prevA: true, prevB: true }; }
      if (!g) { c.prevA = true; c.prevB = true; return; }   // no controller now: stays put (a held A on hand-over won't pick)
      var ax = g.axes[0] || 0, ay = g.axes[1] || 0, bt = function (n) { return !!(g.buttons[n] && g.buttons[n].pressed); };
      var vx = (Math.abs(ax) > 0.2 ? ax : 0) + (bt(15) ? 1 : 0) - (bt(14) ? 1 : 0), vy = (Math.abs(ay) > 0.2 ? ay : 0) + (bt(13) ? 1 : 0) - (bt(12) ? 1 : 0);
      c.x = clampN(c.x + vx * 7, 0, 900); c.y = clampN(c.y + vy * 7, 0, 500);
      var a = bt(0), b = bt(1);
      if (a && !c.prevA) {
        // one of our buttons under the cursor (the Back button) wins over picking
        var R0 = gameRect();
        if (clickOurButtonAt(R0.left + c.x * R0.width / 900, R0.top + c.y * R0.height / 500)) { backed = !cs.scr || !(H.W2 && H.W2.csOpen && H.W2.csOpen()); c.prevA = a; c.prevB = b; return; }
        var hit = icons.filter(function (ic) { var r = iconRect(ic); return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h; })[0];
        if (hit) { p.charPick = iconIndex(hit); log('p2', p.name + ' picked ' + PL.charName(p.charPick)); startIfReady(); }
      }
      if (b && !c.prevB) p.charPick = null;
      c.prevA = a; c.prevB = b;
    });
    if (backed) { drawCharSelect(false); return; }
    // hover like P1's mouse: the icon under a player's cursor lights up, and moving onto a new character
    // plays the game's "SelectCharacter" sound
    pickers().forEach(function (p) {
      var c = cs.cursors[p.id], ic = c && !p.charPick ? iconUnder(c) : null, idx = ic ? iconIndex(ic) : null;
      if (c && idx !== c.hoverIdx) {
        if (idx && c.hoverIdx !== undefined) { try { H.audio.controller.playSoundItem('SelectCharacter'); } catch (e) {} }
        c.hoverIdx = idx;
      }
    });
    if (!pv.mon) applyHighlights(null);
    try { updatePedestals(cs.scr); } catch (e) { if (!pv.err) { pv.err = true; log('p2-error', 'pedestals: ' + (e && e.stack || e)); } }
    drawCharSelect(true);
  }
  function clampN(v, a, b) { return Math.max(a, Math.min(b, v)); }
  PL.csCursor = function (pid) { return cs.cursors[pid] || null; };   // (tests / probes)
  // the selectable icon under a cursor (game coordinates), or null
  function iconUnder(c) {
    return csIcons().filter(function (ic) { var r = iconRect(ic); return ic._selectable !== false && c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h; })[0] || null;
  }
  // Highlighted icons ("selected" = the game's white box + colour face): P1's hover (the game's own
  // selectedIcon) plus every controller player's hover. pids = only these players (2-monitor passes:
  // that monitor's players), null = everyone.
  function applyHighlights(pids) {
    var scr = cs.scr;
    if (!scr) return;
    var want = new Set();
    if ((!pids || pids.indexOf(1) >= 0) && scr.selectedIcon) want.add(scr.selectedIcon);
    pickers().forEach(function (p) {
      if (pids && pids.indexOf(p.id) < 0) return;
      var c = cs.cursors[p.id], ic = c && !p.charPick ? iconUnder(c) : null;
      if (ic) want.add(ic);
    });
    csIcons().forEach(function (ic) { var on = want.has(ic); if (!!ic._selected !== on) { try { ic.selected = on; } catch (e) {} } });
  }

  // ---------- a pedestal + preview rider per player ----------
  // The screen previews P1's character with screen.characterLoaded(): it builds art for
  // Settings.characterIndex, makes a small session (screen.session = new U(art), scale 2 at 0,0) and adds it
  // to the screen; the altar art (screen.altar) stands under it. For every other player the same function is
  // called with that player's character index, the new session is kept and P1's restored. All pedestals are
  // scaled down into a grid on the left (2 players side by side, 3-4 in 2x2); P1's stays the game's own.
  var pv = { list: {}, spot: null, altarSaved: null };
  var ALTAR = { x: 40.85, y: 346.05, s: 1.2 }, SES_S = 2;
  function copyDisplay(o) {
    var P = H.P, c;
    if (o.texture && typeof o.calculateVertices === 'function') { c = new P.Sprite(o.texture); if (o.anchor) c.anchor.copyFrom(o.anchor); }
    else { c = new P.Container(); (o.children || []).forEach(function (k) { c.addChild(copyDisplay(k)); }); }
    c.position.copyFrom(o.position); c.scale.copyFrom(o.scale); c.rotation = o.rotation; c.alpha = o.alpha;
    return c;
  }
  function runAs(s, fn) { var St = H.Settings, p = St.currentSession; St.currentSession = s; try { return fn(); } finally { St.currentSession = p; } }
  function buildPreview(scr, idx) {
    var St = H.Settings, prevS = scr.session, prevCur = St.currentSession, prevIdx = St.characterIndex, mine = null;
    St.characterIndex = idx;
    try { scr.characterLoaded(); mine = scr.session; }
    catch (e) { log('p2-error', 'preview ' + idx + ': ' + (e && e.stack || e)); }
    finally { scr.session = prevS; St.currentSession = prevCur; St.characterIndex = prevIdx; }
    if (!mine || mine === prevS) return null;
    // Like the game's own preview it is never run (it isn't started; running it throws every frame): the
    // character just stands on the altar. Its world is not "the" world.
    try { if (mine.m_world) mine.m_world.hwssP2World = true; } catch (e) {}
    return mine;
  }
  // Take a preview session off the screen. Every step on its own: on 1.99.3 the preview sessions have no
  // name aliases, so the old "die" isn't there (it is H.N.real('die')); when one step threw, the removal
  // used to be skipped and previews piled up on P2's pedestal while P2 hovered (TheSplitScreenGuy's report).
  function killPreviewSession(scr, s) {
    if (!s) return;
    try { s.removeEventListener('enterFrame', s.hwssRun); } catch (x) {}
    var dieK = typeof s.die === 'function' ? 'die' : (H.N && H.N.real && typeof s[H.N.real('die')] === 'function' ? H.N.real('die') : null);
    if (dieK) { try { runAs(s, function () { s[dieK](); }); } catch (x) {} }
    try { if (scr) scr.removeChild(s); } catch (x) {}
    try { var px = s._pixiSprite; if (px && px.parent) px.parent.removeChild(px); } catch (x) {}   // whatever happened above
  }
  function killPreview(scr, e) {
    if (!e) return;
    var s = e.session;
    if (s) killPreviewSession(scr, s);
    if (e.altar && e.altar.parent) e.altar.parent.removeChild(e.altar);
  }
  function killAllPreviews(scr) {
    Object.keys(pv.list).forEach(function (k) { killPreview(scr, pv.list[k]); });
    pv.list = {};
  }
  // which character a player's pedestal shows: the icon under their cursor, else their pick
  function previewIdxFor(p) {
    var c = cs.cursors[p.id];
    if (c && !p.charPick) {
      var hit = csIcons().filter(function (ic) { var r = iconRect(ic); return c.x >= r.x && c.x <= r.x + r.w && c.y >= r.y && c.y <= r.y + r.h; })[0];
      if (hit) return iconIndex(hit);
    }
    return p.charPick || null;
  }
  function pedestalSlots(n) {
    if (n <= 2) { var k2 = 0.62; return { k: k2, at: [{ x: -10, y: 500 - 540 * k2 }, { x: 215, y: 500 - 540 * k2 }] }; }
    var k = 0.47;
    return { k: k, at: [{ x: 0, y: -6 }, { x: 225, y: -6 }, { x: 0, y: 244 }, { x: 225, y: 244 }] };
  }
  function placePedestal(sessionObj, altarFlash, altarPx, slot, k) {
    if (sessionObj) { sessionObj.x = slot.x; sessionObj.y = slot.y; sessionObj.scaleX = sessionObj.scaleY = SES_S * k; }
    if (altarFlash) { altarFlash.x = slot.x + ALTAR.x * k; altarFlash.y = slot.y + ALTAR.y * k; altarFlash.scaleX = altarFlash.scaleY = ALTAR.s * k; }
    if (altarPx) { altarPx.position.set(slot.x + ALTAR.x * k, slot.y + ALTAR.y * k); altarPx.scale.set(ALTAR.s * k); }
  }
  // 2-monitor mode: the players on each monitor (split.js), else null
  function monPlayers() { return H.split && H.split.monitorPlayers ? H.split.monitorPlayers() : null; }
  // pedestal layout of one monitor's players (one alone: the game's own full-size pedestal)
  function monitorPedestals(pids) {
    var L = pids.length === 1 ? { k: 1, at: [{ x: 0, y: 0 }] } : pedestalSlots(pids.length);
    return pids.map(function (pid, i) { return { pid: pid, slot: L.at[i], k: L.k }; });
  }
  // the pedestal pieces of player pid: [session (game object), altar (game object), altar (pixi)]
  function pedestalOf(scr, pid) {
    if (pid === 1) return [scr.session, scr.altar, null];
    var e = pv.list[pid];
    return e ? [e.session, null, e.altar] : null;
  }
  function setPedestalVisible(scr, pid, vis) {
    var q = pedestalOf(scr, pid);
    if (!q) return;
    [q[0] && q[0]._pixiSprite, q[1] && q[1]._pixiSprite, q[2]].forEach(function (px) { if (px && px.visible !== vis) px.visible = vis; });
  }
  // split.js calls this around its two draws of the character select in 2-monitor mode: mi = the monitor
  // being drawn (only its players' pedestals, laid out for it), -1 = done (everything visible again).
  // Returns false when there is nothing to split (not on the screen, nobody on the other monitor).
  PL.csMonitorPass = function (mi) {
    var scr = cs.scr, mons = pv.mon;
    if (!scr || !mons || !scr.session || !pv.altarSaved) return false;
    var all = [1].concat(Object.keys(pv.list).map(Number));
    if (mi < 0) { all.forEach(function (pid) { setPedestalVisible(scr, pid, true); }); applyHighlights(null); return true; }
    var mine = mons[mi] || [];
    applyHighlights(mine.map(function (m) { return m.pid; }));   // only this monitor's players' hovers
    all.forEach(function (pid) {
      var at = mine.filter(function (m) { return m.pid === pid; })[0];
      setPedestalVisible(scr, pid, !!at);
      var q = at && pedestalOf(scr, pid);
      if (q) placePedestal(q[0], q[1], q[2], at.slot, at.k);
    });
    return true;
  };
  function updatePedestals(scr) {
    var others = LIST.filter(function (p) { return p.joined; });
    if (!others.length || !scr.altar || !scr.session) { restorePedestals(scr); return; }
    if (!pv.altarSaved) pv.altarSaved = { x: scr.altar.x, y: scr.altar.y, s: scr.altar.scaleX };
    // the spotlights aim at the single centre altar: off while there are several
    if (!pv.spot) { pv.spot = [scr.spotlight1, scr.spotlight2].filter(Boolean).map(function (sp) { var v = sp.visible; sp.visible = false; return [sp, v]; }); }
    // 2-monitor mode: each monitor gets its own players' pedestals (the screen is drawn once per monitor)
    var mp = monPlayers();
    pv.mon = mp && mp.length > 1 && mp[1].length ? mp.map(function (pids) { return monitorPedestals(pids.filter(function (pid) { return pid === 1 || others.some(function (p) { return p.id === pid; }); })); }) : null;
    var L = pedestalSlots(1 + others.length), slots = [];
    placePedestal(scr.session, scr.altar, null, L.at[0], L.k);
    slots.push({ pid: 1, slot: L.at[0] });
    var altarPx = scr.altar._pixiSprite;
    if (!pv.altarLB) { try { var lb = altarPx.getLocalBounds(); pv.altarLB = { cx: lb.x + lb.width / 2, bottom: lb.y + lb.height * 0.31 }; } catch (e) {} }   // slab = top ~30% (legs below)
    others.forEach(function (p, i) {
      var slot = L.at[i + 1], e = pv.list[p.id] || (pv.list[p.id] = { idx: null, session: null, altar: null });
      if (!slot) return;
      if (!e.altar) {
        e.altar = copyDisplay(altarPx);
        var par = altarPx.parent; par.addChildAt(e.altar, Math.min(par.children.indexOf(altarPx) + 1, par.children.length));
      }
      var want = previewIdxFor(p);
      if (want !== e.idx) {
        if (e.session) { killPreviewSession(scr, e.session); e.session = null; }
        e.idx = want;
        if (want) e.session = buildPreview(scr, want);
      }
      placePedestal(e.session, null, e.altar, slot, L.k);
      slots.push({ pid: p.id, slot: slot });
    });
    // players who left: their pedestal goes
    Object.keys(pv.list).forEach(function (k) { if (!others.some(function (p) { return p.id === +k; })) { killPreview(scr, pv.list[k]); delete pv.list[k]; } });
    pv.slots = slots; pv.k = L.k;
  }
  function restorePedestals(scr) {
    killAllPreviews(scr);
    if (scr && pv.altarSaved && scr.altar) { scr.altar.x = pv.altarSaved.x; scr.altar.y = pv.altarSaved.y; scr.altar.scaleX = scr.altar.scaleY = pv.altarSaved.s; }
    if (scr && scr.session) { scr.session.x = 0; scr.session.y = 0; scr.session.scaleX = scr.session.scaleY = SES_S; }
    if (pv.spot) pv.spot.forEach(function (e) { e[0].visible = e[1]; });
    pv.altarSaved = null; pv.spot = null; pv.slots = null; pv.mon = null;
  }
  // DOM overlay over the canvas: picked boxes (one picker: full border; several: a coloured corner each)
  // and the cursors
  var CORNER = { 1: 'tl', 2: 'tr', 3: 'br', 4: 'bl' };
  // P1's mouse, drawn as a P1 cursor on this screen (the real pointer is hidden there)
  // (also the game's own controller "virtual mouse" for P1's stick; not our P2-P4 cursors' synthetic events)
  window.addEventListener('pointermove', function (e) { if (mc && mc.synth) return; cs.mouse = { x: e.clientX, y: e.clientY }; if (mc) mc.p1 = cs.mouse; }, true);
  function nativeCursor(hide) {
    var cv = H.renderer && H.renderer.view, v = hide ? 'none' : '';
    if (cv && cv.style.cursor !== v) cv.style.cursor = v;
    if (document.body && document.body.style.cursor !== v) document.body.style.cursor = v;
  }
  function drawCharSelect(show) {
    nativeCursor(show);
    if (!show) { if (cs.ui) cs.ui.style.display = 'none'; return; }
    if (!cs.ui) {
      cs.ui = document.createElement('div');
      cs.ui.id = 'hwss-charselect';
      cs.ui.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
      document.body.appendChild(cs.ui);
    }
    cs.ui.style.display = 'block';
    // 2-monitor mode: the screen is on both monitors; each player's cursor and pedestal tag go on theirs
    var mons = pv.mon && H.gameRect ? pv.mon : null;
    var rects = mons ? mons.map(function (m, mi) { return gameRect(mi); }) : [gameRect()];
    function monOf(pid) { if (!mons) return 0; for (var mi = 0; mi < mons.length; mi++) if (mons[mi].some(function (m) { return m.pid === pid; })) return mi; return 0; }
    var rect = rects[0], k = rect.width / 900;
    var html = [], picks = {};
    if (cs.p1Pick && cs.pending) (picks[cs.p1Pick] = picks[cs.p1Pick] || []).push(1);
    pickers().forEach(function (p) { if (p.charPick) (picks[p.charPick] = picks[p.charPick] || []).push(p.id); });
    rects.forEach(function (rect) { csIcons().forEach(function (ic) {
      var who = picks[iconIndex(ic)];
      if (!who) return;
      var r = iconRect(ic), L = rect.left + r.x * k, T = rect.top + r.y * k, Wd = r.w * k, Ht = r.h * k, bw = Math.max(3, Math.round(4 * k));
      if (who.length === 1) {
        html.push('<div style="position:absolute;left:' + (L - bw) + 'px;top:' + (T - bw) + 'px;width:' + Wd + 'px;height:' + Ht + 'px;border:' + bw + 'px solid ' + colorOf(who[0]) + ';border-radius:' + bw + 'px;box-shadow:0 0 ' + (bw * 2) + 'px ' + colorOf(who[0]) + '"></div>');
      } else if (who.length <= 3) {
        // 2 pickers: the border half and half (right / left); 3: in thirds like a triangle. A conic
        // gradient masked down to a border ring (the box's inside stays clear).
        var ids = who.slice().sort(), seg = 360 / ids.length, stops = ids.map(function (pid, i) { return colorOf(pid) + ' ' + (i * seg) + 'deg ' + ((i + 1) * seg) + 'deg'; }).join(',');
        var ring = '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;';
        html.push('<div style="position:absolute;box-sizing:content-box;left:' + (L - bw) + 'px;top:' + (T - bw) + 'px;width:' + Wd + 'px;height:' + Ht + 'px;padding:' + bw + 'px;border-radius:' + bw + 'px;background:conic-gradient(' + stops + ');' + ring + '"></div>');
      } else {
        var len = Math.round(Wd * 0.42);
        who.forEach(function (pid) {
          var cn = CORNER[pid], st = 'position:absolute;width:' + len + 'px;height:' + len + 'px;border:' + bw + 'px solid transparent;';
          var col = colorOf(pid);
          if (cn === 'tl') st += 'left:' + (L - bw) + 'px;top:' + (T - bw) + 'px;border-left-color:' + col + ';border-top-color:' + col + ';';
          if (cn === 'tr') st += 'left:' + (L + Wd - len - bw) + 'px;top:' + (T - bw) + 'px;border-right-color:' + col + ';border-top-color:' + col + ';';
          if (cn === 'br') st += 'left:' + (L + Wd - len - bw) + 'px;top:' + (T + Ht - len - bw) + 'px;border-right-color:' + col + ';border-bottom-color:' + col + ';';
          if (cn === 'bl') st += 'left:' + (L - bw) + 'px;top:' + (T + Ht - len - bw) + 'px;border-left-color:' + col + ';border-bottom-color:' + col + ';';
          html.push('<div style="' + st + '"></div>');
        });
      }
    }); });
    function cursor(x, y, pid) {
      var s = Math.round(22 * k), col = colorOf(pid);
      html.push('<svg style="position:absolute;left:' + x + 'px;top:' + y + 'px;overflow:visible" width="' + s + '" height="' + s + '" viewBox="0 0 22 22">' +
        '<path d="M0 0 L0 18 L5 13.5 L8.5 21 L11.5 19.5 L8 12.5 L14.5 12.5 Z" fill="' + col + '" stroke="#13213d" stroke-width="1.6" stroke-linejoin="round"/></svg>');
      html.push('<div style="position:absolute;left:' + (x + s * 0.7) + 'px;top:' + (y + s * 0.75) + 'px;font:900 ' + Math.round(13 * k) + 'px \'Arial Black\',Arial,sans-serif;color:' + col + ';-webkit-text-stroke:' + Math.max(1, Math.round(1.5 * k)) + 'px #13213d;paint-order:stroke fill">P' + pid + '</div>');
    }
    // pedestal tags: "P2" just under each player's altar slab, between its legs
    var lb = pv.altarLB || { cx: 120, bottom: 60 };
    var tagList = mons ? [].concat.apply([], mons.map(function (m, mi) { return m.map(function (e) { return { pid: e.pid, slot: e.slot, k: e.k, mi: mi }; }); }))
                       : (pv.slots || []).map(function (e) { return { pid: e.pid, slot: e.slot, k: pv.k, mi: 0 }; });
    tagList.forEach(function (e) {
      var R = rects[e.mi] || rect, kk = R.width / 900;
      var x = R.left + (e.slot.x + (ALTAR.x + lb.cx * ALTAR.s) * e.k) * kk,
          y = R.top + (e.slot.y + (ALTAR.y + lb.bottom * ALTAR.s) * e.k) * kk + 2;
      html.push('<div style="position:absolute;left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,0);font:900 ' + Math.round(16 * kk) + 'px \'Arial Black\',Arial,sans-serif;color:' + colorOf(e.pid) + ';-webkit-text-stroke:' + Math.max(1, Math.round(2 * kk)) + 'px #13213d;paint-order:stroke fill">P' + e.pid + '</div>');
    });
    // a cursor until that player has picked (B un-picks and brings it back), on that player's monitor
    pickers().forEach(function (p) { var c = cs.cursors[p.id], R = rects[monOf(p.id)] || rect, kk = R.width / 900; if (c && !p.charPick) cursor(R.left + c.x * kk, R.top + c.y * kk, p.id); });
    if (cs.mouse && !cs.pending) cursor(cs.mouse.x, cs.mouse.y, 1);
    // P1 clicked but others are still choosing
    if (cs.pending) {
      var waiting = pickers().filter(function (p) { return !p.charPick; }).map(function (p) { return p.name; }).join(', ');
      html.push('<div style="position:absolute;left:' + (rect.left + 640 * k) + 'px;top:' + (rect.top + 440 * k) + 'px;transform:translateX(-50%);white-space:nowrap;font:900 ' + Math.round(16 * k) + 'px \'Arial Black\',Arial,sans-serif;color:#fff;-webkit-text-stroke:' + Math.max(1, Math.round(2 * k)) + 'px #13213d;paint-order:stroke fill">Waiting for ' + waiting + ' to pick' + (PL.p1Keyboard || LIST.some(function (p) { return p.joined && p.bot; }) ? ' (F10 passes the controller)' : '') + '</div>');
    }
    var out = html.join('');
    if (cs.ui.hwssHtml !== out) { cs.ui.hwssHtml = out; cs.ui.innerHTML = out; }
  }

  // ---------- controller cursors in menus (TheSplitScreenGuy's request) ----------
  // Menus (no level running, not the character select, which has its own cursors; only while the main-menu
  // "Player Cursors" checkbox is on): every joined controller player gets a cursor in their colour (stick /
  // d-pad moves it, A clicks). Pause menu: only the player who paused with their Start (any time). Co-op
  // level-complete screen: everyone (any time). A click goes to whatever is under the cursor, like a mouse
  // click: the game's canvas (pointer events, as P1's mouse) or one of our DOM buttons. Hover is only sent
  // while a cursor moves, so an idle pad doesn't fight P1's mouse. P1's pointer (mouse or the game's virtual
  // mouse) is drawn as the P1 cursor in the same places while anyone has joined. Cursors are the top layer.
  var mc = { cursors: {}, ui: null, last: 0, ctx: null };
  function charSelectActive() { return !!(cs.scr && PL.anyJoined() && cs.started !== cs.scr); }
  function menuCursorPlayers() {
    if (!H.renderer || charSelectActive()) return { ctx: null, list: [] };
    var s = H.session;
    if (H.inLevel) {
      var by = PL.pausedBy;
      if (s && s.paused && !s.hwssLevelDone && by > 1) return { ctx: 'pause', list: LIST.filter(function (p) { return p.id === by && p.joined; }) };
      // co-op level-complete screen: everyone (restart / exit, correcting the win tally)
      if (s && s.hwssLevelDone && s.hwssCoop) return { ctx: 'complete', list: LIST.filter(function (p) { return p.joined; }) };
      return { ctx: null, list: [] };
    }
    if (!PL.getMenuCursors()) return { ctx: null, list: [] };   // main-menu checkbox off: menus as before
    return { ctx: 'menu', list: LIST.filter(function (p) { return p.joined; }) };
  }
  function pointerAt(x, y, types) {
    var R = gameRect(), cx = R.left + x * R.width / 900, cy = R.top + y * R.height / 500, cv = H.renderer.view;
    var el = document.elementFromPoint(cx, cy) || cv;
    var target = el === cv || cv.contains(el) ? cv : el;
    var o = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    mc.synth = true;                                     // P1's cursor ignores these (it follows P1's own pointer)
    try { types.forEach(function (t) {
      if (t === 'pointerup') o.buttons = 0;
      try {
        if (t === 'click') { if (target !== cv) target.dispatchEvent(new MouseEvent('click', o)); return; }
        target.dispatchEvent(new PointerEvent(t, o));
        if (t === 'pointerup' && target === cv) window.dispatchEvent(new PointerEvent('pointerup', o));
      } catch (e) {}
    }); } finally { mc.synth = false; }
  }
  function updateMenuCursors(pads) {
    var now = performance.now(), dt = Math.min(50, now - (mc.last || now)); mc.last = now;
    var who = menuCursorPlayers();
    if (who.ctx !== mc.ctx) { mc.ctx = who.ctx; mc.cursors = {}; }   // fresh cursors for each menu visit / pause
    var shown = [];
    who.list.forEach(function (p) {
      var g = p.padIndex != null && !p.bot ? pads[p.padIndex] : null;
      if (!g) return;
      var c = mc.cursors[p.id];
      if (!c) c = mc.cursors[p.id] = { x: 450 + (p.id - 2.5) * 50, y: 250, prevA: true };   // a held A doesn't click at once
      var ax = g.axes[0] || 0, ay = g.axes[1] || 0, bt = function (n) { return !!(g.buttons[n] && g.buttons[n].pressed); };
      var vx = (Math.abs(ax) > 0.2 ? ax : 0) + (bt(15) ? 1 : 0) - (bt(14) ? 1 : 0), vy = (Math.abs(ay) > 0.2 ? ay : 0) + (bt(13) ? 1 : 0) - (bt(12) ? 1 : 0);
      var sp = 0.45 * dt;                                // ~450 game px per second at full tilt
      if (vx || vy) {
        c.x = clampN(c.x + vx * sp, 0, 900); c.y = clampN(c.y + vy * sp, 0, 500);
        pointerAt(c.x, c.y, ['pointermove']);
      }
      var a = bt(0);
      if (a && !c.prevA) { pointerAt(c.x, c.y, ['pointermove', 'pointerdown']); c.down = true; }
      if (!a && c.down) { pointerAt(c.x, c.y, ['pointerup', 'click']); c.down = false; }
      c.prevA = a;
      shown.push(p.id);
    });
    // P1: in co-op menus and the pause menu, P1's pointer (real mouse, or the game's virtual mouse driven by
    // P1's stick) is drawn as the P1 cursor; the game's own controller arrow and the system pointer are hidden
    var s = H.session, pauseUp = !!(H.inLevel && s && s.paused && !s.hwssLevelDone), doneUp = !!(H.inLevel && s && s.hwssLevelDone && s.hwssCoop);
    var p1On = !!(mc.p1 && H.renderer && PL.anyJoined() && !charSelectActive() && ((!H.inLevel && PL.getMenuCursors()) || pauseUp || doneUp));
    gameCursorHidden(p1On);
    if (!charSelectActive()) nativeCursor(p1On);
    // P1's stick moves the game's own virtual mouse, which may not reach our page buttons: P1's A clicks a
    // scoreboard arrow under P1's cursor directly (the arrow ignores a second click within 250 ms)
    var g1 = PL.p1Pad != null ? pads[PL.p1Pad] : null, a1 = !!(g1 && g1.buttons[0] && g1.buttons[0].pressed);
    var csUp = !!(cs.scr && H.W2 && H.W2.csOpen && H.W2.csOpen());   // character select (Back button), solo too
    if ((p1On || csUp) && mc.p1 && a1 && !mc.p1A) clickOurButtonAt(mc.p1.x, mc.p1.y);
    mc.p1A = a1;
    drawMenuCursors(shown, p1On ? mc.p1 : null);
  }
  // the game's own controller cursor: a fixed DIV holding a 14x21 arrow SVG that follows its virtual mouse
  function gameCursorHidden(hide) {
    if (!mc.gameCur || !mc.gameCur.isConnected) {
      if (!hide) return;
      var svg = document.querySelector('svg[viewBox="0 0 14 21"]');
      mc.gameCur = svg && svg.parentElement && svg.parentElement !== document.body && !/hwss/.test(svg.parentElement.id) ? svg.parentElement : null;
      if (!mc.gameCur) return;
    }
    var v = hide ? 'hidden' : '';
    if (mc.gameCur.style.visibility !== v) mc.gameCur.style.visibility = v;
  }
  function cursorHtml(x, y, pid, k) {
    var s = Math.round(22 * k), col = colorOf(pid);
    return '<svg style="position:absolute;left:' + x + 'px;top:' + y + 'px;overflow:visible" width="' + s + '" height="' + s + '" viewBox="0 0 22 22">' +
      '<path d="M0 0 L0 18 L5 13.5 L8.5 21 L11.5 19.5 L8 12.5 L14.5 12.5 Z" fill="' + col + '" stroke="#13213d" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<div style="position:absolute;left:' + (x + s * 0.7) + 'px;top:' + (y + s * 0.75) + 'px;font:900 ' + Math.round(13 * k) + 'px \'Arial Black\',Arial,sans-serif;color:' + col + ';-webkit-text-stroke:' + Math.max(1, Math.round(1.5 * k)) + 'px #13213d;paint-order:stroke fill">P' + pid + '</div>';
  }
  function drawMenuCursors(pids, p1) {
    if (!pids.length && !p1) { if (mc.ui && mc.ui.style.display !== 'none') mc.ui.style.display = 'none'; return; }
    if (!mc.ui) {
      if (!document.body) return;
      mc.ui = document.createElement('div');
      mc.ui.id = 'hwss-menu-cursors';
      // top layer: cursors draw over the scoreboard and our buttons (those use 2147483646)
      mc.ui.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      document.body.appendChild(mc.ui);
    }
    mc.ui.style.display = 'block';
    var R = gameRect(), k = R.width / 900;
    var out = pids.map(function (pid) { var c = mc.cursors[pid]; return cursorHtml(R.left + c.x * k, R.top + c.y * k, pid, k); }).join('') +
      (p1 ? cursorHtml(p1.x, p1.y, 1, k) : '');      // P1 on top (page coordinates of P1's pointer)
    if (mc.ui.hwssHtml !== out) { mc.ui.hwssHtml = out; mc.ui.innerHTML = out; }
  }
  PL.menuCursor = function (pid) { return mc.cursors[pid] || null; };   // (tests / probes)

  (function loop() {
    try { updateCharSelect(realPads()); } catch (e) { if (!cs.err) { cs.err = true; log('p2-error', 'character select: ' + (e && e.stack || e)); } }
    try { updateMenuCursors(realPads()); } catch (e) { if (!mc.err) { mc.err = true; log('p2-error', 'menu cursors: ' + (e && e.stack || e)); } }
    try { checkMainMenu(); } catch (e) { log('p2-error', 'menu check: ' + e); }
    try { checkOpenMenu(); } catch (e) { log('p2-error', 'open menu check: ' + e); }
    try { readPads(); } catch (e) { log('p2-error', 'pad: ' + e); }
    try { updateHint(); } catch (e) {}
    try { updateWinBanner(); } catch (e) {}
    try { updatePauseTag(); } catch (e) {}
    try { updateScoreboard(); } catch (e) {}
    try { updateMonitorsButton(); } catch (e) {}
    try { updateVersionLabel(); } catch (e) { if (!mc.verErr) { mc.verErr = true; log('p2-error', 'version label: ' + (e && e.stack || e)); } }
    try { updateCsBackButton(); } catch (e) { if (!mc.backErr) { mc.backErr = true; log('p2-error', 'character select back button: ' + (e && e.stack || e)); } }
    try { updateCursorsCheckbox(); } catch (e) { if (!mc.cbErr) { mc.cbErr = true; log('p2-error', 'cursors checkbox: ' + (e && e.stack || e)); } }
    requestAnimationFrame(loop);
  })();

  // ---------- test riders (F3 / F4): replay P1's controls with a delay ----------
  var hist = [];                            // [{t, I}] P1's control state, newest last
  function keyFlags(C) {
    return { up: !!C.upPressed, down: !!C.downPressed, left: !!C.leftPressed, right: !!C.rightPressed,
             space: !!C.spacePressed, shift: !!C.shiftPressed, ctrl: !!C.ctrlPressed, z: !!C.zPressed };
  }
  function setFlags(C, I) {
    C.upPressed = !!I.up; C.downPressed = !!I.down; C.leftPressed = !!I.left; C.rightPressed = !!I.right;
    C.spacePressed = !!I.space; C.shiftPressed = !!I.shift; C.ctrlPressed = !!I.ctrl; C.zPressed = !!I.z;
  }
  function recordP1(C1) {
    var t = performance.now();
    hist.push({ t: t, I: keyFlags(C1) });
    while (hist.length && hist[0].t < t - 3000) hist.shift();
  }
  // F8: P1 delay off / 0.5 s (P1 rides on its own controls from 0.5 s ago)
  PL.p1Delay = 0;
  function delayedP1(sec) {
    var cut = performance.now() - sec * 1000;
    for (var i = hist.length - 1; i >= 0; i--) if (hist[i].t <= cut) return hist[i].I;
    return {};
  }
  // F5 = P2, F3 = P3, F4 = P4 (the game's app menu is removed, so F5 is not a reload key).
  // Not joined → join as a test rider. Joined with a pad → the test rider takes over; press again to hand
  // control back to the pad. Test rider without a pad → leaves.
  // F6 / F7: P3 / P4 test rider without the delay (same controls as P1 in the same frame), toggle.
  var BOT_KEYS = { F5: 2, F3: 3, F4: 4 }, KEY_OF = { 2: 'F5', 3: 'F3', 4: 'F4' }, NODELAY_KEYS = { F6: 3, F7: 4 };
  // F2: hide / show the mod's hint lines on the main menu ("P2: Test Rider (F5 To Remove)", "Press Start To
  // Join", auto-ride...), for recording (TheSplitScreenGuy's request; saved). updateHint() checks dbgHidden().
  var DBG_KEY = 'hwss.hideDebug', dbg = { hide: null };
  function dbgHidden() { if (dbg.hide === null) { try { dbg.hide = window.localStorage.getItem(DBG_KEY) === 'on'; } catch (e) { dbg.hide = false; } } return dbg.hide; }
  PL.toggleDebugText = function () {
    dbg.hide = !dbgHidden();
    try { window.localStorage.setItem(DBG_KEY, dbg.hide ? 'on' : 'off'); } catch (e) {}
    log('p2', 'hint text (F2): ' + (dbg.hide ? 'hidden' : 'shown'));
    return dbg.hide;
  };

  // F1: auto-ride (for recording showcase videos): every player full throttle + random lean left / right
  PL.autoRide = false;
  var autoSt = {};
  function autoInput(pid) {
    var now = performance.now(), st = autoSt[pid];
    if (!st || now > st.until) {
      // lean is all-or-nothing, so it is softened by holding it less (TheSplitScreenGuy: "a little too strong"): short taps
      // of 0.15-0.45 s, left or right at random, with 0.4-1.2 s of riding straight between them (~1/3 leaning)
      var wasLean = !!(st && st.lean);
      var keepA = st ? { aNext: st.aNext, aUntil: st.aUntil } : { aNext: now + 600 + Math.random() * 1900, aUntil: 0 };
      var lean = wasLean ? 0 : (Math.random() < 0.5 ? -1 : 1);
      var dur = lean ? 150 + Math.random() * 300 : 400 + Math.random() * 800;
      st = autoSt[pid] = { lean: lean, until: now + dur, aNext: keepA.aNext, aUntil: keepA.aUntil };
    }
    // random A (primary action = the space flag): a 0.15-0.4 s press every 0.6-2.5 s (TheSplitScreenGuy's request)
    if (now >= st.aNext) { st.aUntil = now + 150 + Math.random() * 250; st.aNext = st.aUntil + 600 + Math.random() * 1900; }
    return { up: true, left: st.lean < 0, right: st.lean > 0, space: now < st.aUntil };
  }
  window.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.code === 'F1') {
      e.preventDefault();
      PL.autoRide = !PL.autoRide; autoSt = {};
      log('p2', 'auto-ride (F1): ' + (PL.autoRide ? 'on: every player full throttle + random lean' : 'off'));
      return;
    }
    if (e.code === 'F2') {
      e.preventDefault();
      PL.toggleDebugText();
      return;
    }
    if (e.code === 'F10') { e.preventDefault(); cycleController(); return; }
    if (e.code === 'F9') {
      e.preventDefault();
      PL.p1Keyboard = !PL.p1Keyboard;
      log('p2', 'P1 ' + (PL.p1Keyboard ? 'keyboard + mouse only (controllers can join as P2-P4)' : 'uses the first controller again'));
      return;
    }
    if (e.code === 'F8') {
      e.preventDefault();
      PL.p1Delay = PL.p1Delay ? 0 : 0.5;
      log('p2', 'P1 delay: ' + (PL.p1Delay ? PL.p1Delay + ' s' : 'none'));
      return;
    }
    var nd = NODELAY_KEYS[e.code];
    if (nd) {
      e.preventDefault();
      var q = byId[nd];
      q.noDelay = !q.noDelay;
      log('p2', q.name + ' test rider delay: ' + (q.noDelay ? 'none' : (BOT_DELAY[q.id] + ' s')));
      return;
    }
    var id = BOT_KEYS[e.code];
    if (!id) return;
    e.preventDefault();
    var p = byId[id];
    if (!p.joined) { p.bot = true; join(p); }
    else if (!p.bot) { p.bot = true; log('p2', p.name + ': test rider takes over'); }
    else if (p.hasPad) { p.bot = false; log('p2', p.name + ': back on the pad'); }
    else { leave(p); p.bot = false; }
  }, true);

  // ---------- shirt colours (P2 red, P3 blue, P4 green) ----------
  // Selective hue shader on the torso/arm clips (and sub-characters like the kid): clearly coloured
  // pixels outside the skin/tan range (hue 8-50 deg) get the player's hue (degrees), keeping
  // saturation and brightness so shading survives. cfg.p2ShirtHue/p3ShirtHue/p4ShirtHue = false disables.
  var SHIRT_FRAG = [
    'varying vec2 vTextureCoord;',
    'uniform sampler2D uSampler;',
    'uniform float uHue;',
    'vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));',
    'vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);float e=1.0e-10;',
    'return vec3(abs(q.z+(q.w-q.y)/(6.0*d+e)),d/(q.x+e),q.x);}',
    'vec3 hsv2rgb(vec3 c){vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);',
    'return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);}',
    'void main(){',
    '  vec4 c=texture2D(uSampler,vTextureCoord);',
    '  if(c.a<=0.0){gl_FragColor=c;return;}',
    '  vec3 rgb=c.rgb/c.a; vec3 hsv=rgb2hsv(rgb); float h=hsv.x*360.0;',
    '  bool skin=h>8.0&&h<50.0;',
    '  if(hsv.y>0.28&&hsv.z>0.12&&!skin){hsv.x=uHue; rgb=hsv2rgb(hsv);}',
    // white / grey / grey-blue tops (lawnmower man's tank top, segway guy's suit incl. its darker
    // shading): colourise everything above near-black outlines, keep the shading
    '  else if(hsv.y<=0.28&&hsv.z>0.2){hsv.x=uHue; hsv.y=0.75; hsv.z=hsv.z*0.85; rgb=hsv2rgb(hsv);}',
    '  gl_FragColor=vec4(rgb*c.a,c.a);',
    '}'
  ].join('\n');
  // The Irresponsible Dad's son (Char3's kid): his shirt is a saturated orange-yellow (hue 36-40, sat 0.6-1)
  // that the rule above keeps as "skin"; his skin is hue 24-32 at sat ~0.4. Recolour only the shirt range.
  var KID_FRAG = SHIRT_FRAG.replace(/  bool skin=[\s\S]*?gl_FragColor=vec4\(rgb\*c\.a,c\.a\);/,
    '  if(h>=33.0&&h<=48.0&&hsv.y>=0.55&&hsv.z>0.12){hsv.x=uHue; rgb=hsv2rgb(hsv);}\n  gl_FragColor=vec4(rgb*c.a,c.a);');
  // Vehicles (Santa's sleigh, the lawnmower): only clearly coloured paint takes the player's hue; greys,
  // blacks and whites (metal, wheels, outlines) and the gold/tan range stay as they are.
  var VEHICLE_FRAG = SHIRT_FRAG.replace(/  else if\(hsv\.y<=0\.28[^\n]*\n/, '');
  var shirtFilters = {}, kidFilters = {}, vehicleFilters = {};
  var SHIRT_CLIPS = ['chestMC', 'upperArm1MC', 'upperArm2MC', 'upperArm3MC', 'upperArm4MC', 'lowerArm1MC', 'lowerArm2MC'];
  function hueOf(pid) { var v = cfg[HUES[pid]]; return v === undefined ? HUE_DEFAULT[pid] : v; }
  PL.hueOf = hueOf;
  // PERFORMANCE: a Pixi filter on a clip costs a separate render pass every time the clip is drawn
  // (measured on the Steam Deck: 4 riders x 17 tinted clips x 4 shared views ≈ 20 ms/frame). So the
  // colour is BAKED: each picture (texture) a tinted clip uses is drawn through the filter ONCE into a
  // cached texture, and the clip's sprites show that instead. Clips without plain sprites (vector
  // graphics) keep the live filter. Sprites that switch pictures later (broken parts) are re-baked by
  // the 500 ms recheck below.
  var bakeCache = new Map(), tinted = [];   // tinted: [{px, f}] clip roots to keep coloured
  function isSprite(o) { return !!(H.P && H.P.Sprite && o instanceof H.P.Sprite && o.texture); }
  function bakeTexture(tex, f) {
    var R = H.renderer, P = H.P;
    if (!R || !tex || !tex.baseTexture || !tex.orig) return null;
    var fr = tex.frame, key = f.hwssKey + '|' + tex.baseTexture.uid + '|' + fr.x + ',' + fr.y + ',' + fr.width + ',' + fr.height + '|' + (tex.rotate || 0) + '|' + R.resolution;
    var t = bakeCache.get(key);
    if (t) return t;
    var w = Math.ceil(tex.orig.width), h = Math.ceil(tex.orig.height);
    if (!w || !h) return null;
    // +1: at resolutions like 2.7 a w x h render texture can measure a hair under w x h
    var rt = P.RenderTexture.create({ width: w + 1, height: h + 1, resolution: R.resolution });
    var tmp = new P.Sprite(tex);
    tmp.filters = [f];
    R.render(tmp, { renderTexture: rt, clear: true });     // full original rect (trim/rotation resolved)
    tmp.filters = null; tmp.destroy();
    t = new P.Texture(rt.baseTexture, new P.Rectangle(0, 0, w, h));
    bakeCache.set(key, t);
    return t;
  }
  // colour every sprite under px; returns how many sprites it found (0 = use the live filter instead)
  function bakeTree(px, f) {
    var n = 0;
    (function walk(o, d) {
      if (!o || d > 8) return;
      if (isSprite(o)) {
        n++;
        if (o.texture !== o.hwssBaked) {                 // new picture (or not done yet)
          var src = o.texture, bt = bakeTexture(src, f);
          if (bt) { o.hwssOrigTex = src; o.hwssBaked = bt; o.texture = bt; }
        }
      }
      for (var i = 0; o.children && i < o.children.length; i++) walk(o.children[i], d + 1);
    })(px, 0);
    return n;
  }
  function unbakeTree(px) {
    (function walk(o, d) {
      if (!o || d > 8) return;
      if (o.hwssOrigTex && o.texture === o.hwssBaked) o.texture = o.hwssOrigTex;
      o.hwssBaked = null; o.hwssOrigTex = null;
      for (var i = 0; o.children && i < o.children.length; i++) walk(o.children[i], d + 1);
    })(px, 0);
  }
  function applyTint(px, f) {
    if (px.filters && px.filters.length === 1 && px.filters[0].hwssKey) px.filters = null;   // an older live filter
    var n = 0;
    try { n = cfg.liveTintFilters ? 0 : bakeTree(px, f); } catch (e) { log('p2-error', 'bake: ' + e); n = 0; }
    if (!n) { px.filters = [f]; return; }               // nothing bakeable: live filter
    for (var i = 0; i < tinted.length; i++) if (tinted[i].px === px) { tinted[i].f = f; return; }
    tinted.push({ px: px, f: f });
  }
  setInterval(function () {                             // re-bake pictures the game swapped in; forget gone clips
    tinted = tinted.filter(function (e) { return e.px && !e.px.destroyed && (e.px.parent || e.px.hwssKeep); });
    tinted.forEach(function (e) { try { bakeTree(e.px, e.f); } catch (x) {} });
  }, 500);
  function tintShirt(C, pid) {
    var hue = hueOf(pid);
    if (hue === false || hue === null || typeof hue !== 'number' || !H.P || !H.P.Filter) return;
    var u = (((hue % 360) + 360) % 360) / 360;
    var f = shirtFilters[pid] || (shirtFilters[pid] = new H.P.Filter(undefined, SHIRT_FRAG, { uHue: u }));
    f.hwssKey = 's' + pid + ':' + hue;
    var n = 0, extra = extraClips(C);
    var vf = vehicleFilters[pid] || (vehicleFilters[pid] = new H.P.Filter(undefined, VEHICLE_FRAG, { uHue: u }));
    vf.hwssKey = 'v' + pid + ':' + hue;
    (VEHICLE_CLIPS[C.tag] || []).forEach(function (k) { clipsOf(C[k]).forEach(function (px) { applyTint(px, vf); n++; }); });
    [C].concat(subCharacters(C)).forEach(function (c) {
      var ff = f;
      if (c !== C && C.tag === 'Char3') { ff = kidFilters[pid] || (kidFilters[pid] = new H.P.Filter(undefined, KID_FRAG, { uHue: u })); ff.hwssKey = 'k' + pid + ':' + hue; }
      SHIRT_CLIPS.concat(c === C ? extra : (SUB_EXTRA[C.tag] || [])).forEach(function (k) { clipsOf(c[k]).forEach(function (px) { applyTint(px, ff); n++; }); });
    });
    log('p2', 'P' + pid + ' shirt tinted (' + n + ' clips)');
  }
  function untintShirt(C) {
    var extra = extraClips(C).concat(VEHICLE_CLIPS[C.tag] || []);
    [C].concat(subCharacters(C)).forEach(function (c) {
      SHIRT_CLIPS.concat(c === C ? extra : (SUB_EXTRA[C.tag] || [])).forEach(function (k) {
        clipsOf(c[k]).forEach(function (px) {
          if (px.filters) px.filters = null;
          unbakeTree(px);
          tinted = tinted.filter(function (e) { return e.px !== px; });
        });
      });
    });
  }
  // More clips per character (by tag) beyond the shirt: the config's p2TintExtra.
  var BUILTIN_EXTRA = {};
  // Vehicles in the player's colour (vehicle tint: paint only). Santa: the sleigh (its gold trim stays);
  // Char11 = lawnmower man: the mower body and its broken pieces (not the wheels).
  var VEHICLE_CLIPS = {
    Santa: ['sleighMC', 'brokenSleighMCs'],
    Char11: ['mowerMC', 'bladeCoverMC', 'frontMC', 'rearMC', 'front1MC', 'front2MC', 'front3MC', 'front4MC', 'front5MC', 'rear1MC', 'rear2MC', 'rear3MC', 'rear4MC']
  };
  // sub-characters (Santa's elves): their pants too, not just the shirt
  var SUB_EXTRA = { Santa: ['pelvisMC', 'upperLeg1MC', 'upperLeg2MC', 'upperLeg3MC', 'upperLeg4MC', 'lowerLeg1MC', 'lowerLeg2MC'] };
  function extraClips(C) { return ((cfg.p2TintExtra && cfg.p2TintExtra[C.tag]) || []).concat(BUILTIN_EXTRA[C.tag] || []); }
  // a clip or a list of clips (…MCs) → their pixi roots
  function clipsOf(v) { return (Array.isArray(v) ? v : [v]).map(function (mc) { return mc && mc._pixiSprite; }).filter(Boolean); }
  // P1 wears blue only while someone else plays (solo stays the game's own look)
  function updateP1Tint(s) {
    var C1 = s && s._character;
    if (!C1) return;
    var want = PL.anyJoined();
    if (want && C1.hwssTinted !== s) { try { tintShirt(C1, 1); C1.hwssTinted = s; } catch (e) { log('p2-error', 'P1 shirt: ' + e); } }
    else if (!want && C1.hwssTinted) { try { untintShirt(C1); } catch (e) {} C1.hwssTinted = null; log('p2', 'P1 shirt back to normal'); }
  }

  // ---------- co-op: hide View Replay + Save Replay in the pause / level-complete window ----------
  // Both screens are one window class (fields restartButton, characterButton, replayButton, saveButton,
  // editFavoritesButton, exitButton, cancelButton; accessor disableSave; methods init, buildWindow; panel
  // = this._window with setDimensions(w, h) that adds horizontalSpace/verticalSpace).
  // In a co-op attempt (session.hwssCoop) the replay is P1-only and its upload is blocked, so both
  // buttons go: hidden, removed from button lists (keyboard/pad navigation), lower buttons moved up,
  // panel shortened.
  var SLOT = 30, BUTTONS = ['restartButton', 'characterButton', 'replayButton', 'saveButton', 'editFavoritesButton', 'exitButton', 'cancelButton'];
  function coopNow() { return !!(H.session && H.session.hwssCoop); }
  // 1.99.3: no buildWindow any more (the buttons are made in init); the class is told apart by its
  // RESTART_LEVEL event constant (static)
  function isMenuWindowProto(p) {
    if (!p || !gopd(p, 'disableSave')) return false;
    if (gopd(p, 'buildWindow')) return true;
    var c = gopd(p, 'init') && gopd(p, 'constructor'), C = c && c.value;
    return !!(C && typeof C === 'function' && gopd(C, 'RESTART_LEVEL'));
  }
  // The split-orientation toggle takes View Replay's slot: a real game button (same class/colour/width).
  function splitLabel() {
    if (H.split && H.split.getMonitors && H.split.getMonitors()) {
      var mm = H.split.getModeMon();
      if (H.split.monOneViewEach && H.split.monOneViewEach())   // 2 players: one view per monitor
        // the view nearly fills a 16:9 monitor either way: the real difference is the camera zoom (TheSplitScreenGuy's naming)
        return mm === 'shared' ? 'split: shared screen' : (mm === 'fit' || mm === 'fitv') ? 'split: normal zoom' : 'split: zoomed out';
      return mm === 'fit' ? 'split: letterbox' : mm === 'fitv' ? 'split: letterbox side' : mm === 'shared' ? 'split: shared screen' : 'split: ' + mm;
    }
    if (H.split && H.split.isMulti && H.split.isMulti()) {
      var m4 = H.split.getMode4();
      return m4 === 'p1' ? 'view: p1 only' : m4 === 'full' ? 'split: full view' : m4 === 'shared' ? 'split: shared screen' : 'split: zoomed';
    }
    var m = H.split && H.split.getOrientation ? H.split.getOrientation() : 'horizontal';
    return m === 'p1' ? 'view: p1 only' : m === 'fit' ? 'split: letterbox' : m === 'fitv' ? 'split: letterbox side' : m === 'stretch' ? 'split: stretch' : m === 'shared' ? 'split: shared screen' : 'split: ' + m;
  }
  function addSplitToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot) return null;
    var btn;
    try { btn = new ref.constructor(splitLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'split toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    var setText = function () { try { btn.label = splitLabel(); } catch (e) { try { btn.textField.text = splitLabel(); } catch (e2) {} } };
    btn.addEventListener('mouseUp', function () { H.split.nextOrientation(); setText(); });
    w.hwssSplitToggle = btn;
    return btn;
  }

  // second toggle (Save Replay's slot): shared world / separate worlds, applied from the next (re)start
  function worldLabel() {
    var m = H.W2 && H.W2.getMode ? H.W2.getMode() : 'shared';
    return 'world: ' + (m === 'collide' ? 'shared collide 2s' : m === 'collide10' ? 'shared collide 10s' : m);
  }
  function addWorldToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.W2) return null;
    var btn;
    try { btn = new ref.constructor(worldLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'world toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.W2.toggleMode();
      try { btn.label = worldLabel(); } catch (e) { try { btn.textField.text = worldLabel(); } catch (e2) {} }
    });
    return btn;
  }

  // third toggle (new slot under the world toggle): camera framing rider / level, applies immediately
  function framingLabel() { return 'camera: ' + (H.split && H.split.getFraming ? H.split.getFraming() : 'rider'); }
  function addFramingToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.split || !H.split.toggleFraming) return null;
    var btn;
    try { btn = new ref.constructor(framingLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'framing toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.toggleFraming();
      try { btn.label = framingLabel(); } catch (e) { try { btn.textField.text = framingLabel(); } catch (e2) {} }
    });
    return btn;
  }

  // fourth toggle (slot under the camera toggle, separate worlds only): ghosts on/off, applies immediately
  function ghostLabel() { return 'ghosts: ' + (H.split && H.split.getGhosts && H.split.getGhosts() ? 'on' : 'off'); }
  function addGhostToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.split || !H.split.toggleGhosts || !H.W2 || H.W2.getMode() !== 'separate') return null;
    var btn;
    try { btn = new ref.constructor(ghostLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'ghost toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.toggleGhosts();
      try { btn.label = ghostLabel(); } catch (e) { try { btn.textField.text = ghostLabel(); } catch (e2) {} }
    });
    return btn;
  }

  // views: smooth / fast (P2-P4's views at half rate; split.js), applies immediately
  function rateLabel() { return 'views: ' + (H.split && H.split.getViewRate ? H.split.getViewRate() : 'smooth'); }
  function addViewRateToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.split || !H.split.toggleViewRate) return null;
    var btn;
    try { btn = new ref.constructor(rateLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'views toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.toggleViewRate();
      try { btn.label = rateLabel(); } catch (e) { try { btn.textField.text = rateLabel(); } catch (e2) {} }
    });
    return btn;
  }

  // simple on/off toggles backed by split.js getters (markers: name tags + arrows; spectate after 5 s dead)
  function onOffToggle(name, get, flip) {
    return function (w, slot) {
      var ref = w.restartButton || w.exitButton;
      var getF = typeof get === 'function' ? get : H.split && H.split[get], flipF = typeof flip === 'function' ? flip : function () { H.split[flip](); };
      if (!ref || !slot || !getF) return null;
      var label = function () { return name + ': ' + (getF() ? 'on' : 'off'); }, btn;
      try { btn = new ref.constructor(label(), ref._bgColor, ref._bgWidth); }
      catch (e) { log('p2-error', name + ' toggle: ' + e); return null; }
      btn.x = slot.x; btn.y = slot.y;
      w.addChild(btn); btn.hwssCoopToggle = true;
      btn.addEventListener('mouseUp', function () {
        flipF();
        try { btn.label = label(); } catch (e) { try { btn.textField.text = label(); } catch (e2) {} }
      });
      return btn;
    };
  }
  var addMarkersToggle = onOffToggle('markers', 'getMarkers', 'toggleMarkers');
  // spectate: off → leader (dead 5 s: watch the leader) → remove dead (dead 2 s: view taken off screen)
  var SPEC_LABEL = { off: 'off', leader: 'leader', remove: 'remove dead' };
  function specLabel() { return 'spectate: ' + (SPEC_LABEL[H.split.getSpectateMode()] || 'off'); }
  function addSpectateToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.split || !H.split.nextSpectate) return null;
    var btn;
    try { btn = new ref.constructor(specLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'spectate toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.nextSpectate();
      try { btn.label = specLabel(); } catch (e) { try { btn.textField.text = specLabel(); } catch (e2) {} }
    });
    return btn;
  }
  // win scoreboard beside the pause/complete menu (saved; default on)
  var SCORE_KEY = 'hwss.scoreboard', scoreCache = null;
  PL.getScoreboard = function () {
    if (scoreCache == null) { try { scoreCache = window.localStorage.getItem(SCORE_KEY) !== 'off'; } catch (e) { scoreCache = true; } }
    return scoreCache;
  };
  PL.toggleScoreboard = function () {
    scoreCache = !PL.getScoreboard();
    try { window.localStorage.setItem(SCORE_KEY, scoreCache ? 'on' : 'off'); } catch (e) {}
    log('p2', 'scoreboard -> ' + (scoreCache ? 'on' : 'off'));
    return scoreCache;
  };
  var addScoreToggle = onOffToggle('scoreboard', PL.getScoreboard, PL.toggleScoreboard);
  // draw unchanging level art once into a picture (faster on levels made of thousands of pieces)
  function addArtCacheToggle(w, slot) {
    if (!H.split || !H.split.getArtCache) return null;
    return onOffToggle('cache static art', H.split.getArtCache, H.split.toggleArtCache)(w, slot);
  }
  // "monitors: 1" (normal window) / "monitors: 2" (window over two monitors, one player per monitor);
  // only offered with 2+ monitors
  function monLabel() { return 'monitors: ' + (H.split.getMonitorsWanted() ? '2' : '1'); }
  function addMonitorsToggle(w, slot) {
    if (!H.split || !H.split.monitorsAvailable || !H.split.monitorsAvailable()) return null;
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot) return null;
    var btn;
    try { btn = new ref.constructor(monLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'monitors toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.toggleMonitors();
      try { btn.label = monLabel(); } catch (e) { try { btn.textField.text = monLabel(); } catch (e2) {} }
    });
    return btn;
  }

  // letterbox bars decoration: black / blur / color / art (split.js), applies immediately
  function barsLabel() { return 'bars: ' + (H.split && H.split.getBarStyle ? H.split.getBarStyle() : 'black'); }
  function addBarsToggle(w, slot) {
    var ref = w.restartButton || w.exitButton;
    if (!ref || !slot || !H.split || !H.split.nextBarStyle) return null;
    var btn;
    try { btn = new ref.constructor(barsLabel(), ref._bgColor, ref._bgWidth); }
    catch (e) { log('p2-error', 'bars toggle: ' + e); return null; }
    btn.x = slot.x; btn.y = slot.y;
    w.addChild(btn); btn.hwssCoopToggle = true;
    btn.addEventListener('mouseUp', function () {
      H.split.nextBarStyle();
      try { btn.label = barsLabel(); } catch (e) { try { btn.textField.text = barsLabel(); } catch (e2) {} }
    });
    return btn;
  }

  var openMenu = null;                                   // the last co-op pause/complete window (scoreboard sits beside it)
  function trimMenu(w) {
    if (coopNow()) openMenu = w;
    if (!coopNow() || w.hwssTrim) return;
    var replaySlot = w.replayButton ? { x: w.replayButton.x, y: w.replayButton.y } : null;
    var saveSlot = w.saveButton ? { x: w.saveButton.x, y: w.saveButton.y } : null;
    var hide = ['replayButton', 'saveButton'].map(function (k) { return w[k]; }).filter(function (b) { return b && b.visible !== false; });
    if (!hide.length) return;
    try { w.disableSave = true; } catch (e) {}
    Object.keys(w).forEach(function (k) {
      var v = w[k];
      if (Array.isArray(v)) hide.forEach(function (b) { var i = v.indexOf(b); if (i >= 0) v.splice(i, 1); });
    });
    hide.forEach(function (b) { b.visible = false; });
    // Two columns: the game's own buttons on the left (packed up into the hidden replay slots), every co-op
    // toggle in a new column on the right; the panel widens by that column and is re-centred.
    var ys = hide.map(function (b) { return b.y; });
    BUTTONS.forEach(function (k) {
      var b = w[k];
      if (!b || hide.indexOf(b) >= 0) return;
      var above = ys.filter(function (y) { return y < b.y; }).length;
      if (above) b.y -= SLOT * above;
    });
    var ref = w.restartButton || w.exitButton;
    var bw = (ref && (ref._bgWidth || ref.width)) || 130, GAP = 14;
    var colX = (ref ? ref.x : (replaySlot || saveSlot).x) + bw + GAP, top = ref ? ref.y : (replaySlot || saveSlot).y;
    var makers = [addSplitToggle, addWorldToggle];
    if (H.W2 && H.W2.getMode() === 'separate') makers.push(addGhostToggle);
    if (H.split && H.split.hasBars && H.split.hasBars()) makers.push(addBarsToggle);
    makers.push(addViewRateToggle);                     // views: smooth / fast
    makers.push(addArtCacheToggle);                     // cache static art: on / off
    makers.push(addMarkersToggle);                      // markers: name tags + off-screen arrows
    makers.push(addSpectateToggle);                     // spectate the leader after 5 s dead
    makers.push(addScoreToggle);                        // win scoreboard right of this menu
    makers.push(addMonitorsToggle);                     // window over all monitors (2+ monitors only)
    // toggles fill a column as tall as the game's own buttons, then a second one (the win screen sits lower
    // than the pause screen and a 9-high column ran off the bottom)
    var leftRows = 0;
    BUTTONS.forEach(function (k) { var b = w[k]; if (b && hide.indexOf(b) < 0 && b.visible !== false) leftRows++; });
    // at most two toggle columns (a third would make the panel wider than the screen)
    var perCol = Math.max(5, leftRows, Math.ceil(makers.length / 2)), n = 0;
    makers.forEach(function (make) {
      var col = Math.floor(n / perCol), row = n % perCol;
      if (make(w, { x: colX + col * (bw + GAP), y: top + SLOT * row })) n++;
    });
    var cols = Math.max(1, Math.ceil(n / perCol));
    // things right of the button column (the full-screen icon) move to the new right edge
    var widen = (bw + GAP) * cols, edge = ref ? ref.x + bw : colX;
    (w.children || []).forEach(function (c) {
      if (!c || c === w._window || c.x < edge || c.y < top - SLOT) return;
      if (BUTTONS.some(function (k) { return w[k] === c; }) || c.hwssCoopToggle) return;
      c.x += widen;
    });
    // height: the replay slots are gone; grow again only if the toggle column is taller than the buttons
    var leftBottom = top;
    BUTTONS.forEach(function (k) { var b = w[k]; if (b && hide.indexOf(b) < 0 && b.visible !== false && b.y > leftBottom) leftBottom = b.y; });
    var rightBottom = top + SLOT * (Math.min(n, perCol) - 1), extraRows = Math.max(0, Math.ceil((rightBottom - leftBottom) / SLOT));
    w.hwssTrim = SLOT * (hide.length - extraRows);    // negative = panel grows
    // the bottom-row icons (sound, full screen) follow the panel's new bottom edge
    (w.children || []).forEach(function (c) {
      if (!c || c === w._window || c.hwssCoopToggle || BUTTONS.some(function (k) { return w[k] === c; })) return;
      if (c.y > leftBottom + SLOT * 0.5 && c.y > rightBottom + SLOT * 0.5 - w.hwssTrim) c.y -= w.hwssTrim;
    });
    w.hwssWiden = widen;
    w.hwssLayout = true;
    shrinkPanel(w);
    log('p2', 'co-op menu: ' + (cols + 1) + ' columns, ' + n + ' toggles, hid ' + hide.length + ' replay button(s)');
  }
  function shrinkPanel(w) {
    var win = w._window;
    if (win && H.N) H.N.alias(win);                     // 1.99.3: setDimensions = $$Yh (names.js)
    if (!w.hwssLayout || !win || typeof win.setDimensions !== 'function') return;
    var hs = win.horizontalSpace || 0, vs = win.verticalSpace || 0;
    if (win.hwssTrimmedHeight !== win.height || win.hwssTrimmedWidth !== win.width) {   // not yet since the last layout
      win.setDimensions(win.width - hs + (w.hwssWiden || 0), win.height - vs - (w.hwssTrim || 0));
      win.hwssTrimmedHeight = win.height; win.hwssTrimmedWidth = win.width;
    }
    // The panel frame (_window) contains this menu: move the FRAME so the wider panel stays centred where the
    // game centred the narrow one (re-applied if the game lays it out again).
    var want = (win.hwssBaseX == null ? win.x : win.hwssBaseX) - (w.hwssWiden || 0) / 2;
    if (win.hwssBaseX == null || Math.abs(win.x - want) > 0.5) { win.hwssBaseX = win.x; win.x = win.x - (w.hwssWiden || 0) / 2; }
    // The menu's own light background box keeps the old narrow size and would stick out below the frame;
    // the frame's inner area already covers the new size, so that box is not drawn.
    // (It is the big shape inside the menu's Animate clip w.mc, next to the title/author/rating texts.)
    var mc = w.mc && w.mc._pixiSprite;
    (mc && mc.children || []).forEach(function (c) {
      if (c.hwssBgHidden || typeof c.text === 'string') return;
      var b = c.getBounds();
      if (b.width >= 200 && b.height >= 200) { c.renderable = false; c.hwssBgHidden = true; }
    });
  }
  var menuHooked = false;
  function hookMenuClass(proto) {
    if (menuHooked) return;
    menuHooked = true;
    ['init', 'buildWindow'].forEach(function (n) {
      var orig = proto[n];
      if (typeof orig !== 'function') return;
      proto[n] = function () {
        var r = orig.apply(this, arguments);
        try { if (n === 'init') trimMenu(this); else if (this.hwssTrim) shrinkPanel(this); } catch (e) { log('p2-error', 'menu trim: ' + e); }
        return r;
      };
    });
    log('p2', 'pause/complete menu class hooked');
  }
  // Find the class once the game is running: scan game-module exports (classes only, already loaded).
  var menuScanTries = 0;
  function findMenuClass() {
    if (menuHooked || !H.req || !H.renderer) return false;
    var vendor = H.vendorIds();
    for (var id in H.req.m) {
      if (vendor.has(id) || /hwss/.test(id)) continue;
      var ex; try { ex = H.req(id); } catch (e) { continue; }
      if (!ex || typeof ex !== 'object') continue;
      for (var k in ex) {
        var C; try { C = ex[k]; } catch (e) { continue; }
        if (typeof C === 'function' && isMenuWindowProto(C.prototype)) { hookMenuClass(C.prototype); return true; }
      }
    }
    return false;
  }
  // Fallback: take the class from an open window on screen (co-op only, every 500 ms until hooked).
  var menuSeenCheck = 0;
  function findOpenMenu(px, d) {
    if (!px || d > 9) return null;
    var f = px._flashSprite;
    if (f && isMenuWindowProto(Object.getPrototypeOf(f))) return f;
    for (var i = 0; px.children && i < px.children.length; i++) { var r = findOpenMenu(px.children[i], d + 1); if (r) return r; }
    return null;
  }
  function checkOpenMenu() {
    if (menuHooked || !coopNow() || !H.stage) return;
    var now = performance.now();
    if (now - menuSeenCheck < 500) return;
    menuSeenCheck = now;
    var w = findOpenMenu(H.stage, 0);
    if (w) { hookMenuClass(Object.getPrototypeOf(w)); trimMenu(w); }
  }
  // ---------- Box2D shape limit ----------
  // b2Settings.b2_maxProxies (1024) caps the shapes in ONE world. Busy levels use nearly all of it
  // (Prehistoric Pilgrim: 1020 with 3 riders), so the 4th shared-world rider ran out mid-create and the
  // half-built rider made every physics step throw (all riders froze). Broadphases size their pools from
  // this value when a world is made, so raising it before the level's world is created is enough.
  var proxyTries = 0;
  (function raiseProxyLimit() {
    var want = cfg.maxProxies || 4096, done = false;
    if (H.req && H.req.m) {
      for (var id in H.req.m) {
        var ex; try { ex = H.req(id); } catch (e) { continue; }
        if (!ex || typeof ex !== 'object') continue;
        for (var k in ex) {
          var v; try { v = ex[k]; } catch (e) { continue; }
          if (!v || (typeof v !== 'function' && typeof v !== 'object')) continue;
          var d = gopd(v, 'b2_maxProxies');
          if (d && typeof d.value === 'number') {
            // 1.99.3: write the REAL (renamed) static ($$HX); this object has no alias accessor, so writing
            // the old name only made an unused property and worlds kept 1024 (Prehistoric Pilgrim P4 bug)
            var realK = (H.N && H.N.real && H.N.real('b2_maxProxies')) || 'b2_maxProxies';
            var key = Object.prototype.hasOwnProperty.call(v, realK) ? realK : 'b2_maxProxies';
            if (d.value < want) {
              v[key] = want;
              log('p2', 'Box2D shape limit ' + d.value + ' -> ' + v[key] + ' (' + key + '; room for 4 riders in busy levels)');
            }
            done = true;
          }
        }
        if (done) break;
      }
    }
    if (!done && ++proxyTries < 60) setTimeout(raiseProxyLimit, 1000);
  })();
  (function pollMenuClass() {
    var ok = false;
    try { ok = findMenuClass(); } catch (e) { log('p2-error', 'menu class scan: ' + e); }
    if (!ok && !menuHooked && ++menuScanTries < 120) setTimeout(pollMenuClass, 2000);
  })();

  // ---------- main menu detection ----------
  // The main menu has no physics running. Find the main-menu screen object (its class has
  // createButtons + openLevelBrowser) via the Pixi tree (node._flashSprite = game object), and treat
  // "main menu" as: that screen is visible and at least one of its menu buttons (class with addArrow)
  // is visible (sub-menus hide the buttons).
  var menuCheckAt = 0;
  // 1.99.3: createButtons = $$ex (names.js); openLevelBrowser is not mapped, so the screen is also told apart by its
  // readable button fields (playBtn, browseBtn) and its buttons list
  function isMenuScreen(o) {
    var p = o && Object.getPrototypeOf(o);
    if (!p) return false;
    if (gopd(p, 'createButtons') && gopd(p, 'openLevelBrowser')) return true;
    return !!(H.N && findOwn(p, H.N.real('createButtons')) && o.playBtn && o.browseBtn && Array.isArray(o.buttons));
  }
  function findOwn(p, n) { for (; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.prototype.hasOwnProperty.call(p, n)) return true; return false; }
  function findMainMenu(px, d) {
    if (!px || d > 7) return null;
    if (px._flashSprite && isMenuScreen(px._flashSprite)) return px;
    for (var i = 0; px.children && i < px.children.length; i++) { var r = findMainMenu(px.children[i], d + 1); if (r) return r; }
    return null;
  }
  function checkMainMenu() {
    var now = performance.now();
    if (now - menuCheckAt < 500) return;
    menuCheckAt = now;
    var at = false;
    if (H.stage && !H.inLevel) {
      var mm = findMainMenu(H.stage, 0);
      if (mm && mm.worldVisible) {
        at = mm.children.some(function (c) {
          var f = c._flashSprite, p = f && Object.getPrototypeOf(f);
          var mo = mm._flashSprite;
          return p && (p.addArrow || (mo && Array.isArray(mo.buttons) && mo.buttons.indexOf(f) >= 0)) && c.worldVisible;
        });
      }
    }
    if (at !== PL.atMainMenu) { PL.atMainMenu = at; log('p2', at ? 'at main menu' : 'left main menu'); }
    // the main menu with nothing open on top of it (Featured Levels and the other sub-menus open over the
    // menu without hiding its buttons): the Monitors button shows only then
    var clean = at;
    if (clean) {
      var o = mm && mm._flashSprite;
      // Options, Credits etc. dim the menu's own buttons (alpha 0.25) while they are open
      var play = o && o.playBtn && o.playBtn._pixiSprite;
      if (play && play.worldAlpha < 0.9) clean = false;
    }
    if (clean) {
      clean = !(o && Object.keys(o).some(function (k) {
        if (!/(Menu|Browser|Window|Popup|Prompt|Dialog)$/.test(k)) return false;
        var v = o[k], px = v && typeof v === 'object' && v._pixiSprite;
        if (!px || !px.worldVisible) return false;
        for (var q = px, i = 0; q && i < 40; i++, q = q.parent) if (q === H.stage) return true;
        return false;
      }));
    }
    PL.atMainMenuClean = clean;
  }

  // ---------- join/leave hints at the bottom of the main menu (one line per player with a pad) ----------
  var hint = null;
  function updateHint() {
    var lines = [];
    if (PL.atMainMenu && PL.autoRide) lines.push('Auto-Ride On: Everyone Full Throttle (F1 To Stop)');
    if (PL.atMainMenu && PL.p1Delay) lines.push('P1: Delay ' + PL.p1Delay + 's (F8 To Remove)');
    if (PL.atMainMenu && PL.p1Keyboard) lines.push('P1: Keyboard + Mouse (F9 To Use A Controller)   Controller: ' + (PL.controllerOwner() ? 'P' + PL.controllerOwner() : 'none') + ' (F10)');
    if (PL.atMainMenu) {
      LIST.forEach(function (p) {
        // (no character name here any more: players pick on the character select screen; TheSplitScreenGuy's choice)
        if (p.hasPad && !p.bot && p.joined) lines.push(p.name + ': Select+Start To Leave');
        else if (p.bot && p.joined) lines.push(p.name + ': Test Rider' + (p.noDelay ? ', No Delay' : '') + ' (' + KEY_OF[p.id] + (p.hasPad ? ' For Pad' : ' To Remove') + ')');
      });
      // a spare controller is connected: whoever presses Start on it joins as the next free player
      var next = PL.spares ? freeSlot() : null;
      if (next) lines.push(next.name + ': Press Start To Join');
    }
    var show = lines.length > 0 && !(dbg && dbgHidden());   // F2 hides these lines (recording)
    if (!hint) {
      if (!show || !document.body) return;
      hint = document.createElement('div');
      hint.id = 'hwss-p2-hint';
      hint.style.cssText = 'position:fixed;left:50%;bottom:4vh;transform:translateX(-50%);z-index:2147483647;' +
        'pointer-events:none;user-select:none;white-space:pre;text-align:center;line-height:1.25;' +
        'font:900 3.4vh "Arial Black",Arial,sans-serif;color:#fff;letter-spacing:0.05em;' +
        'text-shadow:-2px -2px 0 #1b2a4a,2px -2px 0 #1b2a4a,-2px 2px 0 #1b2a4a,2px 2px 0 #1b2a4a,0 3px 6px rgba(0,0,0,.5);';
      document.body.appendChild(hint);
    }
    var text = lines.join('\n');
    if (hint.textContent !== text) hint.textContent = text;
    // centred under the game area (monitor mode: on P1's monitor, not across both)
    var g = H.renderer ? gameRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var size = Math.round(g.height * (lines.length > 1 ? 0.026 : 0.034)) + 'px';
    if (hint.style.fontSize !== size) hint.style.fontSize = size;
    var hl = Math.round(g.left + g.width / 2) + 'px', hb = Math.round(window.innerHeight - (g.top + g.height) + g.height * 0.04) + 'px';
    if (hint.style.left !== hl) hint.style.left = hl;
    if (hint.style.bottom !== hb) hint.style.bottom = hb;
    var disp = show ? 'block' : 'none';
    if (hint.style.display !== disp) hint.style.display = disp;
  }

  // ---------- "Monitors: 1 / 2" button on the main menu (left side; only with 2+ monitors) ----------
  var monBtn = null;
  function updateMonitorsButton() {
    var show = !!(PL.atMainMenuClean && H.split && H.split.monitorsAvailable && H.split.monitorsAvailable() && H.renderer);
    if (!show) { if (monBtn) monBtn.style.display = 'none'; return; }
    if (!monBtn) {
      if (!document.body) return;
      monBtn = document.createElement('div');
      monBtn.id = 'hwss-monitors-btn';
      monBtn.style.cssText = 'position:fixed;z-index:2147483646;cursor:pointer;user-select:none;white-space:nowrap;' +
        'font-family:"Arial Black",Arial,sans-serif;font-weight:900;letter-spacing:0.04em;color:#fff;' +
        'background:rgba(20,30,55,.78);border:2px solid rgba(255,255,255,.35);border-radius:0.45em;padding:0.35em 0.8em;' +
        'box-shadow:0 3px 8px rgba(0,0,0,.35);';
      // the game must not see this click (it would land on the menu behind)
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
        monBtn.addEventListener(t, function (e) { e.stopPropagation(); if (t === 'click') H.split.toggleMonitors(); }, true);
      });
      monBtn.addEventListener('mouseenter', function () { monBtn.style.background = 'rgba(40,70,130,.9)'; });
      monBtn.addEventListener('mouseleave', function () { monBtn.style.background = 'rgba(20,30,55,.78)'; });
      document.body.appendChild(monBtn);
    }
    var r = gameRect(), fs = Math.round(r.height * 0.032);
    var pos = [Math.round(r.left + r.width * 0.012), Math.round(r.top + r.height * 0.83), fs].join(',');
    if (monBtn.hwssPos !== pos) {
      monBtn.hwssPos = pos;
      monBtn.style.left = pos.split(',')[0] + 'px'; monBtn.style.top = pos.split(',')[1] + 'px'; monBtn.style.fontSize = fs + 'px';
    }
    var text = 'Monitors: ' + (H.split.getMonitorsWanted() ? '2' : '1');
    if (monBtn.textContent !== text) monBtn.textContent = text;
    if (monBtn.style.display !== 'block') monBtn.style.display = 'block';
  }

  // ---------- "Happy Wheels Split Screen v1.0" on the main menu (TheSplitScreenGuy's request) ----------
  // On the same line as the game's own version text ("v 1.99.3-s", bottom left), just to its right, in the
  // same font and size; display only. H.version comes from hwss.js.
  var verLabel = null, gameVer = null, gameVerAt = 0;
  function findGameVersionText() {
    var now = performance.now();
    if (gameVer && gameVer.worldVisible && gameVer.parent) return gameVer;
    if (now - gameVerAt < 1000) return null;
    gameVerAt = now; gameVer = null;
    (function walk(o, d) {
      if (!o || d > 14 || gameVer) return;
      if (typeof o.text === 'string' && /^v ?\d+\.\d+/.test(o.text) && o.worldVisible) { gameVer = o; return; }
      (o.children || []).forEach(function (c) { walk(c, d + 1); });
    })(H.stage, 0);
    return gameVer;
  }
  function updateVersionLabel() {
    var show = !!(PL.atMainMenuClean && H.renderer);
    if (!show) { if (verLabel) verLabel.style.display = 'none'; return; }
    if (!verLabel) {
      if (!document.body) return;
      verLabel = document.createElement('div');
      verLabel.id = 'hwss-version';
      verLabel.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;user-select:none;white-space:nowrap;' +
        'font-family:"Clarendon LT Std",Georgia,serif;font-weight:normal;color:#fff;line-height:1;';
      verLabel.textContent = 'Happy Wheels Split Screen v' + (H.version || '1.0');
      document.body.appendChild(verLabel);
    }
    // the game's text in 900x500 game coordinates (fallback: where it sits in 1.99.3)
    var gv = findGameVersionText(), b = { x: 7, y: 482, width: 57, height: 14 }, size = 12;
    if (gv) { try { b = gv.getBounds(); size = (gv.style && parseFloat(gv.style.fontSize)) || 12; } catch (e) {} }
    // a little under the game text's size: DOM text renders its glyphs slightly larger than the game's canvas
    // text at the same nominal size, and the label must not look bigger (TheSplitScreenGuy's request)
    var r = gameRect(), k = r.width / 900, fs = Math.max(8, Math.round(size * k * 0.92));
    var pos = [Math.round(r.left + (b.x + b.width + 7) * k), Math.round(r.top + (b.y + (b.height - size) / 2) * k), fs].join(',');
    if (verLabel.hwssPos !== pos) {
      verLabel.hwssPos = pos;
      verLabel.style.left = pos.split(',')[0] + 'px'; verLabel.style.top = pos.split(',')[1] + 'px'; verLabel.style.fontSize = fs + 'px';
    }
    if (verLabel.style.display !== 'block') verLabel.style.display = 'block';
  }

  // ---------- Back button on the character select screen (TheSplitScreenGuy's request) ----------
  // The game's screen has no way back. Top left, styled like the game's own "back" buttons. Mouse, pad
  // cursors (A over it) and P1's stick + A can press it. world2.js W2.csBack() removes the screen and
  // returns to the main menu; our extra pedestals and pending picks are cleared first.
  var csBackBtn = null;
  function csBackPress() {
    if (!(H.W2 && H.W2.csOpen && H.W2.csOpen())) return;
    var scr = cs.scr;
    try { if (scr) restorePedestals(scr); } catch (e) {}
    cs.pending = null; cs.p1Pick = null;
    LIST.forEach(function (p) { p.charPick = null; });
    if (!H.W2.csBack()) log('p2-error', 'character select back failed');
  }
  function updateCsBackButton() {
    var show = !!(cs.scr && cs.started !== cs.scr && H.renderer && H.W2 && H.W2.csOpen && H.W2.csOpen());
    if (!show) { if (csBackBtn) csBackBtn.style.display = 'none'; return; }
    if (!csBackBtn) {
      if (!document.body) return;
      csBackBtn = document.createElement('div');
      csBackBtn.id = 'hwss-cs-back';
      csBackBtn.setAttribute('data-hwss-btn', 'csback');
      csBackBtn.style.cssText = 'position:fixed;z-index:2147483646;cursor:pointer;user-select:none;white-space:nowrap;' +
        'font-family:"Arial Black",Arial,sans-serif;font-weight:900;color:#3a3f47;' +
        'background:linear-gradient(#f2f4f6,#c4c9d0);border:1px solid #8d939b;border-radius:0.3em;padding:0.25em 0.75em;' +
        'box-shadow:0 2px 4px rgba(0,0,0,.35);';
      csBackBtn.textContent = '◀ back';
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) { csBackBtn.addEventListener(t, function (e) { e.stopPropagation(); }, true); });
      csBackBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var now = performance.now();
        if (csBackBtn.hwssLast && now - csBackBtn.hwssLast < 250) return;   // one press = one action
        csBackBtn.hwssLast = now;
        csBackPress();
      }, true);
      csBackBtn.addEventListener('mouseenter', function () { csBackBtn.style.background = 'linear-gradient(#ffffff,#d6dae0)'; });
      csBackBtn.addEventListener('mouseleave', function () { csBackBtn.style.background = 'linear-gradient(#f2f4f6,#c4c9d0)'; });
      document.body.appendChild(csBackBtn);
    }
    var r = gameRect(), fs = Math.round(r.height * 0.03);
    var pos = [Math.round(r.left + r.width * 0.012), Math.round(r.top + r.height * 0.022), fs].join(',');
    if (csBackBtn.hwssPos !== pos) {
      csBackBtn.hwssPos = pos;
      csBackBtn.style.left = pos.split(',')[0] + 'px'; csBackBtn.style.top = pos.split(',')[1] + 'px'; csBackBtn.style.fontSize = fs + 'px';
    }
    if (csBackBtn.style.display !== 'block') csBackBtn.style.display = 'block';
  }
  // a click on one of our buttons (data-hwss-btn) at page coordinates; true if there was one
  function clickOurButtonAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.getAttribute || !el.getAttribute('data-hwss-btn')) return false;
    mc.synth = true;
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })); } finally { mc.synth = false; }
    return true;
  }

  // ---------- main menu checkbox: player cursors in menus on / off (TheSplitScreenGuy's request; saved, default on) ----------
  // Off = menus behave as before the cursor feature: no P2-P4 cursors, P1 keeps the stock pointer. The pause
  // and level-complete screens keep their cursors either way. Shown on the bare main menu while a controller
  // is connected, above the Monitors button. P1's stick + A can click it too (data-hwss-btn).
  var MC_KEY = 'hwss.menuCursors', mcCache = null, curBtn = null;
  PL.getMenuCursors = function () {
    if (mcCache === null) { var v = null; try { v = window.localStorage.getItem(MC_KEY); } catch (e) {} mcCache = v === 'off' ? false : v === 'on' ? true : cfg.menuCursors !== false; }
    return mcCache;
  };
  PL.toggleMenuCursors = function () {
    mcCache = !PL.getMenuCursors();
    try { window.localStorage.setItem(MC_KEY, mcCache ? 'on' : 'off'); } catch (e) {}
    log('p2', 'player cursors in menus -> ' + (mcCache ? 'on' : 'off'));
    return mcCache;
  };
  function updateCursorsCheckbox() {
    var anyPad = PL.p1Pad != null || PL.spares > 0 || PL.anyJoined();
    var show = !!(PL.atMainMenuClean && anyPad && H.renderer);
    if (!show) { if (curBtn) curBtn.style.display = 'none'; return; }
    if (!curBtn) {
      if (!document.body) return;
      curBtn = document.createElement('div');
      curBtn.id = 'hwss-cursors-toggle';
      curBtn.setAttribute('data-hwss-btn', 'cursors');
      curBtn.style.cssText = 'position:fixed;z-index:2147483646;cursor:pointer;user-select:none;white-space:nowrap;' +
        'font-family:"Arial Black",Arial,sans-serif;font-weight:900;letter-spacing:0.04em;color:#fff;' +
        'background:rgba(20,30,55,.78);border:2px solid rgba(255,255,255,.35);border-radius:0.45em;padding:0.35em 0.8em;' +
        'box-shadow:0 3px 8px rgba(0,0,0,.35);';
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) { curBtn.addEventListener(t, function (e) { e.stopPropagation(); }, true); });
      curBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var now = performance.now();
        if (curBtn.hwssLast && now - curBtn.hwssLast < 250) return;   // one press = one toggle
        curBtn.hwssLast = now;
        PL.toggleMenuCursors();
      }, true);
      curBtn.addEventListener('mouseenter', function () { curBtn.style.background = 'rgba(40,70,130,.9)'; });
      curBtn.addEventListener('mouseleave', function () { curBtn.style.background = 'rgba(20,30,55,.78)'; });
      document.body.appendChild(curBtn);
    }
    var r = gameRect(), fs = Math.round(r.height * 0.032), monShown = !!(monBtn && monBtn.style.display === 'block');
    var pos = [Math.round(r.left + r.width * 0.012), Math.round(r.top + r.height * (monShown ? 0.745 : 0.83)), fs].join(',');
    if (curBtn.hwssPos !== pos) {
      curBtn.hwssPos = pos;
      curBtn.style.left = pos.split(',')[0] + 'px'; curBtn.style.top = pos.split(',')[1] + 'px'; curBtn.style.fontSize = fs + 'px';
    }
    var text = (PL.getMenuCursors() ? '☑' : '☐') + ' Player Cursors';
    if (curBtn.textContent !== text) curBtn.textContent = text;
    if (curBtn.style.display !== 'block') curBtn.style.display = 'block';
  }

  // ---------- "P2 PAUSE" at the top while a co-op game is paused (whoever pressed Start; else P1) ----------
  var pauseTag = null;
  function updatePauseTag() {
    var s = H.session, on = !!(s && H.inLevel && s.paused && !s.hwssLevelDone && s.hwssCoop);
    if (!on) { PL.pausedBy = 0; if (pauseTag) pauseTag.style.display = 'none'; return; }
    if (!pauseTag) {
      if (!document.body) return;
      pauseTag = document.createElement('div');
      pauseTag.id = 'hwss-pause-tag';
      pauseTag.style.cssText = 'position:fixed;transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;user-select:none;' +
        'white-space:nowrap;font-family:"Arial Black",Arial,sans-serif;font-weight:900;letter-spacing:0.06em;paint-order:stroke fill;';
      document.body.appendChild(pauseTag);
    }
    var pid = PL.pausedBy || 1, r = H.renderer && H.renderer.view && gameRect();
    if (r) {
      var fs = Math.round(r.height * 0.06);
      pauseTag.style.left = (r.left + r.width / 2) + 'px'; pauseTag.style.top = (r.top + r.height * 0.07) + 'px';
      pauseTag.style.fontSize = fs + 'px';
      pauseTag.style.webkitTextStroke = Math.max(2, Math.round(fs * 0.08)) + 'px #1b2a4a';
      pauseTag.style.textShadow = '0 ' + Math.round(fs * 0.08) + 'px ' + Math.round(fs * 0.16) + 'px rgba(0,0,0,.45)';
    }
    var text = 'P' + pid + ' PAUSE';
    if (pauseTag.textContent !== text) { pauseTag.textContent = text; pauseTag.style.color = colorOf(pid); }
    pauseTag.style.display = 'block';
  }

  // ---------- "P4 Wins!" banner on the level-complete screen (co-op attempts only) ----------
  var banner = null;
  // co-op wins this play session (split.js counts each finished co-op attempt); cleared when everyone left
  var wins = {};
  PL.addWin = function (pid) { wins[pid] = (wins[pid] || 0) + 1; log('p2', 'win tally: ' + JSON.stringify(wins)); };
  PL.wins = function () { return wins; };
  // page rectangle of the game's 900x500 area (in monitor mode: fitted into P1's monitor)
  function gameRect(mi) {
    var g = H.gameRect && H.gameRect(mi);
    if (g) return g;
    var b = H.renderer.view.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }
  function colorOf(pid) { var h = hueOf(pid); return typeof h === 'number' ? 'hsl(' + h + ',85%,' + (h > 40 && h < 70 ? 52 : 58) + '%)' : '#fff'; }
  function updateWinBanner() {
    var s = H.session;
    var w = s && H.inLevel && s.hwssLevelDone && s.hwssCoop && s.hwssWinner;
    var pid = w ? +String(w).slice(1) : 0;
    if (!banner) {
      if (!pid || !document.body) return;
      banner = document.createElement('div');
      banner.id = 'hwss-win-banner';
      banner.style.cssText = 'position:fixed;transform:translate(-50%,-50%);z-index:2147483647;line-height:1;' +
        'pointer-events:none;user-select:none;white-space:nowrap;font-family:"Arial Black",Arial,sans-serif;' +
        'font-weight:900;letter-spacing:0.04em;paint-order:stroke fill;';
      document.body.appendChild(banner);
    }
    // Placed on the level-complete window's empty grey strip, just under the time in the "VICTORY" arch:
    // centre at 25.5% of the game's height (measured on the 900x500 stage), sized from the canvas.
    if (pid && H.renderer && H.renderer.view) {
      var r = gameRect(), fs = Math.round(r.height * 0.042);
      var pos = [r.left + r.width / 2, r.top + r.height * 0.255, fs].join(',');
      if (banner.hwssPos !== pos) {
        banner.hwssPos = pos;
        banner.style.left = (r.left + r.width / 2) + 'px';
        banner.style.top = (r.top + r.height * 0.255) + 'px';
        banner.style.fontSize = fs + 'px';
        banner.style.webkitTextStroke = Math.max(2, Math.round(fs * 0.07)) + 'px #1b2a4a';
        banner.style.textShadow = '0 ' + Math.round(fs * 0.08) + 'px ' + Math.round(fs * 0.16) + 'px rgba(0,0,0,.45)';
      }
    }
    if (pid) {
      // "P3 Wins!" (the win tally is on the scoreboard beside the menu)
      var key = 'P' + pid;
      if (banner.hwssKey !== key) {
        banner.hwssKey = key;
        banner.textContent = 'P' + pid + ' Wins!';
        banner.style.color = colorOf(pid);
      }
    }
    var disp = pid ? 'block' : 'none';
    if (banner.style.display !== disp) banner.style.display = disp;
  }

  // ---------- win scoreboard: a vertical list just right of the pause / level-complete menu ----------
  var board = null;
  function updateScoreboard() {
    var s = H.session, w = openMenu, px = w && w._pixiSprite, win = w && w._window && w._window._pixiSprite;
    var onStage = false;                                 // a closed menu is detached (worldVisible alone stays true)
    for (var o = px, i = 0; o && i < 40; i++, o = o.parent) if (o === H.stage) { onStage = true; break; }
    var on = !!(PL.getScoreboard() && s && H.inLevel && s.hwssCoop && onStage && px.worldVisible && win && H.renderer && H.renderer.view);
    if (!on) { if (board) board.style.display = 'none'; return; }
    if (!board) {
      if (!document.body) return;
      board = document.createElement('div');
      board.id = 'hwss-scoreboard';
      board.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;user-select:none;white-space:nowrap;' +
        'font-family:"Arial Black",Arial,sans-serif;font-weight:900;letter-spacing:0.05em;line-height:1.25;' +
        'background:rgba(20,30,55,.72);border:2px solid rgba(255,255,255,.25);border-radius:0.4em;padding:0.45em 0.8em;';
      document.body.appendChild(board);
    }
    // the menu frame's right edge, renderer pixels → page pixels
    // menu bounds are in the game's 900x500 coordinates (its stage), drawn into the game area
    var r = gameRect(), sw = 900, sh = 500, b = win.getBounds();
    var fx = r.width / sw, fy = r.height / sh, fs = Math.round(r.height * 0.032);
    var pos = [Math.round(r.left + (b.x + b.width) * fx + fs * 0.8), Math.round(r.top + b.y * fy), fs].join(',');
    if (board.hwssPos !== pos) {
      var p = pos.split(',');
      board.hwssPos = pos;
      board.style.left = p[0] + 'px'; board.style.top = p[1] + 'px'; board.style.fontSize = fs + 'px';
    }
    var ids = [1].concat(PL.joinedIds()), key = ids.map(function (i) { return i + ':' + (wins[i] || 0); }).join(',');
    if (board.hwssKey !== key) {
      board.hwssKey = key;
      while (board.firstChild) board.removeChild(board.firstChild);
      var head = document.createElement('div');
      head.textContent = 'WINS'; head.style.color = '#fff'; head.style.fontSize = '70%'; head.style.opacity = '0.8';
      board.appendChild(head);
      // each count has arrows to correct it (TheSplitScreenGuy's request: endings set off by an NPC / script can't name a winner)
      ids.forEach(function (i) {
        var row = document.createElement('div');
        row.style.color = colorOf(i); row.style.whiteSpace = 'pre';
        row.style.webkitTextStroke = '1px #13213d'; row.style.paintOrder = 'stroke fill';
        var label = document.createElement('span'); label.textContent = 'P' + i + ' ';
        var num = document.createElement('span'); num.textContent = String(wins[i] || 0);
        num.style.display = 'inline-block'; num.style.minWidth = '1.4em'; num.style.textAlign = 'center';
        row.appendChild(label); row.appendChild(scoreArrow(i, -1)); row.appendChild(num); row.appendChild(scoreArrow(i, 1));
        board.appendChild(row);
      });
    }
    if (board.style.display !== 'block') board.style.display = 'block';
  }

  // a clickable ◀ / ▶ next to a count (the board itself ignores the mouse; only these take clicks)
  function scoreArrow(pid, d) {
    var a = document.createElement('span');
    a.textContent = d < 0 ? '◀' : '▶';
    a.setAttribute('data-hwss-btn', 'score');
    a.style.cssText = 'pointer-events:auto;cursor:pointer;display:inline-block;padding:0 0.35em;font-size:75%;opacity:0.85;';
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function (t) { a.addEventListener(t, function (e) { e.stopPropagation(); }, true); });
    a.addEventListener('click', function (e) {
      e.stopPropagation();
      var now = performance.now();
      if (a.hwssLast && now - a.hwssLast < 250) return;  // one press = one step (in case two inputs both click)
      a.hwssLast = now;
      PL.adjustWins(pid, d);
    }, true);
    return a;
  }
  PL.adjustWins = function (pid, d) {
    wins[pid] = Math.max(0, (wins[pid] || 0) + d);
    log('p2', 'win tally corrected: P' + pid + ' ' + (d > 0 ? '+1' : '-1') + ' -> ' + JSON.stringify(wins));
  };
  function titleCase(t) { return String(t).replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }

  function join(p) {
    p.joined = true; log('p2', p.name + ' joined' + (p.bot ? ' (test rider)' : ''));
    if (H.session && levelOk(H.session)) spawn(H.session, p);
    if (H.session) updateP1Tint(H.session);
  }
  function leave(p) {
    p.joined = false; p.bot = false; log('p2', p.name + ' left');
    if (!(p.id === 2 && typeof cfg.p2Pad === 'number')) { p.padIndex = null; p.hasPad = false; p.input = {}; }   // the pad is a spare again
    if (p.char) removePlayer(p);
    if (H.session) updateP1Tint(H.session);
    if (!PL.anyJoined()) wins = {};                      // co-op session over: tally starts fresh
  }
  function levelOk(s) { return s && s._character && s._level && s.m_world === H.world && s.inputAllowed !== false && !s.isMenu; }

  // ---------- per-session setup ----------
  (H.onSession = H.onSession || []).push(function (s) {
    // A new world (level start or restart). The old riders' bodies went with the old world, but on a
    // restart the game reuses the level container, so hide the old riders' graphics.
    LIST.forEach(function (p) { if (p.char) hideClips(p.char); p.char = null; p.bodies = new Set(); });
    H.p2 = null; curSession = s; hist = [];
    bodyOwner = new Map();
    npcIntroDoneAt = 0;                                   // NPC weapons: P1-only again for the new attempt's intro
    hookWorldClass(s.m_world);
    hookContactFilter(s.m_world);
    hookContactListener(s);
    hookNpcWeapons(s); setTimeout(function () { hookNpcWeapons(s); }, 1500);
    hookTriggers(s); setTimeout(function () { hookTriggers(s); }, 1500);
    var b1 = new Set(); collectBodies(s._character, b1); b1.forEach(function (b) { bodyOwner.set(b, 1); });
    mirror(s);
    if (levelOk(s)) LIST.forEach(function (p) { if (p.joined) spawn(s, p); });
    updateP1Tint(s);
  });

  function isBody(v) { return v && typeof v === 'object' && typeof v.GetPosition === 'function' && typeof v.GetShapeList === 'function'; }
  // Sub-characters attached to a character (e.g. the Irresponsible Dad's kid): character objects of
  // the same session stored in one of its fields.
  function subCharacters(c) {
    var out = [];
    if (H.N) H.N.alias(c);
    // 1.99.3: test the real field names (a kid aliased right after construction has no cameraFocus alias
    // yet: that field appears in create()), then re-alias the sub-character so its clips are found
    var RS = H.N ? H.N.real('_session') : '_session', RF = H.N ? H.N.real('cameraFocus') : 'cameraFocus', cs0 = c[RS] || c._session;
    Object.keys(c).forEach(function (k) {
      var v = c[k];
      if (H.N && k !== RS && v && typeof v === 'object' && v !== c && !v._pixiSprite && (v[RS] || v._session) === cs0 && cs0 && (v[RF] || v.cameraFocus || typeof v.tag === 'string')) { H.N.aliasChar(v, true); out.push(v); return; }
      if (k !== '_session' && v !== c._session && v && typeof v === 'object' && v !== c && v._session && v._session === c._session && v.cameraFocus && !v._pixiSprite) out.push(v);
    });
    return out;
  }
  function collectBodies(c, set, depth) {
    depth = depth || 0;
    Object.keys(c).forEach(function (k) { var v = c[k]; if (isBody(v)) set.add(v); });
    if (depth < 2) subCharacters(c).forEach(function (sc) { collectBodies(sc, set, depth + 1); });
  }

  // Run a player's code with the session believing that player is "the" character (things like the
  // kid attach to session._character), then switch straight back.
  function asPlayer(s, C, pid, fn) {
    var prevOwner = owner, prevChar = s._character;
    owner = pid; s._character = C;
    try { return fn(); }
    finally { s._character = prevChar; owner = prevOwner; }
  }

  // bodies created while a player's code is running belong to that player (broken limbs, chunks...)
  var hookedWorldProtos = new WeakSet();
  function hookWorldClass(w) {
    var proto = Object.getPrototypeOf(w);
    if (hookedWorldProtos.has(proto)) return;
    hookedWorldProtos.add(proto);
    var orig = proto.CreateBody;
    proto.CreateBody = function () {
      var b = orig.apply(this, arguments);
      if (owner && this === (curSession && curSession.m_world)) {
        bodyOwner.set(b, owner);
        if (owner !== 1 && byId[owner]) byId[owner].bodies.add(b);
      }
      return b;
    };
  }

  var hookedFilters = new WeakSet();
  function hookContactFilter(w) {
    var f = w.m_contactFilter;
    // 1.99.3: the filter's class is not exported (Box2D aliasing misses it): alias the object itself, and
    // use the real member names in the hot path (runs for every new shape overlap)
    if (f && H.N) H.N.alias(f);
    if (!f || typeof f.ShouldCollide !== 'function' || hookedFilters.has(f)) return;
    hookedFilters.add(f);
    var R = function (n) { return H.N ? H.N.real(n) : n; };
    var GB = R('GetBody'), GF = R('GetFilterData'), MB = R('maskBits'), CB = R('categoryBits');
    var orig = f.ShouldCollide;
    log('p2', 'contact filter hooked (players ' + (cfg.playersCollide ? 'collide' : 'pass through, or collide after the world mode grace') + ')');
    f.ShouldCollide = function (a, b) {
      var oa = bodyOwner.get(a[GB]()), ob = bodyOwner.get(b[GB]());
      if (oa && ob && oa !== ob) {
        // Two different riders. "collide" world modes: they collide once the attempt's grace is over.
        // Box2D only asks this when two shapes start to overlap, so riders still inside each other at
        // that moment keep passing through until they separate (no spawn explosion).
        var grace = H.W2 && H.W2.collideGraceMs ? H.W2.collideGraceMs() : null;
        var collideNow = cfg.playersCollide || (grace != null && curSession && curSession.hwssSpawnAt &&
          performance.now() >= curSession.hwssSpawnAt + grace);
        if (!collideNow) return false;
        // All riders' body parts share collision group -1 ("never collide within the group", which
        // keeps a rider's own limbs apart), so the game's rule would keep different riders apart too.
        // Between riders, decide by category/mask only.
        var fa = a[GF](), fb = b[GF]();
        return (fa[MB] & fb[CB]) !== 0 && (fa[CB] & fb[MB]) !== 0;
      }
      return orig.call(this, a, b);
    };
  }

  // ---------- contacts involving an extra player (triggers etc.) ----------
  // The session's contact listener maps shapes to handlers (_addListeners etc.; every trigger sensor is
  // in there). Triggers check "body == session.character.<body>", i.e. always P1. When either shape of
  // a contact belongs to an extra player, dispatch the whole contact with the session switched to them.
  function hookContactListener(s) {
    var L = s._contactListener;
    if (!L || L.hwssHooked) return;
    L.hwssHooked = true;
    ['Add', 'Persist', 'Remove', 'Result'].forEach(function (name) {
      var orig = L[name];
      if (typeof orig !== 'function') return;
      L[name] = function (pt) {
        var pid = pt ? contactPlayer(pt) : 0, C = pid ? PL.charOf(pid, s) : null;
        if (C) {
          var self = this, args = arguments;
          return asPlayer(s, C, pid, function () { return orig.apply(self, args); });
        }
        return orig.apply(this, arguments);
      };
    });
    log('p2', 'contact listener hooked (extra players can set off triggers)');
  }
  // ---------- level NPC weapons only take P1 in certain levels (shared worlds) ----------
  // Level NPCs with weapons (Taken 3's hobo and his spear) impale whatever their blade touches: the weapon
  // queues the body and joins it to the blade in its actions (createPrisJoint(body)). In a shared world all
  // four riders get stuck on the ONE weapon, which is then too heavy for the NPC to lift, so the level's
  // opening (the hobo taking the dad's son) fails. In the levels listed here the weapon skips P2-P4's
  // bodies (their kids included) in shared worlds, so only P1's kid is taken, like in single player.
  // (TheSplitScreenGuy's choice: hardcoded per level rather than a menu option.) cfg.npcP1Levels adds more names.
  // Only for the intro (TheSplitScreenGuy's report: later in the level P2 could never be impaled): the first time a weapon
  // takes one of P1's bodies (the hobo grabbing P1's kid), the rule ends 2 s later (time for the rest of
  // that grab) and weapons treat everyone normally until the next attempt.
  var NPC_P1_LEVELS = ['taken 3'], npcProtos = new WeakSet(), npcIntroDoneAt = 0, NPC_INTRO_GRACE = 2000;
  function npcSkip(body) {
    if (!PL.getNpcP1Only() || (H.W2 && H.W2.isSeparate && H.W2.isSeparate())) return false;
    var o = bodyOwner.get(body);
    if (o === 1 && !npcIntroDoneAt) { npcIntroDoneAt = performance.now(); log('p2', 'npc weapons: P1 taken, P1-only rule ends in 2 s'); }
    if (npcIntroDoneAt && performance.now() - npcIntroDoneAt > NPC_INTRO_GRACE) return false;
    return (o || 1) > 1;
  }
  function levelName() { try { return String(H.W2.cap.loader.levelDataObject.name || '').trim().toLowerCase(); } catch (e) { return ''; } }
  PL.getNpcP1Only = function () {
    var n = levelName(), list = NPC_P1_LEVELS.concat((cfg.npcP1Levels || []).map(function (x) { return String(x).toLowerCase(); }));
    return !!n && list.indexOf(n) >= 0;
  };
  function hookNpcWeapons(s) {
    var items = s && s._level && s._level.paintItemVector;
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      for (var p = Object.getPrototypeOf(it), n = 0; p && p !== Object.prototype && n < 6; p = Object.getPrototypeOf(p), n++) {
        var d = gopd(p, 'createPrisJoint');
        if (!d || typeof d.value !== 'function') continue;
        if (npcProtos.has(p)) return;
        npcProtos.add(p);
        var orig = d.value;
        // 1.99.3: the game calls the renamed method ($$au); assign the wrapper under the REAL name (a plain
        // `p.createPrisJoint = ...` only made an unused property: no alias accessor exists on this class)
        var key = H.N && H.N.real && H.N.real('createPrisJoint');
        if (!key || !Object.prototype.hasOwnProperty.call(p, key)) key = 'createPrisJoint';
        p[key] = function (body) {
          if (npcSkip(body)) return;
          return orig.apply(this, arguments);
        };
        log('p2', 'npc weapons hooked (' + (it.constructor && it.constructor.name) + ')');
        return;
      }
    });
  }
  var PT_REAL = { shape1: (H.N && H.N.real && H.N.real('shape1')) || 'shape1', shape2: (H.N && H.N.real && H.N.real('shape2')) || 'shape2' };
  function ptShape(pt, name) { var v = pt[name]; return v !== undefined ? v : pt[PT_REAL[name]]; }
  // ---------- who set off a trigger (winner of a "level complete" trigger) ----------
  // A trigger's activate method ($$DL(body), 1.99.3) runs inside the contact (as the player who touched it)
  // but only stores the body ($$rw) and queues the trigger; its actions() fire the effect later, e.g. type 3
  // = level complete, outside that player's context, so the winner came out as P1 (TheSplitScreenGuy's report: P4 won,
  // "P1 Wins!"). While a trigger's actions() run, PL.triggerWinner() = the owner of its stored body.
  var trigProtos = new WeakSet(), trigBy = 0;
  var TRIG_BODY = (H.N && H.N.real && H.N.real('triggeringBody')) || '$$rw';   // (no old name known: 1.99.3 token)
  function hookTriggers(s) {
    var L = s && s._level;
    if (!L) return;
    Object.keys(L).forEach(function (k) {
      var arr; try { arr = L[k]; } catch (e) { return; }
      if (!Array.isArray(arr) || !arr.length) return;
      arr.forEach(function (t) {
        if (!t || typeof t !== 'object') return;
        var p = Object.getPrototypeOf(t);
        if (!p || trigProtos.has(p) || !Object.prototype.hasOwnProperty.call(p, 'actions') || !('triggeredBy' in t)) return;
        trigProtos.add(p);
        // activation: remember who set it off NOW ($$rw is cleared again when the body leaves the area, so a
        // delayed trigger can fire after the rider passed through). No owned body (set off by another
        // trigger): the player of the trigger whose actions are running, else whose code runs right now.
        var ACT = '$$DL';                                   // 1.99.3 token of the trigger's activate(body)
        if (typeof p[ACT] === 'function') {
          var origAct = p[ACT];
          p[ACT] = function (body) {
            // -1 = set off by something that is no player (an NPC, a loose object): split.js then gives the win
            // to the player still alive (TheSplitScreenGuy's rule; Ultimate Payback's ending is the NPC reaching a trigger)
            var o = (body && bodyOwner.get(body)) || trigBy || owner || -1;
            this.hwssBy = o;
            return origAct.apply(this, arguments);
          };
        }
        // set off by ANOTHER trigger ("activate trigger" target action calls $$bjz, not $$DL): inherit the
        // player of the trigger whose actions are running (TheSplitScreenGuy's test: Ultimate Payback's level-complete
        // trigger is only ever activated by other triggers, so it kept an old "P1")
        var CHAIN = '$$bjz';
        if (typeof p[CHAIN] === 'function') {
          var origChain = p[CHAIN];
          p[CHAIN] = function () {
            if (trigBy) this.hwssBy = trigBy;
            return origChain.apply(this, arguments);
          };
        }
        var orig = p.actions;
        p.actions = function () {
          var prev = trigBy, b = this[TRIG_BODY], o = this.hwssBy || (b ? bodyOwner.get(b) : 0);
          trigBy = o || prev;
          try { return orig.apply(this, arguments); } finally { trigBy = prev; }
        };
        log('p2', 'triggers hooked (winner of level-complete triggers)');
      });
    });
  }
  // > 1: that player set it off; -1: no player did (NPC / object); 0: P1 or unknown
  PL.triggerWinner = function () { return trigBy > 1 || trigBy === -1 ? trigBy : 0; };
  function contactPlayer(pt) {
    try {
      // 1.99.3: contact points carry only the renamed fields ($$sT / $$y; no alias on their class)
      var s1 = ptShape(pt, 'shape1'), s2 = ptShape(pt, 'shape2');
      var a = s1 && s1.GetBody && bodyOwner.get(s1.GetBody());
      if (a && a !== 1) return a;
      var b = s2 && s2.GetBody && bodyOwner.get(s2.GetBody());
      return b && b !== 1 ? b : 0;
    } catch (e) { return 0; }
  }

  // ---------- mirror the session's calls on P1 onto the extra players ----------
  // 1.99.3: handleContactBuffer calls handleContactResults itself (the session no longer calls both), so
  // mirroring both would run an extra player's contact results twice
  var MIRROR = H.N ? ['preActions', 'checkKeyStates', 'actions', 'handleContactBuffer', 'checkJoints', 'paint']
    : ['preActions', 'checkKeyStates', 'actions', 'handleContactBuffer', 'handleContactResults', 'checkJoints', 'paint'];
  function gopd(o, n) { return H.N ? H.N.desc(o, n) : Object.getOwnPropertyDescriptor(o, n); }   // sees through names.js aliases
  function isClipKey(C, k) { return H.N ? H.N.isClipKey(C, k) : /MCs?$/.test(k); }
  // The P1 character object can be reused across sessions while the session around it is replaced, so
  // the wrapper must NOT remember a session: it looks it up at call time (this._session). An earlier
  // version captured the session and silently stopped forwarding after such a restart.
  function mirror(s) {
    var C1 = s._character;
    MIRROR.forEach(function (name) {
      if (typeof C1[name] !== 'function' || (C1[name] && C1[name].hwssMirror)) return;
      var orig = C1[name];
      var wrapper = C1[name] = function () {
        var prev = owner; owner = 1;
        var r, real = null;
        if (name === 'checkKeyStates') {
          // test riders copy P1's REAL controls (set by the keyboard listeners)
          try { recordP1(this); } catch (e) {}
          // F8: P1 itself rides on its own controls from P1_DELAY s ago (so no-delay test riders lead)
          // F1 auto-ride wins over the F8 delay
          if (PL.autoRide) { real = keyFlags(this); setFlags(this, autoInput(1)); }
          else if (PL.p1Delay) { real = keyFlags(this); setFlags(this, delayedP1(PL.p1Delay)); }
        }
        try { r = orig.apply(this, arguments); }
        finally { owner = prev; if (real) setFlags(this, real); }   // the listeners keep the real state
        var cur = this._session, args = arguments;
        if (cur) LIST.forEach(function (p) {
          var C = p.char;
          if (!C || C._session !== cur || typeof C[name] !== 'function') return;
          if (name === 'checkKeyStates') applyInput(C, p);
          try { asPlayer(cur, C, p.id, function () { C[name].apply(C, args); }); }
          catch (e) { log('p2-error', p.name + ' ' + name + ': ' + (e && e.stack || e)); }
        });
        return r;
      };
      wrapper.hwssMirror = true;
    });
  }
  function inputOf(p) {
    if (PL.autoRide) return autoInput(p.id);              // F1 auto-ride wins over pads and test riders
    if (p.bot) return delayedP1(p.noDelay ? 0 : (BOT_DELAY[p.id] || 0.6));   // test rider wins over a pad (F5/F3/F4)
    if (p.hasPad) return p.input;
    return {};
  }
  function applyInput(C, p) { setFlags(C, inputOf(p)); }
  PL.applyInput = function (C, pid) { applyInput(C, byId[pid] || P2); };
  PL.tintShirt = function (C, pid) { try { tintShirt(C, pid || 2); } catch (e) { log('p2-error', 'shirt: ' + e); } };
  // old names (world2.js used these for P2)
  P2.applyInput = function (C) { applyInput(C, P2); };
  P2.tintShirt = function (C) { PL.tintShirt(C, 2); };

  // ---------- spawn / remove ----------
  // The character takes its body clips out of an art container ("sourceObject"), so each rider needs its
  // own. The game builds it (loadCharacterData) as: new MovieClip(); clip.setPixiMovieClip(new <Animate
  // stage>(), true) and P1's art pixi object is an instance of that Animate stage class.
  function makeArt(src) {
    var art = new src.constructor(null);
    art.setPixiMovieClip(new src._pixiSprite.constructor(), true);
    // Characters differ (the lawnmower man has no bike "frame"), so only require a non-empty art set;
    // spawn() verifies afterwards that no body clip is shared with P1.
    if (!art.numChildren) throw new Error('fresh art is empty');
    return art;
  }

  // ---------- per-player characters ----------
  // p.charIndex: 1-11 (Settings.characterNames order) or null = same as P1. Used only when the level lets
  // players choose (user levels: levelDataObject._forceChar false; levels without that info: allowed).
  var CHAR_COUNT = 11;
  PL.charAllowed = function () {
    var L = H.W2 && H.W2.cap && H.W2.cap.loader, lo = L && L.levelDataObject;
    return lo ? !lo._forceChar : true;
  };
  PL.charName = function (idx) {
    var St = H.Settings, d = St && gopd(St, 'characterNames'), n = d && d.value;
    // no own pick yet: they ride P1's character, so name that one (not "same as P1")
    var i = idx || (St && St.characterIndex);
    return i && n && n[i - 1] ? n[i - 1] : 'same as P1';
  };
  // the character index player p should get in this level, or null (= P1's character, built the old way)
  PL.charFor = function (p) {
    var St = H.Settings;
    if (!p || !p.charIndex || !St || !PL.charAllowed()) return null;
    return p.charIndex === St.characterIndex ? null : p.charIndex;
  };
  // A character's art, built by the game's own loader code (loadCharacterData) on a stand-in loader whose
  // "loaded" event does nothing — on the real loader that event would start the level again.
  PL.artFor = function (idx) {
    var L = H.W2 && H.W2.cap && H.W2.cap.loader;
    if (!L) return null;
    var proto = Object.getPrototypeOf(L), d;
    for (var q = proto; q && !(d = gopd(q, 'loadCharacterData')); q = Object.getPrototypeOf(q));
    if (!d || typeof d.value !== 'function') return null;
    var fake = Object.create(proto);
    fake.characterIndex = idx; fake._levelVersion = L._levelVersion; fake.listeners = {};
    fake.dispatchEvent = function () { return true; };
    d.value.call(fake);
    return fake._characterData || null;
  };
  // A rider of character idx for session s, constructed by the game's setupCharacter with that index
  // (it picks the class from Settings.characterIndex and sets session._character — both put back).
  function constructChar(s, idx, art) {
    var St = H.Settings, prevIdx = St.characterIndex, prevChar = s._character;
    St.characterIndex = idx;
    try { s.setupCharacter(art); return s._character; }
    finally { s._character = prevChar; St.characterIndex = prevIdx; }
  }
  function cycleChar(p, dir) {
    var v = (p.charIndex || 0) + dir;
    if (v < 0) v = CHAR_COUNT; if (v > CHAR_COUNT) v = 0;
    p.charIndex = v || null;
    log('p2', p.name + ' character -> ' + PL.charName(p.charIndex));
  }

  function spawn(s, p) {
    if (p.char && p.char._session === s) return;
    // separate-worlds mode: the player lives in their own session (world2.js), not in P1's world
    if (H.W2 && H.W2.isSeparate && H.W2.isSeparate()) { s.hwssCoop = true; return; }
    var C1 = s._character, start = s.getStartPoint(), C, art, idx = PL.charFor(p);
    try { art = idx ? PL.artFor(idx) : makeArt(C1.sourceObject); if (!art) throw new Error('no art for character ' + idx); }
    catch (e) { log('p2-error', p.name + ' art: ' + (e && e.stack || e)); return; }
    var bodies = p.bodies = new Set();
    // bodies already in the world: if building the rider fails half way, the new ones are removed again
    // (a half-built rider left in the world made every physics step throw → everyone froze)
    var before = new Set();
    try { for (var wb = s.m_world.GetBodyList(); wb; wb = wb.GetNext()) before.add(wb); } catch (e) {}
    try {
      // construct with P1 as session._character (the constructor may need a valid one), but swap to
      // the new rider for create(), which builds bodies/joints and attaches the kid
      var prev = owner; owner = p.id;
      try { C = idx ? constructChar(s, idx, art) : new C1.constructor(start.x, start.y, art, s); } finally { owner = prev; }
      if (H.N) H.N.aliasChar(C);                          // 1.99.3 old names on its class (names.js)
      // sub-characters built in the constructor (the kid) may have grabbed session._character (= P1)
      subCharacters(C).forEach(function (sc) {
        Object.keys(sc).forEach(function (k) { if (sc[k] === C1) { sc[k] = C; log('p2', 'relinked ' + k + ' of sub-character to ' + p.name); } });
      });
      asPlayer(s, C, p.id, function () { C.create(); });
      if (H.N) { H.N.aliasChar(C, true); subCharacters(C).forEach(function (sc) { H.N.aliasChar(sc, true); }); }   // clip fields exist from create() on
    } catch (e) {
      log('p2-error', p.name + ' spawn: ' + (e && e.stack || e));
      var gone = 0;
      try {
        var added = [];
        for (var nb = s.m_world.GetBodyList(); nb; nb = nb.GetNext()) if (!before.has(nb)) added.push(nb);
        added.forEach(function (b) { try { s.m_world.DestroyBody(b); gone++; } catch (x) {} });
      } catch (x) {}
      log('p2', p.name + ' not spawned in the shared world (removed ' + gone + ' half-built bodies)');
      return;
    }
    // Safety: the rider must not own any of P1's body clips (the riders would steal each other's sprites).
    var shared = Object.keys(C).filter(function (k) { return isClipKey(C, k) && C[k] && C[k] === C1[k]; });
    if (shared.length) {
      log('p2-error', p.name + ' shares body clips with P1 (' + shared.slice(0, 6).join(',') + '), not spawning ' + C.tag);
      // remove only this rider's physics bodies: hiding its clips would hide P1's shared ones too
      bodies.forEach(function (b) { try { s.m_world.DestroyBody(b); } catch (e) {} bodyOwner.delete(b); });
      p.bodies = new Set();
      return;
    }
    var all = new Set(); collectBodies(C, all);
    all.forEach(function (b) { bodies.add(b); bodyOwner.set(b, p.id); });
    C.isPlayer2 = true;                                  // "an extra player" (the game never reads it)
    C.hwssPlayer = p.id;
    s.hwssCoop = true;                                   // this attempt is co-op: no replay upload (hwss.js)
    s.hwssSpawnAt = performance.now();                   // "collide" world modes: grace counts from here
    try { tintShirt(C, p.id); } catch (e) { log('p2-error', 'shirt: ' + e); }
    p.char = C; p.spawns++;
    if (p.id === 2) H.p2 = C;
    log('p2', p.name + ' spawned (' + C.tag + ', ' + bodies.size + ' bodies)');
  }
  function removePlayer(p) {
    var C = p.char; p.char = null;
    if (p.id === 2) H.p2 = null;
    if (!C) return;
    // Hide the rider's graphics and take its bodies out of the world.
    try {
      var w = C._session && C._session.m_world;
      p.bodies.forEach(function (b) { try { if (w) w.DestroyBody(b); } catch (e) {} bodyOwner.delete(b); });
      p.bodies = new Set();
      hideClips(C);
    } catch (e) { log('p2-error', 'remove: ' + e); }
    log('p2', p.name + ' removed');
  }
  // Take the character's body clips out of the scene: ONLY fields named *MC / *MCs (never _session,
  // sourceObject or anything else, since the session and level container are reused on restart),
  // plus the same for attached sub-characters (the kid).
  function hideClips(C, depth) {
    depth = depth || 0;
    Object.keys(C).forEach(function (k) {
      if (!isClipKey(C, k)) return;
      var v = C[k], list = Array.isArray(v) ? v : [v];
      list.forEach(function (mc) {
        if (!mc || typeof mc !== 'object' || !mc._pixiSprite) return;
        try { mc.visible = false; if (mc.parent && mc.parent.removeChild) mc.parent.removeChild(mc); } catch (e) {}
      });
    });
    if (depth < 2) subCharacters(C).forEach(function (sc) { hideClips(sc, depth + 1); });
  }
})();
