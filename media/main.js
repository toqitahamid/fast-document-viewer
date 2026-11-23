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
  const frame = document.getElementById('htmlframe');
  let pendingHtml = null; // { sent, name } until the iframe fires 'load'
  frame.addEventListener('load', () => {
    if (!pendingHtml) return;
    vscode.postMessage({ type: 'htmlShown', name: pendingHtml.name, sent: pendingHtml.sent, at: Date.now() });
    pendingHtml = null;
  });

  // ---- PDF viewer (pdf.js is loaded on the first PDF) ----
  const pdfState = new Map(); // key -> { frac, zoom }
  let libPromise = null;
  let seq = 0; // bumps on every mode or file change; stale async work checks it
  let pdf = null; // { doc, key, name, zoom, gen, pages: [{div, canvas, tl, tlNew, tlTask, gen, task, w, h}], io }
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
    const isHtml = m === 'html';
    document.documentElement.classList.toggle('pdf-mode', isPdf);
    content.style.display = isPdf || isHtml ? 'none' : '';
    pdfEl.hidden = !isPdf;
    bar.hidden = !isPdf;
    frame.hidden = !isHtml;
    if (!isHtml && frame.getAttribute('src') && frame.getAttribute('src') !== 'about:blank') {
      pendingHtml = null;
      frame.src = 'about:blank'; // free the page's memory
    }
    if (btn) btn.style.display = isPdf ? 'none' : '';
  }

  function savePdfState() {
    if (!pdf) return;
    const h = document.documentElement.scrollHeight;
    pdfState.set(pdf.key, { frac: h ? window.scrollY / h : 0, zoom: pdf.zoom });
  }

  // Stop the page's canvas render and text-layer build; drop a half-built text layer.
  function cancelPage(pg) {
    if (pg.task) { try { pg.task.cancel(); } catch (e) { /* ignore */ } pg.task = null; }
    if (pg.tlTask) { try { pg.tlTask.cancel(); } catch (e) { /* ignore */ } pg.tlTask = null; }
    if (pg.tlNew) { pg.tlNew.remove(); pg.tlNew = null; }
  }

  function closePdf() {
    if (!pdf) return;
    const p = pdf; pdf = null;
    if (p.io) p.io.disconnect();
    for (const pg of p.pages) cancelPage(pg);
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
    // The text layer sizes its spans from --scale-factor, so it follows zoom at once.
    if (pg.tl) pg.tl.style.setProperty('--scale-factor', String(CSS_PER_PT * pdf.zoom));
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
      pg.div.insertBefore(canvas, pg.div.firstChild); // the text layer stays above the canvas
      if (shownSent) {
        vscode.postMessage({ type: 'pdfShown', key: p.key, name: p.name, pages: p.doc.numPages, sent: shownSent, at: Date.now() });
        shownSent = 0;
      }
      await buildTextLayer(p, pg, page, vp, gen);
    } catch (e) {
      if (pg.gen === gen) pg.gen = -1; // allow a retry
      if (!(e && e.name === 'RenderingCancelledException')) vscode.postMessage({ type: 'pdfError', message: 'page ' + (i + 1) + ': ' + (e && e.message) });
    }
  }

  // Selectable, invisible text over the canvas (pdf.js 3.11 renderTextLayer). A new layer
  // replaces the old one only when it is complete, so a selection is not lost half-way.
  async function buildTextLayer(p, pg, page, vp, gen) {
    const lib = window.pdfjsLib;
    if (!lib || !lib.renderTextLayer) return;
    let tl = null;
    try {
      const tc = await page.getTextContent();
      if (pdf !== p || p.gen !== gen) return;
      tl = document.createElement('div');
      tl.className = 'textLayer';
      tl.style.setProperty('--scale-factor', String(vp.scale));
      pg.tlNew = tl;
      pg.div.appendChild(tl);
      const task = lib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] });
      pg.tlTask = task;
      await task.promise;
      pg.tlTask = null;
      if (pdf !== p || p.gen !== gen) { tl.remove(); return; }
      pg.tlNew = null;
      if (pg.tl) pg.tl.remove();
      pg.tl = tl;
    } catch (e) {
      if (tl) tl.remove();
      pg.tlNew = null; pg.tlTask = null;
      // A cancelled build is normal (zoom changed); a failed one only costs selection on this page.
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
      cancelPage(pg);
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

  function showHtml(m) {
    seq++;
    if (mode === 'md') scrolls.set(currentKey, window.scrollY);
    else if (mode === 'pdf') { savePdfState(); closePdf(); }
    currentKey = m.key;
    setMode('html');
    pendingHtml = { sent: m.sent || Date.now(), name: m.name };
    frame.src = m.src;
  }

  // A re-show of the same key (a recompiled PDF) keeps the old pages on screen until the new
  // document is loaded, then swaps them at once and restores zoom and reading position.
  async function showPdf(m) {
    const my = ++seq;
    const same = mode === 'pdf' && !!pdf && currentKey === m.key;
    if (mode === 'md') scrolls.set(currentKey, window.scrollY); else savePdfState();
    if (!same) {
      closePdf();
      currentKey = m.key;
      setMode('pdf');
      pageLabel.textContent = 'Loading...';
      window.scrollTo(0, 0);
    }
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
        p.pages.push({ div, canvas: null, tl: null, tlNew: null, tlTask: null, gen: 0, task: null, w: i === 0 ? v.width : 0, h: i === 0 ? v.height : 0 });
        frag.appendChild(div);
      }
      const old = same ? pdf : null;
      const oldCanvases = old ? old.pages.map((pg) => pg.canvas) : [];
      if (old) closePdf();
      pdf = p;
      shownSent = m.sent || 0;
      for (const pg of p.pages) sizePage(pg);
      pdfEl.appendChild(frag);
      // Show the old page images until the new ones are drawn (no blank flash).
      oldCanvases.forEach((c, i) => { if (c && p.pages[i]) { p.pages[i].div.appendChild(c); p.pages[i].canvas = c; } });
      window.scrollTo(0, saved.frac * document.documentElement.scrollHeight);
      observe();
      updatePage();
    } catch (e) {
      if (my === seq) {
        if (!same) { pageLabel.textContent = ''; pdfEl.textContent = 'Could not show this PDF: ' + (e && e.message); }
        vscode.postMessage({ type: 'pdfError', message: String(e && e.message) });
      }
    }
  }

  // ---- PDF figures in LaTeX previews (.tex-pdffig). Separate from the PDF viewer: own queue, own documents. ----
  const figCache = new Map(); // url -> { src (blob URL), pxW, ratio, cssW }
  const figQueue = [];
  let figBusy = false;
  let figIo = null;

  function figShow(el, c) {
    const img = document.createElement('img');
    img.alt = '';
    img.style.aspectRatio = String(c.ratio);
    img.src = c.src;
    el.textContent = '';
    el.appendChild(img);
    el.classList.add('done');
    if (!el.dataset.w) el.style.width = c.cssW + 'px';
  }

  async function renderFig(el) {
    const url = el.dataset.src;
    const hint = !!el.dataset.w;
    const container = content.clientWidth || 800;
    const target = hint && el.clientWidth > 20 ? el.clientWidth : 0; // 0: natural width
    const dpr = window.devicePixelRatio || 1;
    let c = figCache.get(url);
    if (c && (!target || c.pxW >= target * dpr * 0.9)) { figShow(el, c); return; }
    let doc = null;
    try {
      const lib = await loadLib();
      try { doc = await lib.getDocument({ url, isEvalSupported: false }).promise; }
      catch (e1) {
        const buf = await (await fetch(url)).arrayBuffer();
        doc = await lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      }
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const cssW = Math.max(40, Math.min(target || base.width * 4 / 3, container));
      let d = dpr;
      if (cssW * (base.height / base.width) * cssW * d * d > 16e6) d = Math.sqrt(16e6 / (cssW * cssW * base.height / base.width));
      const vp = page.getViewport({ scale: (cssW * d) / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: 'rgb(255,255,255)' }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('could not encode the figure');
      if (c && c.src) URL.revokeObjectURL(c.src);
      c = { src: URL.createObjectURL(blob), pxW: canvas.width, ratio: canvas.width / canvas.height, cssW: Math.round(cssW) };
      figCache.set(url, c);
      figShow(el, c);
    } catch (e) {
      el.classList.add('done');
      vscode.postMessage({ type: 'pdfError', message: 'figure ' + url.split('/').pop() + ': ' + (e && e.message) });
    } finally {
      if (doc) { try { doc.destroy(); } catch (e2) { /* ignore */ } }
    }
  }

  async function figPump() {
    if (figBusy) return;
    figBusy = true;
    try {
      while (figQueue.length) {
        const el = figQueue.shift();
        if (el.isConnected && !el.classList.contains('done')) await renderFig(el);
      }
    } finally { figBusy = false; }
  }

  function processPdfFigs() {
    const els = content.querySelectorAll('.tex-pdffig:not(.done)');
    if (figIo) { figIo.disconnect(); figIo = null; }
    figQueue.length = 0;
    if (!els.length) return;
    figIo = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { figIo.unobserve(en.target); figQueue.push(en.target); }
      figPump();
    }, { rootMargin: '300px 0px' });
    for (const el of els) {
      const c = figCache.get(el.dataset.src);
      if (c) figShow(el, c); else figIo.observe(el);
    }
  }

  document.getElementById('pdf-out').addEventListener('click', () => setZoom(pdf ? pdf.zoom / 1.2 : 1));
  document.getElementById('pdf-in').addEventListener('click', () => setZoom(pdf ? pdf.zoom * 1.2 : 1));
  document.getElementById('pdf-fit').addEventListener('click', () => setZoom(pdf ? fitZoom() : 1));
  document.getElementById('pdf-100').addEventListener('click', () => setZoom(1));

  // Trackpad pinch (and Ctrl + mouse wheel) arrive as wheel events with ctrlKey.
  // Resize the pages at once, keep the point under the fingers fixed, and
  // redraw the canvases sharply when the gesture pauses.
  let pinchTimer;
  window.addEventListener('wheel', (e) => {
    if (mode !== 'pdf' || !pdf || !e.ctrlKey) return;
    e.preventDefault();
    const old = pdf.zoom;
    const z = Math.min(5, Math.max(0.25, old * Math.exp(-e.deltaY * 0.01)));
    if (z === old) return;
    const docX = window.scrollX + e.clientX;
    const docY = window.scrollY + e.clientY;
    pdf.zoom = z;
    for (const pg of pdf.pages) sizePage(pg);
    const r = z / old;
    window.scrollTo(docX * r - e.clientX, docY * r - e.clientY);
    updatePage();
    clearTimeout(pinchTimer);
    pinchTimer = setTimeout(() => {
      if (!pdf) return;
      pdf.gen++;
      for (const pg of pdf.pages) cancelPage(pg);
      observe();
    }, 200);
  }, { passive: false });
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

  // ---- Banner over the page (compile errors, "Compiling...") ----
  let bannerEl = null;
  function setBanner(text, level) {
    if (!text) { if (bannerEl) bannerEl.style.display = 'none'; return; }
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.id = 'paper-banner';
      bannerEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:50;padding:8px 36px 8px 14px;font:13px/1.4 var(--vscode-font-family,sans-serif);white-space:pre-wrap;max-height:40vh;overflow:auto;box-shadow:0 2px 6px rgba(0,0,0,.3)';
      const x = document.createElement('span');
      x.textContent = '\u00d7'; x.title = 'Dismiss';
      x.style.cssText = 'position:absolute;top:4px;right:12px;cursor:pointer;font-size:18px';
      x.addEventListener('click', () => { bannerEl.style.display = 'none'; });
      bannerEl.appendChild(x);
      bannerEl.appendChild(document.createElement('div'));
      document.body.appendChild(bannerEl);
    }
    bannerEl.style.display = '';
    bannerEl.style.background = level === 'info' ? '#2b5797' : '#b3261e';
    bannerEl.style.color = '#fff';
    bannerEl.lastChild.textContent = text;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'banner') { setBanner(m.text, m.level); return; }
    if (m.type === 'pdf') { showPdf(m); return; }
    if (m.type === 'html') { showHtml(m); return; }
    if (m.type !== 'render') return;
    seq++;
    if (mode === 'pdf') { savePdfState(); closePdf(); setMode('md'); }
    else if (mode === 'html') setMode('md');
    const key = m.key || currentKey;
    const sameDoc = key === currentKey;
    if (!sameDoc) scrolls.set(currentKey, window.scrollY);
    const y = sameDoc ? window.scrollY : (scrolls.get(key) || 0);
    content.innerHTML = m.html;
    currentKey = key;
    window.scrollTo(0, y);
    processPdfFigs();
    if (m.sent) requestAnimationFrame(() => vscode.postMessage({ type: 'rendered', sent: m.sent, at: Date.now() }));
  });

  // ---- Selection and copy (md, LaTeX preview, PDF text layers) ----
  const selText = () => { const s = window.getSelection(); return s ? s.toString() : ''; };
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const k = (e.key || '').toLowerCase();
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (k === 'a') {
      const root = mode === 'pdf' ? pdfEl : mode === 'md' ? content : null;
      if (!root) return;
      e.preventDefault();
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(root);
      sel.removeAllRanges();
      sel.addRange(r);
    } else if (k === 'c') {
      const text = selText();
      if (!text) return;
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      if (ok) return;
      e.preventDefault();
      const fallback = () => vscode.postMessage({ type: 'copyText', text });
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
        else fallback();
      } catch (err) { fallback(); }
    }
  });

  document.addEventListener('click', (e) => {
    if (selText()) return; // a drag that ended on a link made a selection: do not follow the link
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
