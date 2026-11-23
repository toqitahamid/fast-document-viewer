(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  document.getElementById('edit-btn').addEventListener('click', () => vscode.postMessage({ type: 'edit' }));
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'render') {
      const y = window.scrollY;
      content.innerHTML = e.data.html;
      window.scrollTo(0, y);
    }
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
