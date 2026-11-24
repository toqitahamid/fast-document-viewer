'use strict';
const vscode = require('vscode');
const { createRenderer } = require('./src/render');
const { texToHtml } = require('./src/tex');
const { findRoots } = require('./src/texroot');
const tc = require('./src/texcompile');
const U = require('./src/util');
const S = require('./src/strings');

const VIEW_TYPE = 'paperMd.viewer';
const FOLLOW_TYPE = 'paperMd.follow';
const isMd = (uri) => /\.(md|markdown)$/i.test(uri.path);
const isPdf = (uri) => /\.pdf$/i.test(uri.path);
const isHtml = (uri) => /\.html?$/i.test(uri.path);
const isTex = (uri) => /\.tex$/i.test(uri.path);

const esc = U.escHtml;
const { inRoots } = U;
const GLOBAL = vscode.ConfigurationTarget ? vscode.ConfigurationTarget.Global : 1;

let channel;
let manager; // the live Manager, for deactivate()
const openTimes = new Map();
function log(msg) {
  if (!channel) channel = vscode.window.createOutputChannel('Paper MD');
  channel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}
// Fire-and-forget a promise-like without an unhandled rejection.
const bg = (p, what) => { try { Promise.resolve(p).catch((e) => log(`${what}: ${e && e.message}`)); } catch (e) { log(`${what}: ${e && e.message}`); } };

let cachedAssets;
function assets(ctx) {
  if (!cachedAssets) {
    const fs = require('fs');
    const p = (f) => vscode.Uri.joinPath(ctx.extensionUri, 'media', f).fsPath;
    cachedAssets = {
      katexCss: fs.readFileSync(p('katex.css'), 'utf8'),
      paperCss: fs.readFileSync(p('paper.css'), 'utf8'),
      mainJs: fs.readFileSync(p('main.js'), 'utf8'),
    };
  }
  return cachedAssets;
}

const dirOf = (uri) => vscode.Uri.joinPath(uri, '..');

function rootsFor(ctx, docUri) {
  const roots = [vscode.Uri.joinPath(ctx.extensionUri, 'media'), ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri)];
  if (docUri) roots.push(dirOf(docUri));
  return roots;
}

// Render a document to HTML; image paths resolve against the document's folder.
function renderDoc(wv, document, allowed) {
  const docDir = dirOf(document.uri);
  const render = createRenderer({
    resolveImage: (src) => {
      try {
        const clean = decodeURIComponent(src.split(/[?#]/)[0]);
        const uri = clean.startsWith('/') ? document.uri.with({ path: clean }) : vscode.Uri.joinPath(docDir, clean);
        return !allowed || inRoots(allowed, uri) ? wv.asWebviewUri(uri).toString() : null;
      } catch (e) { return null; }
    },
  });
  try { return render(document.getText()); }
  catch (e) { return '<pre>' + esc(S.renderError(String(e && e.message))) + '</pre>'; }
}

// Page shell. CSS and script are inline: separate resource requests do not load faster.
function shell(ctx, wv, bodyHtml, opts) {
  const n = U.makeNonce();
  const a = assets(ctx);
  const fontsBase = wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'fonts')).toString();
  const kcss = a.katexCss.replace(/url\(fonts\//g, `url(${fontsBase}/`);
  const custom = vscode.workspace.getConfiguration('paperMd').get('customCss') || '';
  const noStyleEnd = U.stripStyleEnd;
  const csp = U.shellCsp({ cspSource: wv.cspSource, nonce: n, allowRemoteImages: vscode.workspace.getConfiguration('paperMd').get('allowRemoteImages') !== false });
  const mediaUri = (f) => wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'pdfjs', f)).toString();
  const button = opts.editButton ? `<button type="button" id="edit-btn">${S.editButton}</button>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${noStyleEnd(kcss)}</style><style>${noStyleEnd(a.paperCss)}</style>
<style>${noStyleEnd(custom)}</style></head>
<body data-theme="${esc(vscode.workspace.getConfiguration('paperMd').get('theme') === 'auto' ? 'auto' : 'paper')}" data-key="${esc(opts.key || '')}" data-pdfjs="${mediaUri('pdf.min.js')}" data-pdfworker="${mediaUri('pdf.worker.min.js')}">${button}<div id="pdfbar" hidden><button id="pdf-out" title="${S.zoomOut}">&minus;</button><button id="pdf-in" title="${S.zoomIn}">+</button><button id="pdf-fit" title="${S.fitWidth}">Fit</button><button id="pdf-100" title="${S.actualSize}">100%</button><span id="pdf-page"></span></div><div id="pdf" hidden></div><div id="content" role="document" aria-label="${esc(S.contentLabel)}">${bodyHtml}</div>
<script nonce="${n}">${U.stripScriptEnd(a.mainJs)}</script></body></html>`;
}

// Open a link clicked in a rendered page. Relative .md links open with `mdEditor`.
function openLink(href, document, mdEditor) {
  try {
    if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
      bg(vscode.env.openExternal(vscode.Uri.parse(href)), 'openExternal');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const p = href.split('#')[0];
    const target = p.startsWith('/') ? document.uri.with({ path: decodeURIComponent(p) }) : vscode.Uri.joinPath(dirOf(document.uri), decodeURIComponent(p));
    bg(vscode.commands.executeCommand('vscode.openWith', target, isMd(target) ? mdEditor : 'default'), 'openWith');
  } catch (e) { log(`link ${href}: ${e && e.message}`); }
}

// One reused panel for HTML pages. The page's own HTML becomes the webview
// document, with a <base> tag so relative CSS, JS and images load next to the
// file. (An iframe pointing at the file's resource URL stays blank in Cursor.)
// There is no message handler, so page scripts cannot drive the extension.
class HtmlPanel {
  constructor(ctx) { this.ctx = ctx; this.panel = undefined; this.uri = undefined; this.seq = 0; }

  // Resources may come only from the extension's media folder and the shown file's own folder.
  options(uri) {
    return { enableScripts: true, enableForms: true, retainContextWhenHidden: true, enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), dirOf(uri)] };
  }

  show(uri, text, column, reload) {
    const t0 = Date.now();
    const dir = dirOf(uri);
    this.seq++;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('paperMd.html', 'Paper HTML',
        { viewColumn: column || vscode.ViewColumn.Active, preserveFocus: false }, this.options(uri));
      this.ctx.subscriptions.push(this.panel);
      this.panel.onDidDispose(() => { this.panel = undefined; this.uri = undefined; });
    } else {
      this.panel.webview.options = this.options(uri); // recomputed on every show
      if (column) this.panel.reveal(column, false);
    }
    const name = uri.path.split('/').pop();
    this.uri = uri;
    this.panel.title = 'Paper: ' + name;
    const wv = this.panel.webview;
    let html = U.buildHtmlPage(text, { cspSource: wv.cspSource, baseHref: wv.asWebviewUri(dir).toString() + '/' });
    // The same html string would not reload the page; make each set unique.
    html += `\n<!-- paper-md ${Date.now()} -->`;
    wv.html = html;
    log(`html ${name}: ${Math.round(text.length / 1024)} KB set in HTML panel${reload ? ' (reload after save)' : ''}, ${Date.now() - t0} ms`);
    this.notifyOnce();
  }

  notifyOnce() {
    if (HtmlPanel.notified) return;
    HtmlPanel.notified = true;
    bg(vscode.window.showInformationMessage(S.htmlRestricted), 'notify');
  }

  dispose() { if (this.panel) this.panel.dispose(); this.panel = undefined; }
}

// Mode 1: each .md file in its own tab (custom editor). About 1 s per new tab in Cursor.
class Provider {
  constructor(ctx) { this.ctx = ctx; }

  resolveCustomTextEditor(document, panel) {
    const t0 = Date.now();
    const name = document.uri.path.split('/').pop();
    const opened = openTimes.get(document.uri.toString());
    const wv = panel.webview;
    const roots = rootsFor(this.ctx, document.uri);
    wv.options = { enableScripts: true, localResourceRoots: roots };

    const first = renderDoc(wv, document, roots);
    const renderMs = Date.now() - t0;
    wv.html = shell(this.ctx, wv, first, { editButton: true });
    const tHtml = Date.now();

    let timer;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => bg(wv.postMessage({ type: 'render', html: renderDoc(wv, document, roots) }), 'postMessage'), 150);
    });
    panel.onDidDispose(() => { clearTimeout(timer); sub.dispose(); });

    wv.onDidReceiveMessage((m) => {
      if (m.type === 'timing' && m.t) {
        const r = (x) => (x ? (x - t0) + ' ms' : 'n/a');
        log(`tab ${name} (${document.getText().length} chars): ` +
          (opened ? `text doc opened ${t0 - opened} ms before viewer start; ` : '') +
          `render ${renderMs} ms, html set ${r(tHtml)}, webview created ${r(Math.round(m.t.origin))}, ` +
          `DOM ready ${r(m.t.dom)}, page loaded ${r(m.t.load)}, first paint ${r(m.t.paint)} (all from viewer start)`);
      } else if (m.type === 'edit') {
        bg(vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'), 'openWith');
      } else if (m.type === 'copyText' && typeof m.text === 'string') {
        bg(vscode.env.clipboard.writeText(m.text), 'clipboard');
      } else if (m.type === 'link' && typeof m.href === 'string') {
        openLink(m.href, document, VIEW_TYPE);
      }
    });
  }
}

// Mode 2: one panel that follows the active .md text editor. Only the first open
// pays for the webview; later files are a postMessage (tens of ms).
class FollowPanel {
  constructor(ctx, asText) {
    this.ctx = ctx;
    this.panel = undefined;
    this.doc = undefined;
    this.watch = new Map(); // 'panel' | 'html' -> { key, sig, pending } for change polling
    this.saves = new Map(); // uri -> time of the last editor save (per file)
    this.current = undefined; // { kind: 'md' | 'tex' | 'pdf' | 'html', uri } of the file now shown
    this.timer = undefined;
    this.userClosed = false;
    this.asText = asText || new Set(); // documents the user chose to read as text (shared by all panels)
    this.htmlPanel = new HtmlPanel(ctx);
    this.pdfBusy = new Set(); // PDF keys being loaded (re-entry guard)
    this.pdfRetry = new Map(); // PDF key -> column of a forced reload that arrived while busy
    this.lastPdf = { key: '', at: 0 }; // duplicate guard for tab events
    this.seq = 0; // bumps on every show; results of older shows are dropped
    this.allowed = []; // folders the webview may load files from
    this.rootCache = new Map(); // tex uri -> candidate root paths
    this.figMtime = new Map(); // PDF figure uri -> mtime, so a changed figure is re-rasterized
    this.texCache = new Map(); // uri -> { text, at } for \input files read from disk
    this.mirrors = new Map(); // root uri -> { rootUri, rootDir, base, targets } of the last compile
    this.compiler = new tc.Compiler();
    this.compileRoot = undefined; // root Uri of the compiled preview now shown
    this.status = undefined; // status bar item, created on first compile
  }

  // Start of every show: cancel the debounce timer and invalidate older async work.
  begin() { clearTimeout(this.timer); return ++this.seq; }
  stale(seq) { return !this.panel || seq !== this.seq; }

  // Webview roots: media, workspace folders, and the folders of the files shown now. Reset on each show.
  setRoots(...docUris) {
    if (!this.panel) return;
    const roots = U.uniqueBy([...rootsFor(this.ctx), ...docUris.filter(Boolean).map(dirOf)], (r) => r.toString());
    const wv = this.panel.webview;
    const cur = (wv.options.localResourceRoots || []).map((r) => r.toString()).join('|');
    if (cur !== roots.map((r) => r.toString()).join('|')) {
      // Changing the allowed folders makes VS Code reload the webview, which drops messages sent
      // before the reload finishes. Hold later posts until the page reports it has loaded again.
      this.holdPosts();
      wv.options = { ...wv.options, localResourceRoots: roots };
    }
    this.allowed = roots;
  }

  holdPosts() {
    if (this.reloadDone) return;
    this.reloading = new Promise((res) => {
      const t = setTimeout(done, 4000); // never hold forever
      const self = this;
      function done() { clearTimeout(t); self.reloadDone = null; self.reloading = null; res(); }
      this.reloadDone = done;
    });
  }

  // Called when the page sends its 'timing' message (it has loaded).
  pageLoaded() { if (this.reloadDone) this.reloadDone(); }

  post(msg) {
    if (!this.panel) return;
    this.sendQ = (this.sendQ || Promise.resolve()).then(() => this.reloading).then(() => {
      if (this.panel) return this.panel.webview.postMessage(msg);
    });
    bg(this.sendQ, 'postMessage');
  }

  // ---- compile mode (real TeX engine, see src/texcompile.js) ----
  compileMode() {
    if (vscode.workspace.isTrusted === false) return false; // untrusted workspace: never run a TeX engine
    return this.texMode() && vscode.workspace.getConfiguration('paperMd').get('tex.mode') === 'compile';
  }

  texPath() {
    const c = vscode.workspace.getConfiguration('paperMd');
    if (vscode.workspace.isTrusted === false) { const i = c.inspect('tex.texPath'); return i && i.globalValue; }
    return c.get('tex.texPath');
  }

  banner(text, level) { this.post({ type: 'banner', text: text || '', level: level || 'error' }); }

  setStatus(text, tip) {
    if (!vscode.window.createStatusBarItem) return;
    if (!this.status) {
      this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 0);
      this.status.command = 'paperMd.openTexLog';
      this.ctx.subscriptions.push(this.status);
    }
    this.status.text = text; this.status.tooltip = tip || S.texLogTitle;
    this.status.show();
  }

  hideStatus() { if (this.status) this.status.hide(); }

  cacheDir(rootUri) {
    const base = this.ctx.globalStorageUri ? this.ctx.globalStorageUri.fsPath : require('os').tmpdir();
    return tc.cacheDirFor(base, rootUri.toString());
  }

  rootPdf(rootUri) {
    return require('path').join(this.cacheDir(rootUri), 'out', rootUri.path.split('/').pop().replace(/\.tex$/i, '') + '.pdf');
  }

  // A PDF too large to post to the webview: show a banner instead.
  pdfTooBig(uri, name, bytes) {
    this.compileRoot = undefined;
    this.doc = undefined;
    this.current = { kind: 'pdf', uri };
    this.banner(S.pdfTooBig(name, Math.round(bytes / 1048576), Math.round(U.MAX_POST_BYTES / 1048576)), 'error');
    log(`pdf ${name}: ${Math.round(bytes / 1048576)} MB is over the viewer limit, not shown`);
  }

  // Post the compiled PDF with a stable key per root, so scroll and zoom survive recompiles.
  postCompiled(rootUri, pdfPath, stale) {
    if (!this.panel) return;
    const name = rootUri.path.split('/').pop().replace(/\.tex$/i, '.pdf');
    let data;
    try { data = require('fs').readFileSync(pdfPath); } catch (e) { log(`tex compile: cannot read ${pdfPath}: ${e && e.message}`); return; }
    if (U.tooBigToPost(data.length)) { this.pdfTooBig(this.current ? this.current.uri : rootUri, name, data.length); return; }
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    this.panel.title = 'Paper: ' + name + ' (compiled)';
    this.post({ type: 'pdf', key: rootUri.toString() + '#compiled', name, data: buf, sent: Date.now() });
    log(`tex compile: showing ${stale ? 'cached ' : ''}${name}, ${Math.round(data.length / 1024)} KB`);
  }

  async showCompiled(document) {
    if (!this.panel) return;
    const uri = document.uri;
    const seq = this.begin();
    this.doc = document;
    this.current = { kind: 'tex', uri };
    this.setRoots(uri);
    const roots = await this.findTexRoots(uri, document.getText());
    if (this.stale(seq)) return;
    const rootUri = roots.length ? uri.with({ path: roots[0] }) : uri;
    this.compileRoot = rootUri;
    const pdf = this.rootPdf(rootUri);
    if (require('fs').existsSync(pdf)) {
      this.postCompiled(rootUri, pdf, true);
    } else {
      await this.showTexHtml(document, seq);
      if (this.stale(seq)) return;
      this.banner(S.compiling, 'info');
    }
    this.compileRootNow(rootUri, false);
  }

  // Mirror the root folder, then compile. One run per root; a request during a run reruns once.
  compileRootNow(rootUri, force) {
    const key = rootUri.toString();
    this.setStatus('TeX: compiling…');
    this.compiler.request(key, async (o) => {
      const cache = this.cacheDir(rootUri);
      const maxMB = vscode.workspace.getConfiguration('paperMd').get('tex.maxMirrorMB') || 200;
      let ex = { base: dirOf(rootUri), relRoot: '', targets: [], warnings: [] };
      try { ex = await tc.findExternal(vscode, rootUri); } catch (e) { log('tex external refs: ' + (e && e.message)); }
      this.mirrors.set(key, { rootUri, rootDir: dirOf(rootUri), base: ex.base, targets: ex.targets || [] });
      for (const w of ex.warnings) log('tex mirror: ' + w);
      const m = await tc.mirror(vscode, dirOf(rootUri), cache, { maxMB, force, baseUri: ex.base, extra: ex.targets });
      if (m.tooBig) {
        log(`tex mirror: ${m.files} files, ${(m.totalBytes / 1048576).toFixed(1)} MB is over paperMd.tex.maxMirrorMB (${maxMB})`);
        return { ok: false, banner: S.mirrorTooBig(rootUri.path.split('/').pop(), (m.totalBytes / 1048576).toFixed(0), maxMB) };
      }
      log(`tex mirror base: ${ex.base.path}${ex.relRoot ? ' (root folder at ' + ex.relRoot + ')' : ''}${m.extFolders && m.extFolders.length ? '; external folders: ' + m.extFolders.join(', ') : ''}${ex.targets.length ? '; ' + ex.targets.length + ' external refs' : ''}`);
      log(`tex mirror: ${m.scanned} scanned, ${m.files} kept, ${m.copied} copied (${(m.bytes / 1048576).toFixed(2)} MB), ${m.removed} removed, ${m.ms} ms`);
      const rootFile = require('path').join(cache, 'src', ex.relRoot, rootUri.path.split('/').pop());
      const res = await tc.compile(rootFile, cache, { texPath: this.texPath(), force: !!(o && o.force) || !!force, timeoutMs: this.compileTimeoutMs, skipped: m.skipped });
      res.rootUri = rootUri;
      return res;
    }, (res, again) => {
      const name = rootUri.path.split('/').pop();
      const shown = this.compileRoot && this.compileRoot.toString() === key && this.current && this.current.kind === 'tex';
      if (res.ok) {
        let kb = 0;
        try { kb = Math.round(require('fs').statSync(res.pdf).size / 1024); } catch (e) { /* ignore */ }
        log(`tex compile ${name}: ok, ${res.engine}, ${res.ms} ms, PDF ${kb} KB`);
        if (!again) this.setStatus(`TeX: ok ${(res.ms / 1000).toFixed(1)} s`);
        if (shown) {
          this.postCompiled(rootUri, res.pdf, false);
          this.banner('');
        }
      } else {
        log(`tex compile ${name}: failed${res.engine ? ' (' + res.engine + ')' : ''}, ${res.ms || 0} ms. ${String(res.banner || '').split('\n')[0]}${res.logPath ? ' Log: ' + res.logPath : ''}`);
        if (!again) this.setStatus('TeX: error');
        if (shown) this.banner(res.banner, 'error');
      }
      for (const w of res.warnings || []) log(`tex compile ${name}: ${w}`);
      this.lastLog = res.logPath || this.lastLog;
    }, force);
  }

  // A .tex/.sty/.cls/.bib file was saved: recompile the root whose folder tree or external mirror holds it.
  async compileOnSave(d) {
    if (!this.panel || !this.compileMode() || !/\.(tex|sty|cls|bib)$/i.test(d.uri.path)) return;
    let root;
    const m = this.compileRoot && this.mirrors.get(this.compileRoot.toString());
    if (this.compileRoot && (inRoots([dirOf(this.compileRoot)], d.uri) || U.mirrorHit(m, d.uri))) root = this.compileRoot;
    if (!root) {
      if (!isTex(d.uri)) return;
      const roots = await this.findTexRoots(d.uri, d.getText());
      root = roots.length ? d.uri.with({ path: roots[0] }) : d.uri;
    }
    this.compileRootNow(root, false);
  }

  replaceMode() {
    return vscode.workspace.getConfiguration('paperMd').get('followPanel.replaceTextTab');
  }

  open(document, reveal, column, extraUri) {
    if (this.panel) {
      if (reveal) this.panel.reveal(column, !this.replaceMode());
      if (document) this.showDoc(document);
      return;
    }
    this.userClosed = false;
    const t0 = Date.now();
    const replace = this.replaceMode();
    const roots = rootsFor(this.ctx, extraUri || (document && document.uri));
    const panel = vscode.window.createWebviewPanel(FOLLOW_TYPE, 'Paper MD',
      { viewColumn: replace && column ? column : vscode.ViewColumn.Beside, preserveFocus: !replace },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: roots });
    this.ctx.subscriptions.push(panel);
    this.panel = panel;
    this.allowed = roots;
    this.begin();
    this.doc = document;
    const tex = !!document && isTex(document.uri);
    this.current = document ? { kind: tex ? 'tex' : 'md', uri: document.uri } : undefined;
    const wv = panel.webview;
    const body = !document ? `<p>${S.emptyPanel}</p>` : tex ? `<p class="tex-note">${S.rendering}</p>` : renderDoc(wv, document, roots);
    if (document) panel.title = 'Paper: ' + document.uri.path.split('/').pop();
    wv.html = shell(this.ctx, wv, body, { editButton: replace, key: document ? document.uri.toString() : '' });
    if (tex) bg(this.showTex(document), 'tex');

    wv.onDidReceiveMessage((m) => {
      if (m.type === 'timing' && m.t) {
        this.pageLoaded();
        log(`panel created: DOM ready ${m.t.dom - t0} ms, first paint ${m.t.paint - t0} ms (one-time cost)`);
      } else if (m.type === 'rendered') {
        log(`panel switch ${this.doc ? this.doc.uri.path.split('/').pop() : ''}: shown ${m.at - m.sent} ms after send (render ${this.lastRenderMs} ms)`);
      } else if (m.type === 'pdfShown') {
        log(`pdf ${m.name || ''}: first page shown ${m.at - m.sent} ms after send (${m.pages} pages)`);
      } else if (m.type === 'pdfError') {
        log(`pdf error: ${m.message}`);
      } else if (m.type === 'edit' && this.current) {
        // Read this file as text: stop replacing its text tab until it is closed.
        const uri = this.current.uri;
        this.asText.add(uri.toString());
        bg(vscode.window.showTextDocument(uri, { viewColumn: this.panel && this.panel.viewColumn, preview: false }), 'showTextDocument');
      } else if (m.type === 'copyText' && typeof m.text === 'string') {
        bg(vscode.env.clipboard.writeText(m.text), 'clipboard');
      } else if (m.type === 'link' && typeof m.href === 'string' && this.doc) {
        openLink(m.href, this.doc, 'default');
      }
    });
    panel.onDidDispose(() => {
      clearTimeout(this.timer);
      this.seq++;
      this.panel = undefined;
      this.doc = undefined;
      this.current = undefined;
      this.compileRoot = undefined;
      // In replace mode, closing the panel is like closing a file; keep auto-open on.
      this.userClosed = !this.replaceMode();
    });
  }

  // Close the text tabs of `uri` so the panel is the only view of the file. Tabs with unsaved edits stay.
  closeTextTabs(uri) {
    const key = uri.toString();
    const tabs = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const tab of g.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key && !tab.isDirty) tabs.push(tab);
      }
    }
    if (tabs.length) bg(vscode.window.tabGroups.close(tabs, true), 'close tabs');
  }

  show(document) {
    if (!this.panel) return;
    const wv = this.panel.webview;
    this.begin();
    this.setRoots(document.uri);
    this.doc = document;
    this.current = { kind: 'md', uri: document.uri };
    this.compileRoot = undefined;
    this.panel.title = 'Paper: ' + document.uri.path.split('/').pop();
    this.banner('');
    this.hideStatus();
    const t = Date.now();
    const html = renderDoc(wv, document, this.allowed);
    this.lastRenderMs = Date.now() - t;
    this.post({ type: 'render', key: document.uri.toString(), html, sent: Date.now() });
  }

  showDoc(document) {
    if (isTex(document.uri)) return this.showTex(document);
    this.show(document);
  }

  texMode() {
    const c = vscode.workspace.getConfiguration('paperMd');
    return !!c.get('tex.enabled') && !!c.get('followPanel.replaceTextTab');
  }

  // Text of a file next to the .tex file: an open editor wins (live text), else disk, kept 2 s.
  async readTexInput(uri) {
    const key = uri.toString();
    const open = vscode.workspace.textDocuments && vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) return open.getText();
    const hit = this.texCache.get(key);
    if (hit && Date.now() - hit.at < 2000) return hit.text;
    let text = null;
    try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch (e) { text = null; }
    this.texCache.set(key, { text, at: Date.now() });
    return text;
  }

  // Root documents of a section file (see src/texroot.js); cached per file until a .tex file is saved.
  async findTexRoots(uri, text) {
    const key = uri.toString();
    if (this.rootCache.has(key)) return this.rootCache.get(key);
    const io = {
      readText: (p) => this.readTexInput(uri.with({ path: p })),
      listDir: async (p) => (await vscode.workspace.fs.readDirectory(uri.with({ path: p }))).map((e) => e[0]),
    };
    let roots = [];
    try { roots = await findRoots(uri.path, text, io); } catch (e) { roots = []; }
    this.rootCache.set(key, roots);
    return roots;
  }

  showTex(document) {
    return this.compileMode() ? this.showCompiled(document) : this.showTexHtml(document);
  }

  // Render a .tex file (async because of \input) and post it to the panel.
  async showTexHtml(document, ownSeq) {
    if (!this.panel) return;
    const uri = document.uri;
    const key = uri.toString();
    const name = uri.path.split('/').pop();
    this.setRoots(uri);
    this.doc = document;
    this.current = { kind: 'tex', uri };
    this.panel.title = 'Paper: ' + name;
    const seq = ownSeq || this.begin();
    const t0 = Date.now();
    const wv = this.panel.webview;
    const listings = new Map(); // folder -> Set of names, one directory read per folder
    const text = document.getText();
    // A section file is shown with the context of its root document (macros, numbers, paths).
    const roots = await this.findTexRoots(uri, text);
    const build = async (rootPath, preambleOnly) => {
      if (this.stale(seq)) return null;
      const rootUri = rootPath ? uri.with({ path: rootPath }) : uri;
      const dir = dirOf(rootUri);
      const rel = (p) => (p.startsWith('/') ? uri.with({ path: p }) : vscode.Uri.joinPath(dir, p));
      this.setRoots(uri, rootUri);
      const rootText = rootPath ? await this.readTexInput(rootUri) : text;
      if (typeof rootText !== 'string') return null;
      const rootName = rootUri.path.split('/').pop();
      return texToHtml(rootText, {
        baseName: rootName.replace(/\.tex$/i, ''),
        rootName: rootPath ? rootName : undefined,
        part: rootPath ? { rel: require('path').posix.relative(dir.path, uri.path), text, preambleOnly: !!preambleOnly } : undefined,
        readFile: (p) => this.readTexInput(rel(p)),
        exists: async (p) => {
          const full = rel(p);
          const folder = vscode.Uri.joinPath(full, '..');
          const fk = folder.toString();
          if (!listings.has(fk)) {
            let names = new Set();
            try { names = new Set((await vscode.workspace.fs.readDirectory(folder)).map((e) => e[0])); } catch (e) { /* missing folder */ }
            listings.set(fk, names);
          }
          const found = listings.get(fk).has(full.path.split('/').pop());
          if (found && /\.pdf$/i.test(full.path)) {
            try { this.figMtime.set(full.toString(), (await vscode.workspace.fs.stat(full)).mtime); } catch (e) { /* no version */ }
          }
          return found;
        },
        // Only files inside the workspace or the document/root folders get a webview URL.
        resolveImage: (p) => {
          try { const u = rel(p); if (!inRoots(this.allowed, u)) return null;
            const v = this.figMtime.get(u.toString());
            return wv.asWebviewUri(u).toString() + (v ? '?v=' + v : ''); } catch (e) { return null; }
        },
      });
    };
    let result = null;
    try {
      if (!roots.length) result = await build(null);
      else {
        for (const r of roots) { const x = await build(r, false); if (x && x.stats.partFound) { result = x; break; } }
        if (!result) result = await build(roots[0], true) || await build(null);
        else log(`tex ${name}: part of ${result.stats.rootName}`);
      }
    } catch (e) {
      result = { html: '<pre>' + esc(S.renderError(String(e && e.message))) + '</pre>', stats: { inputs: 0 } };
    }
    if (!result) result = { html: '<pre>' + esc(S.renderError('')) + '</pre>', stats: { inputs: 0 } };
    if (this.stale(seq) || !this.current || this.current.kind !== 'tex' || this.current.uri.toString() !== key) return; // stale
    this.lastRenderMs = Date.now() - t0;
    this.post({ type: 'render', key, html: result.html, sent: Date.now() });
    log(`tex ${name}: ${Math.round(text.length / 1024)} KB, ${result.stats.inputs || 0} inputs, render ${this.lastRenderMs} ms`);
  }

  pdfMode() {
    const c = vscode.workspace.getConfiguration('paperMd');
    return !!c.get('pdf.enabled') && !!c.get('followPanel.replaceTextTab');
  }

  // Show a PDF in the follow panel, then close its placeholder tab.
  async showPdf(uri, column, force) {
    const key = uri.toString();
    const now = Date.now();
    if (this.pdfBusy.has(key)) { if (force) this.pdfRetry.set(key, column); return; } // a forced reload runs once the current one ends
    if (!force && this.lastPdf.key === key && now - this.lastPdf.at < 1500) return;
    this.pdfBusy.add(key);
    const name = uri.path.split('/').pop();
    try {
      if (!this.panel) {
        if (this.userClosed || !vscode.workspace.getConfiguration('paperMd').get('followPanel.autoOpen')) {
          log(`pdf ${name}: no panel (closed by user or autoOpen off)`);
          return;
        }
        log(`pdf ${name}: opening panel in place`);
        this.open(undefined, false, column);
      }
      const seq = this.begin();
      const t0 = Date.now();
      let size;
      try { size = (await vscode.workspace.fs.stat(uri)).size; } catch (e) { size = undefined; }
      if (this.stale(seq)) return;
      if (size !== undefined && U.tooBigToPost(size)) { this.pdfTooBig(uri, name, size); return; }
      const data = await vscode.workspace.fs.readFile(uri);
      const readMs = Date.now() - t0;
      if (this.stale(seq)) return; // panel closed or another file shown while reading
      if (U.tooBigToPost(data.byteLength)) { this.pdfTooBig(uri, name, data.byteLength); return; }
      log(`pdf ${name}: ${Math.round(data.byteLength / 1024)} KB, read ${readMs} ms`);
      this.banner('');
      this.lastPdf = { key, at: Date.now() };
      this.doc = undefined;
      this.compileRoot = undefined;
      this.setRoots();
      this.current = { kind: 'pdf', uri };
      this.panel.title = 'Paper: ' + name;
      this.panel.reveal(column || this.panel.viewColumn, false);
      // Send a plain ArrayBuffer: a Node Buffer can arrive in the webview as a plain object.
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.post({ type: 'pdf', key, name, data: buf, sent: Date.now() });
      this.closeTextTabs(uri);
    } catch (e) {
      log(`pdf ${name}: failed: ${e && e.message}`);
    } finally {
      this.pdfBusy.delete(key);
      if (this.pdfRetry.has(key)) {
        const col = this.pdfRetry.get(key);
        this.pdfRetry.delete(key);
        if (this.panel && this.current && this.current.kind === 'pdf' && this.current.uri.toString() === key) bg(this.showPdf(uri, col, true), 'pdf retry');
      }
    }
  }

  htmlMode() {
    const c = vscode.workspace.getConfiguration('paperMd');
    return !!c.get('html.enabled') && !!c.get('followPanel.replaceTextTab');
  }

  onDocSave(d) {
    const now = Date.now();
    U.pruneSaves(this.saves, now);
    this.saves.set(d.uri.toString(), now);
    if (isTex(d.uri)) { this.rootCache.clear(); this.texCache.clear(); }
    this.compileOnSave(d).catch((e) => log('tex compile on save: ' + (e && e.message)));
    const h = this.htmlPanel;
    if (h.panel && h.uri && h.uri.toString() === d.uri.toString()) {
      log(`html ${d.uri.path.split('/').pop()}: saved, reloading`);
      h.show(d.uri, d.getText(), undefined, true);
    }
  }

  // A binary .pdf does not raise onDidChangeActiveTextEditor; watch the active tab instead.
  checkTabs() {
    if (!this.pdfMode()) return;
    const g = vscode.window.tabGroups.activeTabGroup;
    const tab = g && g.activeTab;
    if (tab && tab.input instanceof vscode.TabInputText && U.isRealScheme(tab.input.uri.scheme) && isPdf(tab.input.uri)) {
      bg(this.showPdf(tab.input.uri, g.viewColumn), 'pdf');
    }
  }

  onEditorChange(editor) {
    if (!editor || !U.isRealScheme(editor.document.uri.scheme)) return; // git, diff, scm and other virtual editors are left alone
    const html = isHtml(editor.document.uri);
    const tex = isTex(editor.document.uri);
    if (html ? !this.htmlMode() : tex ? !this.texMode() : !isMd(editor.document.uri)) return;
    const doc = editor.document;
    const name = doc.uri.path.split('/').pop();
    if (this.asText.has(doc.uri.toString())) { log(`editor change ${name}: kept as text (Edit as text)`); return; }
    const replace = this.replaceMode();
    if (html) {
      // HTML pages use their own reused panel (see HtmlPanel).
      log(`editor change ${name}: showing in HTML panel`);
      this.htmlPanel.show(doc.uri, doc.getText(), editor.viewColumn, false);
      if (replace) this.closeTextTabs(doc.uri);
      return;
    }
    if (this.panel) {
      log(`editor change ${name}: updating panel` + (replace ? ' in place' : ''));
      if (!this.doc || this.doc.uri.toString() !== doc.uri.toString()) bg(this.showDoc(doc), 'show');
      if (replace) this.panel.reveal(editor.viewColumn, false);
    } else if (!this.userClosed && vscode.workspace.getConfiguration('paperMd').get('followPanel.autoOpen')) {
      log(`editor change ${name}: opening panel` + (replace ? ' in place' : ' beside'));
      this.open(doc, false, editor.viewColumn);
    } else {
      log(`editor change ${name}: no panel (closed by user or autoOpen off)`);
      return;
    }
    // Close the text tab at once (no timer) so it is visible for as short a time as possible.
    if (replace) this.closeTextTabs(doc.uri);
  }

  // Files rebuilt or edited by another process raise no save event. Poll the shown
  // file's size and mtime; reload once it has been stable for one poll (write finished).
  async pollFiles() {
    if (this.polling) return;
    this.polling = true;
    try {
      const targets = [];
      if (this.panel && this.panel.visible && this.current) targets.push({ own: 'panel', uri: this.current.uri, kind: this.current.kind });
      const h = this.htmlPanel;
      if (h.panel && h.panel.visible && h.uri) targets.push({ own: 'html', uri: h.uri, kind: 'html' });
      for (const t of targets) {
        const key = t.own + '|' + t.uri.toString();
        let st;
        try { st = await vscode.workspace.fs.stat(t.uri); } catch (e) { continue; }
        const sig = st.mtime + ':' + st.size;
        const w = this.watch.get(t.own);
        if (!w || w.key !== key) { this.watch.set(t.own, { key, sig, pending: false }); continue; }
        if (sig !== w.sig) { w.sig = sig; w.pending = true; continue; }
        if (w.pending) {
          let r;
          try { r = await this.reloadFile(t); } catch (e) { log('reload: ' + (e && e.message)); }
          if (r !== 'skip') w.pending = false; // skipped (just saved from an editor): try again at the next poll
        }
      }
    } finally { this.polling = false; }
  }

  async reloadFile(t) {
    const uri = t.uri;
    const key = uri.toString();
    const name = uri.path.split('/').pop();
    if (U.recentlySaved(this.saves, key, Date.now(), t.kind)) return 'skip'; // an editor save handles it
    log(`${name}: changed on disk, reloading`);
    if (t.kind === 'pdf') { this.lastPdf = { key: '', at: 0 }; await this.showPdf(uri, undefined, true); return 'done'; }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open && open.isDirty) return 'done'; // live edits already update the view
    const isTexFile = isTex(uri);
    if (isTexFile) { this.rootCache.clear(); this.texCache.clear(); }
    if (t.kind === 'tex' && isTexFile && this.compileMode()) { this.compileRootNow(this.compileRoot || uri, false); return 'done'; }
    const h = this.htmlPanel;
    const seq0 = t.kind === 'html' ? h.seq : this.seq;
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (t.kind === 'html') {
      if (!h.panel || h.seq !== seq0 || !h.uri || h.uri.toString() !== key) return 'done'; // another file was shown meanwhile
      h.show(uri, text, undefined, true);
      return 'done';
    }
    if (this.stale(seq0) || !this.current || this.current.uri.toString() !== key) return 'done';
    await this.showDoc({ uri, getText: () => text });
    return 'done';
  }

  onDocClose(d) { this.asText.delete(d.uri.toString()); }

  // A text tab closed: forget "Edit as text" only when no other tab still shows the file.
  onTabClosed(uri) {
    const keys = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const tab of g.tabs) if (tab.input instanceof vscode.TabInputText) keys.push(tab.input.uri.toString());
    }
    if (!U.hasTabFor(keys, uri.toString())) this.asText.delete(uri.toString());
  }

  onDocChange(e) {
    if (!this.panel || !this.doc || e.document.uri.toString() !== this.doc.uri.toString()) return;
    if (isTex(e.document.uri) && this.compileMode()) return; // the PDF updates on save
    clearTimeout(this.timer);
    const seq = this.seq;
    const key = e.document.uri.toString();
    this.timer = setTimeout(() => {
      if (this.stale(seq) || !this.doc || this.doc.uri.toString() !== key) return; // something else was shown meanwhile
      bg(this.showDoc(e.document), 'show');
    }, isTex(e.document.uri) ? 300 : 150);
  }

  dispose() {
    clearTimeout(this.timer);
    this.seq++;
    if (this.status) this.status.dispose();
    if (this.panel) this.panel.dispose();
    this.htmlPanel.dispose();
  }
}

// Several follow panels: with replaceTextTab on, each editor column gets its own panel,
// so "Open to the Side" makes a second viewer and leaves the first one alone.
class Manager {
  constructor(ctx) {
    this.ctx = ctx;
    this.asText = new Set();
    this.list = [new FollowPanel(ctx, this.asText)];
  }
  texMode() { return this.list[0].texMode(); }
  at(col) {
    const L = this.list;
    if (!col || !L[0].replaceMode()) return L[0];
    const hit = L.find((f) => (f.panel && f.panel.viewColumn === col) || (f.htmlPanel.panel && f.htmlPanel.panel.viewColumn === col));
    if (hit) return hit;
    const idle = L.find((f) => !f.panel && !f.htmlPanel.panel);
    if (idle) return idle;
    const f = new FollowPanel(this.ctx, this.asText);
    L.push(f);
    return f;
  }
  active() {
    return this.list.find((f) => (f.panel && f.panel.active) || (f.htmlPanel.panel && f.htmlPanel.panel.active)) || this.list[0];
  }
  onEditorChange(ed) { if (ed) this.at(ed.viewColumn).onEditorChange(ed); }
  onDocChange(e) { for (const f of this.list) f.onDocChange(e); }
  onDocClose(d) { this.list[0].onDocClose(d); }
  onTabClosed(uri) { this.list[0].onTabClosed(uri); }
  onDocSave(d) { for (const f of this.list) f.onDocSave(d); }
  checkTabs() {
    const g = vscode.window.tabGroups.activeTabGroup;
    this.at(g && g.viewColumn).checkTabs();
  }
  poll() { for (const f of this.list) f.pollFiles().catch((e) => log('poll: ' + (e && e.message))); }
  // Workspace trust changed: re-show TeX files so the mode and TeX path follow the new setting.
  refreshTrust() {
    for (const f of this.list) if (f.panel && f.doc && f.current && f.current.kind === 'tex') bg(f.showDoc(f.doc), 'trust refresh');
  }
  dispose() {
    for (const f of this.list) f.dispose();
    if (typeof tc.killAll === 'function') tc.killAll();
  }
}

// ---- first run and "turn on all viewers" ----
const ENABLE_KEYS = ['followPanel.autoOpen', 'followPanel.replaceTextTab', 'pdf.enabled', 'html.enabled', 'tex.enabled'];
const PREV_KEY = 'enableAll.previous';

async function enableAll(ctx) {
  const cfg = vscode.workspace.getConfiguration('paperMd');
  const wb = vscode.workspace.getConfiguration();
  const settings = {};
  for (const k of ENABLE_KEYS) { const v = cfg.inspect(k); settings[k] = v && v.globalValue !== undefined ? v.globalValue : null; }
  const assocInfo = wb.inspect('workbench.editorAssociations');
  const assoc = assocInfo && assocInfo.globalValue !== undefined ? assocInfo.globalValue : null;
  const alreadyOn = ENABLE_KEYS.every((k) => settings[k] === true) && assoc !== null && JSON.stringify(U.addPdfAssociation(assoc)) === JSON.stringify(assoc);
  // Keep the first snapshot when run again, so Undo goes back to before the viewers were on.
  if (!(alreadyOn && ctx.globalState.get(PREV_KEY))) await ctx.globalState.update(PREV_KEY, { settings, assoc });
  try {
    for (const k of ENABLE_KEYS) await cfg.update(k, true, GLOBAL);
    await wb.update('workbench.editorAssociations', U.addPdfAssociation(assoc === null ? undefined : assoc), GLOBAL);
  } catch (e) {
    log('enableAll: ' + (e && e.message));
  }
  const pick = await vscode.window.showInformationMessage(S.enabledAll, S.reloadWindow, S.undo);
  if (pick === S.reloadWindow) bg(vscode.commands.executeCommand('workbench.action.reloadWindow'), 'reload');
  else if (pick === S.undo) await undoEnableAll(ctx);
}

async function undoEnableAll(ctx) {
  const prev = ctx.globalState.get(PREV_KEY);
  if (!prev) return;
  const cfg = vscode.workspace.getConfiguration('paperMd');
  const wb = vscode.workspace.getConfiguration();
  try {
    for (const k of ENABLE_KEYS) await cfg.update(k, prev.settings[k] === null ? undefined : prev.settings[k], GLOBAL);
    const info = wb.inspect('workbench.editorAssociations');
    await wb.update('workbench.editorAssociations', U.restorePdfAssociation(info && info.globalValue, prev.assoc === null ? undefined : prev.assoc), GLOBAL);
    await ctx.globalState.update(PREV_KEY, undefined);
    vscode.window.showInformationMessage(S.undone);
  } catch (e) { log('undo enableAll: ' + (e && e.message)); }
}

async function firstRun(ctx) {
  if (ctx.globalState.get('firstRunDone')) return;
  const pick = await vscode.window.showInformationMessage(S.firstRun, S.turnOn, S.openGuide, S.notNow);
  await ctx.globalState.update('firstRunDone', true); // never ask again once answered or dismissed
  if (pick === S.turnOn) await vscode.commands.executeCommand('paperMd.enableAll');
  else if (pick === S.openGuide) await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'toqitahamid.fast-document-viewer#paperMd.gettingStarted');
}

function activate(ctx) {
  const ta = Date.now();
  if (!channel) { channel = vscode.window.createOutputChannel('Paper MD'); ctx.subscriptions.push(channel); }
  const follow = new Manager(ctx);
  manager = follow;
  const pollTimer = setInterval(() => follow.poll(), 1500);
  const activeMd = () => {
    const ed = vscode.window.activeTextEditor;
    return ed && U.isRealScheme(ed.document.uri.scheme) && (isMd(ed.document.uri) || (isTex(ed.document.uri) && follow.texMode())) ? ed.document : undefined;
  };
  ctx.subscriptions.push(
    { dispose: () => clearInterval(pollTimer) },
    { dispose: () => { follow.dispose(); if (manager === follow) manager = undefined; } },
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (isMd(d.uri)) openTimes.set(d.uri.toString(), Date.now());
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor((ed) => follow.onEditorChange(ed)),
    vscode.workspace.onDidChangeTextDocument((e) => follow.onDocChange(e)),
    vscode.workspace.onDidCloseTextDocument((d) => { openTimes.delete(d.uri.toString()); follow.onDocClose(d); }),
    vscode.workspace.onDidSaveTextDocument((d) => follow.onDocSave(d)),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) if (tab.input instanceof vscode.TabInputText) follow.onTabClosed(tab.input.uri);
      follow.checkTabs();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => follow.checkTabs()),
    vscode.commands.registerCommand('paperMd.openFollowPanel', () => follow.active().open(activeMd(), true)),
    vscode.commands.registerCommand('paperMd.enableAll', () => enableAll(ctx)),
    vscode.commands.registerCommand('paperMd.recompileTex', async () => {
      const F = follow.active();
      const ed = vscode.window.activeTextEditor;
      const shownTex = !!(F.panel && F.current && F.current.kind === 'tex');
      // The active panel wins over a stale activeTextEditor.
      let root = F.panel && F.panel.active && shownTex ? (F.compileRoot || F.current.uri) : undefined;
      if (!root && ed && U.isRealScheme(ed.document.uri.scheme) && isTex(ed.document.uri)) {
        const roots = await F.findTexRoots(ed.document.uri, ed.document.getText());
        root = roots.length ? ed.document.uri.with({ path: roots[0] }) : ed.document.uri;
      }
      if (!root && shownTex) root = F.compileRoot || F.current.uri;
      if (!root) { vscode.window.showInformationMessage(S.openTexFirst); return; }
      if (shownTex && F.compileRoot && F.compileRoot.toString() !== root.toString()) F.compileRoot = root;
      F.compileRootNow(root, true);
    }),
    vscode.commands.registerCommand('paperMd.openTexLog', () => {
      const F = follow.active();
      const p = F.lastLog || (F.compileRoot && require('path').join(F.cacheDir(F.compileRoot), 'out', F.compileRoot.path.split('/').pop().replace(/\.tex$/i, '.log')));
      if (p && require('fs').existsSync(p)) bg(vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true }), 'showTextDocument');
      else { log('tex log: none yet'); if (channel) channel.show(true); }
    }),
    vscode.commands.registerCommand('paperMd.openAsText', (arg) => {
      const F = follow.active();
      const h = F.htmlPanel;
      let uri = arg instanceof vscode.Uri ? arg : undefined;
      let col;
      // Panels first: activeTextEditor can be stale while a webview has focus.
      if (!uri && F.panel && F.panel.active && F.current && F.current.kind !== 'pdf') {
        uri = F.current.uri; col = F.panel.viewColumn;
      } else if (!uri && h.panel && h.panel.active && h.uri) {
        uri = h.uri; col = h.panel.viewColumn;
      }
      if (!uri) {
        const ed = vscode.window.activeTextEditor;
        uri = ed && ed.document.uri;
      }
      log(`openAsText: ${uri ? uri.toString() : 'no target'}`);
      if (!uri) { vscode.window.showInformationMessage(S.noTextSource); return; }
      follow.asText.add(uri.toString());
      bg(vscode.window.showTextDocument(uri, { viewColumn: col, preview: false }), 'showTextDocument');
    }),
    // From a .md/.tex/.html text tab (title-bar preview button): back to the rendered view.
    vscode.commands.registerCommand('paperMd.showPaper', (uri) => {
      const ed = vscode.window.activeTextEditor;
      const doc = ed && (!uri || ed.document.uri.toString() === uri.toString()) ? ed.document : undefined;
      if (!doc) return;
      follow.asText.delete(doc.uri.toString());
      const F = follow.at(ed.viewColumn);
      F.userClosed = false;
      F.onEditorChange(ed);
    }),
  );
  if (vscode.workspace.onDidGrantWorkspaceTrust) ctx.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => follow.refreshTrust()));
  // A Markdown text editor may already be active when the extension starts.
  follow.onEditorChange(vscode.window.activeTextEditor);
  follow.checkTabs();
  firstRun(ctx).catch((e) => log('first run: ' + (e && e.message)));
  log(`activated in ${Date.now() - ta} ms`);
}

function deactivate() {
  if (manager) { manager.dispose(); manager = undefined; }
  if (typeof tc.killAll === 'function') tc.killAll();
}
module.exports = { activate, deactivate, Manager };
