/*
 * Classic (non-module) script: reports problems that would otherwise leave a blank page,
 * e.g. opening index.html directly from disk or a browser without ES module support.
 * Kept in its own file (not inline) so the Content-Security-Policy can forbid inline scripts.
 */
(function () {
  function fail(title, detail) {
    var text = document.getElementById('loading-text');
    var info = document.getElementById('loading-detail');
    var root = document.getElementById('loading');
    if (!text || !root) return;
    root.classList.add('error');
    text.textContent = title;
    info.innerHTML = detail;
  }
  if (location.protocol === 'file:') {
    fail('Please run Earth 3D from a local web server',
      'Browsers block textures and data loaded from <code>file://</code>.<br>' +
      'In the <b>earth-3d</b> folder run <code>python scripts/serve.py</code>,<br>' +
      'then open <code>http://localhost:8000</code>.');
    return;
  }
  // First script error before the start (e.g. a module that no longer matches a cached one)
  var scriptError = null;
  window.addEventListener('error', function (e) {
    if (!scriptError && !window.__EARTH3D_STARTED && e.message) scriptError = e.message;
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (window.__EARTH3D_STARTED) return;
      if (scriptError) {
        fail('Earth 3D could not start',
          'An application script could not be loaded: <code>' +
          scriptError.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code><br>' +
          'After an update the browser may still use old cached files: press <b>Ctrl+F5</b> ' +
          '(Mac: <b>Cmd+Shift+R</b>) to reload them.');
      } else {
        fail('Earth 3D could not start',
          'Your browser could not load the application scripts (ES modules / import maps).<br>' +
          'Please use a recent version of Chrome, Edge, Firefox or Safari.');
      }
    }, 1500);
  });
})();
