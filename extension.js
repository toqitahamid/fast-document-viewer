'use strict';
const vscode = require('vscode');
const { createRenderer } = require('./src/render');
const { texToHtml } = require('./src/tex');
const { findRoots } = require('./src/texroot');
const tc = require('./src/texcompile');

const VIEW_TYPE = 'paperMd.viewer';
const FOLLOW_TYPE = 'paperMd.follow';
const isMd = (uri) => /\.(md|markdown)$/i.test(uri.path);
const isPdf = (uri) => /\.pdf$/i.test(uri.path);
const isHtml = (uri) => /\.html?$/i.test(uri.path);
const isTex = (uri) => /\.tex$/i.test(uri.path);

function nonce() {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

let channel;
const openTimes = new Map();
function log(msg) {
  if (!channel) channel = vscode.window.createOutputChannel('Paper MD');
  channel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

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

function inRoots(roots, uri) {
  return roots.some((r) => r.scheme === uri.scheme && r.authority === uri.authority &&
    (uri.path === r.path || uri.path.startsWith(r.path.endsWith('/') ? r.path : r.path + '/')));
}

// Render a document to HTML; image paths resolve against the document's folder.
function renderDoc(wv, document) {
  const docDir = dirOf(document.uri);
  const render = createRenderer({
    resolveImage: (src) => {
      try {
        const clean = decodeURIComponent(src.split(/[?#]/)[0]);
        const uri = clean.startsWith('/') ? document.uri.with({ path: clean }) : vscode.Uri.joinPath(docDir, clean);
        return wv.asWebviewUri(uri).toString();
      } catch (e) { return null; }
    },
  });
  try { return render(document.getText()); }
  catch (e) { return '<pre>Render error: ' + esc(String(e && e.message)) + '</pre>'; }
}

// Page shell. CSS and script are inline: separate resource requests do not load faster.
function shell(ctx, wv, bodyHtml, opts) {
  const n = nonce();
  const a = assets(ctx);
  const fontsBase = wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'fonts')).toString();
  const kcss = a.katexCss.replace(/url\(fonts\//g, `url(${fontsBase}/`);
  const custom = vscode.workspace.getConfiguration('paperMd').get('customCss') || '';
  const noStyleEnd = (s) => s.replace(/<\/style/gi, '');
  const mediaUri = (f) => wv.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'pdfjs', f)).toString();
  const button = opts.editButton ? '<button id="edit-btn">Edit as text</button>' : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} https: data: blob:; style-src ${wv.cspSource} 'unsafe-inline'; frame-src ${wv.cspSource}; font-src ${wv.cspSource}; script-src 'nonce-${n}' ${wv.cspSource}; worker-src blob:; connect-src ${wv.cspSource};">
<style>${noStyleEnd(kcss)}</style><style>${noStyleEnd(a.paperCss)}</style>
<style>${noStyleEnd(custom)}</style></head>
<body data-key="${esc(opts.key || '')}" data-pdfjs="${mediaUri('pdf.min.js')}" data-pdfworker="${mediaUri('pdf.worker.min.js')}">${button}<div id="pdfbar" hidden><button id="pdf-out" title="Zoom out">&minus;</button><button id="pdf-in" title="Zoom in">+</button><button id="pdf-fit" title="Fit width">Fit</button><button id="pdf-100" title="Actual size">100%</button><span id="pdf-page"></span></div><div id="pdf" hidden></div><iframe id="htmlframe" hidden sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe><div id="content">${bodyHtml}</div>
<script nonce="${n}">${a.mainJs.replace(/<\/script/gi, '')}</script></body></html>`;
}

// Open a link clicked in a rendered page. Relative .md links open with `mdEditor`.
function openLink(href, document, mdEditor) {
  if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
    vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  const p = href.split('#')[0];
  let target;
  try { target = p.startsWith('/') ? document.uri.with({ path: decodeURIComponent(p) }) : vscode.Uri.joinPath(dirOf(document.uri), decodeURIComponent(p)); }
  catch (e) { return; }
  vscode.commands.executeCommand('vscode.openWith', target, isMd(target) ? mdEditor : 'default');
}

// One reused panel for HTML pages. The page's own HTML becomes the webview
// document, with a <base> tag so relative CSS, JS and images load next to the
// file. (An iframe pointing at the file's resource URL stays blank in Cursor.)
// There is no message handler, so page scripts cannot drive the extension.
class HtmlPanel {
  constructor(ctx) { this.ctx = ctx; this.panel = undefined; this.uri = undefined; }

  show(uri, text, column, reload) {
    const t0 = Date.now();
    const dir = dirOf(uri);
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('paperMd.html', 'Paper HTML',
        { viewColumn: column || vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, enableForms: true, retainContextWhenHidden: true, enableFindWidget: true,
          localResourceRoots: [...rootsFor(this.ctx, uri)] });
      this.panel.onDidDispose(() => { this.panel = undefined; this.uri = undefined; });
    } else {
      const wv = this.panel.webview;
      const roots = wv.options.localResourceRoots || [];
      if (!inRoots(roots, dir)) wv.options = { ...wv.options, localResourceRoots: [...roots, dir] };
      if (column) this.panel.reveal(column, false);
    }
    const name = uri.path.split('/').pop();
    this.uri = uri;
    this.panel.title = 'Paper: ' + name;
    const base = `<base href="${this.panel.webview.asWebviewUri(dir).toString()}/">`;
    const m = /<head[^>]*>/i.exec(text);
    let html = m ? text.slice(0, m.index + m[0].length) + base + text.slice(m.index + m[0].length) : base + text;
    // The same html string would not reload the page; make each set unique.
    html += `\n<!-- paper-md ${Date.now()} -->`;
    this.panel.webview.html = html;
    log(`html ${name}: ${Math.round(text.length / 1024)} KB set in HTML panel${reload ? ' (reload after save)' : ''}, ${Date.now() - t0} ms`);
  }
}

// Mode 1: each .md file in its own tab (custom editor). About 1 s per new tab in Cursor.
class Provider {
  constructor(ctx) { this.ctx = ctx; }

  resolveCustomTextEditor(document, panel) {
    const t0 = Date.now();
    const name = document.uri.path.split('/').pop();
    const opened = openTimes.get(document.uri.toString());
    const wv = panel.webview;
    wv.options = { enableScripts: true, localResourceRoots: rootsFor(this.ctx, document.uri) };

    const first = renderDoc(wv, document);
    const renderMs = Date.now() - t0;
    wv.html = shell(this.ctx, wv, first, { editButton: true });
    const tHtml = Date.now();

    let timer;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      clearTimeout(timer);
      timer = setTimeout(() => wv.postMessage({ type: 'render', html: renderDoc(wv, document) }), 150);
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
        vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      } else if (m.type === 'copyText' && typeof m.text === 'string') {
        vscode.env.clipboard.writeText(m.text);
      } else if (m.type === 'link' && typeof m.href === 'string') {
        openLink(m.href, document, VIEW_TYPE);
      }
    });
  }
}

// Mode 2: one panel that follows the active .md text editor. Only the first open
// pays for the webview; later files are a postMessage (tens of ms).
class FollowPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.panel = undefined;
    this.doc = undefined;
    this.current = undefined; // { kind: 'md' | 'tex' | 'pdf' | 'html', uri } of the file now shown
    this.timer = undefined;
    this.userClosed = false;
    this.asText = new Set(); // documents the user chose to read as text
    this.htmlPanel = new HtmlPanel(ctx);
    this.pdfBusy = new Set(); // PDF keys being loaded (re-entry guard)
    this.lastPdf = { key: '', at: 0 }; // duplicate guard for tab events
    this.texSeq = 0; // bumps on every LaTeX render; older results are dropped
    this.rootCache = new Map(); // tex uri -> candidate root paths
    this.texCache = new Map(); // uri -> { text, at } for \input files read from disk
    this.compiler = new tc.Compiler();
    this.compileRoot = undefined; // root Uri of the compiled preview now shown
    this.status = undefined; // status bar item, created on first compile
  }

  // ---- compile mode (real TeX engine, see src/texcompile.js) ----
  compileMode() {
    return this.texMode() && vscode.workspace.getConfiguration('paperMd').get('tex.mode') === 'compile';
  }

  banner(text, level) {
    if (this.panel) this.panel.webview.postMessage({ type: 'banner', text: text || '', level: level || 'error' });
  }

  setStatus(text, tip) {
    if (!vscode.window.createStatusBarItem) return;
    if (!this.status) { this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment ? vscode.StatusBarAlignment.Left : 1, 0); this.status.command = 'paperMd.openTexLog'; }
    this.status.text = text; this.status.tooltip = tip || 'Open the TeX log';
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

  // Post the compiled PDF with a stable key per root, so scroll and zoom survive recompiles.
  postCompiled(rootUri, pdfPath, stale) {
    if (!this.panel) return;
    const fsn = require('fs');
    const data = fsn.readFileSync(pdfPath);
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const name = rootUri.path.split('/').pop().replace(/\.tex$/i, '.pdf');
    this.panel.title = 'Paper: ' + name + ' (compiled)';
    this.panel.webview.postMessage({ type: 'pdf', key: rootUri.toString() + '#compiled', name, data: buf, sent: Date.now() });
    log(`tex compile: showing ${stale ? 'cached ' : ''}${name}, ${Math.round(data.length / 1024)} KB`);
  }

  async showCompiled(document) {
    if (!this.panel) return;
    const uri = document.uri;
    const seq = ++this.texSeq;
    this.doc = document;
    this.current = { kind: 'tex', uri };
    this.ensureRoot(uri);
    const roots = await this.findTexRoots(uri, document.getText());
    if (!this.panel || seq !== this.texSeq) return;
    const rootUri = roots.length ? uri.with({ path: roots[0] }) : uri;
    this.compileRoot = rootUri;
    const pdf = this.rootPdf(rootUri);
    if (require('fs').existsSync(pdf)) {
      this.postCompiled(rootUri, pdf, true);
    } else {
      await this.showTexHtml(document);
      this.banner('Compiling\u2026', 'info');
    }
    this.compileRootNow(rootUri, false);
  }

  // Mirror the root folder, then compile. One run per root; a request during a run reruns once.
  compileRootNow(rootUri, force) {
    const key = rootUri.toString();
    this.setStatus('TeX: compiling\u2026');
    this.compiler.request(key, async () => {
      const cache = this.cacheDir(rootUri);
      const maxMB = vscode.workspace.getConfiguration('paperMd').get('tex.maxMirrorMB') || 200;
      let ex = { base: dirOf(rootUri), relRoot: '', targets: [], warnings: [] };
      try { ex = await tc.findExternal(vscode, rootUri); } catch (e) { log('tex external refs: ' + (e && e.message)); }
      for (const w of ex.warnings) log('tex mirror: ' + w);
      const m = await tc.mirror(vscode, dirOf(rootUri), cache, { maxMB, force, baseUri: ex.base, extra: ex.targets });
      if (m.tooBig) {
        log(`tex mirror: ${m.files} files, ${(m.totalBytes / 1048576).toFixed(1)} MB is over paperMd.tex.maxMirrorMB (${maxMB})`);
        return { ok: false, banner: `The folder of ${rootUri.path.split('/').pop()} holds ${(m.totalBytes / 1048576).toFixed(0)} MB of TeX-related files. This is over paperMd.tex.maxMirrorMB (${maxMB}). Raise the setting or move the paper to a smaller folder.` };
      }
      log(`tex mirror base: ${ex.base.path}${ex.relRoot ? ' (root folder at ' + ex.relRoot + ')' : ''}${m.extFolders && m.extFolders.length ? '; external folders: ' + m.extFolders.join(', ') : ''}${ex.targets.length ? '; ' + ex.targets.length + ' external refs' : ''}`);
      log(`tex mirror: ${m.scanned} scanned, ${m.files} kept, ${m.copied} copied (${(m.bytes / 1048576).toFixed(2)} MB), ${m.removed} removed, ${m.ms} ms`);
      const rootFile = require('path').join(cache, 'src', ex.relRoot, rootUri.path.split('/').pop());
      const texPath = vscode.workspace.getConfiguration('paperMd').get('tex.texPath');
      const res = await tc.compile(rootFile, cache, { texPath, force, timeoutMs: this.compileTimeoutMs });
      res.rootUri = rootUri;
      return res;
    }, (res, again) => {
      const name = rootUri.path.split('/').pop();
      if (res.ok) {
        let kb = 0;
        try { kb = Math.round(require('fs').statSync(res.pdf).size / 1024); } catch (e) { /* ignore */ }
        log(`tex compile ${name}: ok, ${res.engine}, ${res.ms} ms, PDF ${kb} KB`);
        if (!again) this.setStatus(`TeX: ok ${(res.ms / 1000).toFixed(1)} s`);
        if (this.compileRoot && this.compileRoot.toString() === key && this.current && this.current.kind === 'tex') {
          this.postCompiled(rootUri, res.pdf, false);
          this.banner('');
        }
      } else {
        log(`tex compile ${name}: failed${res.engine ? ' (' + res.engine + ')' : ''}, ${res.ms || 0} ms. ${String(res.banner || '').split('\n')[0]}${res.logPath ? ' Log: ' + res.logPath : ''}`);
        if (!again) this.setStatus('TeX: error');
        if (this.compileRoot && this.compileRoot.toString() === key) this.banner(res.banner, 'error');
      }
      this.lastLog = res.logPath || this.lastLog;
    });
  }

  // A .tex/.sty/.cls/.bib file was saved: recompile the root whose folder tree holds it.
  async compileOnSave(d) {
    if (!this.compileMode() || !/\.(tex|sty|cls|bib)$/i.test(d.uri.path)) return;
    let root = this.compileRoot;
    if (!root || !inRoots([dirOf(root)], d.uri)) {
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
    const panel = vscode.window.createWebviewPanel(FOLLOW_TYPE, 'Paper MD',
      { viewColumn: replace && column ? column : vscode.ViewColumn.Beside, preserveFocus: !replace },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true,
        localResourceRoots: rootsFor(this.ctx, extraUri || (document && document.uri)) });
    this.panel = panel;
    this.doc = document;
    const tex = !!document && isTex(document.uri);
    this.current = document ? { kind: tex ? 'tex' : 'md', uri: document.uri } : undefined;
    const wv = panel.webview;
    const body = !document ? '<p>Open a Markdown file to show it here.</p>' : tex ? '<p class="tex-note">Rendering LaTeX...</p>' : renderDoc(wv, document);
    if (document) panel.title = 'Paper: ' + document.uri.path.split('/').pop();
    wv.html = shell(this.ctx, wv, body, { editButton: replace, key: document ? document.uri.toString() : '' });
    if (tex) this.showTex(document);

    wv.onDidReceiveMessage((m) => {
      if (m.type === 'timing' && m.t) {
        log(`panel created: DOM ready ${m.t.dom - t0} ms, first paint ${m.t.paint - t0} ms (one-time cost)`);
      } else if (m.type === 'rendered') {
        log(`panel switch ${this.doc ? this.doc.uri.path.split('/').pop() : ''}: shown ${m.at - m.sent} ms after send (render ${this.lastRenderMs} ms)`);
      } else if (m.type === 'pdfShown') {
        log(`pdf ${m.name || ''}: first page shown ${m.at - m.sent} ms after send (${m.pages} pages)`);
      } else if (m.type === 'pdfError') {
        log(`pdf error: ${m.message}`);
      } else if (m.type === 'htmlShown') {
        log(`html ${m.name || ''}: iframe loaded ${m.at - m.sent} ms after send`);
      } else if (m.type === 'edit' && this.current) {
        // Read this file as text: stop replacing its text tab until it is closed.
        const uri = this.current.uri;
        this.asText.add(uri.toString());
        vscode.window.showTextDocument(uri, { viewColumn: this.panel.viewColumn, preview: false });
      } else if (m.type === 'copyText' && typeof m.text === 'string') {
        vscode.env.clipboard.writeText(m.text);
      } else if (m.type === 'link' && typeof m.href === 'string' && this.doc) {
        openLink(m.href, this.doc, 'default');
      }
    });
    panel.onDidDispose(() => {
      clearTimeout(this.timer);
      this.panel = undefined;
      this.doc = undefined;
      this.current = undefined;
      // In replace mode, closing the panel is like closing a file; keep auto-open on.
      this.userClosed = !this.replaceMode();
    });
  }

  // Close the text tabs of `uri` so the panel is the only view of the file.
  closeTextTabs(uri) {
    const key = uri.toString();
    const tabs = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const tab of g.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key) tabs.push(tab);
      }
    }
    if (tabs.length) vscode.window.tabGroups.close(tabs, true);
  }

  // Image or page folder outside the allowed roots: widen the roots so files load.
  ensureRoot(uri) {
    const wv = this.panel.webview;
    const roots = wv.options.localResourceRoots || [];
    if (!inRoots(roots, dirOf(uri))) wv.options = { ...wv.options, localResourceRoots: [...roots, dirOf(uri)] };
  }

  show(document) {
    if (!this.panel) return;
    const wv = this.panel.webview;
    this.ensureRoot(document.uri);
    this.doc = document;
    this.current = { kind: 'md', uri: document.uri };
    this.panel.title = 'Paper: ' + document.uri.path.split('/').pop();
    this.banner('');
    this.hideStatus();
    const t = Date.now();
    const html = renderDoc(wv, document);
    this.lastRenderMs = Date.now() - t;
    wv.postMessage({ type: 'render', key: document.uri.toString(), html, sent: Date.now() });
  }

  showDoc(document) {
    if (isTex(document.uri)) this.showTex(document); else this.show(document);
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
  async showTexHtml(document) {
    if (!this.panel) return;
    const uri = document.uri;
    const key = uri.toString();
    const name = uri.path.split('/').pop();
    this.ensureRoot(uri);
    this.doc = document;
    this.current = { kind: 'tex', uri };
    this.panel.title = 'Paper: ' + name;
    const seq = ++this.texSeq;
    const t0 = Date.now();
    const wv = this.panel.webview;
    const listings = new Map(); // folder -> Set of names, one directory read per folder
    const text = document.getText();
    // A section file is shown with the context of its root document (macros, numbers, paths).
    const roots = await this.findTexRoots(uri, text);
    const build = async (rootPath, preambleOnly) => {
      const rootUri = rootPath ? uri.with({ path: rootPath }) : uri;
      const dir = dirOf(rootUri);
      const rel = (p) => (p.startsWith('/') ? uri.with({ path: p }) : vscode.Uri.joinPath(dir, p));
      this.ensureRoot(rootUri);
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
          return listings.get(fk).has(full.path.split('/').pop());
        },
        resolveImage: (p) => {
          try { const u = rel(p); this.ensureRoot(u); return wv.asWebviewUri(u).toString(); } catch (e) { return null; }
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
      result = { html: '<pre>Render error: ' + esc(String(e && e.message)) + '</pre>', stats: { inputs: 0 } };
    }
    if (!result) result = { html: '<pre>Render error</pre>', stats: { inputs: 0 } };
    if (!this.panel || seq !== this.texSeq || !this.current || this.current.kind !== 'tex' || this.current.uri.toString() !== key) return; // stale
    this.lastRenderMs = Date.now() - t0;
    wv.postMessage({ type: 'render', key, html: result.html, sent: Date.now() });
    log(`tex ${name}: ${Math.round(text.length / 1024)} KB, ${result.stats.inputs || 0} inputs, render ${this.lastRenderMs} ms`);
  }

  pdfMode() {
    const c = vscode.workspace.getConfiguration('paperMd');
    return !!c.get('pdf.enabled') && !!c.get('followPanel.replaceTextTab');
  }

  // Show a PDF in the follow panel, then close its placeholder tab.
  async showPdf(uri, column) {
    const key = uri.toString();
    const now = Date.now();
    if (this.pdfBusy.has(key) || (this.lastPdf.key === key && now - this.lastPdf.at < 1500)) return;
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
      const t0 = Date.now();
      const data = await vscode.workspace.fs.readFile(uri);
      const readMs = Date.now() - t0;
      if (!this.panel) return; // panel closed while reading
      log(`pdf ${name}: ${Math.round(data.byteLength / 1024)} KB, read ${readMs} ms`);
      this.banner('');
      this.lastPdf = { key, at: Date.now() };
      this.doc = undefined;
      this.current = { kind: 'pdf', uri };
      this.panel.title = 'Paper: ' + name;
      this.panel.reveal(column || this.panel.viewColumn, false);
      // Send a plain ArrayBuffer: a Node Buffer can arrive in the webview as a plain object.
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      this.panel.webview.postMessage({ type: 'pdf', key, name, data: buf, sent: Date.now() });
      this.closeTextTabs(uri);
    } catch (e) {
      log(`pdf ${name}: failed: ${e && e.message}`);
    } finally {
      this.pdfBusy.delete(key);
    }
  }

  htmlMode() {
    const c = vscode.workspace.getConfiguration('paperMd');
    return !!c.get('html.enabled') && !!c.get('followPanel.replaceTextTab');
  }

  // Show an HTML file in the panel's sandboxed iframe. The iframe loads the file from disk.
  showHtml(uri, reload) {
    if (!this.panel) return;
    this.ensureRoot(uri);
    const name = uri.path.split('/').pop();
    this.doc = undefined;
    this.banner('');
    this.current = { kind: 'html', uri };
    this.panel.title = 'Paper: ' + name;
    // Add a cache-busting query only on reload after a save, so the first open uses the plain resource URL.
    const src = this.panel.webview.asWebviewUri(uri).toString() + (reload ? '?v=' + Date.now() : '');
    this.panel.webview.postMessage({ type: 'html', key: uri.toString(), name, src, sent: Date.now() });
    log(`html ${name}: shown in panel`);
  }

  onDocSave(d) {
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
    if (tab && tab.input instanceof vscode.TabInputText && isPdf(tab.input.uri)) {
      this.showPdf(tab.input.uri, g.viewColumn);
    }
  }

  onEditorChange(editor) {
    if (!editor) return;
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
      if (!this.doc || this.doc.uri.toString() !== doc.uri.toString()) this.showDoc(doc);
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

  onDocClose(d) { this.asText.delete(d.uri.toString()); }

  onDocChange(e) {
    if (!this.panel || !this.doc || e.document.uri.toString() !== this.doc.uri.toString()) return;
    if (isTex(e.document.uri) && this.compileMode()) return; // the PDF updates on save
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.showDoc(e.document), isTex(e.document.uri) ? 300 : 150);
  }
}

function activate(ctx) {
  const ta = Date.now();
  const follow = new FollowPanel(ctx);
  const activeMd = () => {
    const ed = vscode.window.activeTextEditor;
    return ed && (isMd(ed.document.uri) || (isTex(ed.document.uri) && follow.texMode())) ? ed.document : undefined;
  };
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (isMd(d.uri)) openTimes.set(d.uri.toString(), Date.now());
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.onDidChangeActiveTextEditor((ed) => follow.onEditorChange(ed)),
    vscode.workspace.onDidChangeTextDocument((e) => follow.onDocChange(e)),
    vscode.workspace.onDidCloseTextDocument((d) => follow.onDocClose(d)),
    vscode.workspace.onDidSaveTextDocument((d) => follow.onDocSave(d)),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) if (tab.input instanceof vscode.TabInputText) follow.onDocClose(tab.input);
      follow.checkTabs();
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => follow.checkTabs()),
    vscode.commands.registerCommand('paperMd.openFollowPanel', () => follow.open(activeMd(), true)),
    vscode.commands.registerCommand('paperMd.recompileTex', async () => {
      const ed = vscode.window.activeTextEditor;
      let root = follow.compileRoot;
      if (ed && isTex(ed.document.uri)) {
        const roots = await follow.findTexRoots(ed.document.uri, ed.document.getText());
        root = roots.length ? ed.document.uri.with({ path: roots[0] }) : ed.document.uri;
      }
      if (!root) { vscode.window.showInformationMessage('Paper MD: open a .tex file first.'); return; }
      if (follow.compileRoot && follow.compileRoot.toString() !== root.toString()) follow.compileRoot = root;
      follow.compileRootNow(root, true);
    }),
    vscode.commands.registerCommand('paperMd.openTexLog', () => {
      const p = follow.lastLog || (follow.compileRoot && require('path').join(follow.cacheDir(follow.compileRoot), 'out', follow.compileRoot.path.split('/').pop().replace(/\.tex$/i, '.log')));
      if (p && require('fs').existsSync(p)) vscode.window.showTextDocument(vscode.Uri.file(p), { preview: true });
      else { log('tex log: none yet'); if (channel) channel.show(true); }
    }),
    vscode.commands.registerCommand('paperMd.openAsText', (arg) => {
      const h = follow.htmlPanel;
      let uri = arg instanceof vscode.Uri ? arg : undefined;
      let col;
      // Panels first: activeTextEditor can be stale while a webview has focus.
      if (!uri && follow.panel && follow.panel.active && follow.current && follow.current.kind !== 'pdf') {
        uri = follow.current.uri; col = follow.panel.viewColumn;
      } else if (!uri && h.panel && h.panel.active && h.uri) {
        uri = h.uri; col = h.panel.viewColumn;
      }
      if (!uri) {
        const ed = vscode.window.activeTextEditor;
        uri = ed && ed.document.uri;
      }
      log(`openAsText: ${uri ? uri.toString() : 'no target'}`);
      if (!uri) { vscode.window.showInformationMessage('Paper MD: no text file to edit here (a plain PDF has no text source).'); return; }
      follow.asText.add(uri.toString());
      vscode.window.showTextDocument(uri, { viewColumn: col, preview: false });
    }),
    // From a .md/.tex/.html text tab (title-bar preview button): back to the rendered view.
    vscode.commands.registerCommand('paperMd.showPaper', (uri) => {
      const ed = vscode.window.activeTextEditor;
      const doc = ed && (!uri || ed.document.uri.toString() === uri.toString()) ? ed.document : undefined;
      if (!doc) return;
      follow.asText.delete(doc.uri.toString());
      follow.userClosed = false;
      follow.onEditorChange(ed);
    }),
  );
  // A Markdown text editor may already be active when the extension starts.
  follow.onEditorChange(vscode.window.activeTextEditor);
  follow.checkTabs();
  log(`activated in ${Date.now() - ta} ms`);
}
function deactivate() {}
module.exports = { activate, deactivate };
