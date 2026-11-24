'use strict';
// findExternal and mirror over a fake workspace.fs backed by a temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = path.posix;
const tc = require('../src/texcompile');

const posix = process.platform !== 'win32';
const mkUri = (p) => ({ scheme: 'file', path: p, with: (o) => mkUri(o.path), toString: () => 'file://' + p });
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
function vscodeFor() {
  const typeOf = (st) => (st.isSymbolicLink() ? 64 : 0) | (st.isDirectory() ? 2 : st.isFile() ? 1 : 0);
  return {
    FileType,
    Uri: { joinPath: (b, ...parts) => mkUri(P.join(b.path, ...parts)) },
    workspace: { fs: {
      readFile: async (u) => fs.readFileSync(u.path),
      readDirectory: async (u) => fs.readdirSync(u.path).map((n) => [n, typeOf(fs.lstatSync(P.join(u.path, n)))]),
      stat: async (u) => { const l = fs.lstatSync(u.path); const st = l.isSymbolicLink() ? fs.statSync(u.path) : l; return { type: typeOf(l) | (st.isDirectory() ? 2 : st.isFile() ? 1 : 0), size: st.size, mtime: Math.floor(st.mtimeMs) }; },
    } },
  };
}
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-mir-')));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s || 'x'); };

test('findExternal: absolute paths and >4 levels above the root are refused', async () => {
  const d = tmp(); const root = P.join(d, 'a/b/c/d/e/f/g/paper/main.tex');
  write(root, '\\input{/etc/passwd}\\includegraphics{/etc/shadow.png}\\bibliography{../../../../../../../x}\n\\input{../shared/ok}\\usepackage{C:/evil}\n\\lstinputlisting{~/secret.txt}');
  const r = await tc.findExternal(vscodeFor(), mkUri(root));
  const paths = r.targets.map((t) => t.uri.path);
  assert.ok(!paths.some((p) => /etc|evil|secret/.test(p)), paths.join());
  assert.ok(paths.includes(P.join(d, 'a/b/c/d/e/f/g/shared/ok.tex')));
  assert.ok(!paths.some((p) => /\/x\.bib$/.test(p)));
  assert.ok(r.warnings.some((w) => /absolute path/.test(w)));
  assert.ok(r.warnings.some((w) => /more than 4 levels/.test(w)));
  fs.rmSync(d, { recursive: true, force: true });
});

test('mirror: symlinks are never followed, filters apply to file refs, skips are counted', { skip: !posix }, async () => {
  const d = tmp(); const proj = P.join(d, 'proj'); const secret = P.join(d, 'secret');
  write(P.join(proj, 'main.tex'), 'x'); write(P.join(proj, 'refs.bib'), 'x'); write(P.join(proj, 'data.csv'), 'x');
  write(P.join(proj, 'notes.xyz'), 'x'); write(P.join(proj, '.hidden.tex'), 'x'); write(P.join(proj, 'main.aux'), 'x');
  write(P.join(proj, 'big.png'), 'x');
  write(P.join(secret, 'key.tex'), 'TOP SECRET');
  fs.symlinkSync(secret, P.join(proj, 'linkdir')); fs.symlinkSync(P.join(secret, 'key.tex'), P.join(proj, 'link.tex'));
  write(P.join(proj, 'a/b/c/d/e/f/g/h/deep.tex'), 'x');
  write(P.join(proj, 'script.py'), 'x');
  const cache = P.join(d, 'cache');
  const m = await tc.mirror(vscodeFor(), mkUri(proj), cache, { extra: [{ kind: 'file', uri: mkUri(P.join(proj, 'script.py')) }] });
  const kept = fs.readdirSync(P.join(cache, 'src')).sort();
  assert.deepEqual(kept, ['data.csv', 'main.tex', 'refs.bib', 'big.png'].sort());
  assert.ok(!fs.existsSync(P.join(cache, 'src/link.tex')) && !fs.existsSync(P.join(cache, 'src/linkdir')));
  assert.equal(m.skipped.symlink, 2);
  assert.equal(m.skipped.dot, 1);
  assert.equal(m.skipped.ext, 2); // notes.xyz and script.py (reached twice, counted once)
  assert.equal(m.skipped.deep, 1);
  assert.equal(m.skipped.examples.includes('main.aux'), false); // build litter is not reported
  assert.match(tc.skippedNote(m.skipped), /unknown extension/);
  assert.equal(tc.skippedNote({ ext: 0, big: 0, deep: 0, dot: 0, symlink: 0, outside: 0, examples: [] }), '');
  fs.rmSync(d, { recursive: true, force: true });
});

test('mirror: an extra symlinked tree or file is skipped, and files outside the base never get written', { skip: !posix }, async () => {
  const d = tmp(); const proj = P.join(d, 'proj'); const other = P.join(d, 'other');
  write(P.join(proj, 'main.tex'), 'x'); write(P.join(other, 'real.sty'), 'x'); write(P.join(d, 'outside.sty'), 'x');
  fs.symlinkSync(other, P.join(d, 'lnk'));
  const cache = P.join(d, 'cache');
  const m = await tc.mirror(vscodeFor(), mkUri(proj), cache, { baseUri: mkUri(proj), extra: [
    { kind: 'tree', uri: mkUri(P.join(d, 'lnk')) },
    { kind: 'file', uri: mkUri(P.join(d, 'outside.sty')) }, // rel is ../outside.sty
  ] });
  assert.ok(m.skipped.symlink >= 1);
  assert.equal(m.skipped.outside, 1);
  assert.deepEqual(fs.readdirSync(P.join(cache, 'src')), ['main.tex']);
  assert.ok(!fs.existsSync(P.join(cache, 'outside.sty')));
  fs.rmSync(d, { recursive: true, force: true });
});

test('EXTS covers data files and still excludes dotfiles and latexmkrc', () => {
  for (const e of ['csv', 'dat', 'txt', 'json', 'tikz', 'pgf', 'asy', 'mp', 'md']) assert.ok(tc.EXTS.has(e), e);
  assert.ok(!tc.EXTS.has('latexmkrc'));
});

test('compile banner mentions skipped files when the log shows a missing file', async () => {
  const { install } = require('./helpers/vscode-stub'); install();
  if (!posix) return;
  const d = tmp(); const bin = P.join(d, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(P.join(bin, 'latexmk'), "#!/bin/sh\necho \"! LaTeX Error: File 'data.xyz' not found.\"\nexit 12\n", { mode: 0o755 });
  const cache = P.join(d, 'cache'); write(P.join(cache, 'src/main.tex'), '\\documentclass{article}');
  const r = await tc.compile(P.join(cache, 'src/main.tex'), cache, { texPath: bin, skipped: { ext: 1, big: 0, deep: 0, dot: 0, symlink: 0, outside: 0, examples: ['data.xyz'] } });
  assert.equal(r.ok, false);
  assert.match(r.banner, /Not copied to the preview folder: 1 with an unknown extension \(for example data\.xyz\)/);
  fs.rmSync(d, { recursive: true, force: true });
});
