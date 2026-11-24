'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../src/util');
const strings = require('../src/strings');

test('isRealScheme accepts file systems only', () => {
  for (const s of ['file', 'vscode-remote', 'vscode-vfs']) assert.ok(u.isRealScheme(s));
  for (const s of ['git', 'gitlens', 'vscode-userdata', 'untitled', 'scm', 'output']) assert.ok(!u.isRealScheme(s));
});

test('nonce is random base64 of 16 bytes', () => {
  const a = u.makeNonce(), b = u.makeNonce();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, 16);
});

test('stripStyleEnd loops until no end tag is left', () => {
  assert.equal(u.stripStyleEnd('a</style>b'), 'a>b');
  assert.ok(!/<\/style/i.test(u.stripStyleEnd('<<\/style/style>x')));
  assert.ok(!/<\/style/i.test(u.stripStyleEnd('<</STYLE/style/style>')));
  assert.ok(!/<\/script/i.test(u.stripScriptEnd('<</script/script>')));
});

test('shell CSP: form-action, base-uri, remote images switch', () => {
  const on = u.shellCsp({ cspSource: 'vsc:', nonce: 'N', allowRemoteImages: true });
  assert.match(on, /form-action 'none'/);
  assert.match(on, /base-uri 'none'/);
  assert.match(on, /img-src vsc: https: data: blob:/);
  assert.match(on, /'nonce-N'/);
  const off = u.shellCsp({ cspSource: 'vsc:', nonce: 'N', allowRemoteImages: false });
  assert.doesNotMatch(off.split('img-src')[1].split(';')[0], /https:/);
  assert.match(u.shellCsp({ cspSource: 'vsc:', nonce: 'N' }), /img-src vsc: https:/); // default on
});

test('html page CSP blocks network but allows own resources', () => {
  const c = u.htmlPageCsp('vsc:');
  assert.match(c, /connect-src 'none'/);
  assert.match(c, /form-action 'none'/);
  assert.match(c, /frame-src 'none'/);
  assert.match(c, /default-src 'unsafe-inline' 'unsafe-eval' vsc: data: blob: https:/);
});

test('injectIntoHead: head with attributes, not <header>', () => {
  assert.equal(u.injectIntoHead('<html><head lang="x"><title>t</title></head>', 'X'), '<html><head lang="x">X<title>t</title></head>');
  const r = u.injectIntoHead('<html><body><header>h</header></body></html>', 'X');
  assert.equal(r, '<html>X<body><header>h</header></body></html>');
});

test('injectIntoHead: no head goes after <html>, else after doctype, never before it', () => {
  assert.equal(u.injectIntoHead('<!DOCTYPE html><html lang="en"><body>b', 'X'), '<!DOCTYPE html><html lang="en">X<body>b');
  assert.equal(u.injectIntoHead('<!DOCTYPE html>\n<p>hi', 'X'), '<!DOCTYPE html>X\n<p>hi');
  assert.equal(u.injectIntoHead('<p>hi', 'X'), 'X<p>hi');
});

test('buildHtmlPage puts CSP before base', () => {
  const out = u.buildHtmlPage('<head><script>1</script></head>', { cspSource: 'vsc:', baseHref: 'https://x/a"b/' });
  assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<base'));
  assert.ok(out.indexOf('<base') < out.indexOf('<script>'));
  assert.match(out, /<base href="https:\/\/x\/a&quot;b\/">/);
});

const U = (path, scheme = 'file', authority = '') => ({ scheme, authority, path });

test('inRoots respects scheme, authority and path boundary', () => {
  const roots = [U('/w/proj')];
  assert.ok(u.inRoots(roots, U('/w/proj')));
  assert.ok(u.inRoots(roots, U('/w/proj/a/b.png')));
  assert.ok(!u.inRoots(roots, U('/w/proj2/a.png')));
  assert.ok(!u.inRoots(roots, U('/w/proj/a.png', 'vscode-remote', 'ssh')));
  assert.ok(!u.inRoots(roots, U('/etc/passwd')));
  assert.ok(u.inRoots([U('/')], U('/x')));
});

test('mirrorHit: root dir, base, tree and file targets', () => {
  const e = { rootDir: U('/p/paper'), base: U('/p'), targets: [{ kind: 'tree', path: '/q/figs' }, { kind: 'file', path: '/r/my.sty' }] };
  assert.ok(u.mirrorHit(e, U('/p/paper/a.tex')));
  assert.ok(u.mirrorHit(e, U('/p/shared/b.bib')));
  assert.ok(u.mirrorHit(e, U('/q/figs/x.tex')));
  assert.ok(u.mirrorHit(e, U('/r/my.sty')));
  assert.ok(!u.mirrorHit(e, U('/r/other.sty')));
  assert.ok(!u.mirrorHit(e, U('/p/a.tex', 'vscode-remote')));
  assert.ok(!u.mirrorHit(undefined, U('/p/a.tex')));
});

test('uniqueBy keeps first', () => {
  assert.deepEqual(u.uniqueBy([{ k: 1 }, { k: 2 }, { k: 1, z: 1 }], (x) => x.k), [{ k: 1 }, { k: 2 }]);
});

test('save guard is per uri and pdf is never guarded', () => {
  const saves = new Map([['a', 1000]]);
  assert.ok(u.recentlySaved(saves, 'a', 3000, 'html'));
  assert.ok(!u.recentlySaved(saves, 'b', 3000, 'html')); // other file saved: not guarded
  assert.ok(!u.recentlySaved(saves, 'a', 6001, 'html'));
  assert.ok(!u.recentlySaved(saves, 'a', 3000, 'pdf'));
  u.pruneSaves(saves, 7000);
  assert.equal(saves.size, 0);
});

test('size cap and tab lookup', () => {
  assert.ok(!u.tooBigToPost(200 * 1024 * 1024));
  assert.ok(u.tooBigToPost(200 * 1024 * 1024 + 1));
  assert.ok(u.hasTabFor(['x', 'y'], 'y'));
  assert.ok(!u.hasTabFor([], 'y'));
});

test('addPdfAssociation keeps other keys (object and array form)', () => {
  assert.deepEqual(u.addPdfAssociation({ '*.png': 'x' }), { '*.png': 'x', '*.pdf': 'default' });
  assert.deepEqual(u.addPdfAssociation(undefined), { '*.pdf': 'default' });
  assert.deepEqual(u.addPdfAssociation([{ viewType: 'v', filenamePattern: '*.md' }]), [{ viewType: 'v', filenamePattern: '*.md' }, { viewType: 'default', filenamePattern: '*.pdf' }]);
  assert.deepEqual(u.addPdfAssociation([{ viewType: 'pdf.preview', filenamePattern: '*.pdf' }]), [{ viewType: 'default', filenamePattern: '*.pdf' }]);
});

test('restorePdfAssociation undoes only the pdf key', () => {
  assert.deepEqual(u.restorePdfAssociation({ '*.png': 'x', '*.pdf': 'default' }, { '*.png': 'x' }), { '*.png': 'x' });
  assert.equal(u.restorePdfAssociation({ '*.pdf': 'default' }, undefined), undefined);
  assert.deepEqual(u.restorePdfAssociation({ '*.pdf': 'default', '*.a': 'b' }, { '*.pdf': 'pdf.preview' }), { '*.pdf': 'pdf.preview', '*.a': 'b' });
  assert.deepEqual(u.restorePdfAssociation([{ viewType: 'default', filenamePattern: '*.pdf' }, { viewType: 'v', filenamePattern: '*.md' }], undefined), [{ viewType: 'v', filenamePattern: '*.md' }]);
});

test('strings module is a plain object of strings and functions', () => {
  assert.equal(typeof strings.htmlRestricted, 'string');
  assert.match(strings.pdfTooBig('a.pdf', 300, 200), /300 MB/);
});

test('migrateAssociations renames the old custom-editor ID (object and array forms)', () => {
  const o = u.migrateAssociations({ '*.md': 'paperMd.viewer', '*.pdf': 'default' });
  assert.deepEqual(o, { value: { '*.md': 'fastDocViewer.viewer', '*.pdf': 'default' }, changed: true });
  const a = u.migrateAssociations([{ viewType: 'paperMd.viewer', filenamePattern: '*.md' }, { viewType: 'default', filenamePattern: '*.pdf' }]);
  assert.equal(a.changed, true); assert.equal(a.value[0].viewType, 'fastDocViewer.viewer'); assert.equal(a.value[1].viewType, 'default');
  const same = { '*.pdf': 'default' };
  assert.deepEqual(u.migrateAssociations(same), { value: same, changed: false });
  assert.deepEqual(u.migrateAssociations(undefined), { value: undefined, changed: false });
});

test('migration covers every setting declared in package.json', () => {
  const props = Object.keys(require('../package.json').contributes.configuration.properties).map((k) => k.replace(/^fastDocViewer\./, ''));
  assert.deepEqual([...u.SETTING_SUFFIXES].sort(), props.sort());
});
