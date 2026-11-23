'use strict';
const vscode = require('vscode');
const { createRenderer } = require('./src/render');

const VIEW_TYPE = 'paperMd.viewer';
const FOLLOW_TYPE = 'paperMd.follow';
const isMd = (uri) => /\.(md|markdown)$/i.test(uri.path);
const isPdf = (uri) => /\.pdf$/i.test(uri.path);
const isHtml = (uri) => /\.html?$/i.test(uri.path);

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
    this.current = undefined; // { kind: 'md' | 'pdf' | 'html', uri } of the file now shown
    this.timer = undefined;
    this.userClosed = false;
    this.asText = new Set(); // documents the user chose to read as text
    this.htmlPanel = new HtmlPanel(ctx);
    this.pdfBusy = new Set(); // PDF keys being loaded (re-entry guard)
    this.lastPdf = { key: '', at: 0 }; // duplicate guard for tab events
  }

  replaceMode() {
    return vscode.workspace.getConfiguration('paperMd').get('followPanel.replaceTextTab');
  }

  open(document, reveal, column, extraUri) {
    if (this.panel) {
      if (reveal) this.panel.reveal(column, !this.replaceMode());
      if (document) this.show(document);
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
    this.current = document ? { kind: 'md', uri: document.uri } : undefined;
    const wv = panel.webview;
    const body = document ? renderDoc(wv, document) : '<p>Open a Markdown file to show it here.</p>';
    if (document) panel.title = 'Paper: ' + document.uri.path.split('/').pop();
    wv.html = shell(this.ctx, wv, body, { editButton: replace, key: document ? document.uri.toString() : '' });

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
    const t = Date.now();
    const html = renderDoc(wv, document);
    this.lastRenderMs = Date.now() - t;
    wv.postMessage({ type: 'render', key: document.uri.toString(), html, sent: Date.now() });
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
    this.current = { kind: 'html', uri };
    this.panel.title = 'Paper: ' + name;
    // Add a cache-busting query only on reload after a save, so the first open uses the plain resource URL.
    const src = this.panel.webview.asWebviewUri(uri).toString() + (reload ? '?v=' + Date.now() : '');
    this.panel.webview.postMessage({ type: 'html', key: uri.toString(), name, src, sent: Date.now() });
    log(`html ${name}: shown in panel`);
  }

  onDocSave(d) {
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
    if (html ? !this.htmlMode() : !isMd(editor.document.uri)) return;
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
      if (!this.doc || this.doc.uri.toString() !== doc.uri.toString()) this.show(doc);
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
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(e.document), 150);
  }
}

function activate(ctx) {
  const ta = Date.now();
  const follow = new FollowPanel(ctx);
  const activeMd = () => {
    const ed = vscode.window.activeTextEditor;
    return ed && isMd(ed.document.uri) ? ed.document : undefined;
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
    vscode.commands.registerCommand('paperMd.openAsText', (uri) => {
      uri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
        || (vscode.window.tabGroups.activeTabGroup.activeTab && vscode.window.tabGroups.activeTabGroup.activeTab.input && vscode.window.tabGroups.activeTabGroup.activeTab.input.uri);
      // From the HTML panel: open its page as text and keep it as text.
      const h = follow.htmlPanel;
      if (!uri && h.panel && h.panel.active && h.uri) { uri = h.uri; follow.asText.add(uri.toString()); }
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
  );
  // A Markdown text editor may already be active when the extension starts.
  follow.onEditorChange(vscode.window.activeTextEditor);
  follow.checkTabs();
  log(`activated in ${Date.now() - ta} ms`);
}
function deactivate() {}
module.exports = { activate, deactivate };
