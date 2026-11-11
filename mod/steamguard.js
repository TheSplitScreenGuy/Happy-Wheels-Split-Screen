// HWSS steam guard: appended to app.asar.unpacked/node_modules/steamworks.js/index.js by
// tools/install.js. Runs in Electron's MAIN process and wraps the Steamworks client.
// Steam achievements and stats are ALLOWED by default (co-op included, TheSplitScreenGuy's choice 2026-11-08).
// Setting "blockSteamAchievements": true in resources/webroot/hwss/config.json blocks every achievement
// unlock and stat write/store (read when the game starts). Reads and Steam Cloud saves always pass.
// Log: %APPDATA%\HappyWheels\hwss-steamguard.log (Linux: ~/.config/HappyWheels)
(function () {
  const fs = require('node:fs');
  const p = require('node:path');
  // Windows / Proton: %APPDATA%; native Linux (Steam Deck): $XDG_CONFIG_HOME or ~/.config
  const base = process.env.APPDATA || process.env.XDG_CONFIG_HOME || p.join(require('node:os').homedir(), '.config');
  const logFile = p.join(base, 'HappyWheels', 'hwss-steamguard.log');
  const log = (msg) => { try { fs.mkdirSync(p.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {} };

  // resources/app.asar.unpacked/node_modules/steamworks.js → resources/webroot/hwss/config.json
  function blockWanted() {
    const dir = typeof __dirname === 'string' ? __dirname : '';
    const cfgPath = process.env.HWSS_CONFIG || p.join(dir, '..', '..', '..', 'webroot', 'hwss', 'config.json');
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).blockSteamAchievements === true; }
    catch (e) { return false; }                        // no/unreadable config: the default (allowed)
  }

  const realInit = module.exports.init;
  module.exports.init = function (appId) {
    const api = realInit(appId);
    if (!blockWanted()) { log('steam guard: achievements + stats allowed (appId ' + appId + ')'); return api; }
    const guarded = Object.assign({}, api);
    if (api.achievement) {
      guarded.achievement = Object.assign({}, api.achievement, {
        activate: (name) => { log('BLOCKED achievement.activate ' + name); return false; },
        clear: (name) => { log('BLOCKED achievement.clear ' + name); return false; },
      });
    }
    if (api.stats) {
      guarded.stats = Object.assign({}, api.stats, {
        setInt: (name, v) => { log('BLOCKED stats.setInt ' + name + '=' + v); return true; },
        store: () => { log('BLOCKED stats.store'); return true; },
        resetAll: () => { log('BLOCKED stats.resetAll'); return false; },
      });
    }
    log('steam guard active: achievements + stats blocked (blockSteamAchievements) (appId ' + appId + ')');
    return guarded;
  };

  // ---------- monitor mode: the game window spread over two monitors (main-menu / pause-menu toggle) ----------
  // The page leaves a request in window.__hwssMonReq ('on' | 'off' | 'query'), polled here every 400 ms
  // (contextIsolation + sandbox: no other channel; console messages didn't arrive). Answer:
  // window.__hwssMonitors({...}) run in the page. Two window kinds:
  //  - 1.99.3 default on Windows ("native"): the page renders offscreen and the game shows its frames in
  //    its own native window (steamworks.js gameWindow). That window is placed with Win32 calls through a
  //    PowerShell helper (spanOnNative); OFF puts its frame style back, then fullscreen / maximized.
  //  - "classic" BrowserWindow (--classic-window, older builds): its CONTENT area is set to cover the
  //    monitors and the frame sits outside them (spanOn).
  try {
    const electron = require('electron');
    const { app, BrowserWindow, screen } = electron;
    const state = new WeakMap();                       // window → { on, wasFull, wasMax }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Two monitors only: the primary one (P1) and the monitor closest to it (3+ monitors: the rest are
    // left alone).
    function displays() {
      const all = screen.getAllDisplays(), prim = screen.getPrimaryDisplay();
      const ds = all.map((d) => ({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, primary: d.id === prim.id, scale: d.scaleFactor }));
      const P = ds.find((d) => d.primary) || ds[0];
      if (!P || ds.length <= 2) return ds;
      const cx = (d) => d.x + d.w / 2, cy = (d) => d.y + d.h / 2;
      const next = ds.filter((d) => d !== P).sort((a, b) => Math.hypot(cx(a) - cx(P), cy(a) - cy(P)) - Math.hypot(cx(b) - cx(P), cy(b) - cy(P)))[0];
      return [P, next];
    }
    function union(ds) {
      const x0 = Math.min(...ds.map((d) => d.x)), y0 = Math.min(...ds.map((d) => d.y));
      const x1 = Math.max(...ds.map((d) => d.x + d.w)), y1 = Math.max(...ds.map((d) => d.y + d.h));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    function tell(win) {
      if (!win || win.isDestroyed()) return;
      const st = state.get(win) || {}, ds = displays();
      const info = { on: !!st.on, displays: ds, union: union(ds) };
      win.webContents.executeJavaScript('window.__hwssMonitors && window.__hwssMonitors(' + JSON.stringify(info) + ')').catch(() => {});
    }
    // Leaving fullscreen to span makes the game save "windowed" as the player's preference, and monitor
    // mode comes back on by itself at the next start (already windowed): remember the player's real
    // fullscreen choice in a file of our own, so turning monitor mode off restores it.
    const prefFile = p.join(base, 'HappyWheels', 'hwss-monitors.json');
    const readPref = () => { try { return JSON.parse(fs.readFileSync(prefFile, 'utf8')); } catch (e) { return {}; } };
    const writePref = (o) => { try { fs.writeFileSync(prefFile, JSON.stringify(o)); } catch (e) {} };
    // ---- 1.99.3 native window ----
    // 1.99.3 (Windows, unless --classic-window) renders the page in a hidden OFFSCREEN BrowserWindow and
    // shows the frames in its own native window (steamworks.js gameWindow, class HappyWheelsGameWindow).
    // Resizing the BrowserWindow only changed the offscreen size; the native window has no setBounds, so
    // it is placed with Win32 SetWindowPos through a PowerShell helper (no FFI in the main process). The
    // native window reports its new size to the game, which resizes the page itself.
    const gw = module.exports.gameWindow;
    const isNative = (win) => { try { return !!(gw && gw.getState && win.webContents.isOffscreen()); } catch (e) { return false; } };
    const gwState = () => { try { return gw.getState() || {}; } catch (e) { return {}; } };
    // NB PowerShell variables are case-insensitive: the window handle must not be called $h ($H = height).
    const WIN_PS = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class HwssW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static IntPtr Find(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p != want) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "HappyWheelsGameWindow") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
"@
$hwnd = [HwssW]::Find([uint32]$P)
if ($hwnd -eq [IntPtr]::Zero) { '{"ok":false,"error":"no game window"}'; exit }
$old = [HwssW]::GetWindowLongPtr($hwnd, -16).ToInt64()
if ($Mode -eq 'style') {
  [void][HwssW]::SetWindowLongPtr($hwnd, -16, [IntPtr]$Style)
  [void][HwssW]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0, 0x0027)
  '{"ok":true,"oldStyle":' + $old + '}'; exit
}
if ([HwssW]::IsZoomed($hwnd)) { [void][HwssW]::ShowWindow($hwnd, 9); Start-Sleep -Milliseconds 200; $old = [HwssW]::GetWindowLongPtr($hwnd, -16).ToInt64() }
$ns = $old -band (-bnot 0xC40000)
if ($ns -ne $old) { [void][HwssW]::SetWindowLongPtr($hwnd, -16, [IntPtr]$ns) }
$tx = $X; $ty = $Y; $tw = $W; $th = $H
for ($i = 0; $i -lt 3; $i++) {
  [void][HwssW]::SetWindowPos($hwnd, [IntPtr]::Zero, $tx, $ty, $tw, $th, 0x0024)
  $wr = New-Object HwssW+RECT; [void][HwssW]::GetWindowRect($hwnd, [ref]$wr)
  $cr = New-Object HwssW+RECT; [void][HwssW]::GetClientRect($hwnd, [ref]$cr)
  $pt = New-Object HwssW+POINT; [void][HwssW]::ClientToScreen($hwnd, [ref]$pt)
  $cw = $cr.R; $ch = $cr.B
  if ($pt.X -eq $X -and $pt.Y -eq $Y -and $cw -eq $W -and $ch -eq $H) { break }
  $tx = $wr.L + ($X - $pt.X); $ty = $wr.T + ($Y - $pt.Y)
  $tw = ($wr.R - $wr.L) + ($W - $cw); $th = ($wr.B - $wr.T) + ($H - $ch)
}
'{"ok":true,"oldStyle":' + $old + ',"client":[' + $pt.X + ',' + $pt.Y + ',' + $cw + ',' + $ch + ']}'
`;
    function winHelper(vars) {
      const pre = Object.entries(vars).map(([k, v]) => '$' + k + ' = ' + (typeof v === 'string' ? "'" + v + "'" : Math.round(v)) + ';').join(' ');
      const enc = Buffer.from(pre + '\n' + WIN_PS, 'utf16le').toString('base64');
      return new Promise((resolve) => {
        require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
          { windowsHide: true, timeout: 20000 }, (err, out) => {
            if (err) { log('monitors helper error: ' + err.message); resolve({ ok: false }); return; }
            try { resolve(JSON.parse(String(out).trim().split(/\r?\n/).pop())); } catch (e) { log('monitors helper output: ' + out); resolve({ ok: false }); }
          });
      });
    }
    async function spanOnNative(win, ds) {
      const pref = readPref();
      const wasFull = pref.spanned ? !!pref.wasFull : !!gwState().fullscreen;
      writePref({ spanned: true, wasFull: wasFull, style: pref.spanned ? pref.style : undefined });
      const st = { on: true, wasFull: wasFull, native: true };
      state.set(win, st);
      if (gwState().fullscreen) { gw.setFullscreen(false); await sleep(700); }
      const u = union(ds);
      const r = await winHelper({ P: process.pid, Mode: 'span', X: u.x, Y: u.y, W: u.w, H: u.h });
      // the frame style from before spanning (kept across restarts so OFF can put the frame back)
      const style = pref.spanned && pref.style ? pref.style : r.oldStyle;
      st.style = style;
      writePref({ spanned: true, wasFull: wasFull, style: style });
      try { gw.focus(); } catch (e) {}
      log('monitors ON (native window): ' + ds.length + ' displays, ' + JSON.stringify(u) + ', helper ' + JSON.stringify(r));
      await sleep(300);
      tell(win);
    }
    async function spanOffNative(win, st) {
      writePref({ spanned: false });
      if (st.style) await winHelper({ P: process.pid, Mode: 'style', Style: st.style });
      if (st.wasFull) gw.setFullscreen(true); else gw.maximize();
      log('monitors OFF (native window)' + (st.wasFull ? ' (back to fullscreen)' : ''));
    }

    async function spanOn(win) {
      const ds = displays();
      if (ds.length < 2) { log('monitors: only one display'); tell(win); return; }
      if (isNative(win)) return spanOnNative(win, ds);
      const pref = readPref();
      const wasFull = pref.spanned ? !!pref.wasFull : win.isFullScreen();
      writePref({ spanned: true, wasFull: wasFull });
      const st = { on: true, wasFull: wasFull, wasMax: win.isMaximized() };
      state.set(win, st);
      if (win.isFullScreen()) { win.setFullScreen(false); await sleep(500); }
      if (win.isMaximized()) { win.unmaximize(); await sleep(250); }
      const u = union(ds);
      for (let i = 0; i < 3; i++) { win.setContentBounds({ x: u.x, y: u.y, width: u.w, height: u.h }); await sleep(150); }
      win.focus();
      log('monitors ON: ' + ds.length + ' displays, ' + JSON.stringify(u) + ', window ' + JSON.stringify(win.getBounds()));
      tell(win);
    }
    async function spanOff(win) {
      const st = state.get(win);
      state.set(win, { on: false });
      if (st && st.on && st.native) await spanOffNative(win, st);
      else if (st && st.on) {
        writePref({ spanned: false });
        if (st.wasFull) win.setFullScreen(true);
        else { win.maximize(); }
        log('monitors OFF' + (st.wasFull ? ' (back to fullscreen)' : ''));
      }
      await sleep(300);
      tell(win);
    }
    // The page leaves a request in window.__hwssMonReq ('on' | 'off' | 'query'); polled here (console
    // messages did not reach the main process in this build).
    const POLL = '(function(){var r=window.__hwssMonReq||"";window.__hwssMonReq="";return r})()';
    function hook(win) {
      if (!win || win.hwssMonHooked) return;
      win.hwssMonHooked = true;
      log('monitors: watching window ' + win.id);
      let busy = false;
      const timer = setInterval(() => {
        if (win.isDestroyed()) { clearInterval(timer); return; }
        if (busy) return;
        // native window: the game's own fullscreen (F11 / its button) ends monitor mode
        const ms = state.get(win);
        if (ms && ms.on && ms.native && gwState().fullscreen) {
          state.set(win, { on: false }); writePref({ spanned: false }); log('monitors OFF (fullscreen)'); setTimeout(() => tell(win), 300);
        }
        win.webContents.executeJavaScript(POLL, true).then((cmd) => {
          if (!cmd) return;
          busy = true;
          const done = () => { busy = false; };
          if (cmd === 'on') spanOn(win).catch((x) => log('monitors error: ' + x)).then(done);
          else if (cmd === 'off') spanOff(win).catch((x) => log('monitors error: ' + x)).then(done);
          else { tell(win); done(); }
        }).catch(() => {});
      }, 400);
      // the game's own fullscreen (F11 / its button) covers one monitor: monitor mode ends
      win.on('enter-full-screen', () => { const st = state.get(win); if (st && st.on) { state.set(win, { on: false }); writePref({ spanned: false }); log('monitors OFF (fullscreen)'); setTimeout(() => tell(win), 300); } });
    }
    const start = () => {
      BrowserWindow.getAllWindows().forEach(hook);
      app.on('browser-window-created', (e, win) => hook(win));
      const again = () => BrowserWindow.getAllWindows().forEach(tell);
      screen.on('display-added', again); screen.on('display-removed', again); screen.on('display-metrics-changed', again);
    };
    if (app.isReady()) start(); else app.once('ready', start);
  } catch (e) { log('monitors setup failed: ' + (e && e.stack || e)); }
})();
