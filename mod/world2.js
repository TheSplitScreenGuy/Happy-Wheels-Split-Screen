/* HWSS separate worlds. Appended after audio.js by tools/install.js.
 * In "separate" mode (pause-menu toggle, saved), each extra player (P2-P4) gets a complete copy of the
 * level: their own session/world/level/triggers/character, simulated alongside P1's and drawn in their
 * view. Needed for levels whose "player" is a level-built contraption (e.g. Super Jetboy).
 * How a session is made (session controller beginSession):
 *   new Session(Settings.CURRENT_VERSION, characterData, levelData, levelVersion, debug); then create().
 * levelData and characterData are display objects the session takes apart, so each copy needs fresh
 * ones: user levels rebuild via loader.userLevelLoader.buildLevelSourceObject(); campaign levels via the
 * Animate stage class; character art like the shared-world riders' art. Game code looks things up
 * through Settings.currentSession, so it is the copy's session while that copy is created and runs.
 * API: W2.worlds = [{pid, S}], W2.worldFor(pid), W2.S1 (P1's session), W2.S2 (first copy, old name).
 */
(function () {
  'use strict';
  var H = window.__HWSS__;
  if (!H || H.w2Loaded) return;
  H.w2Loaded = true;
  var cfg = H.cfg, log = H.log;

  var MODE_KEY = 'hwss.worldMode', modeCache = null;
  var W2 = H.W2 = { worlds: [], S2: null, S1: null, cap: null, building: false, errors: 0 };
  // Modes: "shared" (one world, riders pass through each other), "collide" (one world, riders collide
  // after a 2 s grace per attempt; p2.js contact filter), "separate" (own worlds, from next restart).
  // "collide10" = like "collide" with a 10 s grace (levels with long intros that hold the riders in place)
  var MODES = ['shared', 'collide', 'collide10', 'separate'];
  W2.collideGraceMs = function () { var m = W2.getMode(); return m === 'collide' ? 2000 : m === 'collide10' ? 10000 : null; };
  W2.getMode = function () {
    if (modeCache) return modeCache;
    var v = null;
    try { v = window.localStorage.getItem(MODE_KEY); } catch (e) {}
    if (MODES.indexOf(v) < 0) v = MODES.indexOf(cfg.worldMode) >= 0 ? cfg.worldMode : 'shared';
    return (modeCache = v);
  };
  W2.setMode = function (v) {
    v = MODES.indexOf(v) >= 0 ? v : 'shared';
    modeCache = v;
    try { window.localStorage.setItem(MODE_KEY, v); } catch (e) {}
    log('w2', 'world mode -> ' + v + (v === 'separate' || W2.worlds.length ? ' (separate worlds change from the next start/restart)' : ''));
    return v;
  };
  W2.toggleMode = function () { return W2.setMode(MODES[(MODES.indexOf(W2.getMode()) + 1) % MODES.length]); };
  function anyJoined() { return !!(H.PL && H.PL.anyJoined()); }
  // would the next attempt use separate worlds?
  W2.isSeparate = function () { return W2.getMode() === 'separate' && anyJoined() && !!(W2.cap && !W2.cap.error && !W2.cap.isReplay); };
  W2.active = function (s) { return !!(W2.worlds.length && W2.S1 === s); };
  W2.worldFor = function (pid) { for (var i = 0; i < W2.worlds.length; i++) if (W2.worlds[i].pid === pid) return W2.worlds[i].S; return null; };
  function entryOf(S) { for (var i = 0; i < W2.worlds.length; i++) if (W2.worlds[i].S === S) return W2.worlds[i]; return null; }

  // ---------- discovery: Settings (static class) + session controller ----------
  var St = null, Ctl = null;
  function scan() {
    var r = H.req; if (!r) return false;
    var vendor = H.vendorIds();
    for (var id in r.m) {
      if (vendor.has(id) || /hwss/.test(id)) continue;
      var ex; try { ex = r(id); } catch (e) { continue; }
      if (!ex || typeof ex !== 'object') continue;
      for (var k in ex) {
        var v; try { v = ex[k]; } catch (e) { continue; }
        if (typeof v !== 'function') continue;
        // 1.99.3: test the real (renamed) names, prototypes by descriptor only (names.js)
        if (!St && R('currentSession') in v && R('CURRENT_VERSION') in v) St = v;
        // (1.99.3: sessionCompleteHandler is a bound instance field, so test restartLevel instead)
        if (!Ctl && v.prototype && isFn(v.prototype, R('beginSession')) && (isFn(v.prototype, R('sessionCompleteHandler')) || (H.N && isFn(v.prototype, R('restartLevel'))))) Ctl = v;
      }
      if (St && Ctl) break;
    }
    if (St && Ctl && H.N) { H.N.aliasClass(St); H.N.aliasClass(Ctl); }
    return !!(St && Ctl);
  }
  function R(n) { return H.N ? H.N.real(n) : n; }
  function isFn(p, n) { var d = Object.getOwnPropertyDescriptor(p, n); return !!(d && typeof d.value === 'function'); }
  function hookController() {
    var proto = Ctl.prototype;
    if (proto.hwssCapture) return;
    proto.hwssCapture = true;
    var orig = proto.beginSession;
    proto.beginSession = function () {
      W2.ctl = this;                                     // (P1-only restart calls its restartLevel)
      // 1.99.3: alias the controller + loader instances (their fields), and keep the loader: the game's
      // beginSession now clears its loader field at the end
      if (H.N) { H.N.alias(this); }
      var L = this.sessionContentLoader, cap = null;
      if (H.N && L) { H.N.alias(L); if (L.userLevelLoader) H.N.alias(L.userLevelLoader); }
      try {
        if (L) {
          var ld = L.levelData;
          cap = { loader: L, levelVersion: L.levelVersion, isReplay: !!L.replayData,
                  levelStageCtor: ld && ld._pixiSprite && ld._pixiSprite.parent ? ld._pixiSprite.parent.constructor : null,
                  version: St.CURRENT_VERSION, useDebug: St.useDebug };
        }
      } catch (e) { cap = { error: String(e) }; }
      var r = orig.apply(this, arguments);
      if (cap) { cap.sessionClass = this.session && this.session.constructor; W2.cap = cap; log('w2', 'level load captured' + (cap.isReplay ? ' (replay: separate worlds off)' : '')); }
      return r;
    };
    // Character select: the controller shows it ($$sE: new screen + "characterselected" listener) before any
    // session exists, so remember the controller there too. The screen has no way back of its own;
    // W2.csBack() removes it ($$qTO) and sends the navigation event the game itself sends when a level
    // fails to load (X6 "mainmenu"), which brings back the main menu. (1.99.3 tokens: no old names.)
    var SHOW_CS = '$$sE';
    if (typeof proto[SHOW_CS] === 'function' && !proto[SHOW_CS].hwss) {
      var origShow = proto[SHOW_CS];
      proto[SHOW_CS] = function () { W2.ctl = this; return origShow.apply(this, arguments); };
      proto[SHOW_CS].hwss = true;
    }
    log('w2', 'session controller hooked');
  }
  var NavEvent = null;
  function findNavEvent() {
    if (NavEvent) return NavEvent;
    var r = H.req, vendor = H.vendorIds();
    function chainHas(p, n) { for (var i = 0; p && i < 8; p = Object.getPrototypeOf(p), i++) if (Object.getOwnPropertyDescriptor(p, n)) return true; return false; }
    for (var id in r.m) {
      if (vendor.has(id) || /hwss/.test(id)) continue;
      var ex; try { ex = r(id); } catch (e) { continue; }
      if (!ex || typeof ex !== 'object') continue;
      for (var k in ex) {
        var v; try { v = ex[k]; } catch (e) { continue; }
        if (typeof v !== 'function' || !v.prototype) continue;
        var d = Object.getOwnPropertyDescriptor(v, '$$hX');   // the event class's MAIN_MENU constant ("mainmenu")
        if (d && typeof d.value === 'string' && chainHas(v.prototype, '$$tYB')) return (NavEvent = v);
      }
    }
    return null;
  }
  W2.csOpen = function () { var c = W2.ctl; return !!(c && c['$$RV']); };
  W2.csBack = function () {
    var c = W2.ctl, Ev = findNavEvent();
    if (!c || !c['$$RV'] || typeof c['$$qTO'] !== 'function' || !Ev) { log('w2-error', 'character select back: not available'); return false; }
    c['$$qTO']();
    c.dispatchEvent(new Ev(Ev['$$hX']));
    log('w2', 'character select: back to the main menu');
    return true;
  };
  var tries = 0;
  (function poll() {
    var ok = false;
    if (H.req && H.renderer) { try { ok = scan(); } catch (e) { log('w2-error', 'scan: ' + e); } }
    if (ok) { H.Settings = St; hookController(); hookSessionClass(); return; }
    if (++tries < 120) setTimeout(poll, 1000);
  })();

  // ---------- build / destroy the copies ----------
  function makeArt(src) {
    var art = new src.constructor(null);
    art.setPixiMovieClip(new src._pixiSprite.constructor(), true);
    return art;
  }
  function freshLevelData(cap, mcClass) {
    var u = cap.loader && cap.loader.userLevelLoader;
    if (u && typeof u.buildLevelSourceObject === 'function') return u.buildLevelSourceObject();
    if (cap.levelStageCtor) {
      var mc = new mcClass(null);
      mc.setPixiMovieClip(new cap.levelStageCtor(), true);
      try { mc.gotoAndStop(mc.totalFrames); } catch (e) {}
      return mc.getChildAt(0);
    }
    return null;
  }
  function build(S1, pid) {
    var cap = W2.cap, so = S1._character && S1._character.sourceObject;
    if (!cap || !so || !cap.sessionClass || W2.worldFor(pid)) return;
    var art, ld, S, prev = St.currentSession, prevSess = St.session, prevIdx = St.characterIndex;
    // this player's own character, if they picked one and the level allows it (p2.js)
    var idx = H.PL && H.PL.charFor ? H.PL.charFor(H.PL.byId[pid]) : null;
    W2.building = true;
    try {
      art = idx ? H.PL.artFor(idx) : makeArt(so);
      if (!art) throw new Error('no art for character ' + idx);
      ld = freshLevelData(cap, so.constructor);
      if (!ld) throw new Error('cannot rebuild level data');
      // the rider class is picked from Settings.characterIndex when the session is CONSTRUCTED (setupCharacter),
      // so switch it before `new` (switching only before create() gave P1's class with this player's art)
      if (idx) St.characterIndex = idx;
      S = new cap.sessionClass(cap.version, art, ld, cap.levelVersion, cap.useDebug);
      S.hwssP2Session = true;
      S.hwssPlayer = pid;
      St.currentSession = S;
      S.create();
      if (H.N) { H.N.alias(S); H.N.aliasChar(S._character, true); H.N.alias(S._camera); }   // 1.99.3 (names.js)
    } catch (e) {
      log('w2-error', 'build P' + pid + ': ' + (e && e.stack || e));
      S = null;
    } finally {
      St.currentSession = prev;
      St.characterIndex = prevIdx;
      if (St.session !== prevSess) St.session = prevSess;
      W2.building = false;
    }
    if (!S) return;
    if (S.m_world) S.m_world.hwssP2World = true;
    try { S._character.removeKeyListeners(); } catch (e) {}
    // same zoom as P1's camera (split.js zooms P1's out only in the cropped split modes)
    var f = typeof cfg.splitZoom === 'number' && cfg.splitZoom > 0 ? cfg.splitZoom : 1;
    if (S._camera && f !== 1 && S1._camera && S1._camera.hwssZoomed) { S._camera.zoom = S._camera.zoom * f; S._camera.hwssZoomed = true; }
    // run loop with Settings.currentSession = this copy's session
    try { S.removeEventListener('enterFrame', S.runBind); } catch (e) {}
    S.hwssRun = function (ev) {
      if (!entryOf(S) || W2.paused) return;
      var p = St.currentSession;
      St.currentSession = S;
      W2.inP2Run = true;                 // audio.js skips the sound manager's step during this frame
      try { S.runBind(ev); }
      catch (e) { if (++W2.errors <= 5) log('w2-error', 'run P' + pid + ': ' + (e && e.stack || e)); if (W2.errors > 20) destroyAll('too many errors'); }
      finally { St.currentSession = p; W2.inP2Run = false; }
    };
    S.addEventListener('enterFrame', S.hwssRun);
    // the player's pad (or test-rider input) drives this copy's character
    var C = S._character, cks = C.checkKeyStates;
    C.isPlayer2 = true; C.hwssPlayer = pid;
    C.checkKeyStates = function () { if (H.PL) H.PL.applyInput(this, pid); return cks.apply(this, arguments); };
    if (H.PL) H.PL.tintShirt(C, pid);
    W2.worlds.push({ pid: pid, S: S });
    W2.worlds.sort(function (a, b) { return a.pid - b.pid; });
    W2.S2 = W2.worlds[0].S; W2.S1 = S1; W2.paused = false;
    S1.hwssCoop = true;
    log('w2', 'P' + pid + ' world built (' + C.tag + ')');
  }
  function destroyEntry(e, why) {
    var i = W2.worlds.indexOf(e);
    if (i < 0) return;
    W2.worlds.splice(i, 1);
    W2.S2 = W2.worlds.length ? W2.worlds[0].S : null;
    if (!W2.worlds.length) W2.S1 = null;
    var S = e.S;
    try { S.removeEventListener('enterFrame', S.hwssRun); } catch (x) {}
    var p = St.currentSession;
    St.currentSession = S;
    try { S.die(); } catch (x) { log('w2-error', 'die: ' + x); }
    finally { St.currentSession = p; }
    log('w2', 'P' + e.pid + ' world removed (' + why + ')');
  }
  // Back on a player's controller (p2.js): that player starts over in a fresh copy of the level; everyone
  // else keeps playing. Separate worlds only (no copy = nothing to do).
  W2.respawn = function (pid) {
    var e = null; W2.worlds.forEach(function (x) { if (x.pid === pid) e = x; });
    var S1 = W2.S1;
    if (!e || !S1) return false;
    destroyEntry(e, 'P' + pid + ' respawns');
    build(S1, pid);
    var ok = !!W2.worldFor(pid);
    if (ok && W2.onRespawn) W2.onRespawn(pid);
    log('w2', 'P' + pid + ' respawned' + (ok ? '' : ' FAILED'));
    return ok;
  };
  function destroyAll(why) { W2.worlds.slice().forEach(function (e) { destroyEntry(e, why); }); W2.errors = 0; }
  W2.destroy = destroyAll;
  // Back on P1's controller in separate worlds (p2.js): P1 starts over (the game's own level restart of P1's
  // session) while P2-P4 keep playing in their worlds — they are carried over to P1's new session instead of
  // being destroyed and rebuilt.
  W2.restartP1Only = function () {
    if (!W2.worlds.length || !W2.S1 || !W2.ctl || typeof W2.ctl.restartLevel !== 'function') return false;
    W2.keepForP1 = true;
    try { W2.ctl.restartLevel(); }
    catch (e) { W2.keepForP1 = false; log('w2-error', 'P1 restart: ' + (e && e.stack || e)); return false; }
    log('w2', 'P1 restarts alone (P' + W2.worlds.map(function (x) { return x.pid; }).join(', P') + ' keep playing)');
    return true;
  };

  // ---------- lifecycle ----------
  (H.onSession = H.onSession || []).push(function (s) {
    if (W2.keepForP1 && W2.worlds.length) {
      // P1-only restart: the other players' worlds carry on with P1's new session
      W2.keepForP1 = false;
      W2.S1 = s; s.hwssCoop = true; W2.paused = false;
      H.PL.joinedIds().forEach(function (pid) { if (!W2.worldFor(pid) && W2.isSeparate()) build(s, pid); });
      log('w2', 'P1 restarted alone; worlds kept: P' + W2.worlds.map(function (x) { return x.pid; }).join(', P'));
      return;
    }
    W2.keepForP1 = false;
    if (W2.worlds.length) destroyAll('new attempt');
    if (W2.isSeparate()) H.PL.joinedIds().forEach(function (pid) { build(s, pid); });
  });
  // pause/unpause/die/levelComplete of the session class (shared by P1's session and the copies)
  function hookSessionClass() {
    var S = H.session, proto = S && Object.getPrototypeOf(S);
    // the class may not be known yet; retry from onSession
    if (!proto) return;
    function own(name) { var p = proto; while (p && !Object.prototype.hasOwnProperty.call(p, name)) p = Object.getPrototypeOf(p); return p; }
    ['pause', 'unpause', 'die', 'levelComplete'].forEach(function (n) {
      var p = own(n);
      if (!p || p['hwssW2_' + n]) return;
      p['hwssW2_' + n] = true;
      var orig = p[n];
      p[n] = function () {
        if (W2.worlds.length && this === W2.S1) {
          if (n === 'pause') W2.paused = true;
          else if (n === 'unpause') W2.paused = false;
          else if (n === 'die' && !W2.keepForP1) destroyAll('P1 session ended');
        }
        var e = n === 'levelComplete' ? entryOf(this) : null;
        if (e) {
          // A player finished in their world: complete the level for everyone, them as the winner (P1's
          // session drives the level-complete screen). The copy's own completion is not run.
          // This runs inside the copy's frame (Settings.currentSession = the copy); the end screen code
          // looks things up through currentSession, so complete P1's session with currentSession = P1's.
          var S1 = W2.S1, args = arguments;
          if (S1 && !S1.hwssLevelDone) {
            var prevCur = St.currentSession, prevRun = W2.inP2Run;
            St.currentSession = S1; W2.inP2Run = false; S1.hwssForceWinner = 'p' + e.pid;
            try { S1.levelComplete.apply(S1, args); log('w2', 'P' + e.pid + ' finished in their world: level complete for all'); }
            catch (x) { log('w2-error', 'complete: ' + (x && x.stack || x)); }
            finally { S1.hwssForceWinner = null; St.currentSession = prevCur; W2.inP2Run = prevRun; }
          }
          return;
        }
        return orig.apply(this, arguments);
      };
    });
  }
  (H.onSession = H.onSession || []).push(function () { try { hookSessionClass(); } catch (e) {} });
  // a player left (Select+Start / F3 / F4): remove their world
  (function watch() {
    W2.worlds.slice().forEach(function (e) {
      var p = H.PL && H.PL.byId[e.pid];
      if (!p || !p.joined) destroyEntry(e, 'P' + e.pid + ' left');
    });
    setTimeout(watch, 250);
  })();
})();
