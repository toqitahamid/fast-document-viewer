(function () {
  // ---- Pure helpers (no DOM). Exported for tests when loaded under Node. ----
  const MAX_PDF_BYTES = 512 * 1024 * 1024;
  const PAGE_WINDOW = 3; // keep canvases for this many pages either side of the current page
  const FIG_CACHE_MAX = 40;

  // The message channel may deliver bytes as ArrayBuffer, a typed array, a serialized Node
  // Buffer ({type:'Buffer', data:[...]}), an array, or an object with numeric keys.
  // Turn any of them into a Uint8Array. Sizes are capped; anything else is rejected.
  function toBytes(d, max) {
    const cap = max || MAX_PDF_BYTES;
    const tooBig = () => new Error('PDF data is too large');
    if (!d || typeof d !== 'object') throw new Error('no PDF data received');
    if (d instanceof Uint8Array) { if (d.length > cap) throw tooBig(); return d; }
    if (d instanceof ArrayBuffer) { if (d.byteLength > cap) throw tooBig(); return new Uint8Array(d); }
    if (ArrayBuffer.isView(d)) { if (d.byteLength > cap) throw tooBig(); return new Uint8Array(d.buffer, d.byteOffset, d.byteLength); }
    if (Array.isArray(d)) { if (d.length > cap) throw tooBig(); return Uint8Array.from(d); }
    if (d.type === 'Buffer' && Array.isArray(d.data)) { if (d.data.length > cap) throw tooBig(); return Uint8Array.from(d.data); }
    const n = d.length;
    if (!Number.isInteger(n) || n < 0 || n > cap) throw new Error('unexpected PDF data');
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = d[i];
    return out;
  }

  // Messages from a frame INSIDE the page (a child or deeper descendant frame, such as an iframe in a
  // Markdown file) must not drive the viewer. Everything else is the host: VS Code relays host
  // messages through its own frames, which differ between editor versions, so they are accepted.
  function isHostMessage(e, self) {
    if (!e || !e.data || typeof e.data !== 'object') return false;
    let w = e.source;
    for (let i = 0; w && i < 32; i++) {
      let up;
      try { up = w.parent; } catch (err) { return false; } // cross-origin access denied: treat as foreign
      if (!up || up === w) return true; // reached a top window without passing through this one
      if (up === self) return false; // this frame lies inside our own window
      w = up;
    }
    return true;
  }

  // Indices of rendered pages that should lose their canvas: outside the window around the
  // current page and not intersecting the observer's margin.
  function pagesToEvict(rendered, cur, win, visible) {
    return rendered.filter((i) => Math.abs(i - cur) > win && !(visible && visible.has(i)));
  }

  // Map-based LRU. onEvict(value, key) runs for entries dropped by the cap or by delete/clear.
  function createLru(max, onEvict) {
    const m = new Map();
    const drop = (k) => { const v = m.get(k); m.delete(k); if (onEvict) onEvict(v, k); };
    return {
      get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
      set(k, v) {
        if (m.has(k)) drop(k);
        m.set(k, v);
        while (m.size > max) drop(m.keys().next().value);
      },
      delete(k) { if (m.has(k)) drop(k); },
      clear() { for (const k of Array.from(m.keys())) drop(k); },
      keys() { return Array.from(m.keys()); },
      get size() { return m.size; },
    };
  }

  // A figure URL is its own cache key (a ?v= stamp added by the host makes a changed file a new key).
  const figKey = (url) => String(url).split('#')[0];
  const figVersioned = (key) => /[?&]v=/.test(key);

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  // In-page "#anchor": generated heading ids carry a prefix, so try that first. Only elements
  // inside the document count, so a link can never land on the viewer's own elements.
  function resolveAnchor(raw, byId, inContent) {
    const id = safeDecode(raw);
    for (const c of ['h-' + id, id]) {
      if (!c) continue;
      const el = byId(c);
      if (el && inContent(el)) return el;
    }
    return null;
  }

  // PDF link policy: only these schemes leave the webview (the host checks again).
  function isAllowedPdfUrl(s) {
    if (typeof s !== 'string' || !s || s.length > 2048) return false;
    if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return false;
    return /^(https?|mailto):/i.test(s);
  }

  // Link rectangle (PDF user space, as returned by pdf.js) to percentages of the page box.
  // vpRect is the result of viewport.convertToViewportRectangle; its corners may be in any order.
  function linkBox(vpRect, width, height) {
    if (!Array.isArray(vpRect) || vpRect.length < 4 || !(width > 0) || !(height > 0)) return null;
    const [x1, y1, x2, y2] = vpRect.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    const l = Math.min(x1, x2), r = Math.max(x1, x2), tp = Math.min(y1, y2), b = Math.max(y1, y2);
    if (r - l < 0.5 || b - tp < 0.5) return null;
    const pct = (v, d) => Math.max(0, Math.min(100, (v / d) * 100));
    const left = pct(l, width), top = pct(tp, height);
    return { left, top, width: Math.min(100 - left, pct(r - l, width)), height: Math.min(100 - top, pct(b - tp, height)) };
  }

  // Internal destination (named string or explicit array) to { page: 0-based index, top: fraction
  // of the page height to scroll to, 0 = page top }. Returns null when it cannot be resolved.
  async function resolvePdfDest(doc, dest, pageH) {
    try {
      let d = dest;
      if (typeof d === 'string') d = await doc.getDestination(d);
      if (!Array.isArray(d) || !d.length) return null;
      const ref = d[0];
      let page = -1;
      if (Number.isInteger(ref)) page = ref;
      else if (ref && typeof ref === 'object') page = await doc.getPageIndex(ref);
      if (!Number.isInteger(page) || page < 0 || page >= doc.numPages) return null;
      let top = 0;
      const name = d[1] && d[1].name;
      const y = name === 'XYZ' ? d[3] : (name === 'FitH' || name === 'FitBH') ? d[2] : null;
      if (typeof y === 'number' && Number.isFinite(y) && pageH > 0) top = Math.max(0, Math.min(1, (pageH - y) / pageH));
      return { page, top };
    } catch (e) { return null; }
  }

  // Named actions that move within the document, as 0-based page index (or null).
  function namedActionPage(action, cur, count) {
    switch (action) {
      case 'NextPage': return cur + 1 < count ? cur + 1 : null;
      case 'PrevPage': return cur > 0 ? cur - 1 : null;
      case 'FirstPage': return 0;
      case 'LastPage': return count > 0 ? count - 1 : null;
      default: return null;
    }
  }

  if (typeof module === 'object' && module && module.exports) {
    module.exports = { toBytes, isHostMessage, pagesToEvict, createLru, figKey, figVersioned, resolveAnchor, safeDecode, isAllowedPdfUrl, linkBox, resolvePdfDest, namedActionPage, MAX_PDF_BYTES, PAGE_WINDOW, FIG_CACHE_MAX };
  }
  if (typeof acquireVsCodeApi !== 'function') return;

  const vscode = acquireVsCodeApi();
  if (document.body.dataset.theme === 'auto') document.body.classList.add('fdv-follow-theme');
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

  // Names for assistive technology (the page template only sets titles).
  const label = (id, text, role) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('aria-label', text);
    if (role) el.setAttribute('role', role);
  };
  content.setAttribute('role', 'document');
  label('edit-btn', 'Edit as text');
  label('pdfbar', 'PDF controls', 'toolbar');
  label('pdf-out', 'Zoom out');
  label('pdf-in', 'Zoom in');
  label('pdf-fit', 'Fit page width');
  label('pdf-100', 'Actual size, 100 percent');
  label('pdf', 'PDF pages', 'document');
  const html = document.getElementById('htmlframe');
  if (html) html.remove(); // the HTML-in-frame view was removed; nothing sends it any more

  // ---- PDF viewer (pdf.js is loaded on the first PDF) ----
  const pdfState = new Map(); // key -> { frac, zoom }
  let libPromise = null;
  let seq = 0; // bumps on every mode or file change; stale async work checks it
  let pdf = null; // { doc, key, name, zoom, fit, gen, vis, pages: [{div, canvas, page, tl, tlNew, tlTask, gen, task, w, h}], io }
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
    pdfState.set(pdf.key, { frac: h ? window.scrollY / h : 0, zoom: pdf.zoom, fit: !!pdf.fit });
  }

  // Stop the page's canvas render and text-layer build; drop a half-built text layer.
  function cancelPage(pg) {
    if (pg.task) { try { pg.task.cancel(); } catch (e) { /* ignore */ } pg.task = null; }
    if (pg.tlTask) { try { pg.tlTask.cancel(); } catch (e) { /* ignore */ } pg.tlTask = null; }
    if (pg.tlNew) { pg.tlNew.remove(); pg.tlNew = null; }
  }

  // Free a page's canvas and text layer (a 16 Mpx canvas is ~64 MB). It is redrawn when the
  // page comes back into view: gen = 0 makes renderPage run again.
  function evictPage(pg) {
    cancelPage(pg);
    pg.gen = 0;
    if (pg.canvas) { pg.canvas.width = 0; pg.canvas.height = 0; pg.canvas.remove(); pg.canvas = null; }
    if (pg.tl) { pg.tl.remove(); pg.tl = null; }
    if (pg.al) { pg.al.remove(); pg.al = null; }
    if (pg.page) { try { pg.page.cleanup(); } catch (e) { /* ignore */ } pg.page = null; }
  }

  function evictFar(cur) {
    const p = pdf;
    const rendered = [];
    p.pages.forEach((pg, i) => { if (pg.canvas || pg.gen) rendered.push(i); });
    for (const i of pagesToEvict(rendered, cur, PAGE_WINDOW, p.vis)) evictPage(p.pages[i]);
  }

  function closePdf() {
    if (!pdf) return;
    const p = pdf; pdf = null;
    if (p.io) p.io.disconnect();
    for (const pg of p.pages) { cancelPage(pg); pg.page = null; }
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
      if (pdf !== p || p.gen !== gen || pg.gen !== gen) return;
      const base = page.getViewport({ scale: 1 });
      if (pg.w !== base.width || pg.h !== base.height) {
        // A page of another size changes the layout. If it sits above the reading position,
        // shift the scroll by the same amount so the text on screen does not jump.
        const before = pg.div.offsetHeight;
        const above = pg.div.offsetTop + before <= window.scrollY;
        pg.w = base.width; pg.h = base.height; sizePage(pg);
        if (above) window.scrollBy(0, pg.div.offsetHeight - before);
      }
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
      if (pdf !== p || p.gen !== gen || pg.gen !== gen) { canvas.width = 0; canvas.height = 0; return; }
      if (pg.canvas) pg.canvas.remove();
      pg.canvas = canvas;
      pg.page = page;
      pg.div.insertBefore(canvas, pg.div.firstChild); // the text layer stays above the canvas
      if (shownSent) {
        vscode.postMessage({ type: 'pdfShown', key: p.key, name: p.name, pages: p.doc.numPages, sent: shownSent, at: Date.now() });
        shownSent = 0;
      }
      await buildTextLayer(p, pg, page, vp, gen);
      await buildLinkLayer(p, pg, page, vp, gen, i);
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
      if (pdf !== p || p.gen !== gen || pg.gen !== gen) return;
      tl = document.createElement('div');
      tl.className = 'textLayer';
      tl.style.setProperty('--scale-factor', String(vp.scale));
      pg.tlNew = tl;
      pg.div.appendChild(tl);
      const task = lib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] });
      pg.tlTask = task;
      await task.promise;
      pg.tlTask = null;
      if (pdf !== p || p.gen !== gen || pg.gen !== gen) { tl.remove(); return; }
      pg.tlNew = null;
      if (pg.tl) pg.tl.remove();
      pg.tl = tl;
    } catch (e) {
      if (tl) tl.remove();
      pg.tlNew = null; pg.tlTask = null;
      // A cancelled build is normal (zoom changed); a failed one only costs selection on this page.
    }
  }


  // Clickable links over the page (Link annotations). Positions are percentages of the page box,
  // so the layer follows zoom at once and is rebuilt on the next render. Anchors carry no
  // navigation of their own: the click handler routes them (see linkInfo).
  const linkInfo = new WeakMap();
  async function buildLinkLayer(p, pg, page, vp, gen, index) {
    if (typeof page.getAnnotations !== 'function') return;
    try {
      const anns = await page.getAnnotations({ intent: 'display' });
      if (pdf !== p || p.gen !== gen || pg.gen !== gen) return;
      const layer = document.createElement('div');
      layer.className = 'annotationLayer';
      for (const a of anns) {
        if (!a || a.subtype !== 'Link' || !a.rect) continue;
        const box = linkBox(vp.convertToViewportRectangle(a.rect), vp.width, vp.height);
        if (!box) continue;
        let info = null;
        if (typeof a.url === 'string' && a.url) {
          if (!isAllowedPdfUrl(a.url)) continue;
          info = { url: a.url };
        } else if (a.dest) info = { dest: a.dest };
        else if (typeof a.action === 'string' && namedActionPage(a.action, index, p.doc.numPages) !== null) info = { action: a.action, from: index };
        if (!info) continue;
        const el = document.createElement('a');
        el.setAttribute('href', info.url || '#');
        el.rel = 'noopener noreferrer';
        el.style.left = box.left + '%'; el.style.top = box.top + '%';
        el.style.width = box.width + '%'; el.style.height = box.height + '%';
        linkInfo.set(el, info);
        layer.appendChild(el);
      }
      if (pg.al) pg.al.remove();
      pg.al = layer;
      pg.div.appendChild(layer);
    } catch (e) { /* links are optional */ }
  }

  async function followPdfLink(info) {
    if (!pdf) return;
    const p = pdf;
    if (info.url) {
      if (isAllowedPdfUrl(info.url)) vscode.postMessage({ type: 'pdfLink', href: info.url });
      return;
    }
    let target = null;
    if (info.action) {
      const page = namedActionPage(info.action, info.from, p.doc.numPages);
      if (page !== null) target = { page, top: 0 };
    } else if (info.dest) {
      const first = p.pages[0];
      target = await resolvePdfDest(p.doc, info.dest, 0);
      if (target && target.top === 0) {
        const pg = p.pages[target.page];
        const h = (pg && pg.h) || (first && first.h) || 0;
        const again = await resolvePdfDest(p.doc, info.dest, h);
        if (again) target = again;
      }
    }
    if (!target || pdf !== p) return;
    const pg = p.pages[target.page];
    if (!pg) return;
    window.scrollTo(window.scrollX, Math.max(0, pg.div.offsetTop + target.top * pg.div.offsetHeight - 8));
  }

  function observe() {
    if (!pdf) return;
    const p = pdf;
    if (p.io) p.io.disconnect();
    // Render the visible pages plus about one screen ahead (and a little behind).
    p.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const i = Number(en.target.dataset.i);
        if (en.isIntersecting) { p.vis.add(i); renderPage(p, i); } else p.vis.delete(i);
      }
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
    pageLabel.textContent = 'Page ' + (cur + 1) + ' of ' + pdf.pages.length + ', ' + Math.round(pdf.zoom * 100) + '%';
    evictFar(cur);
  }

  // fit: this zoom was chosen with "Fit"; the window width then keeps driving it.
  function setZoom(z, fit) {
    if (!pdf) return;
    pdf.zoom = Math.min(5, Math.max(0.25, z));
    pdf.fit = !!fit;
    relayout();
  }

  // A re-show of the same key (a recompiled PDF) keeps the old pages on screen until the new
  // document is loaded, then swaps them at once and restores zoom and reading position.
  async function showPdf(m) {
    const my = ++seq;
    let doc = null;
    const same = mode === 'pdf' && !!pdf && currentKey === m.key;
    if (mode === 'md') scrolls.set(currentKey, window.scrollY); else savePdfState();
    if (!same) {
      closePdf();
      currentKey = m.key;
      setMode('pdf');
      pageLabel.textContent = 'Loading PDF\u2026';
      window.scrollTo(0, 0);
    }
    try {
      const lib = await loadLib();
      if (my !== seq) return;
      doc = await lib.getDocument({ data: toBytes(m.data), isEvalSupported: false }).promise;
      if (my !== seq) { doc.destroy(); return; }
      const first = await doc.getPage(1);
      if (my !== seq) { doc.destroy(); return; }
      const v = first.getViewport({ scale: 1 });
      const saved = pdfState.get(m.key) || { frac: 0, zoom: 1 };
      const p = { doc, key: m.key, name: m.name, zoom: saved.zoom, fit: !!saved.fit, gen: 1, pages: [], vis: new Set(), io: null };
      const frag = document.createDocumentFragment();
      for (let i = 0; i < doc.numPages; i++) {
        const div = document.createElement('div');
        div.className = 'pdf-page';
        div.dataset.i = String(i);
        div.setAttribute('role', 'group');
        div.setAttribute('aria-label', 'Page ' + (i + 1) + ' of ' + doc.numPages);
        p.pages.push({ div, canvas: null, page: null, tl: null, tlNew: null, al: null, tlTask: null, gen: 0, task: null, w: i === 0 ? v.width : 0, h: i === 0 ? v.height : 0 });
        frag.appendChild(div);
      }
      const old = same ? pdf : null;
      const oldCanvases = old ? old.pages.map((pg) => pg.canvas) : [];
      if (old) closePdf();
      pdf = p;
      doc = null; // owned by the viewer now; closePdf destroys it
      shownSent = m.sent || 0;
      if (p.fit) p.zoom = fitZoom();
      for (const pg of p.pages) sizePage(pg);
      pdfEl.appendChild(frag);
      // Show the old page images until the new ones are drawn (no blank flash).
      oldCanvases.forEach((c, i) => { if (c && p.pages[i]) { p.pages[i].div.appendChild(c); p.pages[i].canvas = c; } });
      window.scrollTo(0, saved.frac * document.documentElement.scrollHeight);
      observe();
      updatePage();
    } catch (e) {
      if (doc) { try { doc.destroy(); } catch (e2) { /* ignore */ } }
      if (my === seq) {
        if (!same) { pageLabel.textContent = ''; pdfEl.textContent = 'This PDF could not be opened. It may be damaged or still being written. Save it again and reopen it.'; }
        vscode.postMessage({ type: 'pdfError', message: String(e && e.message) });
      }
    }
  }

  // ---- PDF figures in LaTeX previews (.tex-pdffig). Separate from the PDF viewer: own queue, own documents. ----
  // key (see figKey) -> { src (blob URL), pxW, ratio, cssW }. Capped; blob URLs are revoked on eviction.
  const figCache = createLru(FIG_CACHE_MAX, (c) => { if (c && c.src) URL.revokeObjectURL(c.src); });
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
    const key = figKey(url);
    const hint = !!el.dataset.w;
    const container = content.clientWidth || 800;
    const target = hint && el.clientWidth > 20 ? el.clientWidth : 0; // 0: natural width
    const dpr = window.devicePixelRatio || 1;
    let c = figCache.get(key);
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
      c = { src: URL.createObjectURL(blob), pxW: canvas.width, ratio: canvas.width / canvas.height, cssW: Math.round(cssW) };
      figCache.set(key, c); // replacing an entry revokes the old blob URL
      figShow(el, c);
    } catch (e) {
      el.classList.add('done');
      vscode.postMessage({ type: 'pdfError', message: 'figure ' + url.split('/').pop() + ': ' + (e && e.message) });
      el.textContent = 'This figure could not be shown.';
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
      const c = figCache.get(figKey(el.dataset.src));
      if (c) figShow(el, c); else figIo.observe(el);
    }
  }

  document.getElementById('pdf-out').addEventListener('click', () => setZoom(pdf ? pdf.zoom / 1.2 : 1));
  document.getElementById('pdf-in').addEventListener('click', () => setZoom(pdf ? pdf.zoom * 1.2 : 1));
  document.getElementById('pdf-fit').addEventListener('click', () => setZoom(pdf ? fitZoom() : 1, true));
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
    pdf.fit = false;
    for (const pg of pdf.pages) sizePage(pg);
    const r = z / old;
    window.scrollTo(docX * r - e.clientX, docY * r - e.clientY);
    updatePage();
    clearTimeout(pinchTimer);
    const p = pdf;
    pinchTimer = setTimeout(() => {
      if (pdf !== p) return;
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
      // Only a page-width fit depends on the window; other zooms keep their canvases.
      if (mode === 'pdf' && w !== lastW && pdf) { if (pdf.fit) setZoom(fitZoom(), true); else updatePage(); }
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
    if (!text) { if (bannerEl) bannerEl.hidden = true; return; }
    const isInfo = level === 'info';
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.id = 'paper-banner';
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'paper-banner-x'; x.textContent = '\u00d7';
      x.title = 'Dismiss'; x.setAttribute('aria-label', 'Dismiss message');
      x.addEventListener('click', () => { bannerEl.hidden = true; });
      const body = document.createElement('div');
      body.className = 'paper-banner-body';
      bannerEl.append(x, body);
      document.body.appendChild(bannerEl);
    }
    bannerEl.hidden = false;
    bannerEl.className = 'paper-banner ' + (isInfo ? 'info' : 'error');
    bannerEl.setAttribute('role', isInfo ? 'status' : 'alert');
    // An icon and a word, so the level never depends on colour alone.
    bannerEl.lastChild.textContent = (isInfo ? '\u2139 ' : '\u26a0 Problem: ') + text;
  }

  window.addEventListener('message', (e) => {
    if (!isHostMessage(e, window)) return;
    const m = e.data;
    if (m.type === 'banner') { setBanner(typeof m.text === 'string' ? m.text : '', m.level); return; }
    if (m.type === 'pdf') { showPdf(m); return; }
    if (m.type !== 'render' || typeof m.html !== 'string') return;
    seq++;
    if (mode === 'pdf') { savePdfState(); closePdf(); setMode('md'); }
    const key = m.key || currentKey;
    const sameDoc = key === currentKey;
    if (!sameDoc) { scrolls.set(currentKey, window.scrollY); figCache.clear(); }
    else for (const k of figCache.keys()) if (!figVersioned(k)) figCache.delete(k); // may have changed on disk
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
    if (mode === 'pdf' && pdf && (e.metaKey || e.ctrlKey) && !e.altKey) {
      const zk = e.key;
      if (zk === '+' || zk === '=') { e.preventDefault(); setZoom(pdf.zoom * 1.2); return; }
      if (zk === '-' || zk === '_') { e.preventDefault(); setZoom(pdf.zoom / 1.2); return; }
      if (zk === '0') { e.preventDefault(); setZoom(1); return; }
    }
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
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault(); // always: the webview must never navigate by itself
    const sel = window.getSelection();
    // A drag that ended on this link made a selection: do not follow the link.
    if (sel && !sel.isCollapsed && sel.containsNode(a, true)) return;
    if (pdfEl && pdfEl.contains(a)) {
      const info = linkInfo.get(a);
      if (info) followPdfLink(info);
      return; // PDF anchors never reach the generic branch
    }
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      const el = href.length > 1 && resolveAnchor(href.slice(1), (id) => document.getElementById(id), (n) => content.contains(n));
      if (el) el.scrollIntoView();
      else if (href === '#') window.scrollTo(0, 0);
    } else {
      vscode.postMessage({ type: 'link', href });
    }
  });
})();
