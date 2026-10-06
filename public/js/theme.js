// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('tc.theme');
  } catch (e) {}
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
