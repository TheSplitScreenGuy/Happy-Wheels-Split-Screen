// Test helper for driving the game from the dev channel (installs window.HWT; safe to eval repeatedly).
//   HWT.texts(re)          visible text objects matching re → [{text, x, y, w, h}] in 900x500 coords
//   HWT.clickAt(x, y)      pointer down/up on the canvas at 900x500 coords (what a real click does)
//   HWT.clickText(re)      click the centre of the first visible text matching re (or its button parent)
//   HWT.key(code, up)      keydown (+keyup) on window, e.g. HWT.key('F5')
//   HWT.mainMenu()         the main menu screen object (or null)
(function () {
  var H = __HWSS__;
  function walk(px, fn, d) { if (!px || d > 14) return; fn(px); (px.children || []).forEach(function (c) { walk(c, fn, (d || 0) + 1); }); }
  function stage() { return H.stage; }
  var HWT = window.HWT = {};
  HWT.texts = function (re) {
    var out = [];
    walk(stage(), function (o) {
      if (typeof o.text !== 'string' || !o.worldVisible) return;
      if (re && !new RegExp(re, 'i').test(o.text)) return;
      var b = o.getBounds();
      out.push({ text: o.text.slice(0, 60), x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
    }, 0);
    return out;
  };
  HWT.clickAt = function (x, y) {
    // game (900x500) coordinates → page; in monitor mode the game area is fitted into P1's monitor
    var R = H.renderer, cv = R.view, g = H.gameRect ? H.gameRect() : null, rect = cv.getBoundingClientRect();
    if (!g) g = { left: rect.left, top: rect.top, width: rect.width * 900 / R.screen.width, height: rect.height * 500 / R.screen.height };
    var cx = g.left + x * g.width / 900, cy = g.top + y * g.height / 500;
    var o = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    cv.dispatchEvent(new PointerEvent('pointermove', o));
    cv.dispatchEvent(new PointerEvent('pointerdown', o));
    o.buttons = 0;
    cv.dispatchEvent(new PointerEvent('pointerup', o));
    window.dispatchEvent(new PointerEvent('pointerup', o));
    return [Math.round(cx), Math.round(cy)];
  };
  HWT.clickText = function (re) {
    var t = HWT.texts(re)[0];
    if (!t) return 'no text ' + re;
    HWT.clickAt(t.x + t.w / 2, t.y + t.h / 2);
    return 'clicked "' + t.text + '"';
  };
  HWT.key = function (code, keyCode) {
    var o = { bubbles: true, cancelable: true, code: code, key: code, keyCode: keyCode || 0, which: keyCode || 0 };
    // once, on the document: it bubbles to window too (sending to both delivered every key twice)
    document.dispatchEvent(new KeyboardEvent('keydown', o));
    setTimeout(function () { document.dispatchEvent(new KeyboardEvent('keyup', o)); }, 80);
    return 'key ' + code;
  };
  // hold / release a game key (e.g. ArrowUp 38) for driving P1
  HWT.hold = function (code, keyCode, down) {
    var o = { bubbles: true, cancelable: true, code: code, key: code, keyCode: keyCode, which: keyCode };
    document.dispatchEvent(new KeyboardEvent(down === false ? 'keyup' : 'keydown', o));
    return (down === false ? 'released ' : 'holding ') + code;
  };
  // start a featured level by its list name (main menu must be up)
  HWT.startFeatured = function (name) {
    var mm = HWT.mainMenu(); if (!mm) return 'no main menu';
    mm.openFeaturedMenu();
    setTimeout(function () { HWT.clickText('^' + name + '$'); setTimeout(function () { HWT.clickAt(630, 395); }, 1500); }, 3000);
    return 'starting ' + name;
  };
  HWT.mainMenu = function () {
    var mm = null;
    walk(stage(), function (px) { var o = px._flashSprite, p = o && Object.getPrototypeOf(o); if (!mm && p && p.createButtons && p.openLevelBrowser) mm = o; }, 0);
    return mm;
  };
  return 'HWT ready';
})()
