// Grab the REAL canvas right after the next game frame is drawn (inside the same render call, before
// the browser clears the drawing buffer). Returns a PNG data URL at the canvas' real size.
(async function () {
  var R = __HWSS__.renderer, proto = Object.getPrototypeOf(R);
  return await new Promise(function (resolve) {
    var orig = R.render;   // instance or prototype
    R.render = function (obj, opts) {
      var r = orig.apply(this, arguments);
      if (opts === undefined && obj) {
        delete R.render;
        if (R.render !== orig) R.render = orig;
        resolve(R.view.toDataURL('image/png'));
      }
      return r;
    };
    setTimeout(function () { resolve(null); }, 3000);
  });
})()
