'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install } = require('./helpers/vscode-stub');
install();
const { parseLog, texDefs, detectEngine, cacheDirFor, pool, Compiler } = require('../src/texcompile');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-'));

test('parseLog: null for empty or error-free log', () => {
  assert.equal(parseLog(''), null);
  assert.equal(parseLog('This is pdfTeX\nOutput written.'), null);
});

test('parseLog: \\def\\letterBody style error asks for % !TEX def arguments', () => {
  const log = '! Undefined control sequence.\nl.12 \\letterBody\n                 \n';
  const r = parseLog(log + '! LaTeX Error: please \\def\\letterBody before use\n');
  assert.equal(r.needsArgs, true);
  assert.match(r.banner, /% !TEX def/);
  const r2 = parseLog('! Package foo Error: Please pass the file argument.\nl.3 x\n');
  assert.equal(r2.needsArgs, true);
});

test('parseLog: missing package gives tlmgr hint', () => {
  const r = parseLog("! LaTeX Error: File `algorithm2e.sty' not found.\n\nType X to quit\n");
  assert.equal(r.missing, 'algorithm2e.sty');
  assert.match(r.banner, /tlmgr install algorithm2e/);
});

test('parseLog: missing font, with and without Path=', () => {
  const log = '! Package fontspec Error: The font "Foo Sans" cannot be found.\n';
  assert.match(parseLog(log).banner, /Font "Foo Sans" not found\. Install/);
  assert.match(parseLog(log, { fontPath: true }).banner, /Path= folder exists/);
});

test('parseLog: file:line:error style and plain error', () => {
  const r = parseLog('./main.tex:5: Undefined control sequence.\nl.5 \\zzz\n');
  assert.ok(r.text.startsWith('./main.tex:5:'));
  assert.equal(r.banner, r.text);
});

test('texDefs: joins % !TEX def lines from the first 30 lines only', () => {
  const d = tmp();
  const f = path.join(d, 'main.tex');
  const filler = Array(30).fill('x').join('\n');
  fs.writeFileSync(f, '% !TEX def = \\def\\a{1}\n%!TEX def=\\def\\b{2}\n' + filler + '\n% !TEX def = \\def\\late{3}\n');
  assert.equal(texDefs(f), '\\def\\a{1}\\def\\b{2}');
  assert.equal(texDefs(path.join(d, 'missing.tex')), '');
  fs.rmSync(d, { recursive: true, force: true });
});

test('detectEngine: magic comment, fontspec, luacode, default', () => {
  const d = tmp();
  const w = (n, s) => { const f = path.join(d, n); fs.writeFileSync(f, s); return f; };
  assert.equal(detectEngine(w('a.tex', '% !TEX program = lualatex\n\\documentclass{article}')), 'lualatex');
  assert.equal(detectEngine(w('b.tex', '\\documentclass{article}\\usepackage{fontspec}')), 'xelatex');
  assert.equal(detectEngine(w('c.tex', '\\documentclass{article}\\directlua{}')), 'lualatex');
  assert.equal(detectEngine(w('d.tex', '\\documentclass{article}')), 'pdflatex');
  assert.equal(detectEngine(w('e.tex', '\\documentclass{article}% \\usepackage{fontspec}')), 'pdflatex');
  fs.rmSync(d, { recursive: true, force: true });
});

test('cacheDirFor is stable and distinct per root', () => {
  assert.equal(cacheDirFor('/s', 'file:///a'), cacheDirFor('/s', 'file:///a'));
  assert.notEqual(cacheDirFor('/s', 'file:///a'), cacheDirFor('/s', 'file:///b'));
});

test('pool limits concurrency and visits every item', async () => {
  let live = 0; let max = 0; const seen = [];
  await pool([1, 2, 3, 4, 5, 6], 2, async (x) => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 5)); seen.push(x); live--; });
  assert.equal(max, 2);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6]);
});

test('Compiler: request during a run triggers exactly one rerun', async () => {
  const c = new Compiler();
  let runs = 0; const done = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const finished = new Promise((resolve) => {
    const run = async () => { runs++; if (runs === 1) await gate; return { n: runs }; };
    const onDone = (res, rerun) => { done.push(res.n); if (!rerun) resolve(); };
    assert.equal(c.request('k', run, onDone), true);
    assert.equal(c.request('k', run, onDone), false);
    assert.equal(c.request('k', run, onDone), false);
    release();
  });
  await finished;
  assert.equal(runs, 2);
  assert.deepEqual(done, [1, 2]);
});
