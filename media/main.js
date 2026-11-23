(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const t = { origin: performance.timeOrigin, dom: Date.now() };
  window.addEventListener('load', () => {
    t.load = Date.now();
    requestAnimationFrame(() => { t.paint = Date.now(); vscode.postMessage({ type: 'timing', t }); });
  });
  const btn = document.getElementById('edit-btn');
  if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'edit' }));

  // Follow panel: remember the scroll position of each document it has shown.
  const scrolls = new Map();
  let currentKey = document.body.dataset.key || '';
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'render') return;
    const key = m.key || currentKey;
    const sameDoc = key === currentKey;
    if (!sameDoc) scrolls.set(currentKey, window.scrollY);
    const y = sameDoc ? window.scrollY : (scrolls.get(key) || 0);
    content.innerHTML = m.html;
    currentKey = key;
    window.scrollTo(0, y);
    if (m.sent) requestAnimationFrame(() => vscode.postMessage({ type: 'rendered', sent: m.sent, at: Date.now() }));
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (href.startsWith('#')) {
      const el = document.getElementById(decodeURIComponent(href.slice(1)));
      if (el) el.scrollIntoView();
    } else {
      vscode.postMessage({ type: 'link', href });
    }
  });
})();
