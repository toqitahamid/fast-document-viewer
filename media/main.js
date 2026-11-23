(function () {
  const vscode = acquireVsCodeApi();
  const scriptNonce = document.currentScript && document.currentScript.nonce;
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
  let mode = 'md';
  const pdfEl = document.getElementById('pdf');
  const bar = document.getElementById('pdfbar');
  const pageLabel = document.getElementById('pdf-page');

  // ---- PDF viewer (pdf.js is loaded on the first PDF) ----
  const pdfState = new Map(); // key -> { frac, zoom }
  let libPromise = null;
  let seq = 0; // bumps on every mode or file change; stale async work checks it
  let pdf = null; // { doc, key, name, zoom, gen, pages: [{div, canvas, gen, task, w, h}], io }
  let shownSent = 0;

  function loadLib() {
    if (libPromise) return libPromise;
    const script = new Promise((res, rej) => {
      const s = document.createElement('script');
      if (scriptNonce) s.nonce = scriptNonce;
      s.src = document.body.dataset.pdfjs;
      s.onload = () => res(window.pdfjsLib);
      s.onerror = () => rej(new Error('could not load pdf.js'));
      document.head.appendChild(s);
    });
    const worker = fetch(document.body.dataset.pdfworker).then((r) => r.text());
    libPromise = Promise.all([script, worker]).then(([lib, txt]) => {
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([txt], { type: 'text/javascript' }));
      return lib;
    });
    libPromise.catch(() => { libPromise = null; });
    return libPromise;
  }

  function setMode(m) {
    mode = m;
    const isPdf = m === 'pdf';
    document.documentElement.classList.toggle('pdf-mode', isPdf);
    content.style.display = isPdf ? 'none' : '';
    pdfEl.hidden = !isPdf;
    bar.hidden = !isPdf;
    if (btn) btn.style.display = isPdf ? 'none' : '';
  }

  function savePdfState() {
    if (!pdf) return;
    const h = document.documentElement.scrollHeight;
    pdfState.set(pdf.key, { frac: h ? window.scrollY / h : 0, zoom: pdf.zoom });
  }

  function closePdf() {
    if (!pdf) return;
    const p = pdf; pdf = null;
    if (p.io) p.io.disconnect();
    for (const pg of p.pages) if (pg.task) { try { pg.task.cancel(); } catch (e) { /* ignore */ } }
    pdfEl.textContent = '';
    if (p.doc) p.doc.destroy();
  }

  const fitWidth = () => Math.max(100, document.documentElement.clientWidth - 32);

  // Zoom is absolute: 1 = 100% (1 PDF point = 4/3 CSS px, as in pdf.js and Acrobat).
  const CSS_PER_PT = 4 / 3;
  const fitZoom = () => fitWidth() / (pdf.pages[0].w * CSS_PER_PT);

  function sizePage(pg) {
    const w = (pg.w || pdf.pages[0].w) * CSS_PER_PT * pdf.zoom;
    const ratio = (pg.h || pdf.pages[0].h) / (pg.w || pdf.pages[0].w);
    pg.div.style.width = w + 'px';
    pg.div.style.height = w * ratio + 'px';
    if (pg.canvas) { pg.canvas.style.width = '100%'; pg.canvas.style.height = '100%'; }
  }

  async function renderPage(p, i) {
    const pg = p.pages[i];
    if (pg.gen === p.gen) return;
    pg.gen = p.gen;
    const gen = p.gen;
    try {
      const page = await p.doc.getPage(i + 1);
      if (pdf !== p || p.gen !== gen) return;
      const base = page.getViewport({ scale: 1 });
      if (pg.w !== base.width || pg.h !== base.height) { pg.w = base.width; pg.h = base.height; sizePage(pg); }
      const cssW = base.width * CSS_PER_PT * p.zoom;
      const vp = page.getViewport({ scale: cssW / base.width });
      let dpr = window.devicePixelRatio || 1;
      const maxPx = 16e6;
      if (vp.width * vp.height * dpr * dpr > maxPx) dpr = Math.sqrt(maxPx / (vp.width * vp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null, background: 'rgb(255,255,255)' });
      pg.task = task;
      await task.promise;
      pg.task = null;
      if (pdf !== p || p.gen !== gen) return;
      if (pg.canvas) pg.canvas.remove();
      pg.canvas = canvas;
      pg.div.appendChild(canvas);
      if (shownSent) {
        vscode.postMessage({ type: 'pdfShown', key: p.key, name: p.name, pages: p.doc.numPages, sent: shownSent, at: Date.now() });
        shownSent = 0;
      }
    } catch (e) {
      if (pg.gen === gen) pg.gen = -1; // allow a retry
      if (!(e && e.name === 'RenderingCancelledException')) vscode.postMessage({ type: 'pdfError', message: 'page ' + (i + 1) + ': ' + (e && e.message) });
    }
  }

  function observe() {
    if (!pdf) return;
    const p = pdf;
    if (p.io) p.io.disconnect();
    // Render the visible pages plus about one screen ahead (and a little behind).
    p.io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) renderPage(p, Number(en.target.dataset.i));
    }, { rootMargin: '50% 0px 100% 0px' });
    for (const pg of p.pages) p.io.observe(pg.div);
  }

  // Re-layout at the current zoom and window width, keeping the reading position.
  function relayout() {
    if (!pdf) return;
    const h = document.documentElement.scrollHeight;
    const frac = h ? window.scrollY / h : 0;
    pdf.gen++;
    for (const pg of pdf.pages) {
      if (pg.task) { try { pg.task.cancel(); } catch (e) { /* ignore */ } pg.task = null; }
      sizePage(pg);
    }
    window.scrollTo(window.scrollX, frac * document.documentElement.scrollHeight);
    observe();
    updatePage();
  }

  function updatePage() {
    if (!pdf) return;
    const probe = window.scrollY + window.innerHeight / 3;
    let cur = 0;
    for (let i = 0; i < pdf.pages.length; i++) {
      if (pdf.pages[i].div.offsetTop <= probe) cur = i; else break;
    }
    pageLabel.textContent = (cur + 1) + ' / ' + pdf.pages.length + '  ' + Math.round(pdf.zoom * 100) + '%';
  }

  function setZoom(z) {
    if (!pdf) return;
    pdf.zoom = Math.min(5, Math.max(0.25, z));
    relayout();
  }

  // The message channel may deliver bytes as ArrayBuffer, a typed array, a
  // serialized Node Buffer ({type:'Buffer', data:[...]}), an array, or an
  // object with numeric keys. Turn any of them into a Uint8Array.
  function toBytes(d) {
    if (!d) throw new Error('no PDF data received');
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (Array.isArray(d)) return Uint8Array.from(d);
    if (d.type === 'Buffer' && Array.isArray(d.data)) return Uint8Array.from(d.data);
    if (typeof d === 'object') {
      const n = typeof d.length === 'number' ? d.length : Object.keys(d).length;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = d[i];
      return out;
    }
    throw new Error('unexpected PDF data type: ' + typeof d);
  }

  async function showPdf(m) {
    const my = ++seq;
    if (mode === 'md') scrolls.set(currentKey, window.scrollY); else savePdfState();
    closePdf();
    currentKey = m.key;
    setMode('pdf');
    pageLabel.textContent = 'Loading...';
    window.scrollTo(0, 0);
    try {
      const lib = await loadLib();
      if (my !== seq) return;
      const doc = await lib.getDocument({ data: toBytes(m.data), isEvalSupported: false }).promise;
      if (my !== seq) { doc.destroy(); return; }
      const first = await doc.getPage(1);
      if (my !== seq) { doc.destroy(); return; }
      const v = first.getViewport({ scale: 1 });
      const saved = pdfState.get(m.key) || { frac: 0, zoom: 1 };
      const p = { doc, key: m.key, name: m.name, zoom: saved.zoom, gen: 1, pages: [], io: null };
      const frag = document.createDocumentFragment();
      for (let i = 0; i < doc.numPages; i++) {
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.dataset.i = String(i);
        p.pages.push({ div, canvas: null, gen: 0, task: null, w: i === 0 ? v.width : 0, h: i === 0 ? v.height : 0 });
        frag.appendChild(div);
      }
      pdf = p;
      shownSent = m.sent || 0;
      for (const pg of p.pages) sizePage(pg);
      pdfEl.appendChild(frag);
      window.scrollTo(0, saved.frac * document.documentElement.scrollHeight);
      observe();
      updatePage();
    } catch (e) {
      if (my === seq) {
        pageLabel.textContent = '';
        pdfEl.textContent = 'Could not show this PDF: ' + (e && e.message);
        vscode.postMessage({ type: 'pdfError', message: String(e && e.message) });
      }
    }
  }

  document.getElementById('pdf-out').addEventListener('click', () => setZoom(pdf ? pdf.zoom / 1.2 : 1));
  document.getElementById('pdf-in').addEventListener('click', () => setZoom(pdf ? pdf.zoom * 1.2 : 1));
  document.getElementById('pdf-fit').addEventListener('click', () => setZoom(pdf ? fitZoom() : 1));
  document.getElementById('pdf-100').addEventListener('click', () => setZoom(1));
  let rsTimer; let lastW = document.documentElement.clientWidth;
  window.addEventListener('resize', () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => {
      const w = document.documentElement.clientWidth;
      if (mode === 'pdf' && w !== lastW) relayout();
      lastW = w;
    }, 150);
  });
  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (mode !== 'pdf' || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updatePage(); });
  }, { passive: true });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'pdf') { showPdf(m); return; }
    if (m.type !== 'render') return;
    seq++;
    if (mode === 'pdf') { savePdfState(); closePdf(); setMode('md'); }
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
