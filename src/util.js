'use strict';
// Pure helpers for extension.js (no `vscode` import, so they can be unit tested).
const crypto = require('crypto');

// Only real file-system schemes are handled; git, diff, scm, untitled and userdata editors are left alone.
const REAL_SCHEMES = new Set(['file', 'vscode-remote', 'vscode-vfs']);
const isRealScheme = (scheme) => REAL_SCHEMES.has(scheme);

const makeNonce = () => crypto.randomBytes(16).toString('base64');
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Remove every `</tag` until none is left, so `<</style/style>` cannot re-form one.
function stripEndTag(s, tag) {
  const re = new RegExp('</' + tag, 'gi');
  let prev;
  do { prev = s; s = s.replace(re, ''); } while (s !== prev);
  return s;
}
const stripStyleEnd = (s) => stripEndTag(String(s), 'style');
const stripScriptEnd = (s) => stripEndTag(String(s), 'script');

// CSP of the rendered-page shell (Markdown, TeX, PDF viewer).
function shellCsp({ cspSource, nonce, allowRemoteImages }) {
  const img = `${cspSource} ${allowRemoteImages === false ? '' : 'https: '}data: blob:`;
  return `default-src 'none'; img-src ${img}; style-src ${cspSource} 'unsafe-inline'; frame-src ${cspSource}; font-src ${cspSource}; ` +
    `script-src 'nonce-${nonce}' ${cspSource}; worker-src blob:; connect-src ${cspSource}; form-action 'none'; base-uri 'none';`;
}

// CSP injected into a user's HTML page: its own scripts, styles and images still run, but
// fetch, XHR, websockets, forms and frames are blocked so it cannot send data out.
function htmlPageCsp(cspSource) {
  const src = `'unsafe-inline' 'unsafe-eval' ${cspSource} data: blob: https:`;
  return `default-src ${src}; connect-src 'none'; form-action 'none'; frame-src 'none';`;
}

// Insert `inject` right after <head ...>; else after <html ...>; else after the doctype; else first.
function injectIntoHead(text, inject) {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(text);
    if (m) { const at = m.index + m[0].length; return text.slice(0, at) + inject + text.slice(at); }
  }
  return inject + text;
}

function buildHtmlPage(text, { cspSource, baseHref }) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="${htmlPageCsp(cspSource)}">`;
  return injectIntoHead(text, csp + `<base href="${escHtml(baseHref)}">`);
}

// ---- roots ----
const pathUnder = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
const sameAuthority = (r, u) => r.scheme === u.scheme && r.authority === u.authority;
const inRoots = (roots, uri) => roots.some((r) => sameAuthority(r, uri) && pathUnder(uri.path, r.path));

// Unique roots by key (first wins).
function uniqueBy(list, keyFn) {
  const seen = new Set();
  return list.filter((x) => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Does a saved uri belong to a compile mirror? entry: { rootDir, base, targets: [{kind, path}] } (uris are {scheme, authority, path}).
function mirrorHit(entry, uri) {
  if (!entry) return false;
  if (inRoots([entry.rootDir, entry.base].filter(Boolean), uri)) return true;
  return (entry.targets || []).some((t) => (t.kind === 'tree' ? pathUnder(uri.path, t.path) : uri.path === t.path));
}

// ---- state guards ----
const SAVE_WINDOW_MS = 5000;
// True when this very file was saved from an editor in the last 5 s (the save handler reloads it).
function recentlySaved(saves, key, now, kind) {
  if (kind === 'pdf') return false;
  const at = saves.get(key);
  return at !== undefined && now - at < SAVE_WINDOW_MS;
}
function pruneSaves(saves, now) {
  for (const [k, at] of saves) if (now - at >= SAVE_WINDOW_MS) saves.delete(k);
}

const MAX_POST_BYTES = 200 * 1024 * 1024;
const tooBigToPost = (bytes) => bytes > MAX_POST_BYTES;

// Is any open tab showing this uri? tabs: [{ uri }] (already filtered to text tabs).
const hasTabFor = (tabUris, key) => tabUris.some((u) => u === key);

// ---- editorAssociations (object form or the legacy array form) ----
const PDF_GLOB = '*.pdf';
function addPdfAssociation(cur) {
  if (Array.isArray(cur)) {
    if (cur.some((e) => e && e.filenamePattern === PDF_GLOB)) return cur.map((e) => (e && e.filenamePattern === PDF_GLOB ? { ...e, viewType: 'default' } : e));
    return [...cur, { viewType: 'default', filenamePattern: PDF_GLOB }];
  }
  return { ...(cur || {}), [PDF_GLOB]: 'default' };
}
// Put the "*.pdf" entry back as it was (`prev` is the value captured before enabling), leaving other keys alone.
function restorePdfAssociation(cur, prev) {
  if (Array.isArray(cur)) {
    const rest = cur.filter((e) => !(e && e.filenamePattern === PDF_GLOB));
    const was = Array.isArray(prev) ? prev.find((e) => e && e.filenamePattern === PDF_GLOB) : undefined;
    const out = was ? [...rest, was] : rest;
    return out.length ? out : undefined;
  }
  const out = { ...(cur || {}) };
  const had = prev && !Array.isArray(prev) && Object.prototype.hasOwnProperty.call(prev, PDF_GLOB);
  if (had) out[PDF_GLOB] = prev[PDF_GLOB]; else delete out[PDF_GLOB];
  return Object.keys(out).length ? out : undefined;
}

// ---- migration from the old `paperMd.*` IDs (up to 0.8.2) to `fastDocViewer.*` ----
const OLD_PREFIX = 'paperMd';
const NEW_PREFIX = 'fastDocViewer';
const SETTING_SUFFIXES = ['followPanel.autoOpen', 'followPanel.replaceTextTab', 'pdf.enabled', 'html.enabled', 'tex.enabled',
  'tex.mode', 'tex.texPath', 'tex.maxMirrorMB', 'customCss', 'allowRemoteImages', 'theme'];
// Rewrite the custom-editor ID in `workbench.editorAssociations` (object or array form). Returns { value, changed }.
function migrateAssociations(cur) {
  const oldId = OLD_PREFIX + '.viewer', newId = NEW_PREFIX + '.viewer';
  if (Array.isArray(cur)) {
    let changed = false;
    const value = cur.map((e) => { if (e && e.viewType === oldId) { changed = true; return { ...e, viewType: newId }; } return e; });
    return { value: changed ? value : cur, changed };
  }
  if (cur && typeof cur === 'object') {
    let changed = false; const value = {};
    for (const k of Object.keys(cur)) { if (cur[k] === oldId) { value[k] = newId; changed = true; } else value[k] = cur[k]; }
    return { value: changed ? value : cur, changed };
  }
  return { value: cur, changed: false };
}

// Links that may leave a PDF: web and mail only, never code-executing or local schemes.
function isSafeExternalUrl(s) {
  if (typeof s !== 'string' || !s || s.length > 2048) return false;
  if (/[\u0000-\u001f\u007f-\u009f\s]/.test(s)) return false;
  return /^(https?|mailto):/i.test(s);
}

module.exports = {
  isSafeExternalUrl,
  OLD_PREFIX, NEW_PREFIX, SETTING_SUFFIXES, migrateAssociations,
  isRealScheme, makeNonce, escHtml, stripStyleEnd, stripScriptEnd, shellCsp, htmlPageCsp, injectIntoHead, buildHtmlPage,
  pathUnder, inRoots, uniqueBy, mirrorHit, recentlySaved, pruneSaves, SAVE_WINDOW_MS, MAX_POST_BYTES, tooBigToPost, hasTabFor,
  addPdfAssociation, restorePdfAssociation,
};
