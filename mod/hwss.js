/* HWSS - Happy Wheels splitscreen mod by TheSplitScreenGuy. Renderer-side loader (first file of the bundle).
 * Injected at the top of webroot/js/dependencies.js by tools/install.js (dev) or install.py (release),
 * so it runs before any game code. Reads the config, filters network requests (see verdict(): with the
 * installers' settings everything goes through except the replay/leaderboard upload during a co-op
 * attempt and Sentry crash reports), logs to the dev server when one is configured, and finds the
 * game's webpack chunk array for the other modules. Steam achievement/stat writes are handled in the
 * main process (steamguard.js): allowed unless blockSteamAchievements is true.
 */
(function () {
  'use strict';
  if (window.__HWSS__) return;

  // ---------- config (webroot/hwss/config.json, read synchronously at startup) ----------
  // These are the fallbacks when config.json is missing. Both installers write onlineMode "blocklist"
  // (TheSplitScreenGuy's choice 2026-11-06): online features work, only the co-op replay upload is blocked.
  var cfg = {
    devServer: '',              // e.g. "http://127.0.0.1:8737" - logs + command channel; "" = off
    // totaljerkface.com filtering on/off. GETs that look like a submission are blocked in both modes.
    blockTotalJerkFace: true,
    // "allowlist" mode only: POST "action=" values that get through (the installers add the read-only
    // ones TheSplitScreenGuy approved: get_featured, get_record, rate_level, get_all, search, favorites).
    allowPostActions: [],
    // "allowlist": only allowPostActions get through (every other POST blocked). "blocklist": every
    // request gets through EXCEPT blockPostActions entries, written "/path.hw:action"
    // (e.g. "/replay.hw:create" = replay/leaderboard upload).
    onlineMode: 'allowlist',
    blockPostActions: [],
    // "blocklist" mode: blocked only for a co-op attempt (another player spawned in the current attempt):
    // the replay/leaderboard upload. Solo uploads go through.
    blockPostActionsCoop: ['/replay.hw:create'],
    blockSteamAchievements: false,   // true = block Steam achievement unlocks + stat writes (default: allowed)
    blockSentry: true           // never send error reports to the developers' Sentry
  };
  try {
    var x = new XMLHttpRequest();
    x.open('GET', './hwss/config.json', false);
    x.send();
    if (x.status === 200) {
      var c = JSON.parse(x.responseText);
      for (var k in c) cfg[k] = c[k];
    }
  } catch (e) { /* defaults */ }

  var HW = window.__HWSS__ = { cfg: cfg, version: '1.0.1', blocked: [], log: log };
  // The game's webpack chunk array (self.<name>) differs per build and version (1.99.2: Windows
  // Tmuvm81k91, native Linux Tmuvmbn5d9; 1.99.3: Tmw7x8r033, also on the Steam Deck under Proton). The
  // installers read it from dependencies.js into cfg.chunkGlobal; if that's missing, findChunkName()
  // looks for the array whose push webpack has replaced (game loaded).
  HW.chunkName = typeof cfg.chunkGlobal === 'string' && cfg.chunkGlobal ? cfg.chunkGlobal : null;
  HW.findChunkName = function () {
    if (HW.chunkName && self[HW.chunkName]) return HW.chunkName;
    var keys = Object.getOwnPropertyNames(self);
    for (var i = 0; i < keys.length; i++) {
      var v; try { v = self[keys[i]]; } catch (e) { continue; }
      if (Array.isArray(v) && v.push !== Array.prototype.push && v.length && Array.isArray(v[0]) && Array.isArray(v[0][0])) return (HW.chunkName = keys[i]);
    }
    return HW.chunkName;
  };
  // module ids of the first (vendor) chunk: libraries, skipped when scanning for game classes
  HW.vendorIds = function () {
    var c = HW.findChunkName() && self[HW.chunkName];
    return c && c[0] && c[0][1] ? new Set(Object.keys(c[0][1])) : new Set();
  };

  // ---------- logging to the local dev server (fire and forget, never throws) ----------
  var queue = [], flushing = false, origFetch = window.fetch, nativeFetch = origFetch.bind(window);
  var recent = HW.recent = [];      // last 40 log lines, for the cfg.diag snapshot (p2.js)
  function log(type, data) {
    var line = { t: Date.now(), type: type, data: data };
    if (type !== 'net') {
      recent.push(type + ' ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300));
      if (recent.length > 40) recent.shift();
    }
    if (!cfg.devServer) return;
    queue.push(line);
    if (!flushing) { flushing = true; setTimeout(flush, 250); }
  }
  function flush() {
    var batch = queue.splice(0, queue.length);
    nativeFetch(cfg.devServer + '/log', { method: 'POST', body: JSON.stringify(batch) })
      .catch(function () {}).then(function () { flushing = false; if (queue.length) { flushing = true; setTimeout(flush, 250); } });
  }

  // Make wrappers look native to Function.prototype.toString (obfuscated code may check).
  var nativeToString = Function.prototype.toString, disguised = new WeakMap();
  function disguise(wrapper, original) { disguised.set(wrapper, original); return wrapper; }
  Function.prototype.toString = disguise(function toString() {
    return nativeToString.call(disguised.get(this) || this);
  }, nativeToString);
  HW.disguise = disguise;

  // (1.99.3: the game's own modules register in the same webpack runtime as the vendor chunk, so H.req
  // reaches every game class; only the scans by readable member names need names.js.)

  // ---------- network: classify + block ----------
  var TJF = /(^|\.)totaljerkface\.com$/i;
  var SENTRY = /(^|\.)sentry\.io$|ingest\./i;
  var SUBMITTY = /submit|upload|save|score|record_?(add|set|new|put)|replay_?(add|save|put|new)|rate|rating|vote|comment|report|flag|post|achiev|stat|beacon|track|telemetry|log/i;

  function bodyAction(body) {
    try {
      if (body == null) return '';
      if (typeof body === 'string') return new URLSearchParams(body).get('action') || '';
      if (body instanceof URLSearchParams) return body.get('action') || '';
      if (typeof FormData !== 'undefined' && body instanceof FormData) return String(body.get('action') || '');
    } catch (e) {}
    return '';
  }
  function bodySummary(body) {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return body.length > 300 ? body.slice(0, 300) + '...(' + body.length + ')' : body;
      if (body instanceof URLSearchParams) return bodySummary(body.toString());
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var o = {}; body.forEach(function (v, k) { o[k] = typeof v === 'string' ? v.slice(0, 80) : '[blob ' + (v.size || 0) + ']'; }); return o;
      }
      return '[' + (body.constructor && body.constructor.name) + ' ' + (body.byteLength || body.size || '') + ']';
    } catch (e) { return '[?]'; }
  }
  // returns null to allow, or a reason string to block
  function verdict(method, url, body) {
    var u; try { u = new URL(url, location.href); } catch (e) { return 'unparseable-url'; }
    if (cfg.blockSentry && SENTRY.test(u.hostname)) return 'sentry';
    if (u.hostname === '127.0.0.1' && cfg.devServer && String(url).indexOf(cfg.devServer) === 0) return null;
    if (TJF.test(u.hostname)) {
      // Local game files: served from disk by the app's protocol handler, never sent online.
      if (u.pathname.indexOf('/__hw_app__/') === 0) return null;
      if (!cfg.blockTotalJerkFace) return null;
      var m = (method || 'GET').toUpperCase();
      var tag = 'tjf:' + m + ' ' + u.pathname;
      if (m === 'GET' || m === 'HEAD') {
        return SUBMITTY.test(u.pathname + u.search) ? tag + ' (looks like a submission)' : null;
      }
      var action = bodyAction(body) || u.searchParams.get('action') || '';
      if (cfg.onlineMode === 'blocklist') {
        // allowed unless this exact script+action is blocked: always (blockPostActions), or only for a
        // co-op attempt (blockPostActionsCoop; session.hwssCoop is set when P2 spawns in the attempt)
        var key = u.pathname + ':' + action;
        if ((cfg.blockPostActions || []).indexOf(key) >= 0) return tag + ' action=' + action + ' (blocklist)';
        var coop = !!(HW.session && HW.session.hwssCoop);
        if (coop && (cfg.blockPostActionsCoop || []).indexOf(key) >= 0) return tag + ' action=' + action + ' (co-op attempt)';
        return null;
      }
      if (m === 'POST' && action && cfg.allowPostActions.indexOf(action) >= 0) return null;
      return tag + (action ? ' action=' + action : '');
    }
    return null;
  }
  HW.verdict = verdict;   // exposed for tests
  function record(kind, method, url, body, reason) {
    var entry = { kind: kind, method: method, url: String(url), body: bodySummary(body), blocked: reason };
    if (reason) HW.blocked.push(entry);
    log('net', entry);
  }

  // fetch
  window.fetch = disguise(function fetch(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = (init && init.method) || (input && input.method) || 'GET';
    var body = init && init.body;
    var reason = verdict(method, url, body);
    if (!(cfg.devServer && String(url).indexOf(cfg.devServer) === 0)) record('fetch', method, url, body, reason);
    if (reason) {
      // Behave exactly like having no internet: the request never leaves the PC.
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return nativeFetch(input, init);
  }, origFetch);

  // XMLHttpRequest
  var XP = XMLHttpRequest.prototype, xOpen = XP.open, xSend = XP.send;
  XP.open = disguise(function open(method, url) {
    this.__hwss = { method: method, url: url };
    return xOpen.apply(this, arguments);
  }, xOpen);
  XP.send = disguise(function send(body) {
    var m = this.__hwss;
    if (m) {
      var reason = verdict(m.method, m.url, body);
      record('xhr', m.method, m.url, body, reason);
      if (reason) {
        // Behave like a network failure (status 0 + "error" event); the real send never runs.
        var self = this;
        try { Object.defineProperty(self, 'readyState', { value: 4, configurable: true }); } catch (e) {}
        setTimeout(function () {
          ['readystatechange', 'error', 'loadend'].forEach(function (t) {
            var ev = t === 'readystatechange' ? new Event(t) : new ProgressEvent(t);
            try { self.dispatchEvent(ev); } catch (e) {}
          });
        }, 0);
        return;
      }
    }
    return xSend.apply(this, arguments);
  }, xSend);

  // sendBeacon
  if (navigator.sendBeacon) {
    var nBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = disguise(function sendBeacon(url, data) {
      var reason = verdict('POST', url, data);
      record('beacon', 'POST', url, data, reason);
      return reason ? true : nBeacon(url, data);
    }, navigator.sendBeacon);
  }

  // WebSocket
  if (window.WebSocket) {
    var NWS = window.WebSocket;
    var WS = disguise(function WebSocket(url, protocols) {
      var reason = verdict('WS', url, null);
      record('websocket', 'WS', url, null, reason);
      if (reason) url = 'ws://127.0.0.1:9/hwss-blocked';   // dead local port: fails, nothing sent online
      return protocols === undefined ? new NWS(url) : new NWS(url, protocols);
    }, NWS);
    WS.prototype = NWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { WS[k] = NWS[k]; });
    window.WebSocket = WS;
  }

  // Image / script / iframe src pings to TJF (e.g. tracking pixels)
  [['HTMLImageElement', 'src'], ['HTMLScriptElement', 'src'], ['HTMLIFrameElement', 'src']].forEach(function (p) {
    var C = window[p[0]]; if (!C) return;
    var d = Object.getOwnPropertyDescriptor(C.prototype, p[1]); if (!d || !d.set) return;
    Object.defineProperty(C.prototype, p[1], {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: disguise(function (v) {
        var reason = verdict('GET', v, null);
        if (reason) { record(p[0], 'GET', v, null, reason); return; }
        return d.set.call(this, v);
      }, d.set)
    });
  });

  // ---------- Steam: achievements / stats ----------
  // (writeProgress = the Steam Cloud progress file with the featured check marks: never blocked)
  var STEAM_WRITES = { unlockAchievement: 1, setStat: 1, addStat: 1, storeStats: 1 };
  function wrapSteam() {
    var api = window.hwNative;
    if (!api || !api.steam || typeof api.steam.call !== 'function') { log('steam', 'hwNative.steam missing'); return 'missing'; }
    var realCall = api.steam.call;
    var fakeStats = {};
    var wrapped = disguise(function call(method) {
      var args = Array.prototype.slice.call(arguments, 1);
      if (cfg.blockSteamAchievements && STEAM_WRITES[method]) {
        HW.blocked.push({ kind: 'steam', method: method, args: args });
        log('steam-blocked', { method: method, args: args });
        switch (method) {
          case 'unlockAchievement': return Promise.resolve(false);
          case 'setStat': fakeStats[args[0]] = Number(args[1]); return Promise.resolve(true);
          case 'addStat':
            return Promise.resolve(realCall('getStat', args[0])).then(function (v) {
              var cur = (args[0] in fakeStats) ? fakeStats[args[0]] : (v == null ? 0 : v);
              fakeStats[args[0]] = cur + Number(args[1]);
              return fakeStats[args[0]];
            });
          default: return Promise.resolve(true);
        }
      }
      if (cfg.blockSteamAchievements && method === 'getStat' && args[0] in fakeStats) return Promise.resolve(fakeStats[args[0]]);
      return realCall.apply(this, arguments);
    }, realCall);

    // Try in order: mutate the bridged object, then shadow window.hwNative with a copy.
    try { api.steam.call = wrapped; } catch (e) {}
    if (window.hwNative.steam.call === wrapped) return 'mutated';
    try {
      var copy = {};
      for (var k in api) copy[k] = api[k];
      copy.steam = { call: wrapped };
      Object.defineProperty(window, 'hwNative', { value: copy, configurable: true, writable: false, enumerable: true });
    } catch (e) { /* expected in the real game: contextBridge makes hwNative read-only */ }
    // Not fatal: the real block is mod/steamguard.js in the main process.
    return window.hwNative.steam.call === wrapped ? 'shadowed' : 'renderer-hook-unavailable (steamguard.js blocks in main process)';
  }
  HW.steamHook = wrapSteam();

  // ---------- dev command channel: poll devServer for JS to evaluate ----------
  if (cfg.devServer) {
    var indirectEval = eval;
    var poll = function () {
      nativeFetch(cfg.devServer + '/cmd').then(function (r) { return r.ok ? r.json() : null; }).then(function (cmd) {
        if (cmd && cmd.id) {
          var out;
          Promise.resolve().then(function () { return indirectEval(cmd.code); }).then(function (v) {
            try { out = { ok: true, value: JSON.parse(JSON.stringify(v === undefined ? null : v)) }; }
            catch (e) { out = { ok: true, value: String(v) }; }
          }, function (e) { out = { ok: false, error: String(e && e.stack || e) }; }).then(function () {
            return nativeFetch(cfg.devServer + '/result', { method: 'POST', body: JSON.stringify({ id: cmd.id, result: out }) });
          });
        }
      }).catch(function () {}).then(function () { setTimeout(poll, 300); });
    };
    setTimeout(poll, 500);
  }

  window.addEventListener('error', function (e) { log('error', String(e.message) + ' @' + e.filename + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { log('rejection', String(e.reason && e.reason.stack || e.reason)); });
  log('start', { version: HW.version, steamHook: HW.steamHook, cfg: cfg, ua: navigator.userAgent });
})();
