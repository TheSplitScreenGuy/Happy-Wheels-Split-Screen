/* HWSS audio: extra sound listeners for P2-P4. Appended after p2.js by tools/install.js (and safe to
 * eval into a running game for testing).
 * The game's SoundController sets one listener per step (_center = camera.midScreenPoint) and every
 * positional sound asks calculateSoundTransform(listener) -> {volume, panning} | null.
 * While the split is active, each sound is evaluated for P1's listener and every extra view's camera
 * centre, and the LOUDEST result wins (with its panning): no doubling, and each player hears what
 * happens near them. After each controller step the listener (_center) is replaced by a COPY: the
 * camera's cached point it came from gets recomputed during the other views' draw, which put P1's
 * listener at P2's spot. In separate worlds only P1's session steps the controller.
 */
(function () {
  'use strict';
  var H = window.__HWSS__;
  if (!H || H.audioLoaded) return;
  H.audioLoaded = true;
  var log = H.log;
  var A = H.audio = { patchedClasses: 0, picksP2: 0 };

  // the extra players' listeners (split.js: centre of each extra view's camera), or []
  function extraListeners() {
    var sp = H.split;
    if (!sp || !sp.active || typeof sp.extraListeners !== 'function') return [];
    try { return sp.extraListeners(); } catch (e) { return []; }
  }

  // Wrap calculateSoundTransform on every class in a sound's prototype chain that defines it.
  var patched = new WeakSet();
  function patchSound(snd) {
    for (var p = Object.getPrototypeOf(snd); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (H.N && !Object.prototype.hasOwnProperty.call(p, 'calculateSoundTransform') && Object.prototype.hasOwnProperty.call(p, H.N.real('calculateSoundTransform'))) H.N.alias(snd);
      if (!Object.prototype.hasOwnProperty.call(p, 'calculateSoundTransform') || patched.has(p)) continue;
      patched.add(p);
      (function (proto) {
        var orig = proto.calculateSoundTransform;
        proto.calculateSoundTransform = function (center) {
          var t1 = orig.call(this, center);
          if (inSecond) return t1;                   // subclasses call super: don't double-evaluate
          var ls = extraListeners();
          if (!ls.length) return t1;
          var best = t1, bv = t1 ? t1.volume : -1;
          inSecond = true;
          try {
            for (var i = 0; i < ls.length; i++) {
              var t2 = orig.call(this, ls[i]), v2 = t2 ? t2.volume : -1;
              if (v2 > bv) { best = t2; bv = v2; }
            }
          } finally { inSecond = false; }
          if (best !== t1) A.picksP2++;
          return best;
        };
      })(p);
      A.patchedClasses++;
    }
  }
  var inSecond = false;

  // Find SoundController.instance among game-module exports (class with a static instance).
  function findController() {
    var r = H.req; if (!r) return null;
    var vendor = H.vendorIds();
    for (var id in r.m) {
      if (vendor.has(id) || /hwss/.test(id)) continue;
      var ex; try { ex = r(id); } catch (e) { continue; }
      if (!ex || typeof ex !== 'object') continue;
      for (var k in ex) {
        var v; try { v = ex[k]; } catch (e) { continue; }
        var inst = v && typeof v === 'function' ? v.instance : null;
        if (inst && H.N && typeof inst === 'object') H.N.alias(inst);   // 1.99.3 old names (names.js)
        if (inst && typeof inst.playPointSoundInstance === 'function' && Array.isArray(inst._areaSounds)) return inst;
      }
    }
    return null;
  }

  function install(ctrl) {
    // Patch classes as sounds appear: on every controller step (area sounds) and on creation (point sounds).
    var stepOrig = ctrl.step;
    ctrl.step = function () {
      // Separate worlds: P2's session also calls this from its own run, which would move the listener
      // to P2's camera and re-mix every sound twice per frame (P1's audio sounded weird). Only P1's
      // session drives it; the two-listener rule covers P2's sounds.
      if (H.W2 && H.W2.inP2Run) return;
      for (var i = 0; i < this._areaSounds.length; i++) patchSound(this._areaSounds[i]);
      var r = stepOrig.apply(this, arguments);
      // The step stores the camera's CACHED midScreenPoint object as the listener (_center), by reference.
      // In a shared-world split, the camera recomputes that cached point while the shared level layer sits
      // where P2's camera put it (during P2's view pass), so until the next step every new sound (impacts,
      // gore...) was placed against P2's spot and P1 heard almost nothing (TheSplitScreenGuy's report, 1.99.3). Keep a copy.
      try { var c = this._center; if (c && typeof c.x === 'number' && c.constructor) this._center = new c.constructor(c.x, c.y); } catch (e) {}
      return r;
    };
    ['playPointSoundInstance', 'playAreaSoundInstance', 'playAreaSoundLoop', 'playAreaSoundLoopStatic'].forEach(function (n) {
      var o = ctrl[n]; if (typeof o !== 'function') return;
      ctrl[n] = function () { var snd = o.apply(this, arguments); if (snd && typeof snd === 'object') patchSound(snd); return snd; };
    });
    ctrl._areaSounds.forEach(patchSound);
    A.controller = ctrl;
    // record who mutes/unmutes the whole sound engine (Howler) — diagnosing "almost no audio"
    var Hw = window.Howler;
    if (Hw && typeof Hw.mute === 'function' && !Hw.mute.hwss) {
      var origMute = Hw.mute, m = function (v) {
        if (typeof v === 'boolean' && v !== Hw._muted) {
          var st = String(new Error().stack || '').split('\n').slice(2, 6).map(function (l) { return l.trim().replace(/https?:\/\/[^)]*\//, ''); }).join(' < ');
          log('audio', 'Howler.mute(' + v + ') paused=' + !!(H.session && H.session.paused) + ' split=' + !!(H.split && H.split.active) + ' from ' + st);
        }
        return origMute.apply(this, arguments);
      };
      m.hwss = true;
      Hw.mute = m;
    }
    log('audio', 'P2 listener installed (' + A.patchedClasses + ' sound classes patched so far)');
  }

  // Only scan the game's modules once the game is actually running (renderer seen by split.js):
  // requiring a module that hasn't been loaded yet would execute it early.
  var tries = 0;
  function poll() {
    tries++;
    var c = null;
    if (H.req && H.renderer) {
      try { c = findController(); } catch (e) { log('audio', 'find error: ' + e); }
    }
    if (c) install(c); else if (tries < 180) setTimeout(poll, 1000);
  }
  if (document.readyState === 'complete') setTimeout(poll, 3000);
  else window.addEventListener('load', function () { setTimeout(poll, 3000); });
})();
