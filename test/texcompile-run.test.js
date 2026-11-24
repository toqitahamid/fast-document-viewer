'use strict';
// compile(): command injection, option-like names, killAll, cwd and PATH handling. Uses a fake latexmk (POSIX only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('./helpers/vscode-stub');
install();
const tc = require('../src/texcompile');

const posix = process.platform !== 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-run-'));

// A latexmk stand-in: records cwd and argv to $FDV_REC, writes <outdir>/<jobname or file>.pdf, exits $FDV_EXIT (default 0).
function fakeTex(dir, body) {
  const f = path.join(dir, 'latexmk');
  fs.writeFileSync(f, body || `#!/bin/sh
{ echo "cwd=$(pwd)"; for a in "$@"; do echo "arg=$a"; done; } > "$FDV_REC"
out=""; job=""; last=""
for a in "$@"; do case "$a" in -outdir=*) out="\${a#-outdir=}";; -jobname=*) job="\${a#-jobname=}";; esac; last="$a"; done
if [ -z "$job" ]; then job=$(basename "$last" .tex); fi
echo pdf > "$out/$job.pdf"
exit \${FDV_EXIT:-0}
`);
  fs.chmodSync(f, 0o755);
}
function setup(rootText, name) {
  const d = tmp();
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  fakeTex(bin);
  const cache = path.join(d, 'cache'); const src = path.join(cache, 'src'); fs.mkdirSync(src, { recursive: true });
  const root = path.join(src, name || 'main.tex');
  fs.writeFileSync(root, rootText);
  const rec = path.join(d, 'rec.txt');
  process.env.FDV_REC = rec;
  const argv = () => fs.readFileSync(rec, 'utf8').split('\n').filter((l) => l.startsWith('arg=')).map((l) => l.slice(4));
  return { d, bin, cache, src, root, rec, argv };
}
const clean = (d) => { delete process.env.FDV_REC; delete process.env.FDV_EXIT; fs.rmSync(d, { recursive: true, force: true }); };

test('compile: a def with $(...) is never put on the command line and runs no command', { skip: !posix }, async () => {
  const marker = path.join(tmp(), 'PWNED');
  const t = setup('% !TEX def = \\def\\x{$(touch ' + marker + ')}\n% !TEX def = \\def\\y{`touch ' + marker + '`}\n% !TEX def = \\def\\z{ok}\n\\documentclass{article}\n');
  const r = await tc.compile(t.root, t.cache, { texPath: t.bin });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(marker), false);
  const a = t.argv();
  assert.ok(!a.some((x) => /usepretex|touch|\$\(/.test(x)), a.join(' '));
  assert.ok(a.includes('-jobname=main'));
  assert.equal(a[a.length - 1], './_fdv_main.tex');
  assert.equal(r.pdfPath, path.join(t.cache, 'out', 'main.pdf'));
  assert.ok(fs.existsSync(r.pdfPath)); // jobname keeps the root's PDF name
  const wrapper = fs.readFileSync(path.join(t.src, '_fdv_main.tex'), 'utf8');
  assert.equal(wrapper, '\\def\\z{ok}\n\\input{./main.tex}\n');
  assert.equal(r.warnings.length, 2); // the two unsafe lines were skipped with a warning
  assert.match(r.warnings[0], /Ignored/);
  clean(t.d); fs.rmSync(path.dirname(marker), { recursive: true, force: true });
});

test('compile: def lines must start with a definition command and avoid shell characters', async () => {
  const d = tmp(); const f = path.join(d, 'main.tex');
  const lines = ['\\def\\a{1}', '\\newcommand{\\b}{2}', '\\renewcommand{\\c}{3}', '\\providecommand{\\d}{4}', '\\let\\e\\relax',
    '\\input{/etc/passwd}', '\\def\\q{"}', '\\def\\q{a|b}', '\\def\\q{a;b}', '\\def\\q{a&b}', '\\def\\q{$x$}', '\\def\\q{`x`}', '\\defx{1}'];
  fs.writeFileSync(f, lines.map((l) => '% !TEX def = ' + l).join('\n') + '\n');
  const info = tc.texDefsInfo(f);
  assert.deepEqual(info.lines, lines.slice(0, 5));
  assert.equal(info.rejected.length, lines.length - 5);
  fs.rmSync(d, { recursive: true, force: true });
});

test('compile: without defs the root is compiled directly, as ./name', { skip: !posix }, async () => {
  const t = setup('\\documentclass{article}\n', '-weird.tex');
  const r = await tc.compile(t.root, t.cache, { texPath: t.bin, force: true });
  assert.equal(r.ok, true);
  const a = t.argv();
  assert.equal(a[a.length - 1], './-weird.tex');
  assert.ok(a.includes('-g'));
  assert.ok(!a.includes('-jobname=-weird'));
  assert.ok(!fs.existsSync(path.join(t.src, '_fdv_main.tex')));
  assert.match(t.argv().join('|'), /-outdir=/);
  clean(t.d);
});

test('compile: a name starting with - works together with defs (wrapper input is ./name)', { skip: !posix }, async () => {
  const t = setup('% !TEX def = \\def\\a{1}\n\\documentclass{article}\n', '-x y.tex');
  const r = await tc.compile(t.root, t.cache, { texPath: t.bin });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(t.src, '_fdv_main.tex'), 'utf8'), '\\def\\a{1}\n\\input{"./-x y.tex"}\n');
  assert.ok(fs.existsSync(path.join(t.cache, 'out', '-x y.pdf')));
  clean(t.d);
});

test('compile: a root file name with shell characters is refused', async () => {
  const t = setup('\\documentclass{article}\n', 'a$(x).tex');
  const r = await tc.compile(t.root, t.cache, { texPath: t.bin });
  assert.equal(r.ok, false);
  assert.match(r.banner, /unsafe/);
  clean(t.d);
});

test('compile: missing working folder is reported apart from "TeX not found"', async () => {
  const d = tmp();
  const r = await tc.compile(path.join(d, 'gone', 'main.tex'), path.join(d, 'cache'), { texPath: d });
  assert.equal(r.ok, false);
  assert.match(r.banner, /working folder .* does not exist/);
  assert.doesNotMatch(r.banner, /TeX not found/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('compile: TeX missing from PATH says so', async () => {
  const t = setup('\\documentclass{article}\n');
  const saved = process.env.PATH; process.env.PATH = t.d; // no latexmk in here
  try {
    const r = await tc.compile(t.root, t.cache, { texPath: '/nonexistent-fdv', platform: 'win32' });
    assert.equal(r.ok, false);
    assert.match(r.banner, /TeX not found/);
  } finally { process.env.PATH = saved; clean(t.d); }
});

test('compile: PATH is joined with path.delimiter and a missing texPath falls back to plain PATH', { skip: !posix }, async () => {
  const t = setup('\\documentclass{article}\n');
  const saved = process.env.PATH; process.env.PATH = t.bin + path.delimiter + saved;
  try {
    const r = await tc.compile(t.root, t.cache, { texPath: '/nonexistent-fdv-tex', platform: 'win32' }); // win32: no platform default, so plain PATH
    assert.equal(r.ok, true); // found latexmk through plain PATH
  } finally { process.env.PATH = saved; clean(t.d); }
});

test('killAll kills a running compile and its process group', { skip: !posix }, async () => {
  const t = setup('\\documentclass{article}\n');
  fakeTex(t.bin, '#!/bin/sh\nsleep 30\n');
  const p = tc.compile(t.root, t.cache, { texPath: t.bin, timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tc.killAll(), 1);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.killed, true);
  assert.equal(tc.killAll(), 0);
  clean(t.d);
});

test('compile: timeout kills the process and reports it', { skip: !posix }, async () => {
  const t = setup('\\documentclass{article}\n');
  fakeTex(t.bin, '#!/bin/sh\nsleep 30\n');
  const r = await tc.compile(t.root, t.cache, { texPath: t.bin, timeoutMs: 150 });
  assert.equal(r.timedOut, true);
  clean(t.d);
});
