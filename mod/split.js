/* HWSS split view. Bundled after hwss.js + names.js (same page, runs before the game).
 * Discovers the game's Pixi renderer, Box2D world and level session at run time (by shape; 1.99.3 names
 * through names.js), then, while a co-op level is running, draws one view per player (2-4) into the
 * layout of the chosen view mode (pause-menu "split:" toggle): top/bottom or side-by-side bands, letterbox,
 * stretch, "shared screen" (one camera framing everyone), P1 only; 3-4 players use quarters. Also here:
 * separate-world views + ghosts, markers, spectate, the 2-monitor window mode (monitorLayout /
 * monitorSingle), zoom-aware culling and sound listener, the level-complete winner (levelComplete wrapper),
 * mouse mapping into the views, and the static-art cache. Full screen whenever no level is running, the
 * game is paused or the level is complete. Errors: 3 in one attempt switch the split off until the next
 * attempt (game rendering continues).
 * Config (webroot/hwss/config.json): forceSplit (dev), splitZoom, splitOrientation, splitBandTop/Left,
 * ghosts, ghostAlpha, sharedMinZoom, ... (most are overridden by the saved pause-menu choices).
 */
(function () {
  'use strict';
  var H = window.__HWSS__;
  if (!H || H.splitLoaded) return;
  H.splitLoaded = true;
  var cfg = H.cfg, log = H.log, own = Object.prototype.hasOwnProperty;
  var W = 900, FULL = 500, HALF = 250;

  var S = H.split = { wanted: !!cfg.forceSplit, active: false, frames: 0, errors: 0, lastError: null, comp: null };

  // ---------- 1. webpack require (our chunk's runtime callback receives it) ----------
  // The chunk array's name differs per game build (hwss.js: H.chunkName). Known from the installer →
  // push now (webpack processes it when its runtime starts); otherwise push once the game's runtime has
  // replaced the array's push (it then runs our callback right away).
  var chunkPushed = false;
  function pushChunk() {
    if (chunkPushed || H.req) return true;
    var name = H.chunkName || (H.findChunkName && H.findChunkName());
    if (!name) return false;
    chunkPushed = true;
    (self[name] = self[name] || []).push([['hwss'], {}, function (req) { H.req = req; }]);
    log('split', 'webpack chunk array: ' + name);
    return true;
  }
  pushChunk();

  // ---------- 2. discovery ----------
  function findClass(srcRe, test) {
    var m = H.req && H.req.m; if (!m) return null;
    for (var id in m) {
      if (!srcRe.test(Function.prototype.toString.call(m[id]))) continue;
      var ex; try { ex = H.req(id); } catch (e) { continue; }
      for (var k in ex) {
        var v; try { v = ex[k]; } catch (e) { continue; }
        if (typeof v === 'function' && v.prototype && test(v, v.prototype)) return v;
      }
    }
    return null;
  }
  function has(p, names) { return names.every(function (n) { return n in p; }); }

  var P = H.P = {};
  function discover() {
    if (!H.req) { pushChunk(); return false; }
    // 1.99.3: Box2D names are renamed; names.js adds the old ones back as aliases on its classes
    var PIXI_SRC = /resizeTo/, B2_SRC = /SetBoundaryListener|\.m_world=this/;
    if (H.N && !S.b2Aliased) { S.b2Aliased = H.N.aliasModules(/\.m_world=this/); log('split', 'names: Box2D classes aliased: ' + S.b2Aliased + ' (' + H.N.aliased + ' aliases)'); }
    P.Renderer = P.Renderer || findClass(PIXI_SRC, function (C, p) { return has(p, ['render', 'resize', 'clear', 'generateTexture', 'addSystem']); });
    P.Container = P.Container || findClass(PIXI_SRC, function (C, p) { return own.call(p, 'sortChildren'); });
    P.Sprite = P.Sprite || findClass(PIXI_SRC, function (C, p) { return own.call(p, 'calculateTrimmedVertices'); });
    P.RenderTexture = P.RenderTexture || findClass(PIXI_SRC, function (C, p) { return typeof C.create === 'function' && 'framebuffer' in p && own.call(p, 'resize'); });
    P.Texture = P.Texture || findClass(PIXI_SRC, function (C, p) { return own.call(p, 'updateUvs'); });
    P.Rectangle = P.Rectangle || findClass(PIXI_SRC, function (C, p) { return own.call(p, 'pad') && own.call(p, 'fit'); });
    P.World = P.World || findClass(B2_SRC, function (C, p) { return own.call(p, 'GetBodyList') && own.call(p, 'Step'); });
    // Pixi Matrix (ghosts in separate worlds); optional
    P.Matrix = P.Matrix || findClass(PIXI_SRC, function (C, p) { return own.call(p, 'translate') && own.call(p, 'invert') && own.call(p, 'append') && own.call(p, 'applyInverse'); });
    // Pixi Filter base class (used by p2.js for the red shirt); optional
    if (!P.Filter) {
      var fc = findClass(PIXI_SRC, function (C, p) { return own.call(p, 'apply') && 'blendMode' in p && typeof C.defaultVertexSrc === 'string' && !(Object.getPrototypeOf(p) && own.call(Object.getPrototypeOf(p), 'apply')); });
      if (fc) P.Filter = fc;
    }
    var missing = Object.keys({ Renderer: 1, Container: 1, Sprite: 1, RenderTexture: 1, Texture: 1, Rectangle: 1, World: 1 }).filter(function (k) { return !P[k]; });
    if (missing.length) { log('split', 'discovery incomplete, missing: ' + missing.join(',')); return false; }
    installHooks();
    log('split', 'discovery ok; forceSplit=' + S.wanted);
    return true;
  }

  // ---------- 3. hooks ----------
  var lastWorld = null, worldStepAt = 0;
  // Frame-cost counters (summed; S.takePerf() returns per-frame averages and resets). Read by the
  // cfg.diag snapshot (p2.js) — the only way to measure on the Steam Deck.
  var perf = S.perf = { frames: 0, gap: 0, gapMax: 0, slow: 0, last: 0, phys: 0, split: 0, cull: 0, draw: 0, ghosts: 0, culled: 0, t0: performance.now() };
  S.takePerf = function () {
    var n = perf.frames || 1, r2 = function (v) { return Math.round(v * 100) / 100; };
    var out = { fps: r2(perf.frames * 1000 / Math.max(1, performance.now() - perf.t0)), frameMs: r2(perf.gap / n), worstFrameMs: r2(perf.gapMax),
                slowFrames: perf.slow, physMs: r2(perf.phys / n), splitMs: r2(perf.split / n), cullMs: r2(perf.cull / n),
                drawMs: r2(perf.draw / n), ghostMs: r2(perf.ghosts / n), culledPerFrame: Math.round(perf.culled / n), views: S.active ? viewIds().length : 1,
                world: H.W2 && H.W2.getMode ? H.W2.getMode() : null, mode: S.getOrientation && S.getOrientation() };
    perf.frames = 0; perf.gap = 0; perf.gapMax = 0; perf.slow = 0; perf.phys = 0; perf.split = 0; perf.cull = 0; perf.draw = 0; perf.ghosts = 0; perf.culled = 0; perf.t0 = performance.now();
    return out;
  };
  function timed(key, fn) { var t = performance.now(); try { return fn(); } finally { perf[key] += performance.now() - t; } }
  function installHooks() {
    ['Step', 'InterpolatedStep'].forEach(function (name) {
      var orig = P.World.prototype[name]; if (typeof orig !== 'function') return;
      P.World.prototype[name] = function () {
        // P2's separate world (world2.js) must never become "the current world"
        if (!this.hwssP2World && !(H.W2 && H.W2.building)) { H.world = this; worldStepAt = performance.now(); }
        var t = performance.now();
        try { return orig.apply(this, arguments); } finally { perf.phys += performance.now() - t; }
      };
    });
    var origRender = P.Renderer.prototype.render;
    S.origRender = origRender;
    P.Renderer.prototype.render = function (obj, opts) {
      if (opts !== undefined || !obj) return origRender.apply(this, arguments);
      // Any mod error here must never stop the game's own frame: an exception thrown before the game
      // drew froze the screen (non-P1 win, then "exit to menu": the ended session had no container).
      var self = this, args = arguments;
      try { return hookedRender.call(this, obj, opts); }
      catch (e) {
        S.errors++; S.lastError = String(e && e.stack || e);
        if (S.errors <= 5) log('split-error', 'render hook: ' + S.lastError);
        if (S.errors >= 20) { S.broken = true; log('split', 'disabled after repeated errors'); }
        return origRender.apply(self, args);
      }
    };
    function hookedRender(obj, opts) {
      H.renderer = this; H.stage = obj;
      // monitor mode: canvas over all monitors; anything not split is drawn into P1's monitor
      var self0 = this, mon = S.mon.on && S.mon.rects && !S.broken;
      if (mon) monEnforce(this);
      var finalRender = mon ? function (o, op) { if (op === undefined && o === obj) return monitorSingle(self0, o, origRender); return origRender.call(this, o, op); } : origRender;
      var now = performance.now();
      if (perf.last) { var gap = now - perf.last; perf.gap += gap; if (gap > perf.gapMax) perf.gapMax = gap; if (gap > 20) perf.slow++; }
      perf.last = now; perf.frames++;
      var sess = currentSession();                       // always tracked (P2 needs it before the split)
      // Screen state for p2.js: in a level (also while paused), or at the menu (no level session for
      // the current world, but the menu's background world is stepping).
      H.inLevel = !!sess && sess.m_world === H.world && !!sess._level && !sess.isMenu;
      H.atMenu = !H.inLevel && performance.now() - worldStepAt < 500;
      try { artCacheTick(this, H.inLevel ? sess : null); } catch (e) { if (!S.artErr) { S.artErr = true; log('split-error', 'art cache: ' + (e && e.stack || e)); } }
      S.wanted = !!cfg.forceSplit || anyJoined();
      if (!S.wanted || S.broken) {
        if (S.active) { S.active = false; log('split', 'split OFF (not wanted)'); }
        return finalRender.call(this, obj);
      }
      // (shared screen on one monitor: no split at all, P1's camera frames everyone)
      var on = !!sess && levelRunning(sess) && attachedTo(sess, obj) && S.getOrientation() !== 'p1' && !(S.isSharedScreen() && !(S.mon.on && S.mon.rects));
      if (on !== S.active) { S.active = on; log('split', on ? 'split ON' : 'split OFF (full screen)'); }
      // Level complete with an extra player as the winner: one full view, from the winner's camera/world.
      var wpid = sess && sess.hwssLevelDone && sess.hwssWinner && sess.hwssWinner !== 'p1' ? +sess.hwssWinner.slice(1) : 0;
      if (!on && wpid && attachedTo(sess, obj) && (sepWorld(sess, wpid) || charOf(wpid, sess))) {
        try { return fullViewFor(this, obj, sess, finalRender, wpid); }
        catch (e) { log('split-error', 'winner view: ' + (e && e.stack || e)); }
      }
      if (!on) return finalRender.call(this, obj);
      try { splitRender(this, obj, sess, origRender); S.frames++; }
      catch (e) {
        S.errors++; S.lastError = String(e && e.stack || e);
        log('split-error', S.lastError);
        if (S.errors >= 3) { S.broken = true; log('split', 'disabled after repeated errors'); }
        return finalRender.call(this, obj);
      }
    };
  }

  // ---------- 4. session tracking ----------
  var session = null;
  function currentSession() {
    var w = H.world;
    if (!w) return null;
    if (w === lastWorld && session) return session;
    lastWorld = w; session = null;
    for (var b = w.GetBodyList(); b && !session; b = b.GetNext()) {
      var u = b.GetUserData && b.GetUserData();
      for (var d = 0; u && d < 6; d++, u = u.parent) {
        if (u._character && u.m_world === w && u._camera !== undefined && !u.hwssP2Session && !isPreviewSession(u)) { session = u; break; }
      }
    }
    if (session) {
      // 1.99.3: old member names as aliases on the session, its character, camera and bodies (names.js)
      if (H.N) { H.N.alias(session); H.N.aliasChar(session._character); H.N.alias(session._camera); H.N.alias(w.GetBodyList()); }
      H.session = session; log('split', 'session found (' + (session._character && session._character.tag) + ')'); hookCameraClass(session);
      hookSessionClass(session);
      session.hwssLevelDone = false;                     // new attempt (the session object may be reused)
      session.hwssTallied = false;
      session.hwssCoop = false;                          // set by p2.js when P2 spawns in this attempt
      zoomAtStart(session);
      (H.onSession || []).forEach(function (fn) { try { fn(session); } catch (e) { log('split-error', 'onSession: ' + (e && e.stack || e)); } });
    }
    return session;
  }
  // The character select screen shows the hovered character on an altar in a small session of its own,
  // rebuilt on every hover. It is not a level: treating it as one ran every new-attempt hook (separate
  // worlds, riders, shirt tints) on each hover and made the screen sluggish.
  function isPreviewSession(u) {
    var px = u._pixiSprite && u._pixiSprite.parent;
    for (var i = 0; px && i < 12; i++, px = px.parent) {
      var o = px._flashSprite;
      if (o && Object.getOwnPropertyDescriptor(o, 'icons') && Object.getOwnPropertyDescriptor(o, 'iconHolder')) return true;
    }
    return false;
  }
  function levelRunning(s) {
    return s.m_world === H.world && s._level && s._camera && s._containerSprite && !s.paused && !s.isMenu &&
      !s.hwssLevelDone && performance.now() - worldStepAt < 250;
  }
  // Level complete (by either player): mark the session so the split goes back to one full view while
  // the level-complete screen is up. Reset when the next attempt's world appears.
  var hookedSessionProtos = new WeakSet();
  function hookSessionClass(s) {
    var proto = Object.getPrototypeOf(s);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'levelComplete')) proto = Object.getPrototypeOf(proto);
    if (!proto || hookedSessionProtos.has(proto)) return;
    hookedSessionProtos.add(proto);
    var orig = proto.levelComplete;
    proto.levelComplete = function () {
      // First finisher wins: a later finisher (e.g. P1 crossing after P2 won) must not re-run the end
      // screen or take the win.
      if (this.hwssLevelDone && this.hwssWinner) { log('split', 'level already complete (' + this.hwssWinner.toUpperCase() + ' won): later finish ignored'); return; }
      this.hwssLevelDone = true;
      // Who won, in order: (1) separate worlds: world2.js forces 'p<n>' when player n finished in their own
      // world; (2) a finish reached by an extra player's contact runs with session._character = that player
      // (p2.js asPlayer), so the finisher is "the character" right now; (3) a "level complete" trigger fires
      // from its own actions(), after the contact: p2.js remembers who set it off (also through chains of
      // triggers); if no player did (e.g. the level's NPC reached it) the survivor rule applies: the living
      // player furthest from their start, or 'p0' (no winner, no win counted) when everyone is dead;
      // (4) otherwise P1. The scoreboard arrows let players correct a wrong count.
      var tw = H.PL && H.PL.triggerWinner ? H.PL.triggerWinner() : 0;
      this.hwssWinner = this.hwssForceWinner || ((this._character && this._character.hwssPlayer) ? 'p' + this._character.hwssPlayer
        : tw === -1 ? survivorWinner(this) : tw ? 'p' + tw : 'p1');
      // co-op win tally for this play session (p2.js shows it on the winner banner)
      if (this.hwssCoop && !this.hwssTallied && H.PL && H.PL.addWin && this.hwssWinner !== 'p0') { this.hwssTallied = true; H.PL.addWin(+this.hwssWinner.slice(1)); }
      log('split', 'level complete by ' + this.hwssWinner.toUpperCase() + ': full screen on the winner (forced ' + (this.hwssForceWinner || '-') +
        ', character P' + ((this._character && this._character.hwssPlayer) || 1) + ', trigger P' + (tw || '-') + ')');
      // who called it (method names show as "[as $$xx]"): for winner bugs
      try { log('split', 'level complete called from: ' + String(new Error().stack).split('\n').slice(2, 10).map(function (l) { var m = /\[as ([^\]]+)\]/.exec(l) || /at ([\w$.<>]+)/.exec(l); return m ? m[1] : '?'; }).join(' < ')); } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
  // the level ended through something no player set off (an NPC reaching a trigger...): the win goes to the
  // player still alive — several: the one furthest from their start; nobody alive: no winner, no win counted
  // ('p0') (TheSplitScreenGuy's rules)
  function survivorWinner(s) {
    var ids = viewIds();
    try { trackDead(s, ids); } catch (e) {}
    if (aliveNow.length) { log('split', 'ending set off by no player: P' + aliveNow[0].pid + ' was alive (furthest), wins'); return 'p' + aliveNow[0].pid; }
    log('split', 'ending set off by no player and everyone is dead: no winner, no win counted');
    return 'p0';
  }
  S.survivorWinner = function () { return survivorWinner(session); };   // (tests / probes)
  function attachedTo(s, root) {
    // a session that has ended (exit to menu) has no container any more
    var o = s && s._containerSprite && s._containerSprite._pixiSprite;
    for (var i = 0; o && i < 64; i++) { if (o === root) return true; o = o.parent; }
    return false;
  }

  // Zoom out for the split ONCE, when a level (re)starts: changing zoom mid-ride makes the camera
  // re-centre with a visible jump. The camera is recreated on every (re)start, so this never stacks.
  // If P2 joins mid-level, the wider view starts from the next restart.
  function zoomAtStart(s) {
    var f = typeof cfg.splitZoom === 'number' && cfg.splitZoom > 0 ? cfg.splitZoom : 1;
    var wanted = !!cfg.forceSplit || anyJoined();
    // "p1 only" view mode keeps stock zoom (TheSplitScreenGuy's choice); split modes zoom out
    var o = S.getOrientation();
    var zoomed = wanted && f !== 1 && o !== 'p1' && o !== 'fit' && o !== 'fitv' && o !== 'stretch' && o !== 'shared';
    // monitor mode: a whole monitor per view keeps stock zoom; two views stacked on a monitor zoom out
    if (S.mon.on && S.mon.rects) zoomed = wanted && f !== 1 && (o === 'horizontal' || o === 'vertical') && viewIds().length > S.mon.rects.length;
    if (o === 'shared') zoomed = false;                  // shared screen sets its own zoom
    if (!zoomed || !s._camera || s._camera.hwssZoomed) return;
    s._camera.zoom = s._camera.zoom * f;
    s._camera.hwssZoomed = true;
    log('split', 'camera zoom set to ' + s._camera.zoom + ' for this attempt');
  }

  // ---------- "shared screen" view mode: one camera framing every living player ----------
  // Shared worlds only (in separate worlds the players are in different worlds). The camera gets a stand-in
  // focus body at the middle of the players it frames and zooms out (smoothly) until they all fit; a player
  // dead for 2 s stops counting (everyone dead: all count again). 2-monitor mode: one such camera per monitor,
  // framing that monitor's players (P1's camera for monitor 1, a clone for the other).
  S.isSharedScreen = function () {
    return S.getOrientation() === 'shared' && !(H.W2 && H.W2.isSeparate && H.W2.isSeparate()) && (anyJoined() || !!cfg.forceSplit);
  };
  // the player groups, one per screen (monitor mode: per monitor; else everyone together)
  function shareGroups() {
    var ids = viewIds();
    if (S.mon.on && S.mon.rects && S.mon.rects.length > 1) return monitorAssign(ids.length).map(function (ks) { return ks.map(function (k) { return ids[k]; }); }).filter(function (g) { return g.length; });
    return [ids];
  }
  // the views to draw in shared-screen mode: the first player of each group (null = not this mode)
  function sharedScreenIds() { return S.isSharedScreen() && S.mon.on ? shareGroups().map(function (g) { return g[0]; }) : null; }
  function groupOfCamera(cam) {
    var gs = shareGroups(), pid = cam === (session && session._camera) ? 1 : cam.hwssPid;
    for (var i = 0; i < gs.length; i++) if (gs[i].indexOf(pid) >= 0) return gs[i];
    return null;
  }
  function makeFocus() {
    var f = { p: { x: 0, y: 0 }, v: { x: 0, y: 0 } };
    // (the camera reads the focus like a physics body, including the interpolated variants)
    f.GetPosition = f.GetWorldCenter = f.GetInterpolatedPosition = f.GetInterpolatedWorldCenter = function () { return f.p; };
    f.GetLinearVelocity = f.GetInterpolatedLinearVelocity = function () { return f.v; };
    f.GetAngle = f.GetInterpolatedAngle = f.GetAngularVelocity = function () { return 0; };
    f.GetMass = function () { return 1; };
    // 1.99.3: the camera calls the renamed body methods (e.g. GetLinearVelocity = $$Dd): add those too
    if (H.N && H.N.real) Object.keys(f).forEach(function (k) { if (typeof f[k] === 'function') { var r = H.N.real(k); if (r && r !== k && !f[r]) f[r] = f[k]; } });
    return f;
  }
  function sharedCamera(cam) {
    var s = session;
    if (!s || !cam || cam._focus === undefined) return;
    var on = S.isSharedScreen() && H.inLevel && (cam === s._camera || cam.hwssPid);
    if (!on) {
      // mode left: the camera goes back to what it followed, at its own zoom
      if (cam.hwssGroupFocus) {
        if (cam._focus === cam.hwssGroupFocus) cam._focus = cam.hwssOrigFocus || (s._character && s._character.cameraFocus) || cam._focus;
        if (cam.hwssBaseZoom) cam.zoom = cam.hwssBaseZoom;
        cam.hwssGroupFocus = null; cam.hwssOrigFocus = null;
      }
      return;
    }
    var group = groupOfCamera(cam);
    if (!group) return;
    try { trackDead(s, viewIds()); } catch (e) {}
    var now = performance.now(), alive = group.filter(function (pid) { return !(deadSince[pid] && now - deadSince[pid] >= 2000); });
    if (!alive.length) alive = group;
    var pts = [];
    alive.forEach(function (pid) {
      var C = playerChar(pid, s), b = C && C.cameraFocus, p = b && b.GetPosition && b.GetPosition();
      if (!p || !isFinite(p.x)) return;
      var v = b.GetLinearVelocity && b.GetLinearVelocity();
      pts.push({ pid: pid, x: p.x, y: p.y, vx: v ? v.x : 0, vy: v ? v.y : 0 });
    });
    if (!pts.length) return;
    // look ahead for the leader (the group's living player furthest from where they started): a point in
    // front of them along their motion is framed too, so the view leans ahead of whoever is in front
    var lead = null;
    for (var li = 0; li < aliveNow.length && !lead; li++) if (alive.indexOf(aliveNow[li].pid) >= 0) lead = aliveNow[li].pid;
    var LC = lead && playerChar(lead, s), lb = LC && LC.cameraFocus, lp = lb && lb.GetPosition && lb.GetPosition(), lvv = lb && lb.GetLinearVelocity && lb.GetLinearVelocity();
    var aheadPt = null;
    if (lp && lvv && isFinite(lvv.x)) {
      var ax = lvv.x * 0.7, ay = lvv.y * 0.35, al = Math.sqrt(ax * ax + ay * ay), amax = 9;   // 0.7 s ahead, at most 9 m
      if (al > amax) { ax *= amax / al; ay *= amax / al; }
      // smoothed, so a bump or a crash doesn't throw the view around
      cam.hwssAhead = cam.hwssAhead || { x: 0, y: 0 };
      cam.hwssAhead.x += (ax - cam.hwssAhead.x) * 0.05; cam.hwssAhead.y += (ay - cam.hwssAhead.y) * 0.05;
      aheadPt = { x: lp.x + cam.hwssAhead.x, y: lp.y + cam.hwssAhead.y };
    }
    var ps = cam.m_physScale || 62.5, base = cam.hwssBaseZoom || cam.zoom || 1;
    var ZMIN = typeof cfg.sharedMinZoom === 'number' ? cfg.sharedMinZoom : 0.2;
    // the zoom a set of players needs to fit (with room around them, and the leader's look-ahead point)
    function box(list) {
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      list.concat(aheadPt ? [aheadPt] : []).forEach(function (q) { b.x0 = Math.min(b.x0, q.x); b.x1 = Math.max(b.x1, q.x); b.y0 = Math.min(b.y0, q.y); b.y1 = Math.max(b.y1, q.y); });
      return b;
    }
    function need(list) { var b = box(list); return Math.min(W * 0.85 / ((b.x1 - b.x0) * ps + 260), FULL * 0.8 / ((b.y1 - b.y0) * ps + 200)); }
    // too spread out even at the widest zoom: leave out the players furthest from the leader (the ones far
    // behind) until the rest fit (TheSplitScreenGuy's request). A left-out player comes back once they fit with 15% to spare,
    // so nobody flickers at the edge. The markers' edge arrows still show where they are.
    var anchor = null;
    for (var ai = 0; ai < pts.length; ai++) if (pts[ai].pid === lead) anchor = pts[ai];
    anchor = anchor || pts.filter(function (q) { return q.pid === 1; })[0] || pts[0];
    var dropped = cam.hwssDropped || (cam.hwssDropped = {}), inc = pts.slice(), nowDropped = {};
    while (inc.length > 1) {
      var far = null, fd = -1;
      inc.forEach(function (q) { if (q === anchor) return; var d = Math.hypot(q.x - anchor.x, q.y - anchor.y); if (d > fd) { fd = d; far = q; } });
      if (!far || need(inc) >= ZMIN * (dropped[far.pid] ? 1.15 : 1)) break;
      inc.splice(inc.indexOf(far), 1); nowDropped[far.pid] = true;
    }
    pts.forEach(function (q) { if (!!nowDropped[q.pid] !== !!dropped[q.pid]) log('split', 'shared screen: P' + q.pid + (nowDropped[q.pid] ? ' too far behind, left out' : ' back in the shot')); });
    cam.hwssDropped = nowDropped;
    var bb = box(inc), x0 = bb.x0, y0 = bb.y0, x1 = bb.x1, y1 = bb.y1, vx = 0, vy = 0, n = inc.length;
    inc.forEach(function (q) { vx += q.vx; vy += q.vy; });
    if (!cam.hwssGroupFocus) {
      cam.hwssGroupFocus = makeFocus();
      if (cam._focus !== cam.hwssGroupFocus) cam.hwssOrigFocus = cam._focus;
      cam.hwssBaseZoom = cam.hwssBaseZoom || cam.zoom || 1;
    }
    var f = cam.hwssGroupFocus;
    f.p.x = (x0 + x1) / 2; f.p.y = (y0 + y1) / 2; f.v.x = vx / n; f.v.y = vy / n;
    cam._focus = f;
    // zoom: the players' spread (+ room around them) must fit the view; never closer than normal
    base = cam.hwssBaseZoom || 1;
    var target = Math.max(ZMIN, Math.min(base, need(inc)));
    var z = cam.zoom || base;
    cam.zoom = Math.abs(target - z) < 0.002 ? target : z + (target - z) * (target < z ? 0.08 : 0.03);   // out fast, in slowly
  }
  // After the camera's own step: the game's camera only nudges the view when its focus leaves a box around
  // the screen centre (and changing zoom every frame throws that off), so in shared-screen mode the world
  // layer is placed here instead — the group's middle exactly at the screen centre, approached smoothly.
  function sharedCameraPlace(cam) {
    var f = cam.hwssGroupFocus, co = cam._containerObj;
    if (!f || cam._focus !== f || !co) return;
    var ps = cam.m_physScale || 62.5, z = cam.zoom || 1;
    var tx = W / 2 - f.p.x * ps * z, ty = FULL / 2 - f.p.y * ps * z;
    if (cam.hwssPx == null || Math.abs(cam.hwssPx - tx) > 3000 || Math.abs(cam.hwssPy - ty) > 3000) { cam.hwssPx = tx; cam.hwssPy = ty; }
    cam.hwssPx += (tx - cam.hwssPx) * 0.2; cam.hwssPy += (ty - cam.hwssPy) * 0.2;
    co.x = cam.hwssPx; co.y = cam.hwssPy;
    try { if (typeof cam.adjustBackDrops === 'function') cam.adjustBackDrops(); } catch (e) {}
  }

  // alpha the game passes to its camera each frame (interpolation fraction)
  var lastAlpha = 1, hookedCamProtos = new WeakSet();
  function hookCameraClass(s) {
    var proto = s._camera && Object.getPrototypeOf(s._camera);
    if (!proto || hookedCamProtos.has(proto) || typeof proto.step !== 'function') return;
    hookedCamProtos.add(proto);
    var orig = proto.step;
    proto.step = function (a) {
      if (session && this === session._camera) lastAlpha = a;
      try { sharedCamera(this); } catch (e) { if (!S.shareErr) { S.shareErr = true; log('split-error', 'shared screen: ' + (e && e.stack || e)); } }
      var r = orig.apply(this, arguments);
      try { sharedCameraPlace(this); } catch (e) { if (!S.shareErr) { S.shareErr = true; log('split-error', 'shared screen place: ' + (e && e.stack || e)); } }
      // The camera positions the button container (invisible click areas of "click" triggers) with
      // the world layer but never scales it, so with zoom != 1 every click area drifts away from its
      // graphics. Keep its scale equal to the world layer's.
      try {
        var w = this._containerObj && this._containerObj._pixiSprite, b = this._buttonContainer && this._buttonContainer._pixiSprite;
        if (w && b && (b.scale.x !== w.scale.x || b.scale.y !== w.scale.y)) b.scale.set(w.scale.x, w.scale.y);
      } catch (e) {}
      return r;
    };
    zoomAwareCamera(s._camera);
  }

  // The camera's screenBounds and midScreenPoint ignore zoom. Culling uses screenBounds
  // (session.overlapsCamera) and the sound manager uses midScreenPoint as the listener
  // (SoundController.step: _center = currentSession.camera.midScreenPoint), so when zoomed out the level
  // vanished and every positional sound was "too far away". Correct both (no effect at zoom 1).
  function zoomAwareCamera(cam) {
    function accessorOwner(o, name) { for (var p = Object.getPrototypeOf(o); p; p = Object.getPrototypeOf(p)) { var d = Object.getOwnPropertyDescriptor(p, name); if (d) return { proto: p, desc: d }; } return null; }
    // 1.99.3: the getters' real (renamed) names: wrapping an alias would not change what the game reads
    var SBN = H.N ? H.N.real('screenBounds') : 'screenBounds', MIDN = H.N ? H.N.real('midScreenPoint') : 'midScreenPoint';
    var sb = accessorOwner(cam, SBN), mid = accessorOwner(cam, MIDN);
    if (sb && sb.desc.get && !sb.desc.get.hwss) {
      var getSB = sb.desc.get;
      var g1 = function () {
        var r = getSB.call(this), z = this.zoom;
        // shared screen places the world layer itself: the visible area follows from that placement
        // (the camera's own idea of it lags behind, and the game culled objects that were on screen)
        var co = this._containerObj;
        if (this.hwssGroupFocus && this._focus === this.hwssGroupFocus && co && z) {
          var sc = Object.create(Object.getPrototypeOf(r));
          Object.keys(r).forEach(function (k) { sc[k] = r[k]; });
          var m = 120;                                   // a margin: things just off the edge stay drawn
          sc.x = -co.x / z - m; sc.y = -co.y / z - m; sc.width = W / z + 2 * m; sc.height = FULL / z + 2 * m;
          return sc;
        }
        if (!z || z === 1) return r;
        var c = Object.create(Object.getPrototypeOf(r));
        Object.keys(r).forEach(function (k) { c[k] = r[k]; });
        c.x = r.x / z; c.y = r.y / z; c.width = r.width / z; c.height = r.height / z;
        return c;
      };
      g1.hwss = true;
      Object.defineProperty(sb.proto, SBN, { configurable: true, enumerable: sb.desc.enumerable, set: sb.desc.set, get: g1 });
    }
    if (mid && mid.desc.get && !mid.desc.get.hwss) {
      var getMid = mid.desc.get, Pt = getMid.call(cam).constructor;
      var g2 = function () {
        if (!this.zoom || this.zoom === 1) return getMid.call(this);
        var b = this[SBN], ps = this.m_physScale;
        return new Pt((b.x + b.width / 2) / ps, (b.y + b.height / 2) / ps);
      };
      g2.hwss = true;
      Object.defineProperty(mid.proto, MIDN, { configurable: true, enumerable: mid.desc.enumerable, set: mid.desc.set, get: g2 });
    }
    log('split', 'camera made zoom-aware (screenBounds, midScreenPoint)');
  }

  // ---------- 5. players + their cameras ----------
  function anyJoined() { return !!(H.PL && H.PL.anyJoined()); }
  function charOf(pid, s) { return H.PL ? H.PL.charOf(pid, s) : (pid === 1 && s ? s._character : null); }
  // the separate world of player pid while separate worlds run for session s, else null
  function sepWorld(s, pid) { return H.W2 && H.W2.active && H.W2.active(s) ? H.W2.worldFor(pid) : null; }
  // who gets a view: P1, then the joined extra players by number (at most 4 views)
  function viewIds() {
    var ids = H.PL ? H.PL.joinedIds() : [];
    if (!ids.length && cfg.forceSplit) ids = [2];
    return [1].concat(ids.slice(0, 3));
  }
  S.viewIds = viewIds;
  function cloneCamera(c) {
    var n = Object.create(Object.getPrototypeOf(c));
    Object.getOwnPropertyNames(c).forEach(function (k) {
      var v = c[k];
      var isVec = v && typeof v === 'object' && typeof v.x === 'number' && typeof v.y === 'number' && !('parent' in v) && !('children' in v);
      n[k] = isVec ? Object.assign(Object.create(Object.getPrototypeOf(v)), v) : v;
    });
    return n;
  }
  // Shared world: each extra player's view = a clone of P1's camera following that player's rider
  // (P1's focus while the rider doesn't exist yet). Recreated when the game makes a new camera.
  var cams = {}, camsFor = null;
  function camFor(s, pid) {
    if (camsFor !== s._camera) { camsFor = s._camera; cams = {}; }
    var c = cams[pid];
    if (!c) { c = cams[pid] = cloneCamera(s._camera); c.hwssGroupFocus = null; c.hwssOrigFocus = null; log('split', 'camera for P' + pid + ' created'); }
    c.hwssPid = pid;
    var ch = charOf(pid, s);
    c._focus = ch && ch.cameraFocus ? ch.cameraFocus : s._camera._focus;
    return c;
  }
  S.cams = function () { return cams; };
  // audio.js: centres of the extra views' cameras (sound listeners)
  // Shared world: listener positions saved during each view's draw (listenerAt), because the clone
  // cameras' midScreenPoint reads the level layer P1's camera owns — read later, every extra listener
  // was P1's centre (measured: extra listeners never won a single sound in shared worlds).
  var listenerAt = {};
  S.extraListeners = function () {
    var s = H.session, out = [];
    if (!s) return out;
    viewIds().slice(1).forEach(function (pid) {
      var w = sepWorld(s, pid);
      try {
        if (w && w._camera) out.push(w._camera.midScreenPoint);
        else if (listenerAt[pid] && charOf(pid, s)) { var L = listenerAt[pid]; out.push(new L.P(L.x, L.y)); }
      } catch (e) {}
    });
    return out;
  };

  // ---------- "cache static art" (pause-menu toggle, saved; default off) ----------
  // Levels drawn from thousands of small art pieces (pixel-art levels: ~3,600 pieces on screen, ~7 ms of
  // drawing per frame and view) are slow. A group of art whose CONTENT has not changed for a while is
  // drawn once into a texture; the group then shows that one picture and its pieces are not drawn
  // (renderable off). The group itself may still move, hide or fade (that's its own transform). Anything
  // changing INSIDE it (a piece moving, appearing, hiding, fading, animating) drops the cache at once.
  // Watched: groups under each level layer with >= ART_MIN sprites (riders' parts are far below that).
  var ART_KEY = 'hwss.artCache', artCache = null, ART_MIN = 30, ART_MAX_PX = 4096, ART_BUDGET = 64e6;
  var artGroups = new Map(), artFrame = 0, artPixels = 0;   // pixi container → state
  S.getArtCache = function () {
    if (artCache === null) { try { artCache = window.localStorage.getItem(ART_KEY) === 'on'; } catch (e) { artCache = false; } }
    return artCache;
  };
  S.toggleArtCache = function () {
    artCache = !S.getArtCache();
    try { window.localStorage.setItem(ART_KEY, artCache ? 'on' : 'off'); } catch (e) {}
    log('split', 'cache static art -> ' + (artCache ? 'on' : 'off'));
    return artCache;
  };
  S.artStats = function () { var n = 0; artGroups.forEach(function (g) { if (g.rt) n++; }); return { watched: artGroups.size, cached: n, megapixels: Math.round(artPixels / 1e5) / 10 }; };
  // content signature of a group's pieces (not the group's own transform/visibility)
  function artSig(st) {
    var s = 0, n = 0;
    function walk(o) {
      for (var i = 0; i < o.children.length; i++) {
        var c = o.children[i], t = c.transform, tex = c.texture;
        if (c === st.spr) continue;                      // our own cached picture
        n++;
        s = (s * 31 + (t ? t._localID : 0) + (c.visible ? 7 : 3) + Math.round(c.alpha * 100) * 11 + c.children.length * 13 +
             (tex ? (tex.baseTexture ? tex.baseTexture.uid : 0) * 17 + (tex.frame ? tex.frame.x + tex.frame.y * 3 : 0) : 0)) % 2147483647;
        if (c.children.length) walk(c);
      }
    }
    walk(st.g);
    return s + ':' + n;
  }
  // drawn pieces (sprites, vector shapes: anything without children) under o, counting up to cap
  function spriteCount(o, cap) {
    var n = 0;
    (function walk(x) { if (n > cap) return; if (!x.children || !x.children.length) { n++; return; } for (var i = 0; i < x.children.length; i++) walk(x.children[i]); })(o);
    return n;
  }
  // nothing that drawing into a texture would change: no filters, masks or unusual blend modes inside
  function artPlain(o) {
    var ok = true;
    (function walk(x) { if (!ok) return; if (x.filters || x.mask || (x.blendMode && x.blendMode !== 0)) { ok = false; return; } for (var i = 0; i < x.children.length; i++) walk(x.children[i]); })(o);
    return ok;
  }
  function artUncache(st) {
    if (!st.rt) return;
    try { if (st.spr && st.spr.parent) st.spr.parent.removeChild(st.spr); } catch (e) {}
    (st.hidden || []).forEach(function (e) { try { e[0].renderable = e[1]; } catch (x) {} });
    try { st.rt.destroy(true); } catch (e) {}
    artPixels -= st.px || 0;
    st.rt = null; st.spr = null; st.hidden = null; st.px = 0; st.stable = 0;
  }
  function artCacheGroup(renderer, st) {
    var g = st.g, lb = g.getLocalBounds();
    var zoom = 1;
    for (var o = g, i = 0; o && i < 30; i++, o = o.parent) zoom *= Math.abs(o.scale.x) || 1;
    // texture detail = what the group is shown at (camera zoom), capped so zooming in can't blow up memory
    var res = renderer.resolution * Math.max(0.25, Math.min(1.5, zoom));
    var w = Math.ceil(lb.width) + 2, h = Math.ceil(lb.height) + 2;
    if (!(w > 2 && h > 2) || w * res > ART_MAX_PX || h * res > ART_MAX_PX) { st.skip = true; return; }
    var px = w * h * res * res;
    if (artPixels + px > ART_BUDGET) return;              // over the memory budget: stays normal
    var rt = P.RenderTexture.create({ width: w, height: h, resolution: res });
    var M = P.Matrix ? new P.Matrix(1, 0, 0, 1, 1 - lb.x, 1 - lb.y) : null;
    if (!M) { rt.destroy(true); st.skip = true; return; }
    var first = true, kids = g.children.slice();
    kids.forEach(function (c) {
      if (!c.visible) return;
      origRenderRef.call(renderer, c, { renderTexture: rt, clear: first, transform: M });
      first = false;
    });
    if (first) origRenderRef.call(renderer, new P.Container(), { renderTexture: rt, clear: true });
    var spr = new P.Sprite(rt);
    spr.position.set(lb.x - 1, lb.y - 1);
    st.hidden = kids.map(function (c) { var r = c.renderable; c.renderable = false; return [c, r]; });
    g.addChild(spr);
    st.rt = rt; st.spr = spr; st.px = px; artPixels += px;
    st.sig = artSig(st);
  }
  var origRenderRef = null;
  function artCandidates(sess, out) {
    var root = sess && sess._containerSprite && sess._containerSprite._pixiSprite;
    if (!root) return;
    root.children.forEach(function (layer) {
      (layer.children || []).forEach(function add(g, depth) {
        if (!g.children || !g.children.length || artGroups.has(g)) return;
        if (spriteCount(g, ART_MIN) < ART_MIN) return;
        // very large groups: their parts instead (one level down)
        var lb = g.getLocalBounds();
        if ((lb.width > ART_MAX_PX / 2 || lb.height > ART_MAX_PX / 2) && (depth || 0) < 2) { g.children.forEach(function (c) { add(c, (depth || 0) + 1); }); return; }
        if (!artPlain(g)) return;
        out.push(g);
      });
    });
  }
  function artUncacheAll() { artGroups.forEach(function (st) { artUncache(st); }); artGroups.clear(); artPixels = 0; }
  function artCacheTick(renderer, sess) {
    origRenderRef = origRenderRef || S.origRender;
    if (!S.getArtCache() || !sess) { if (artGroups.size) artUncacheAll(); return; }
    artFrame++;
    // cached groups: dropped the moment their content changes (checked every 4th frame)
    if (artFrame % 4 === 0) {
      artGroups.forEach(function (st, g) {
        var gone = !g.parent || g.destroyed;
        if (gone) { artUncache(st); artGroups.delete(g); return; }
        if (st.rt) {
          var sig = artSig(st);                           // (our own picture is not part of it)
          if (sig !== st.sig) { artUncache(st); st.sig = sig; st.drops = (st.drops || 0) + 1; }
        }
      });
    }
    if (artFrame % 20 !== 0) return;
    // every 20 frames: new candidates, and watched groups that kept still for 2 checks get cached
    var worlds = [sess];
    if (H.W2 && H.W2.worlds) H.W2.worlds.forEach(function (e) { var x = e.S || e.session || e.s; if (x) worlds.push(x); });
    var fresh = [];
    worlds.forEach(function (w) { artCandidates(w, fresh); });
    fresh.forEach(function (g) { artGroups.set(g, { g: g, sig: null, stable: 0 }); });
    var budget = 6;                                       // a few groups per tick (no hitch)
    artGroups.forEach(function (st) {
      if (st.rt || st.skip || budget <= 0 || (st.drops || 0) >= 3) return;   // changed 3 times: animated, leave it
      var sig = artSig(st);
      if (sig === st.sig) st.stable++; else { st.stable = 0; st.sig = sig; }
      if (st.stable >= 2) { budget--; artCacheGroup(renderer, st); }
    });
  }

  // ---------- monitor mode: the window spans every monitor, one player per monitor ----------
  // steamguard.js (main process) moves the window; it answers through window.__hwssMonitors(info).
  // Here: the canvas fills the whole window and the renderer's logical size becomes (500 * window aspect)
  // x 500, so a logical pixel stays square; each monitor is a rectangle in those coordinates (S.mon.rects).
  // Split: views are placed per monitor (layoutFor). Not split (menus, pause, P1 alone): the game's
  // 900x500 stage is drawn fitted into P1's monitor (monitorSingle); the other monitor shows a card with
  // its players (or "Press Start To Join", the winner, the scoreboard). The window itself is moved by the
  // main process (steamguard.js; 1.99.3 native game window via a Win32 helper).
  var MON_KEY = 'hwss.monitors';
  S.mon = { avail: false, on: false, rects: null, key: '', want: null };
  function monSaved() { try { return window.localStorage.getItem(MON_KEY) === 'on'; } catch (e) { return false; } }
  window.__hwssMonitors = function (info) {
    try {
      var ds = (info && info.displays) || [], u = info && info.union;
      S.mon.avail = ds.length >= 2;
      var on = !!(info && info.on) && S.mon.avail && u && u.w > 0 && u.h > 0;
      if (on) {
        // P1's monitor first (the primary one, else the left-most), then left to right
        var order = ds.slice().sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.x - b.x || a.y - b.y; });
        var LW = FULL * u.w / u.h;
        S.mon.rects = order.map(function (d) { return { x: (d.x - u.x) / u.w * LW, y: (d.y - u.y) / u.h * FULL, w: d.w / u.w * LW, h: d.h / u.h * FULL }; });
        S.mon.lw = LW;
        S.mon.key = S.mon.rects.map(function (r) { return [r.x, r.y, r.w, r.h].map(Math.round).join(','); }).join(';');
      }
      if (on !== S.mon.on) { S.mon.on = on; log('split', 'monitor mode ' + (on ? 'ON (' + ds.length + ' monitors)' : 'OFF')); if (!on) monRestore(); }
      var first = !S.mon.answered;
      S.mon.answered = true;
      S.mon.want = null;                                 // main has answered (the switch is done)
      if (first && !on && S.mon.avail && monSaved()) { S.mon.want = true; window.__hwssMonReq = 'on'; }   // saved: back on at start
    } catch (e) { log('split-error', 'monitors: ' + (e && e.stack || e)); }
  };
  S.monitorsAvailable = function () { return S.mon.avail; };
  S.getMonitors = function () { return S.mon.on; };
  S.getMonitorsWanted = function () { return S.mon.want != null ? S.mon.want : S.mon.on; };
  S.toggleMonitors = function () {
    var want = !S.mon.on;
    S.mon.want = want;
    try { window.localStorage.setItem(MON_KEY, want ? 'on' : 'off'); } catch (e) {}
    window.__hwssMonReq = want ? 'on' : 'off';
    log('split', 'monitor mode requested ' + (want ? 'on' : 'off'));
    return want;
  };
  setTimeout(function () { window.__hwssMonReq = 'query'; }, 1500);
  // per frame while on: canvas over the whole window, renderer at the window's aspect (the game's own
  // resize handler puts it back to 900x500 on every window resize; this undoes that)
  var monPrev = null;
  function monEnforce(renderer) {
    var v = renderer.view, iw = window.innerWidth, ih = window.innerHeight, dpr = window.devicePixelRatio || 1;
    var LW = FULL * iw / ih, res = ih * dpr / FULL;
    if (!monPrev) monPrev = { res: renderer.resolution };
    if (Math.abs(renderer.screen.width - LW) > 0.5 || Math.abs(renderer.screen.height - FULL) > 0.5 || Math.abs(renderer.resolution - res) > 0.01) {
      renderer.resolution = res;
      renderer.resize(LW, FULL);
      S.mon.lw = LW;
    }
    // Pixi's interaction manager keeps its own copy of the resolution (mouse → game coordinates)
    var im = renderer.plugins && renderer.plugins.interaction;
    if (im && im.resolution !== renderer.resolution) im.resolution = renderer.resolution;
    var st = v.style;
    if (st.left !== '0px' || st.top !== '0px' || st.width !== iw + 'px' || st.height !== ih + 'px') {
      st.position = 'absolute'; st.left = '0px'; st.top = '0px'; st.width = iw + 'px'; st.height = ih + 'px';
    }
  }
  function monRestore() {
    var R = H.renderer;
    if (!R || !monPrev) return;
    try { R.resolution = monPrev.res; R.resize(W, FULL); } catch (e) {}
    try { var im = R.plugins && R.plugins.interaction; if (im) im.resolution = R.resolution; } catch (e) {}
    monPrev = null;
    try { window.dispatchEvent(new Event('resize')); } catch (e) {}   // the game lays its canvas out again
  }
  // the 900x500 game area fitted (letterboxed) into P1's monitor, in logical coordinates
  function monGameRect(mi) {
    var r = S.mon.rects[mi || 0] || S.mon.rects[0], s = Math.min(r.w / W, r.h / FULL);
    return { x: r.x + (r.w - W * s) / 2, y: r.y + (r.h - FULL * s) / 2, s: s };
  }
  // page-pixel rectangle of the game's 900x500 area (DOM overlays: banners, pause tag, character select)
  // (mi: which monitor's copy of the game area; the character select is shown on both)
  H.gameRect = function (mi) {
    var R = H.renderer, v = R && R.view;
    if (!v) return null;
    var b = v.getBoundingClientRect();
    if (!S.mon.on || !S.mon.rects) return { left: b.left, top: b.top, width: b.width, height: b.height };
    var g = monGameRect(mi), k = b.height / FULL;
    return { left: b.left + g.x * k, top: b.top + g.y * k, width: W * g.s * k, height: FULL * g.s * k };
  };
  var monRT = null, monSpr = null, monRoot = null, monRT2 = null, monSpr2 = null;
  function monitorSingle(renderer, root, render) {
    hookMouse(renderer);
    var res = renderer.resolution;
    if (!monRT || monRT.baseTexture.resolution !== res) {
      [monRT, monRT2].forEach(function (t) { if (t) { try { t.destroy(true); } catch (e) {} } });
      monRT = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: res });
      monRT2 = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: res });
      monSpr = new P.Sprite(new P.Texture(monRT.baseTexture, new P.Rectangle(0, 0, W, FULL)));
      monSpr2 = new P.Sprite(new P.Texture(monRT2.baseTexture, new P.Rectangle(0, 0, W, FULL)));
      monRoot = new P.Container(); monRoot.addChild(monSpr);
    }
    // Character select with players on the other monitor: the screen is drawn twice, each monitor with
    // only its own players' pedestals (p2.js csMonitorPass). The other monitor first, P1's last, so the
    // stage ends the frame laid out for P1's monitor (mouse hit tests).
    var csPass = H.PL && H.PL.csMonitorPass && S.mon.rects.length > 1 && H.PL.csMonitorPass(1);
    if (csPass) {
      try { render.call(renderer, root, { renderTexture: monRT2, clear: true }); }
      finally { H.PL.csMonitorPass(0); }
    }
    try { render.call(renderer, root, { renderTexture: monRT, clear: true }); }
    finally { if (csPass) H.PL.csMonitorPass(-1); }
    var g = monGameRect();
    monSpr.x = g.x; monSpr.y = g.y; monSpr.scale.set(g.s, g.s);
    if (csPass) {
      var g2 = monGameRect(1);
      monSpr2.x = g2.x; monSpr2.y = g2.y; monSpr2.scale.set(g2.s, g2.s);
      if (monRoot.hwssCardKey !== 'cs') { monRoot.hwssCardKey = 'cs'; monRoot.children.slice(1).forEach(function (c) { monRoot.removeChild(c); }); monRoot.addChild(monSpr2); }
    }
    // the other monitor(s): a card naming the players who play there ("P2", "P2 / P3", "P3 / P4")
    // nobody has joined: the second monitor invites P2 ("Press Start To Join")
    // a co-op level just ended: "P3 Wins!" there too (the banner itself is on P1's monitor)
    var who = monitorPlayers(), solo = viewIds().length < 2, sess = H.session;
    var wonBy = sess && H.inLevel && sess.hwssLevelDone && sess.hwssCoop && sess.hwssWinner && sess.hwssWinner !== 'p0' ? String(sess.hwssWinner).toUpperCase() : '';
    var sub = wonBy ? wonBy + ' Wins!' : solo ? 'Press Start To Join' : '';
    // the win scoreboard (pause / level complete, co-op, "scoreboard: on") is on this monitor too
    var board = null;
    if (!solo && sess && H.inLevel && sess.hwssCoop && (sess.paused || sess.hwssLevelDone) && H.PL && H.PL.getScoreboard && H.PL.getScoreboard()) {
      var wins = H.PL.wins ? H.PL.wins() : {};
      board = viewIds().map(function (pid) { return { pid: pid, wins: wins[pid] || 0 }; });
    }
    var cardKey = who.map(function (l) { return l.join('/'); }).join('|') + '|' + sub + '|' + (board ? JSON.stringify(board) : '') + '|' + S.mon.key + '|' + res;
    if (!csPass && monRoot.hwssCardKey !== cardKey) {
      monRoot.hwssCardKey = cardKey;
      monRoot.children.slice(1).forEach(function (c) { monRoot.removeChild(c); });
      S.mon.rects.forEach(function (r, mi) {
        if (!mi || !who[mi] || !who[mi].length) return;
        var sp = new P.Sprite(monCardTexture(who[mi], r, res, sub, board));
        sp.x = r.x; sp.y = r.y; sp.width = r.w; sp.height = r.h;
        monRoot.addChild(sp);
      });
    }
    S.lastSplit = { key: 'mon1', slots: [{ x: g.x, y: g.y, w: W * g.s, h: FULL * g.s, sx: g.s, sy: g.s, fw: W, fh: FULL, frame: { x: 0, y: 0 }, pid: 1, sep: false, c: { x: 0, y: 0 }, owner: 1 }], c1: { x: 0, y: 0 }, mon: true };
    render.call(renderer, monRoot);                    // clears the whole canvas, other monitors black
    // Pixi hit-tests against the last object rendered: make that the game's stage again
    renderer._lastObjectRendered = root;
  }
  // which views go on which monitor (indices into the view list): P1's monitor fills first, the rest go
  // on the other one — 2: P1 | P2; 3: P1 | P2/P3; 4: P1/P2 | P3/P4 (TheSplitScreenGuy's choice)
  function monitorAssign(n) {
    var m = S.mon.rects.length, per = S.mon.rects.map(function () { return []; });
    var first = n <= 1 ? n : Math.floor(n / 2);
    for (var k = 0; k < n; k++) per[k < first || m < 2 ? 0 : 1].push(k);
    return per;
  }
  // a card for a monitor with no picture right now (menus, pause): "P2" or "P2 / P3", player colours
  var monCards = {};
  // board: [{pid, wins}] = the win scoreboard (pause / level complete, when shown), drawn on the right
  function monCardTexture(pids, r, res, sub, board) {
    var boardKey = board ? board.map(function (b) { return b.pid + ':' + b.wins; }).join(',') : '';
    var key = pids.join('/') + '|' + (sub || '') + '|' + boardKey + '|' + [r.w, r.h].map(Math.round).join('x') + '|' + res;
    if (monCards[key]) return monCards[key];
    var cw = Math.max(1, Math.round(r.w * res)), ch = Math.max(1, Math.round(r.h * res));
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    var g = cv.getContext('2d'), hue0 = H.PL && H.PL.hueOf ? H.PL.hueOf(pids[0]) : 0;
    if (typeof hue0 !== 'number') hue0 = 0;
    var grad = g.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, Math.max(cw, ch) * 0.7);
    grad.addColorStop(0, 'hsl(' + hue0 + ',35%,16%)'); grad.addColorStop(1, 'hsl(' + hue0 + ',30%,4%)');
    g.fillStyle = grad; g.fillRect(0, 0, cw, ch);
    var fs = Math.round(ch * 0.22);
    g.font = '900 ' + fs + 'px "Arial Black", Arial, sans-serif';
    g.textBaseline = 'middle';
    var parts = [];
    pids.forEach(function (pid, i) {
      if (i) parts.push({ t: ' / ', c: 'rgba(255,255,255,.55)' });
      var h = H.PL && H.PL.hueOf ? H.PL.hueOf(pid) : 0;
      parts.push({ t: 'P' + pid, c: typeof h === 'number' ? 'hsl(' + h + ',85%,58%)' : '#fff' });
    });
    var total = parts.reduce(function (a, q) { return a + g.measureText(q.t).width; }, 0), x = (cw - total) / 2;
    g.lineJoin = 'round'; g.lineWidth = Math.max(2, fs * 0.08); g.strokeStyle = '#0d1426';
    // banner along the top: the mod's name (TheSplitScreenGuy's request)
    (function () {
      var bh = ch * 0.13, bf = Math.round(ch * 0.055);
      var bg = g.createLinearGradient(0, 0, 0, bh);
      bg.addColorStop(0, 'rgba(0,0,0,.55)'); bg.addColorStop(1, 'rgba(0,0,0,.2)');
      g.fillStyle = bg; g.fillRect(0, 0, cw, bh);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(0, bh - Math.max(1, ch * 0.003), cw, Math.max(1, ch * 0.003));
      g.save();
      g.font = '900 ' + bf + 'px "Arial Black", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = Math.max(2, bf * 0.12); g.strokeStyle = '#0d1426';
      g.strokeText('Happy Wheels Split Screen', cw / 2, bh / 2);
      g.fillStyle = '#fff'; g.fillText('Happy Wheels Split Screen', cw / 2, bh / 2);
      g.restore();
    })();
    var ty = sub ? ch * 0.44 : ch / 2;
    parts.forEach(function (q) { g.strokeText(q.t, x, ty); g.fillStyle = q.c; g.fillText(q.t, x, ty); x += g.measureText(q.t).width; });
    if (sub) {                                         // "Press Start To Join" / "P3 Wins!" under the names
      var win = /^P(\d) Wins!$/.exec(sub), fs2 = Math.round(ch * (win ? 0.1 : 0.06));
      g.font = '900 ' + fs2 + 'px "Arial Black", Arial, sans-serif';
      g.textAlign = 'center'; g.lineWidth = Math.max(2, fs2 * 0.12);
      var wh = win && H.PL && H.PL.hueOf ? H.PL.hueOf(+win[1]) : null;
      g.strokeText(sub, cw / 2, ch * 0.64);
      g.fillStyle = typeof wh === 'number' ? 'hsl(' + wh + ',85%,58%)' : '#fff';
      g.fillText(sub, cw / 2, ch * 0.64);
    }
    if (board && board.length) {                       // "WINS" + one row per player, like monitor 1's
      var rf = Math.round(ch * 0.05), lh = rf * 1.3, bwid = rf * 5.2, bh2 = lh * (board.length + 1) + rf * 0.9;
      var bx = cw - bwid - cw * 0.04, by = (ch - bh2) / 2;
      g.save();
      g.fillStyle = 'rgba(20,30,55,.72)'; g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = Math.max(2, rf * 0.06);
      var rr = rf * 0.4;
      g.beginPath(); g.moveTo(bx + rr, by); g.arcTo(bx + bwid, by, bx + bwid, by + bh2, rr); g.arcTo(bx + bwid, by + bh2, bx, by + bh2, rr);
      g.arcTo(bx, by + bh2, bx, by, rr); g.arcTo(bx, by, bx + bwid, by, rr); g.closePath(); g.fill(); g.stroke();
      g.textAlign = 'left'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.font = '900 ' + Math.round(rf * 0.7) + 'px "Arial Black", Arial, sans-serif';
      g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText('WINS', bx + rf * 0.6, by + rf * 0.45 + lh / 2);
      g.font = '900 ' + rf + 'px "Arial Black", Arial, sans-serif';
      board.forEach(function (b, i) {
        var h = H.PL && H.PL.hueOf ? H.PL.hueOf(b.pid) : 0, y = by + rf * 0.45 + lh * (i + 1.5), txt = 'P' + b.pid + '  ' + b.wins;
        g.lineWidth = Math.max(2, rf * 0.1); g.strokeStyle = '#13213d'; g.strokeText(txt, bx + rf * 0.6, y);
        g.fillStyle = typeof h === 'number' ? 'hsl(' + h + ',85%,58%)' : '#fff'; g.fillText(txt, bx + rf * 0.6, y);
      });
      g.restore();
    }
    var t = P.Texture.from(cv, { resolution: res });
    monCards[key] = t;
    return t;
  }
  S.monitorPlayers = function () { return S.mon.on && S.mon.rects ? monitorPlayers() : null; };
  // the players on each monitor (nobody joined yet: the second monitor is P2's)
  function monitorPlayers() {
    var ids = viewIds().slice();
    while (ids.length < 2) ids.push(ids.length + 1);
    return monitorAssign(ids.length).map(function (ks) { return ks.map(function (k) { return ids[k]; }); });
  }
  // the slots of each monitor for n views; two views on one monitor stack
  function monitorLayout(n) {
    var rects = S.mon.rects, per = monitorAssign(n);
    var o = S.getModeMon(), whole = o === 'fit' || o === 'fitv', sideBySide = o === 'vertical' || o === 'fitv';
    var slots = new Array(n), lines = [], bars = [];
    per.forEach(function (ks, mi) {
      var r = rects[mi], c = ks.length;
      ks.forEach(function (k, j) {
        // this view's part of the monitor: the whole monitor, or half (stacked / side by side)
        var R = c < 2 ? r : sideBySide ? { x: r.x + j * r.w / c, y: r.y, w: r.w / c, h: r.h } : { x: r.x, y: r.y + j * r.h / c, w: r.w, h: r.h / c };
        if (whole) {
          // letterbox: the whole 900x500 view, as big as fits, centred (black around it)
          var sw = Math.min(R.w / W, R.h / FULL);
          var sl = slots[k] = { x: R.x + (R.w - W * sw) / 2, y: R.y + (R.h - FULL * sw) / 2, fw: W, fh: FULL, sx: sw, sy: sw, crop: false };
          // the uncovered strips of its part are this view's bars (bar styles: black / blur / color / art)
          var region = [R.x, R.y, R.w, R.h], vw = W * sw, vh = FULL * sw;
          if (sl.x - R.x > 0.5) bars.push({ r: [R.x, R.y, sl.x - R.x, R.h], slot: k, region: region }, { r: [sl.x + vw, R.y, R.x + R.w - sl.x - vw, R.h], slot: k, region: region });
          if (sl.y - R.y > 0.5) bars.push({ r: [R.x, R.y, R.w, sl.y - R.y], slot: k, region: region }, { r: [R.x, sl.y + vh, R.w, R.y + R.h - sl.y - vh], slot: k, region: region });
        } else {
          // fill the part, showing a band of the view that follows the rider
          var s = Math.max(R.w / W, R.h / FULL), fw = Math.min(W, R.w / s), fh = Math.min(FULL, R.h / s);
          slots[k] = { x: R.x, y: R.y, fw: fw, fh: fh, sx: s, sy: s, crop: fw < W - 0.5 || fh < FULL - 0.5 };
        }
        if (j > 0) lines.push(sideBySide ? { x: R.x - 1, y: R.y, w: 2, h: R.h } : { x: R.x, y: R.y - 1, w: R.w, h: 2 });
      });
    });
    return { slots: slots, lines: lines, bars: bars };
  }

  // ---------- 6. layouts + render targets ----------
  // View modes (pause-menu toggle, saved in localStorage; cfg.splitOrientation is the default):
  //   2 views: "horizontal" (top/bottom bands), "vertical" (left/right bands), "fit" (letterbox: each half
  //   shows the WHOLE view at half size, bars left/right), "fitv" (side-by-side letterbox, bars above/
  //   below), "stretch" (whole view squashed to each 900x250 half), "shared" (shared screen: ONE camera
  //   framing every player, zooming out as they spread; shared worlds only, skipped in separate worlds),
  //   "p1" (P1's view only; others still play).
  //   3-4 views: 2x2 quarters (P1 top left, then top right, bottom left, bottom right; with 3 players the
  //   third view is centred in the bottom row). "horizontal"/"vertical" = a 450x250 band of each view that
  //   follows the rider in both directions; "fit"/"fitv"/"stretch" = each WHOLE view at half size.
  //   Cropped layouts zoom out (cfg.splitZoom) at the attempt's start; whole-view layouts keep stock zoom.
  //   Spectate "remove dead" re-lays out with the views still shown (down to one full view).
  var ORIENT_KEY = 'hwss.splitOrientation', MODES = ['horizontal', 'vertical', 'fit', 'fitv', 'stretch', 'shared', 'p1'], orientCache = null;
  function validMode(v) { return MODES.indexOf(v) >= 0; }
  // 3-4 players: horizontal = vertical and fit = fitv = stretch look the same, so the toggle has its own
  // short list, saved separately: "zoomed" (cropped quarters), "full" (whole views), "shared", "p1".
  var MODE4_KEY = 'hwss.splitMode4', MODES4 = ['zoomed', 'full', 'shared', 'p1'], mode4Cache = null;
  S.isMulti = function () { return viewIds().length >= 3; };
  S.getMode4 = function () {
    if (mode4Cache) return mode4Cache;
    var v = null;
    try { v = window.localStorage.getItem(MODE4_KEY); } catch (e) {}
    if (MODES4.indexOf(v) < 0) v = MODES4.indexOf(cfg.splitMode4) >= 0 ? cfg.splitMode4 : 'zoomed';
    return (mode4Cache = v);
  };
  S.setMode4 = function (v) {
    v = MODES4.indexOf(v) >= 0 ? v : 'zoomed';
    mode4Cache = v;
    try { window.localStorage.setItem(MODE4_KEY, v); } catch (e) {}
    log('split', '3-4 player view mode -> ' + v);
    return v;
  };
  // the effective layout mode: with 3-4 players the short list maps onto the 2-player names
  // monitor mode has its own list (how two views share a monitor; a monitor with one view always shows it
  // whole or filled): horizontal / vertical (cropped bands, top-bottom / side by side), fit / fitv
  // (whole views at half size, stacked / side by side, with bars), shared (one camera per monitor framing
  // that monitor's players). Saved separately. With 2 players (one view per monitor) the toggle only offers
  // horizontal / fit / shared, labelled "zoomed out" / "normal zoom" / "shared screen" (p2.js splitLabel).
  var MONMODE_KEY = 'hwss.splitModeMon', MODES_MON = ['horizontal', 'vertical', 'fit', 'fitv', 'shared'], monModeCache = null;
  S.getModeMon = function () {
    if (monModeCache) return monModeCache;
    var v = null;
    try { v = window.localStorage.getItem(MONMODE_KEY); } catch (e) {}
    return (monModeCache = MODES_MON.indexOf(v) >= 0 ? v : 'horizontal');
  };
  S.getOrientation = function () {
    if (S.mon && S.mon.on) return S.getModeMon();
    if (S.isMulti()) { var m = S.getMode4(); return m === 'full' ? 'fit' : m === 'p1' ? 'p1' : m === 'shared' ? 'shared' : 'horizontal'; }
    return get2();
  };
  function get2() {
    if (orientCache) return orientCache;
    var v = null;
    try { v = window.localStorage.getItem(ORIENT_KEY); } catch (e) {}
    if (!validMode(v)) v = validMode(cfg.splitOrientation) ? cfg.splitOrientation : 'horizontal';
    return (orientCache = v);
  };
  S.setOrientation = function (v) {
    v = validMode(v) ? v : 'horizontal';
    orientCache = v;
    try { window.localStorage.setItem(ORIENT_KEY, v); } catch (e) {}
    log('split', 'view mode -> ' + v);
    return v;
  };
  // next mode in a list; "shared" (shared screen) is skipped in separate worlds, where it can't work
  function nextIn(list, cur) {
    var sep = H.W2 && H.W2.getMode && H.W2.getMode() === 'separate';
    for (var i = 1; i <= list.length; i++) { var m = list[(list.indexOf(cur) + i) % list.length]; if (!(sep && m === 'shared')) return m; }
    return cur;
  }
  // 2 players in monitor mode: one view per monitor, so horizontal = vertical ("fill") and fit = fitv
  // ("letterbox"); the toggle only offers fill / letterbox / shared screen (TheSplitScreenGuy's choice)
  var MODES_MON_1VIEW = ['horizontal', 'fit', 'shared'];
  S.monOneViewEach = function () { return !!(S.mon && S.mon.on) && viewIds().length <= 2; };
  S.nextOrientation = function () {
    if (S.mon && S.mon.on && S.monOneViewEach()) {
      var cur = S.getModeMon(); cur = cur === 'vertical' ? 'horizontal' : cur === 'fitv' ? 'fit' : cur;
      monModeCache = nextIn(MODES_MON_1VIEW, cur);
      try { window.localStorage.setItem(MONMODE_KEY, monModeCache); } catch (e) {}
      log('split', 'monitor view mode -> ' + monModeCache);
      return monModeCache;
    }
    if (S.mon && S.mon.on) {
      monModeCache = nextIn(MODES_MON, S.getModeMon());
      try { window.localStorage.setItem(MONMODE_KEY, monModeCache); } catch (e) {}
      log('split', 'monitor view mode -> ' + monModeCache);
      return monModeCache;
    }
    if (S.isMulti()) { S.setMode4(nextIn(MODES4, S.getMode4())); return S.getOrientation(); }
    return S.setOrientation(nextIn(MODES, get2()));
  };

  var QUAD = [{ x: 0, y: 0 }, { x: W / 2, y: 0 }, { x: 0, y: HALF }, { x: W / 2, y: HALF }];
  // slot = where a view goes on screen: x, y; fw x fh = part of the view's full 900x500 frame shown;
  // sx, sy = scale; crop = the shown part follows the rider (setBand) along the axes where it is smaller.
  function layoutFor(o, n) {
    var L = { key: o + '/' + n, slots: [], bg: false, lines: [] };
    function slot(x, y, fw, fh, sx, sy, crop) { L.slots.push({ x: x, y: y, fw: fw, fh: fh, sx: sx, sy: sy, crop: !!crop }); }
    if (S.mon.on && S.mon.rects) {                      // monitor mode: views placed per monitor
      var ML = monitorLayout(n);
      L.slots = ML.slots; L.lines = ML.lines; L.key = 'mon/' + n;
      return L;
    }
    if (n === 1) slot(0, 0, W, FULL, 1, 1);             // only one view left on screen ("remove dead")
    else if (n <= 2) {
      if (o === 'vertical') { slot(0, 0, W / 2, FULL, 1, 1, true); slot(W / 2, 0, W / 2, FULL, 1, 1, true); L.lines.push('v'); }
      else if (o === 'fit') { slot(W / 4, 0, W, FULL, 0.5, 0.5); slot(W / 4, HALF, W, FULL, 0.5, 0.5); L.bg = true; L.lines.push('h'); }
      else if (o === 'fitv') { slot(0, FULL / 4, W, FULL, 0.5, 0.5); slot(W / 2, FULL / 4, W, FULL, 0.5, 0.5); L.bg = true; L.lines.push('v'); }
      else if (o === 'stretch') { slot(0, 0, W, FULL, 1, 0.5); slot(0, HALF, W, FULL, 1, 0.5); L.lines.push('h'); }
      else { slot(0, 0, W, HALF, 1, 1, true); slot(0, HALF, W, HALF, 1, 1, true); L.lines.push('h'); }
    } else {
      var whole = o === 'fit' || o === 'fitv' || o === 'stretch';
      for (var i = 0; i < n && i < 4; i++) {
        // 3 players: the third view sits in the middle of the bottom row
        var q = n === 3 && i === 2 ? { x: W / 4, y: HALF } : QUAD[i];
        if (whole) slot(q.x, q.y, W, FULL, 0.5, 0.5);
        else slot(q.x, q.y, W / 2, HALF, 1, 1, true);
      }
      L.bg = true; L.lines = n === 3 ? ['h', 'vtop'] : ['h', 'v'];
    }
    return L;
  }
  S.layoutFor = layoutFor;
  // Screen areas no view covers ("bars"): letterbox side bars, letterbox-side top/bottom bars, and either
  // side of P3's centred view with 3 players. Each bar belongs to the view next to it (slot) and to that
  // view's band (region = the slot plus its bars), which the decorated styles fill as one picture.
  function barsFor(o, n) {
    var out = [], L4 = W / 4, F4 = FULL / 4;
    function pair(slot, region, a, b) { out.push({ r: a, slot: slot, region: region }, { r: b, slot: slot, region: region }); }
    if (n === 1) return out;
    if (n <= 2) {
      if (o === 'fit') for (var k = 0; k < 2; k++) pair(k, [0, k * HALF, W, HALF], [0, k * HALF, L4, HALF], [W - L4, k * HALF, L4, HALF]);
      else if (o === 'fitv') for (k = 0; k < 2; k++) pair(k, [k * W / 2, 0, W / 2, FULL], [k * W / 2, 0, W / 2, F4], [k * W / 2, FULL - F4, W / 2, F4]);
    } else if (n === 3) pair(2, [0, HALF, W, HALF], [0, HALF, L4, HALF], [W - L4, HALF, L4, HALF]);
    return out;
  }
  S.hasBars = function () {
    var n = viewIds().length;
    if (n < 2) return false;
    // monitor mode: the letterbox modes leave bars around the whole views
    if (S.mon && S.mon.on && S.mon.rects) { var mm = S.getModeMon(); return mm === 'fit' || mm === 'fitv'; }
    return barsFor(S.getOrientation(), n).length > 0;
  };

  // ---------- bar styles: black / blur / color / art (pause-menu toggle, saved) ----------
  var BAR_KEY = 'hwss.barStyle', BAR_STYLES = ['black', 'blur', 'color', 'art'], barCache = null;
  S.getBarStyle = function () {
    if (barCache) return barCache;
    var v = null;
    try { v = window.localStorage.getItem(BAR_KEY); } catch (e) {}
    if (BAR_STYLES.indexOf(v) < 0) v = BAR_STYLES.indexOf(cfg.barStyle) >= 0 ? cfg.barStyle : 'black';
    return (barCache = v);
  };
  S.nextBarStyle = function () {
    barCache = BAR_STYLES[(BAR_STYLES.indexOf(S.getBarStyle()) + 1) % BAR_STYLES.length];
    try { window.localStorage.setItem(BAR_KEY, barCache); } catch (e) {}
    log('split', 'bar style -> ' + barCache);
    return barCache;
  };
  // "cover" a region with a source picture (srcW x srcH, centred, cropped); returns the source rectangle
  // a bar inside that region shows
  function coverFrame(srcW, srcH, region, r) {
    var s = Math.max(region[2] / srcW, region[3] / srcH);
    var x0 = (srcW - region[2] / s) / 2, y0 = (srcH - region[3] / s) / 2;
    var x = Math.max(0, x0 + (r[0] - region[0]) / s), y = Math.max(0, y0 + (r[1] - region[1]) / s);
    // stay a hair inside the source: render textures can measure 899.9999 instead of 900
    return new P.Rectangle(x, y, Math.min(r[2] / s, srcW - 0.01 - x), Math.min(r[3] / s, srcH - 0.01 - y));
  }
  // blur: each view shrunk in small steps (300 → 150 → 75 → 36 wide; a big single step skips pixels and
  // shimmers) every frame, then blended into an accumulated picture at BLUR_MIX (smooths it over time:
  // without that it looked erratic). Stretched into the bars it is a soft, darkened extension of the view.
  var CHAIN = [[300, 167], [150, 83], [75, 42], [36, 20]], TINY_W = 36, TINY_H = 20, BLUR_MIX = 0.2;
  var tinyRTs = [], midRTs = [], tinyHelpers = [];
  function linear(rt) { try { rt.baseTexture.scaleMode = 1; } catch (e) {} return rt; }   // SCALE_MODES.LINEAR
  function tinyFor(slot) {
    if (!tinyRTs[slot]) {
      var steps = [], prevTex = new P.Texture(rtAt(slot).baseTexture, new P.Rectangle(0, 0, W, FULL)), pw = W, ph = FULL;
      var chainRTs = CHAIN.map(function (s) { return linear(P.RenderTexture.create({ width: s[0], height: s[1], resolution: 1 })); });
      CHAIN.forEach(function (s, i) {
        var hs = new P.Sprite(prevTex); hs.scale.set(s[0] / pw, s[1] / ph);
        steps.push({ sprite: hs, rt: chainRTs[i] });
        prevTex = chainRTs[i]; pw = s[0]; ph = s[1];
      });
      var acc = linear(P.RenderTexture.create({ width: TINY_W, height: TINY_H, resolution: 1 }));
      var mix = new P.Sprite(chainRTs[chainRTs.length - 1]); mix.alpha = BLUR_MIX;
      midRTs[slot] = chainRTs;
      tinyRTs[slot] = acc;
      tinyHelpers[slot] = { steps: steps, mix: mix, primed: false };
    }
    return tinyRTs[slot];
  }
  function updateBlur(renderer, render) {
    if (!layout || !layout.blurSlots) return;
    layout.blurSlots.forEach(function (slot) {
      var h = tinyHelpers[slot];
      if (!h) return;
      h.steps.forEach(function (st) { render.call(renderer, st.sprite, { renderTexture: st.rt, clear: true }); });
      // first frame: take the picture as is; then blend it in gradually
      h.mix.alpha = h.primed ? BLUR_MIX : 1;
      render.call(renderer, h.mix, { renderTexture: tinyRTs[slot], clear: !h.primed });
      h.primed = true;
    });
  }
  // color: a dark gradient in the player's colour (darkest at the screen edge) with a faint big "P<n>"
  var colorTexCache = {};
  function colorTexture(pid, r, region) {
    var key = pid + '|' + r.join(',') + '|' + rtRes;
    if (colorTexCache[key]) return colorTexCache[key];
    var sc = Math.max(1, rtRes), cw = Math.max(1, Math.round(r[2] * sc)), ch = Math.max(1, Math.round(r[3] * sc));
    var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    var g = cv.getContext('2d');
    var hue = H.PL && H.PL.hueOf ? H.PL.hueOf(pid) : 0; if (typeof hue !== 'number') hue = 0;
    // gradient runs from the edge next to the view (player colour) to the far edge (near black)
    var cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, rx = region[0] + region[2] / 2, ry = region[1] + region[3] / 2;
    var horiz = r[3] >= r[2] * 0.9 || Math.abs(cx - rx) > Math.abs(cy - ry);
    var toView = horiz ? (cx < rx ? [0, 0, cw, 0] : [cw, 0, 0, 0]) : (cy < ry ? [0, 0, 0, ch] : [0, ch, 0, 0]);
    var grad = g.createLinearGradient(toView[0], toView[1], toView[2], toView[3]);
    grad.addColorStop(0, 'hsl(' + hue + ',45%,7%)');
    grad.addColorStop(1, 'hsl(' + hue + ',70%,30%)');
    g.fillStyle = grad; g.fillRect(0, 0, cw, ch);
    var fs = Math.round(Math.min(cw * 0.55, ch * 0.6));
    g.font = '900 ' + fs + 'px "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'hsla(' + hue + ',90%,75%,0.22)';
    g.fillText('P' + pid, cw / 2, ch / 2);
    var t = P.Texture.from(cv, { resolution: sc });
    colorTexCache[key] = t;
    return t;
  }
  // art: one 900x500 Happy Wheels backdrop (sky gradient, clouds, hills) built from the game's background
  // atlases (found among the loaded resources, so it works whatever the asset folder is called)
  var artTex = null, artTried = 0;
  function atlasTexture(n) {
    var url = null;
    try {
      performance.getEntriesByType('resource').forEach(function (e) {
        if (new RegExp('backgrounds_atlas_' + n + '(@[\\d.]+x)?\\.png').test(e.name) && (!url || !/@/.test(e.name))) url = e.name;
      });
    } catch (e) {}
    if (!url || typeof P.Texture.from !== 'function') return null;
    var t = P.Texture.from(url);
    return t && t.baseTexture && t.baseTexture.valid ? t.baseTexture : null;
  }
  function artTexture(renderer) {
    if (artTex) return artTex;
    if (performance.now() - artTried < 1000) return null;
    artTried = performance.now();
    var b1 = atlasTexture(1), b2 = atlasTexture(2);
    if (!b1 || !b2) return null;
    function part(base, x, y, w, h) { var s = base.width / 2048; return new P.Texture(base, new P.Rectangle(x * s, y * s, w * s, h * s)); }
    var c = new P.Container();
    var sky = new P.Sprite(part(b2, 943, 1368, 900, 500)); c.addChild(sky);                      // hill-asset-5: blue sky
    var cloud = new P.Sprite(part(b1, 3, 1468, 1248, 392)); cloud.scale.set(0.72); cloud.x = 0; cloud.y = 10; cloud.alpha = 0.9; c.addChild(cloud);
    var hillR = new P.Sprite(part(b2, 3, 3, 1191, 537)); hillR.scale.set(-0.62, 0.62); hillR.x = W + 40; hillR.y = FULL - 537 * 0.62 + 30; c.addChild(hillR);
    var hillL = new P.Sprite(part(b1, 3, 3, 1880, 859)); hillL.scale.set(0.42); hillL.x = -60; hillL.y = FULL - 859 * 0.42 + 20; c.addChild(hillL);
    var rt = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: renderer.resolution });
    S.origRender.call(renderer, c, { renderTexture: rt, clear: true });
    c.destroy({ children: true });
    artTex = rt;
    log('split', 'letterbox art built');
    return artTex;
  }
  function barSprite(bar, style, renderer, ids) {
    var sp;
    if (style === 'blur') {
      sp = new P.Sprite(new P.Texture(tinyFor(bar.slot).baseTexture, coverFrame(TINY_W, TINY_H, bar.region, bar.r)));
      sp.tint = 0x5c5c5c;                                // darkened, so the real view stands out
    } else if (style === 'color') {
      sp = new P.Sprite(colorTexture(ids[bar.slot] || bar.slot + 1, bar.r, bar.region));
    } else if (style === 'art') {
      var a = artTexture(renderer);
      if (!a) return null;
      sp = new P.Sprite(new P.Texture(a.baseTexture, coverFrame(W, FULL, bar.region, bar.r)));
      sp.tint = 0xb8b8b8;
    }
    if (!sp) return null;
    sp.x = bar.r[0]; sp.y = bar.r[1]; sp.width = bar.r[2]; sp.height = bar.r[3];
    return sp;
  }

  var rts = [], rtRes = 0, layout = null, sprs = [], winnerSpr = null;
  function ensureRes(renderer) {
    if (rtRes === renderer.resolution) return;
    rts.forEach(function (rt) { try { rt.destroy(true); } catch (e) {} });
    rts = []; rtRes = renderer.resolution; layout = null; winnerSpr = null;
    tinyRTs.concat.apply(tinyRTs, midRTs).forEach(function (t) { try { t && t.destroy(true); } catch (e) {} }); tinyRTs = []; midRTs = []; tinyHelpers = [];
    if (artTex) { try { artTex.destroy(true); } catch (e) {} artTex = null; }
    colorTexCache = {};
  }
  // +1 px: W*resolution rounding can leave the texture at 899.999 px otherwise
  // Each view's texture is rendered at the size it's SHOWN (cfg.viewRes !== false): a whole view in a quarter
  // (scale 0.5) needs only half the resolution — before, every quarter view was rendered at full screen
  // resolution and shrunk, i.e. 4 full screens of pixels per frame.
  var rtScale = [];
  function rtAt(i) { return rts[i] || (rts[i] = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: rtRes * (rtScale[i] || 1) })); }
  function setSlotScale(i, sc) {
    if ((rtScale[i] || 1) === sc) return;
    rtScale[i] = sc;
    if (rts[i]) { try { rts[i].destroy(true); } catch (e) {} rts[i] = null; }
    // the blur chain reads this texture: rebuild it for the new one
    if (tinyRTs[i]) { [tinyRTs[i]].concat(midRTs[i] || []).forEach(function (t) { try { t.destroy(true); } catch (e) {} }); tinyRTs[i] = null; midRTs[i] = null; tinyHelpers[i] = null; }
  }
  var winnerRT = null;                                   // full-resolution texture for the winner's full view
  function winnerTex() {
    if (!winnerRT || winnerRT.baseTexture.resolution !== rtRes) {
      if (winnerRT) { try { winnerRT.destroy(true); } catch (e) {} }
      winnerRT = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: rtRes });
    }
    return winnerRT;
  }
  function ensureTargets(renderer, ids) {
    ensureRes(renderer);
    var n = ids.length, o = S.getOrientation(), style = S.getBarStyle();
    var bars = S.mon.on && S.mon.rects ? monitorLayout(n).bars : barsFor(o, n);
    // art waits for the game's background atlases (tried once a second); the key changes when it's ready
    var artReady = style === 'art' && bars.length ? !!artTexture(renderer) : false;
    var styleKey = !bars.length ? '-' : style + (style === 'color' ? ':' + ids.join('') : '') + (style === 'art' ? (artReady ? ':ok' : ':wait') : '');
    var fullKey = o + '/' + n + '|' + styleKey + (cfg.viewRes === false ? '|fullres' : '') + (S.mon.on ? '|mon:' + S.mon.key : '');
    if (layout && layout.fullKey === fullKey) return;
    if (S.comp) { try { S.comp.destroy({ children: true }); } catch (e) {} }   // (shared textures are kept)
    layout = layoutFor(o, n);
    layout.fullKey = fullKey;
    layout.blurSlots = [];
    S.comp = new P.Container();
    // Bars ONLY where no view is. (A full-screen layer under the views showed through the hairline seam
    // between each view quad's two triangles: a faint diagonal line across a view.) Black under every
    // decorated bar too, for any area the decoration doesn't cover yet (art still loading).
    bars.forEach(function (bar) {
      var r = bar.r, sp = null;
      if (style !== 'black') {
        try { sp = barSprite(bar, style, renderer, ids); } catch (e) { if (!S.barErr) { S.barErr = true; log('split-error', 'bar style ' + style + ': ' + (e && e.stack || e)); } }
      }
      if (sp) { S.comp.addChild(sp); if (style === 'blur' && layout.blurSlots.indexOf(bar.slot) < 0) layout.blurSlots.push(bar.slot); return; }
      // black: plain bar (nothing underneath a decorated bar, or its seam would show as a diagonal line)
      if (P.Texture.WHITE) { var bg = new P.Sprite(P.Texture.WHITE); bg.tint = 0x000000; bg.x = r[0]; bg.y = r[1]; bg.width = r[2]; bg.height = r[3]; S.comp.addChild(bg); }
    });
    layout.slots.forEach(function (sl, i) { setSlotScale(i, cfg.viewRes === false ? 1 : Math.min(1, Math.max(sl.sx, sl.sy))); });
    sprs = layout.slots.map(function (sl, i) {
      var sp = new P.Sprite(new P.Texture(rtAt(i).baseTexture, new P.Rectangle(0, 0, sl.fw, sl.fh)));
      sp.scale.set(sl.sx, sl.sy); sp.x = sl.x; sp.y = sl.y;
      S.comp.addChild(sp);
      return sp;
    });
    if (P.Texture.WHITE) layout.lines.forEach(function (d) {
      var ln = new P.Sprite(P.Texture.WHITE); ln.tint = 0x000000;
      if (typeof d === 'object') { ln.x = d.x; ln.y = d.y; ln.width = d.w; ln.height = d.h; }
      else if (d === 'v') { ln.width = 2; ln.height = FULL; ln.x = W / 2 - 1; }
      else if (d === 'vtop') { ln.width = 2; ln.height = HALF; ln.x = W / 2 - 1; }
      else { ln.width = W; ln.height = 2; ln.y = HALF - 1; }
      S.comp.addChild(ln);
    });
    sprs.forEach(function (sp) { sp.hwssOwnTex = sp.texture; });
    S.overlay = new P.Container();                       // name tags, arrows, "spectating" labels
    S.comp.addChild(S.overlay);
    markerSprites = {}; specTexs = [];
    log('split', 'layout ' + layout.key);
  }

  // ---------- players' positions (shared by markers and spectating) ----------
  // A rider's focus body in physics units; every world uses the same level coordinates, so a position from
  // any world maps into any view: view coords = that view's world-layer position + pos * physScale * zoom.
  function playerChar(pid, s) {
    if (pid === 1) return s._character;
    var w = sepWorld(s, pid);
    return w ? w._character : charOf(pid, s);
  }
  function bodyPos(C) {
    var b = C && C.cameraFocus, p = b && b.GetPosition && b.GetPosition();
    return p ? { x: p.x, y: p.y } : null;
  }
  function isDead(C) { return !!(C && (C._dead || C.dead)); }

  // ---------- spectate: dead for 5 s → show the leader's view (pause-menu toggle, saved) ----------
  // Modes: "off"; "leader" (dead 5 s → that view shows the leader's); "remove" (dead 2 s → that view is
  // taken off the screen and not drawn at all, the others re-laid out; back when they respawn). Saved.
  var SPEC_KEY = 'hwss.spectate', SPEC_MODES = ['off', 'leader', 'remove'], specCache = null, deadSince = {}, startPos = {}, specTexs = [];
  function savedSpectate() {
    if (specCache !== null) return specCache;
    var v = null;
    try { v = window.localStorage.getItem(SPEC_KEY); } catch (e) {}
    if (v === 'on') v = 'leader';                       // saved by the old on/off toggle
    return (specCache = SPEC_MODES.indexOf(v) >= 0 ? v : cfg.spectate === false ? 'off' : 'leader');
  }
  // monitor mode has no "remove dead" (each monitor belongs to its players): it counts as off there
  function monitorOn() { return !!(S.mon && S.mon.on); }
  S.getSpectateMode = function () { var v = savedSpectate(); return v === 'remove' && monitorOn() ? 'off' : v; };
  S.getSpectate = function () { return S.getSpectateMode() === 'leader'; };
  S.nextSpectate = function () {
    var modes = monitorOn() ? ['off', 'leader'] : SPEC_MODES;
    specCache = modes[(modes.indexOf(S.getSpectateMode()) + 1) % modes.length];
    try { window.localStorage.setItem(SPEC_KEY, specCache); } catch (e) {}
    log('split', 'spectate -> ' + specCache);
    return specCache;
  };
  (H.onSession = H.onSession || []).push(function () { deadSince = {}; startPos = {}; });
  // a new attempt gets a fresh chance: before, 3 errors disabled the split until the game was restarted
  // (TheSplitScreenGuy's report: after a monitor-mode crash, 1 monitor only followed P1). Errors in the new attempt
  // still turn it off again.
  H.onSession.push(function () { if (S.broken || S.errors) { if (S.broken) log('split', 're-enabled for the new attempt'); S.broken = false; S.errors = 0; } });
  // who is alive, since when the others are dead (every frame, before the views are drawn)
  var aliveNow = [];
  function trackDead(s, ids) {
    // world2.js loads after this file: hook its respawn on first use (a respawned player is alive again)
    if (H.W2 && !H.W2.onRespawn) H.W2.onRespawn = function (pid) { delete deadSince[pid]; delete startPos[pid]; };
    var now = performance.now(), alive = [];
    ids.forEach(function (pid) {
      var C = playerChar(pid, s), p = bodyPos(C);
      if (!C || !p) return;
      if (!startPos[pid] && !isDead(C)) startPos[pid] = p;
      if (isDead(C)) { if (!deadSince[pid]) deadSince[pid] = now; }
      else { delete deadSince[pid]; var st = startPos[pid] || p; alive.push({ pid: pid, d: Math.hypot(p.x - st.x, p.y - st.y) }); }
    });
    alive.sort(function (a, b) { return b.d - a.d; });
    aliveNow = alive;
  }
  // "remove": the views still on screen (everyone dead → all of them stay)
  function shownIds(ids) {
    if (S.getSpectateMode() !== 'remove') return ids;
    var now = performance.now(), out = ids.filter(function (pid) { return !(deadSince[pid] && now - deadSince[pid] >= 2000); });
    // everyone dead: keep what was on screen (the last to die keeps their view), no layout flicker
    if (!out.length) { out = ids.filter(function (pid) { return lastShownKey.indexOf(String(pid)) >= 0; }); if (!out.length) out = ids; }
    var key = out.join('');
    if (key !== lastShownKey) { if (lastShownKey) log('split', 'views shown: P' + out.join(' P') + (out.length < ids.length ? ' (dead views removed)' : '')); lastShownKey = key; }
    return out;
  }
  var lastShownKey = '';
  // leader = the living player furthest from where they started this attempt
  function spectateTargets(s, ids) {
    var now = performance.now(), out = {};
    if (!S.getSpectate() || !aliveNow.length) return out;
    ids.forEach(function (pid) { if (deadSince[pid] && now - deadSince[pid] >= 5000) out[pid] = aliveNow[0].pid; });
    return out;
  }
  // a texture showing another slot's picture (same render texture, same band)
  function specTexture(k, src) {
    var t = specTexs[k];
    if (!t || t.baseTexture !== src.baseTexture) t = specTexs[k] = new P.Texture(src.baseTexture, src.frame.clone());
    else if (t.frame.x !== src.frame.x || t.frame.y !== src.frame.y || t.frame.width !== src.frame.width || t.frame.height !== src.frame.height) {
      t.frame.x = src.frame.x; t.frame.y = src.frame.y; t.frame.width = src.frame.width; t.frame.height = src.frame.height; t.updateUvs();
    }
    return t;
  }

  // ---------- markers: name tags above riders + edge arrows for players off-screen (toggle, saved) ----------
  var MARK_KEY = 'hwss.markers', markCache = null, markerSprites = {}, markTex = {};
  S.getMarkers = function () {
    if (markCache !== null) return markCache;
    var v = null;
    try { v = window.localStorage.getItem(MARK_KEY); } catch (e) {}
    return (markCache = v === 'on' ? true : v === 'off' ? false : cfg.markers !== false);
  };
  S.toggleMarkers = function () {
    markCache = !S.getMarkers();
    try { window.localStorage.setItem(MARK_KEY, markCache ? 'on' : 'off'); } catch (e) {}
    log('split', 'markers -> ' + (markCache ? 'on' : 'off'));
    return markCache;
  };
  function hueCss(pid, l) { var h = H.PL && H.PL.hueOf ? H.PL.hueOf(pid) : 0; return 'hsl(' + (typeof h === 'number' ? h : 0) + ',85%,' + l + '%)'; }
  // canvas textures, made once per player (kind: tag "P2", arrow triangle, spec "SPECTATING P3")
  function markTexture(kind, pid, extra) {
    var key = kind + pid + (extra || '') + '|' + rtRes;
    if (markTex[key]) return markTex[key];
    var sc = Math.max(1, rtRes), cv = document.createElement('canvas'), g = cv.getContext('2d');
    if (kind === 'arrow') {
      cv.width = cv.height = Math.round(26 * sc);
      g.scale(sc, sc);
      g.beginPath(); g.moveTo(24, 13); g.lineTo(4, 3); g.lineTo(9, 13); g.lineTo(4, 23); g.closePath();
      g.fillStyle = hueCss(pid, 55); g.fill(); g.lineWidth = 2; g.strokeStyle = '#13213d'; g.stroke();
    } else {
      var text = kind === 'spec' ? 'SPECTATING P' + extra : 'P' + pid, fs = kind === 'spec' ? 13 : 15;
      g.font = '900 ' + fs + 'px "Arial Black", Arial, sans-serif';
      var w = Math.ceil(g.measureText(text).width) + 10;
      cv.width = Math.round(w * sc); cv.height = Math.round((fs + 10) * sc);
      g.scale(sc, sc);
      g.font = '900 ' + fs + 'px "Arial Black", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 4; g.strokeStyle = '#13213d'; g.lineJoin = 'round';
      g.strokeText(text, w / 2, (fs + 10) / 2);
      g.fillStyle = kind === 'spec' ? '#ffffff' : hueCss(extra || pid, 62);
      g.fillText(text, w / 2, (fs + 10) / 2);
    }
    var t = P.Texture.from(cv, { resolution: sc });
    markTex[key] = t;
    return t;
  }
  function markSprite(key, tex) {
    var sp = markerSprites[key];
    if (!sp) { sp = markerSprites[key] = new P.Sprite(tex); sp.anchor.set(0.5); S.overlay.addChild(sp); }
    else if (sp.texture !== tex) sp.texture = tex;
    sp.visible = true;
    return sp;
  }
  var TAG_UP = 58;                                       // tag height above the focus body, in level pixels
  var prevMarkPos = {};                                  // last frame's positions (what the ghost pictures show)
  function updateMarkers(s, ids, slots, world, ghostsOn) {
    if (!S.overlay) return;
    for (var k in markerSprites) markerSprites[k].visible = false;
    var on = S.getMarkers();
    var ps = s.m_physScale || 62.5, z = world.scale.x || 1;
    var pos = {}; ids.forEach(function (pid) { var C = playerChar(pid, s); if (C) pos[pid] = bodyPos(C); });
    var seen = prevMarkPos; prevMarkPos = pos;
    // A rider from another world is shown as a ghost picture made LAST frame: its tag must use last
    // frame's position too, or tag and ghost drift apart on frames with/without a physics step (jitter).
    function posIn(sl, pid) {
      var ghost = ghostsOn && (!!sepWorld(s, pid) || !!sepWorld(s, sl.pid));
      return (ghost && seen[pid]) || pos[pid];
    }
    slots.forEach(function (sl, k) {
      var x0 = sl.x, y0 = sl.y, x1 = sl.x + sl.w, y1 = sl.y + sl.h, f = sl.frame;
      if (sl.spectating) {
        var lab = markSprite('spec' + k, markTexture('spec', 0, sl.spectating));
        lab.position.set((x0 + x1) / 2, y0 + 14);
      }
      if (!on) return;
      var placed = [];                                   // tags shown in this slot (stacked if they overlap)
      // the view owner first, so their tag stays closest to their rider
      ids.slice().sort(function (a, b) { return (a === sl.pid ? -1 : 0) - (b === sl.pid ? -1 : 0); }).forEach(function (pid) {
        var p = posIn(sl, pid);
        if (!p || pid === sl.owner) return;             // no tag/arrow for the view's own player
        // in this slot's view coordinates (the view of sl.pid), then on screen
        var vx = sl.c.x + p.x * ps * z, vy = sl.c.y + p.y * ps * z;
        var inside = vx >= f.x && vx <= f.x + sl.fw && vy >= f.y && vy <= f.y + sl.fh;
        var sx = x0 + (vx - f.x) * sl.sx, sy = y0 + (vy - f.y) * sl.sy;
        var tag = markSprite('t' + k + '_' + pid, markTexture('tag', pid));
        if (inside) {
          var tx = clamp(sx, x0 + 14, x1 - 14), ty = clamp(sy - TAG_UP * z * sl.sy, y0 + 10, y1 - 10);
          // riders close together: lift this tag above the ones already placed
          for (var guard = 0; guard < 8; guard++) {
            var hit = placed.some(function (q) { return Math.abs(q.x - tx) < tag.width * 0.9 && Math.abs(q.y - ty) < tag.height * 0.8; });
            if (!hit) break;
            ty -= tag.height * 0.85;
          }
          tag.position.set(tx, Math.max(y0 + 10, ty));
          placed.push({ x: tx, y: ty });
          return;
        }
        // off-screen: arrow on the slot's edge pointing at them, their tag just inside
        var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, dx = sx - cx, dy = sy - cy;
        var hx = (x1 - x0) / 2 - 14, hy = (y1 - y0) / 2 - 14, t = Math.min(hx / Math.max(1e-6, Math.abs(dx)), hy / Math.max(1e-6, Math.abs(dy)));
        var ax = cx + dx * t, ay = cy + dy * t, ang = Math.atan2(dy, dx);
        // players in the same direction: slide this arrow along the edge past the ones already placed
        for (var g2 = 0; g2 < 6 && placed.some(function (q) { return q.arrow && Math.abs(q.x - ax) < 40 && Math.abs(q.y - ay) < 34; }); g2++) {
          if (Math.abs(dx) * hy > Math.abs(dy) * hx) ay = clamp(ay + (ay > cy ? -34 : 34), y0 + 14, y1 - 14);   // left/right edge: move vertically
          else ax = clamp(ax + (ax > cx ? -48 : 48), x0 + 14, x1 - 14);                                    // top/bottom edge: move sideways
        }
        placed.push({ x: ax, y: ay, arrow: true });
        var arrow = markSprite('a' + k + '_' + pid, markTexture('arrow', pid));
        arrow.position.set(ax, ay); arrow.rotation = ang;
        tag.position.set(ax - Math.cos(ang) * 24, ay - Math.sin(ang) * 18);
      });
    });
  }

  // ---------- band (the part of a view a cropped slot shows) ----------
  // The band follows the view's RIDER (what its camera is focused on): it keeps the rider at the same
  // RELATIVE spot in the slot as the level's camera keeps it on the full screen (pos/full), so level
  // camera moves (cutscene look-ahead, Super Jetboy's sky) still show; approached smoothly so physics
  // bounces and the camera's own easing don't jitter. Defaults (no rider / framing "level"): rows from
  // cfg.splitBandTop (170, + splitBandOffset), columns from cfg.splitBandLeft (175).
  var bandState = new WeakMap();
  // Framing: "rider" (band follows the rider) or "level" (fixed band = what the level's camera frames).
  var FRAMING_KEY = 'hwss.splitFraming', framingCache = null;
  // The pause-menu toggle was removed (TheSplitScreenGuy, 2026-11-07): always "rider" unless cfg.splitFraming is
  // "level". An old saved "level" choice is ignored.
  S.getFraming = function () {
    if (framingCache) return framingCache;
    return (framingCache = cfg.splitFraming === 'level' ? 'level' : 'rider');
  };
  S.setFraming = function (v) {
    v = v === 'level' ? 'level' : 'rider';
    framingCache = v;
    try { window.localStorage.setItem(FRAMING_KEY, v); } catch (e) {}
    log('split', 'framing -> ' + v);
    return v;
  };
  S.toggleFraming = function () { return S.setFraming(S.getFraming() === 'rider' ? 'level' : 'rider'); };
  function num(v, d) { return typeof v === 'number' ? v : d; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function setBand(spr, sl, rider) {
    if (!sl.crop) return;                        // whole view shown, no band
    if (S.getFraming() === 'level') rider = null;
    var f = spr.texture.frame, st = bandState.get(spr), changed = false;
    if (!st) { st = {}; bandState.set(spr, st); }
    var axes = [['x', sl.fw, W, num(cfg.splitRiderX, 0.4), num(cfg.splitBandLeft, 175)],
                ['y', sl.fh, FULL, num(cfg.splitRiderY, 0.6), num(cfg.splitBandTop, 170) + (cfg.splitBandOffset || 0)]];
    axes.forEach(function (a) {
      var ax = a[0], span = a[1], full = a[2], frac = a[3], def = a[4], val = 0;
      if (span < full) {
        var pos = rider ? rider[ax] : null;
        // frac only bounds it, so a rider pushed to an edge still stays a little inside the slot
        var rel = pos == null ? frac : clamp(pos / full, 0.12, 0.88);
        var target = (pos == null || !isFinite(pos)) ? def : pos - rel * span;
        target = clamp(target, 0, full - span);
        if (st[ax] == null) st[ax] = target;
        st[ax] += (target - st[ax]) * 0.2;
        val = Math.round(st[ax]);
      }
      if (f[ax] !== val) { f[ax] = val; changed = true; }
    });
    if (changed) spr.texture.updateUvs();
  }
  // Position of what a view's CAMERA is focused on (normally the rider's cameraFocus; levels can point the
  // camera elsewhere for cutscenes), in that view's full-frame screen coordinates. Falls back to the
  // rider's own focus body.
  function riderScreen(char, worldPx, cam) {
    try {
      var b = (cam && cam._focus) || (char && char.cameraFocus), p = b && b.GetPosition && b.GetPosition();
      var ps = (cam && cam.m_physScale) || (char && char.m_physScale) || 62.5;
      if (!p || !worldPx) return null;
      return { x: worldPx.position.x + p.x * ps * worldPx.scale.x, y: worldPx.position.y + p.y * ps * worldPx.scale.y };
    } catch (e) { return null; }
  }

  // Full-screen frame of an extra player's view (used when that player won the level).
  function fullViewFor(renderer, root, s, render, pid) {
    var Sw = sepWorld(s, pid);
    if (Sw && Sw._pixiSprite) {
      // The winner's world rendered into a texture, then shown as a plain picture IN THE STAGE in P1's
      // session's slot (P1's session hidden), so the stage's own background, the winner's view and the
      // level-complete window draw in their normal order (drawing the stage over the view hid it behind
      // the stage's opaque background).
      ensureRes(renderer);
      var rt = winnerTex();
      render.call(renderer, Sw._pixiSprite, { renderTexture: rt, clear: true });
      if (!winnerSpr || winnerSpr.texture.baseTexture !== rt.baseTexture) winnerSpr = new P.Sprite(new P.Texture(rt.baseTexture, new P.Rectangle(0, 0, W, FULL)));
      var sp = s._pixiSprite, par = sp && sp.parent, wasVisible = sp && sp.visible;
      if (!par) return render.call(renderer, root);
      par.addChildAt(winnerSpr, par.children.indexOf(sp));
      sp.visible = false;
      try { render.call(renderer, root); }
      finally { sp.visible = wasVisible; par.removeChild(winnerSpr); }
      renderer._lastObjectRendered = root;
      return;
    }
    var cam1 = s._camera, cam = camFor(s, pid);
    var view = s._containerSprite._pixiSprite.parent;
    var saved = view.children.map(function (c) { return [c, c.position.x, c.position.y, c.scale.x, c.scale.y, c.pivot.x, c.pivot.y, c.visible]; });
    try {
      cam.step(lastAlpha);
      s._camera = cam;
      try { s.cullObjects(); } finally { s._camera = cam1; }
      return render.call(renderer, root);
    } finally {
      saved.forEach(function (e) { var c = e[0]; c.position.set(e[1], e[2]); c.scale.set(e[3], e[4]); c.pivot.set(e[5], e[6]); c.visible = e[7]; });
    }
  }

  // ---------- 7. the split frame ----------
  function splitRender(renderer, root, s, render) {
    var t = performance.now();
    try { return splitRenderInner(renderer, root, s, render); } finally { perf.split += performance.now() - t; }
  }
  // views: smooth (every view every frame) / fast (P2-P4 at half rate); pause-menu toggle, saved
  var RATE_KEY = 'hwss.viewRate', rateCache = null, viewFrame = 0, lastViewInfo = {};
  (H.onSession = H.onSession || []).push(function () { lastViewInfo = {}; });   // new attempt: no stale views
  S.getViewRate = function () {
    if (rateCache) return rateCache;
    var v = null;
    try { v = window.localStorage.getItem(RATE_KEY); } catch (e) {}
    if (v !== 'smooth' && v !== 'fast') v = cfg.viewRate === 'fast' ? 'fast' : 'smooth';
    return (rateCache = v);
  };
  S.toggleViewRate = function () {
    rateCache = S.getViewRate() === 'fast' ? 'smooth' : 'fast';
    try { window.localStorage.setItem(RATE_KEY, rateCache); } catch (e) {}
    log('split', 'views -> ' + rateCache);
    return rateCache;
  };
  function splitRenderInner(renderer, root, s, render) {
    // shared screen in 2-monitor mode: one view per monitor (its first player's camera frames the group)
    var shareIds = sharedScreenIds();
    var ids = shareIds || viewIds();
    try { trackDead(s, viewIds()); } catch (e) { if (!S.specErr) { S.specErr = true; log('split-error', 'spectate: ' + (e && e.stack || e)); } }
    // "remove dead": views of players dead 2 s are left out of the layout and not drawn
    var shownPids = shareIds ? ids : shownIds(ids);
    ensureTargets(renderer, shownPids);
    hookMouse(renderer);
    var cam1 = s._camera, world = s._containerSprite._pixiSprite, view = world.parent;
    var c1 = { x: world.position.x, y: world.position.y };
    var info = [{ pid: 1, sep: false, c: c1, rider: null }], sharedPass = false, anySep = false;
    // Ghosts are drawn INSIDE each world, inserted into the display list right under the view owner's
    // rider, so level decorations in front of the rider cover the ghosts too (levels hide riders behind
    // decorations). They use the rider pictures made at the end of the previous frame (one frame behind).
    var ghostsOn = S.getGhosts() && !!P.Matrix && ids.some(function (id) { return id !== 1 && !!sepWorld(s, id); });
    function withRiderHidden(C, fn, pid, cNow) {
      if (!ghostsOn || !C) return fn();
      var added = [];
      try { added = insertGhosts(C, pid, cNow); } catch (e) { if (!S.ghostErr) { S.ghostErr = true; log('split-error', 'ghost insert: ' + (e && e.stack || e)); } }
      try { return fn(); } finally { added.forEach(function (sp) { if (sp.parent) sp.parent.removeChild(sp); }); }
    }
    // "views: fast": P2-P4's views are redrawn every other frame, taking turns (odd/even view index), so
    // the work is spread evenly; a skipped view keeps last frame's picture and info (its c and rider pos
    // match that picture, which ghosts and the band rely on). P1's view, physics and game logic run every
    // frame.
    viewFrame++;
    var fast = S.getViewRate() === 'fast';
    // the extra views FIRST
    for (var i = 1; i < ids.length; i++) {
      var pid = ids[i], Sw = sepWorld(s, pid), slotIdx = shownPids.indexOf(pid), prev = lastViewInfo[pid];
      if (slotIdx < 0) {
        // removed (dead): not drawn; its world keeps running so a respawn brings the view straight back
        var wpH = Sw && Sw._containerSprite && Sw._containerSprite._pixiSprite;
        info.push({ pid: pid, sep: !!(Sw && Sw._pixiSprite), S: Sw, c: wpH ? { x: wpH.position.x, y: wpH.position.y } : c1, rider: null, hidden: true });
        if (Sw && Sw._pixiSprite) anySep = true;
        continue;
      }
      var rt = rtAt(slotIdx);
      if (fast && (i + viewFrame) % 2 === 0 && prev && prev.base === rt.baseTexture && prev.sep === !!(Sw && Sw._pixiSprite)) {
        info.push(prev.v);
        if (prev.sep) anySep = true;
        continue;
      }
      if (Sw && Sw._pixiSprite) {
        // separate world: the player's own session (it steps, moves its camera and culls in its own run)
        var wp = Sw._containerSprite && Sw._containerSprite._pixiSprite, cw = wp ? { x: wp.position.x, y: wp.position.y } : c1;
        timed('draw', function () { withViewCulled(wp, function () { withRiderHidden(Sw._character, function () { render.call(renderer, Sw._pixiSprite, { renderTexture: rt, clear: true }); }, pid, cw); }); });
        info.push({ pid: pid, sep: true, S: Sw, c: cw, rider: riderScreen(Sw._character, wp, Sw._camera) });
        lastViewInfo[pid] = { v: info[info.length - 1], base: rt.baseTexture, sep: true };
        anySep = true;
        continue;
      }
      // shared world: move the level view with this player's camera, cull for it, render, put everything back
      var cam = camFor(s, pid), ci = null;
      var saved = view.children.map(function (c) { return [c, c.position.x, c.position.y, c.scale.x, c.scale.y, c.pivot.x, c.pivot.y, c.visible]; });
      try {
        cam.step(lastAlpha);
        ci = { x: world.position.x, y: world.position.y };
        s._camera = cam;
        try { timed('cull', function () { s.cullObjects(); }); } finally { s._camera = cam1; }
        // this player's sound listener: the camera centre must be read NOW, while the shared level layer
        // sits where this camera put it (the clone's getters read that shared layer)
        try { var mp = cam.midScreenPoint; listenerAt[pid] = { x: mp.x, y: mp.y, P: mp.constructor }; } catch (e) { listenerAt[pid] = null; }
        // Draw only the session's own display (level + background), like separate-world views, not the
        // whole stage (HUD, overlays): measured on the Steam Deck, 4 views took ~22 ms/frame vs ~7 ms.
        // Its parent's transform keeps it where the stage would have put it. cfg.sharedRenderRoot = true
        // restores the old full-stage draw.
        var sp = s._pixiSprite, par = sp && sp.parent;
        timed('draw', function () {
          withViewCulled(world, function () { withOwnerOnTop(s, pid, function () {
            if (sp && par && cfg.sharedRenderRoot !== true) render.call(renderer, sp, { renderTexture: rt, clear: true, transform: par.worldTransform });
            else render.call(renderer, root, { renderTexture: rt, clear: true });
          }); });
        });
      } finally {
        saved.forEach(function (e) { var c = e[0]; c.position.set(e[1], e[2]); c.scale.set(e[3], e[4]); c.pivot.set(e[5], e[6]); c.visible = e[7]; });
      }
      sharedPass = true;
      info.push({ pid: pid, sep: false, c: ci || c1, rider: riderScreen(charOf(pid, s) || s._character, { position: ci || c1, scale: world.scale }, cam) });
      lastViewInfo[pid] = { v: info[info.length - 1], base: rt.baseTexture, sep: false };
    }
    // P1 LAST (re-cull for P1's camera after shared passes), so the stage's world transforms end the frame
    // in P1's real view: mouse hit tests use them, and the mouse mapping converts into P1's view.
    if (sharedPass) timed('cull', function () { s.cullObjects(); });
    var p1Slot = shownPids.indexOf(1);
    if (p1Slot >= 0) {
      timed('draw', function () { withViewCulled(world, function () { withOwnerOnTop(s, 1, function () { withRiderHidden(anySep ? s._character : null, function () { render.call(renderer, root, { renderTexture: rtAt(p1Slot), clear: true }); }, 1, c1); }); }); });
    } else {
      // P1's view removed: no draw, but the stage's transforms still have to be current (hit tests, ghosts)
      info[0].hidden = true;
      try { var tmp = root.enableTempParent(); root.updateTransform(); root.disableTempParent(tmp); }
      catch (e) { render.call(renderer, root, { renderTexture: rtAt(shownPids.length), clear: true }); }
    }
    info[0].rider = riderScreen(s._character, world, cam1);
    function infoOf(pid) { for (var q = 0; q < info.length; q++) if (info[q].pid === pid) return info[q]; return null; }
    // ghosts: in separate worlds, every rider drawn semi-transparent into the other riders' views
    if (anySep) { try { timed('ghosts', function () { drawGhosts(renderer, render, s, info); }); } catch (e) { if (!S.ghostErr) { S.ghostErr = true; log('split-error', 'ghosts: ' + (e && e.stack || e)); } } }
    var slots = [];
    // bands first (on each slot's own texture), then spectating slots borrow the leader's picture
    layout.slots.forEach(function (sl, k) {
      var v = infoOf(shownPids[k]), sp = sprs[k];
      if (!v || !sp) return;
      if (sp.hwssOwnTex && sp.texture !== sp.hwssOwnTex) sp.texture = sp.hwssOwnTex;
      setBand(sp, sl, v.rider);
    });
    var spec = {};
    try { spec = spectateTargets(s, shownPids); } catch (e) { if (!S.specErr) { S.specErr = true; log('split-error', 'spectate: ' + (e && e.stack || e)); } }
    layout.slots.forEach(function (sl, k) {
      var v = infoOf(shownPids[k]), sp = sprs[k];
      if (!v || !sp) return;
      var t = spec[v.pid], tk = t != null ? shownPids.indexOf(t) : -1, shown = v, frame = sp.texture.frame;
      if (tk >= 0 && sprs[tk] && infoOf(t)) {
        sp.texture = specTexture(k, sprs[tk].texture);
        shown = infoOf(t); frame = sp.texture.frame;
      }
      slots.push({ x: sl.x, y: sl.y, w: sl.fw * sl.sx, h: sl.fh * sl.sy, sx: sl.sx, sy: sl.sy, fw: sl.fw, fh: sl.fh, frame: frame,
                   pid: shown.pid, sep: shown.sep, c: shown.c, owner: v.pid, spectating: tk >= 0 ? t : 0 });
    });
    S.lastSplit = { key: layout.key, slots: slots, c1: c1 };
    try { updateMarkers(s, shownPids, slots, world, ghostsOn); } catch (e) { if (!S.markErr) { S.markErr = true; log('split-error', 'markers: ' + (e && e.stack || e)); } }
    try { updateBlur(renderer, render); } catch (e) { if (!S.blurErr) { S.blurErr = true; log('split-error', 'blur bars: ' + (e && e.stack || e)); } }
    render.call(renderer, S.comp);
    // Pixi's InteractionManager hit-tests against the last object rendered: make that the game's stage
    // again, not our composite, or the game never receives mouse events in split mode.
    renderer._lastObjectRendered = root;
  }

  // ---------- ghosts (separate worlds) ----------
  // All worlds use the same level coordinates and zoom, so a rider's sprites (already transformed by
  // its own world's render this frame) can be drawn into another view shifted by the difference of the
  // two world-layer positions. Drawn into a scratch texture, then blended at cfg.ghostAlpha.
  function riderClips(C, out, depth) {
    out = out || []; depth = depth || 0;
    if (H.N) H.N.alias(C);
    Object.keys(C).forEach(function (k) {
      if (!(H.N ? H.N.isClipKey(C, k) : /MCs?$/.test(k))) return;
      var v = C[k], list = Array.isArray(v) ? v : [v];
      list.forEach(function (mc) { if (mc && mc._pixiSprite && out.indexOf(mc._pixiSprite) < 0) out.push(mc._pixiSprite); });
    });
    // (1.99.3: sub-characters tested by the real field names: see p2.js subCharacters)
    var RS = H.N ? H.N.real('_session') : '_session', RF = H.N ? H.N.real('cameraFocus') : 'cameraFocus', cs0 = C[RS];
    if (depth < 2) Object.keys(C).forEach(function (k) {
      var v = C[k];
      if (k !== RS && cs0 && v && typeof v === 'object' && v !== C && !v._pixiSprite && v[RS] === cs0 && v[RF]) riderClips(v, out, depth + 1);
    });
    return out;
  }
  // Each rider's clips are drawn ONCE per frame into that rider's ghost texture (in its own view's
  // coordinates), and that picture is then blended into every other view at an offset. (Drawing the clips
  // again for every view cost ~8 ms a frame with 4 players.)
  var ghostRTs = [], ghostSprs = [], ghostRes = 0, identity = null;
  function ghostSlot(j, renderer) {
    if (ghostRes !== renderer.resolution) {
      ghostRTs.forEach(function (rt) { try { rt.destroy(true); } catch (e) {} });
      ghostRTs = []; ghostSprs = []; ghostRes = renderer.resolution;
    }
    if (!ghostRTs[j]) {
      ghostRTs[j] = P.RenderTexture.create({ width: W + 1, height: FULL + 1, resolution: ghostRes });
      ghostSprs[j] = new P.Sprite(ghostRTs[j]);
    }
    return j;
  }
  // ghosts on/off: pause-menu toggle (separate worlds only), saved; cfg.ghosts is the default
  var GHOST_KEY = 'hwss.ghosts', ghostCache = null;
  S.getGhosts = function () {
    if (ghostCache !== null) return ghostCache;
    var v = null;
    try { v = window.localStorage.getItem(GHOST_KEY); } catch (e) {}
    return (ghostCache = v === 'on' ? true : v === 'off' ? false : cfg.ghosts !== false);
  };
  S.toggleGhosts = function () {
    ghostCache = !S.getGhosts();
    try { window.localStorage.setItem(GHOST_KEY, ghostCache ? 'on' : 'off'); } catch (e) {}
    log('split', 'ghosts -> ' + (ghostCache ? 'on' : 'off'));
    return ghostCache;
  };
  // ---------- per-view culling (performance; cfg.cullViews = false turns it off) ----------
  // The game culls only its level shapes, for P1's camera. Before each view is drawn, every object in that
  // world's layer (riders' parts, debris, level pieces; big groups piece by piece) that lies fully outside
  // this view is skipped (renderable = false: not drawn, transforms still updated) and restored after.
  // Each object's own-space bounds are cached (refreshed every 30 frames or when its children change).
  var cullFrame = 0, CULL_MARGIN = 60;
  function localBox(o) {
    var c = o.hwssLB;
    if (!c || cullFrame - c.f > 30 || c.n !== (o.children ? o.children.length : 0)) {
      var b = o.getLocalBounds();
      c = o.hwssLB = { x: b.x, y: b.y, w: b.width, h: b.height, f: cullFrame, n: o.children ? o.children.length : 0 };
    }
    return c;
  }
  function cullIn(layer, view, out, depth) {
    var ch = layer.children;
    for (var i = 0; i < ch.length; i++) {
      var o = ch[i];
      if (!o.visible || !o.renderable) continue;
      if (depth < 1 && o.children && o.children.length >= 16 && !o.hwssKeep) { cullIn(o, viewIn(o, view), out, depth + 1); continue; }
      var b = localBox(o);
      if (!(b.w > 0 && b.h > 0)) continue;
      o.transform.updateLocalTransform();
      var m = o.transform.localTransform;
      // the box's corners in the layer's space → its axis-aligned extent
      var x0 = m.a * b.x + m.c * b.y + m.tx, y0 = m.b * b.x + m.d * b.y + m.ty;
      var ax = m.a * b.w, ay = m.b * b.w, bx = m.c * b.h, by = m.d * b.h;
      var minX = x0 + Math.min(0, ax) + Math.min(0, bx), maxX = x0 + Math.max(0, ax) + Math.max(0, bx);
      var minY = y0 + Math.min(0, ay) + Math.min(0, by), maxY = y0 + Math.max(0, ay) + Math.max(0, by);
      if (maxX < view.x0 || minX > view.x1 || maxY < view.y0 || minY > view.y1) { o.renderable = false; out.push(o); }
    }
  }
  // the view rectangle (screen 0..W, 0..FULL plus a margin) in a container's own space (no rotation)
  function viewIn(o, parentView) {
    if (!parentView) {
      var a = o.toLocal({ x: -CULL_MARGIN, y: -CULL_MARGIN }), b = o.toLocal({ x: W + CULL_MARGIN, y: FULL + CULL_MARGIN });
      return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    }
    o.transform.updateLocalTransform();
    var m = o.transform.localTransform, det = m.a * m.d - m.b * m.c;
    if (!det) return parentView;
    function inv(x, y) { x -= m.tx; y -= m.ty; return { x: (m.d * x - m.c * y) / det, y: (-m.b * x + m.a * y) / det }; }
    var p = inv(parentView.x0, parentView.y0), q = inv(parentView.x1, parentView.y1);
    return { x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) };
  }
  // OFF by default (cfg.cullViews = true enables): measured on a heavy level it cost ~1 ms/frame and saved
  // almost nothing — the expensive objects are the ones on screen.
  function withViewCulled(layer, fn) {
    if (cfg.cullViews !== true || !layer || !layer.children) return fn();
    var hidden = [];
    try { timed('cull', function () { cullIn(layer, viewIn(layer, null), hidden, 0); }); }
    catch (e) { if (!S.cullErr) { S.cullErr = true; log('split-error', 'view cull: ' + (e && e.stack || e)); } }
    perf.culled += hidden.length;
    try { return fn(); } finally { for (var i = 0; i < hidden.length; i++) hidden[i].renderable = true; }
  }

  // ---------- shared world: the view owner's rider on top of the other riders (cfg.ownerOnTop !== false) ----------
  // All riders' parts are siblings in one layer, so their order decides who covers whom. For each view the
  // owner's parts are moved to just above the highest OTHER rider part (not the top of the layer, so
  // decorations placed in front of riders still cover everyone), then the original order is restored.
  function withOwnerOnTop(s, ownerPid, fn) {
    if (cfg.ownerOnTop === false) return fn();
    var owner = charOf(ownerPid, s), ids = viewIds(), others = [];
    ids.forEach(function (id) { var C = charOf(id, s); if (C && id !== ownerPid) others.push(C); });
    if (!owner || !others.length) return fn();
    var mine = new Set(riderClips(owner));
    var par = null; mine.forEach(function (px) { if (!par && px.parent) par = px.parent; });
    if (!par) return fn();
    var otherSet = new Set(); others.forEach(function (C) { riderClips(C).forEach(function (px) { if (px.parent === par) otherSet.add(px); }); });
    var ch = par.children, saved = ch.slice(), topOther = -1, i;
    for (i = 0; i < ch.length; i++) if (otherSet.has(ch[i])) topOther = i;
    if (topOther < 0) return fn();
    // new order: everything except mine, with mine (in their own order) right after the top other rider part
    var moved = [], rest = [];
    for (i = 0; i < ch.length; i++) { if (mine.has(ch[i])) moved.push(ch[i]); else rest.push(ch[i]); }
    var topRest = rest.indexOf(saved[topOther]);
    var order = rest.slice(0, topRest + 1).concat(moved, rest.slice(topRest + 1));
    ch.length = 0; Array.prototype.push.apply(ch, order);
    try { return fn(); }
    finally { ch.length = 0; Array.prototype.push.apply(ch, saved); }
  }

  // ghostPics[pid] = { slot, c }: that rider's picture (in its own view's coordinates) from the end of the
  // last frame, and its world layer position then. Ghost slot j = pid - 1.
  var ghostPics = {};
  function drawGhosts(renderer, render, s, info) {
    if (!S.getGhosts() || !P.Matrix) { ghostPics = {}; return; }
    if (!identity) identity = new P.Matrix();
    // riders with their own world this frame: P1 (P1's world) and each separate-world player
    var pics = {};
    info.forEach(function (v) {
      if (v.hidden && v.pid !== 1) return;              // removed dead view: its world isn't drawn, no fresh picture
      var C = v.pid === 1 ? s._character : (v.sep && v.S ? v.S._character : null);
      if (!C) return;
      var j = ghostSlot(v.pid - 1, renderer), rt = ghostRTs[j], first = true, clips = riderClips(C);
      // Batched (cfg.ghostBatch !== false): the rider's layer drawn ONCE with everything except the rider's
      // parts switched off, instead of one draw call per body part (~20). Parts in another layer (rare)
      // are drawn on their own afterwards.
      var par = null, inPar = new Set(), rest = [];
      if (cfg.ghostBatch !== false) {
        clips.forEach(function (px) { if (!par && px.parent) par = px.parent; });
        clips.forEach(function (px) { if (px.parent === par) inPar.add(px); else rest.push(px); });
      } else rest = clips;
      if (par && inPar.size) {
        var off = [];
        par.children.forEach(function (o) { if (!inPar.has(o) && o.renderable) { o.renderable = false; off.push(o); } });
        try { render.call(renderer, par, { renderTexture: rt, clear: true, transform: identity, skipUpdateTransform: true }); }
        finally { off.forEach(function (o) { o.renderable = true; }); }
        first = false;
      }
      rest.forEach(function (px) {
        if (!px.worldVisible && !px.visible) return;
        render.call(renderer, px, { renderTexture: rt, clear: first, transform: identity, skipUpdateTransform: true });
        first = false;
      });
      if (!first) pics[v.pid] = { slot: j, c: { x: v.c.x, y: v.c.y } };
    });
    ghostPics = pics;                                    // used by the NEXT frame's world draws
  }
  // Put the other riders' ghost pictures into the owner's world, just below the owner's rider.
  // Screen position in this view = picture position + (this view's world layer pos - the rider's then);
  // converted into the rider layer's local coordinates (its zoom undone) so the world draw places it.
  function insertGhosts(C, pid, cNow) {
    var clips = riderClips(C), par = null, idx = Infinity;
    clips.forEach(function (px) { if (!par && px.parent) par = px.parent; });
    if (!par) return [];
    clips.forEach(function (px) { if (px.parent === par) { var k = par.children.indexOf(px); if (k >= 0 && k < idx) idx = k; } });
    if (!isFinite(idx)) idx = par.children.length;
    var alpha = typeof cfg.ghostAlpha === 'number' ? cfg.ghostAlpha : 0.4, added = [];
    Object.keys(ghostPics).forEach(function (k) {
      var g = ghostPics[k], sp = ghostSprs[g.slot];
      if (+k === pid || !sp || sp.parent) return;
      var dx = cNow.x - g.c.x, dy = cNow.y - g.c.y;
      var local = par.toLocal({ x: dx, y: dy });         // also refreshes the layer's transform
      var wt = par.worldTransform;
      sp.position.set(local.x, local.y);
      sp.scale.set(1 / (wt.a || 1), 1 / (wt.d || 1));
      sp.alpha = alpha;
      par.addChildAt(sp, Math.min(idx, par.children.length));
      added.push(sp);
    });
    return added;
  }

  // Mouse: the game hit-tests in P1's full 900x500 view, but each slot shows (part of) a view, scaled,
  // and extra players' slots show their own camera. Map the pointer into P1's view: position in the
  // slot's view frame = (pointer - slot origin) / scale + band offset; an extra player's slot (shared
  // world) is then shifted by the difference of the two cameras' world-layer positions (same zoom).
  // Separate-world slots belong to another world, bars / an empty quarter belong to nobody: no hit.
  var mouseHooked = new WeakSet();
  function hookMouse(renderer) {
    var I = renderer.plugins && renderer.plugins.interaction;
    if (!I || mouseHooked.has(I) || typeof I.mapPositionToPoint !== 'function') return;
    mouseHooked.add(I);
    var orig = I.mapPositionToPoint;
    I.mapPositionToPoint = function (point, x, y) {
      orig.call(this, point, x, y);
      // split views, or monitor mode's single fitted game area (menus, pause) on P1's monitor
      var L = S.lastSplit && (S.active || (S.mon.on && S.lastSplit.mon)) ? S.lastSplit : null;
      if (!L) return;
      var sl = null;
      for (var i = 0; i < L.slots.length; i++) {
        var q = L.slots[i];
        if (point.x >= q.x && point.x < q.x + q.w && point.y >= q.y && point.y < q.y + q.h) { sl = q; break; }
      }
      if (!sl || sl.sep) { point.x = -99999; point.y = -99999; return; }
      var lx = (point.x - sl.x) / sl.sx + sl.frame.x, ly = (point.y - sl.y) / sl.sy + sl.frame.y;
      if (sl.pid !== 1) { lx += L.c1.x - sl.c.x; ly += L.c1.y - sl.c.y; }
      point.x = lx; point.y = ly;
    };
    log('split', 'mouse mapping for split views installed');
  }

  // ---------- start discovery once the game is up ----------
  var tries = 0;
  function poll() {
    tries++;
    var ok = false;
    try { ok = discover(); } catch (e) { log('split-error', 'discovery: ' + e); }
    if (!ok && tries < 120) setTimeout(poll, 1000);
  }
  window.addEventListener('load', function () { setTimeout(poll, 1500); });
})();
