'use strict';
const vscode = require('vscode');
const { createRenderer } = require('./src/render');

const VIEW_TYPE = 'paperMd.viewer';

function nonce() {
  let s = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

class Provider {
  constructor(ctx) { this.ctx = ctx; }

  resolveCustomTextEditor(document, panel) {
    const t0 = Date.now();
    const name = document.uri.path.split('/').pop();
    const opened = openTimes.get(document.uri.toString());
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [media, docDir, ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri)];
    const wv = panel.webview;
    wv.options = { enableScripts: true, localResourceRoots: roots };

    const render = createRenderer({
      resolveImage: (src) => {
        try {
          const clean = decodeURIComponent(src.split(/[?#]/)[0]);
          const uri = clean.startsWith('/') ? document.uri.with({ path: clean }) : vscode.Uri.joinPath(docDir, clean);
          return wv.asWebviewUri(uri).toString();
        } catch (e) { return null; }
      },
    });
    const html = () => {
      try { return render(document.getText()); }
      catch (e) { return '<pre>Render error: ' + esc(String(e && e.message)) + '</pre>'; }
    };

    const tr0 = Date.now();
    const first = html();
    const renderMs = Date.now() - tr0;
    const n = nonce();
    const css = wv.asWebviewUri(vscode.Uri.joinPath(media, 'paper.css'));
    const kcss = wv.asWebviewUri(vscode.Uri.joinPath(media, 'katex.css'));
    const js = wv.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    const custom = vscode.workspace.getConfiguration('paperMd').get('customCss') || '';
    wv.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource} https: data:; style-src ${wv.cspSource} 'unsafe-inline'; font-src ${wv.cspSource}; script-src 'nonce-${n}';">
<link rel="stylesheet" href="${kcss}"><link rel="stylesheet" href="${css}">
<style>${custom.replace(/<\/style/gi, '')}</style></head>
<body><button id="edit-btn">Edit as text</button><div id="content">${first}</div>
<script nonce="${n}" src="${js}"></script></body></html>`;

    let timer;
    const subs = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(timer);
        timer = setTimeout(() => wv.postMessage({ type: 'render', html: html() }), 150);
      }),
    ];
    panel.onDidDispose(() => { clearTimeout(timer); subs.forEach((s) => s.dispose()); });

    const tHtml = Date.now();
    wv.onDidReceiveMessage((m) => {
      if (m.type === 'timing' && m.t) {
        const r = (x) => (x ? (x - t0) + ' ms' : 'n/a');
        log(`${name} (${document.getText().length} chars): ` +
          (opened ? `text doc opened ${t0 - opened} ms before viewer start; ` : '') +
          `render ${renderMs} ms, html set ${r(tHtml)}, webview created ${r(Math.round(m.t.origin))}, ` +
          `DOM ready ${r(m.t.dom)}, page loaded ${r(m.t.load)}, first paint ${r(m.t.paint)} (all from viewer start)`);
        return;
      }
      if (m.type === 'edit') {
        vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      } else if (m.type === 'link' && typeof m.href === 'string') {
        const href = m.href;
        if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
          vscode.env.openExternal(vscode.Uri.parse(href));
        } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          const [p, frag] = href.split('#');
          let target;
          try { target = p.startsWith('/') ? document.uri.with({ path: decodeURIComponent(p) }) : vscode.Uri.joinPath(docDir, decodeURIComponent(p)); }
          catch (e) { return; }
          const isMd = /\.(md|markdown)$/i.test(target.path);
          vscode.commands.executeCommand('vscode.openWith', target, isMd ? VIEW_TYPE : 'default');
        }
      }
    });
  }
}

let channel;
const openTimes = new Map();
function log(msg) {
  if (!channel) channel = vscode.window.createOutputChannel('Paper MD');
  channel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function activate(ctx) {
  const ta = Date.now();
  ctx.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (/\.(md|markdown)$/i.test(d.uri.path)) openTimes.set(d.uri.toString(), Date.now());
    }),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new Provider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('paperMd.openAsText', (uri) => {
      uri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri)
        || (vscode.window.tabGroups.activeTabGroup.activeTab && vscode.window.tabGroups.activeTabGroup.activeTab.input && vscode.window.tabGroups.activeTabGroup.activeTab.input.uri);
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
  );
  log(`activated in ${Date.now() - ta} ms (module load before this is not counted)`);
}
function deactivate() {}
module.exports = { activate, deactivate };
