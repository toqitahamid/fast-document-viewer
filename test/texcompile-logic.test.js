'use strict';
// parseLog, detectEngine, platform defaults and Compiler queue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tc = require('../src/texcompile');

test('parseLog: Runaway definition or other \\def errors do not ask for arguments', () => {
  const r = tc.parseLog('! Paragraph ended before \\def was complete.\n<to be read again>\n   \\par\nl.3 \\def\\foo{\n');
  assert.ok(!r.needsArgs);
  const r2 = tc.parseLog('Runaway definition?\n->\\def\\x\n! File ended while scanning definition of \\x.\n');
  assert.ok(!r2.needsArgs);
  const r3 = tc.parseLog('! LaTeX Error: Command \\def\\q already defined.\nl.1 x\n');
  assert.ok(!r3.needsArgs);
  assert.equal(r.banner, r.text);
});

test('parseLog: undefined control sequence only asks for args when a \\def name shows in context', () => {
  const plain = tc.parseLog('! Undefined control sequence.\nl.4 \\typo\n\n');
  assert.ok(!plain.needsArgs);
  const withDef = tc.parseLog('! Undefined control sequence.\nl.4 \\paperTitle\n\n% hint \\def\\paperTitle{..}\n');
  assert.equal(withDef.needsArgs, true);
  assert.equal(tc.parseLog('! Package t Error: Please pass the data path.\nl.2 x\n').needsArgs, true);
});

test('detectEngine: \\RequirePackage of fontspec, unicode-math and luacode', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-eng-'));
  const w = (n, s) => { const f = path.join(d, n); fs.writeFileSync(f, s); return f; };
  assert.equal(tc.detectEngine(w('a.tex', '\\RequirePackage{fontspec}\\documentclass{article}')), 'xelatex');
  assert.equal(tc.detectEngine(w('b.tex', '\\RequirePackage[x]{unicode-math}')), 'xelatex');
  assert.equal(tc.detectEngine(w('c.tex', '\\RequirePackage{luacode}\\RequirePackage{fontspec}')), 'lualatex');
  assert.equal(tc.detectEngine(w('d.tex', '% \\RequirePackage{fontspec}\n\\documentclass{article}')), 'pdflatex');
  fs.rmSync(d, { recursive: true, force: true });
});

test('defaultTexPath per platform, with a fake fs for TeX Live discovery', () => {
  assert.equal(tc.defaultTexPath('darwin'), '/Library/TeX/texbin');
  assert.equal(tc.defaultTexPath('win32'), '');
  const tree = { '/usr/local/texlive': ['2023', '2025'], '/usr/local/texlive/2025/bin': ['x86_64-linux'], '/usr/local/texlive/2023/bin': ['x86_64-linux'] };
  const fake = { readdirSync: (p) => { if (!tree[p]) throw new Error('ENOENT'); return tree[p]; } };
  assert.equal(tc.defaultTexPath('linux', fake), '/usr/local/texlive/2025/bin/x86_64-linux:/usr/local/texlive/2023/bin/x86_64-linux:/usr/bin');
  assert.equal(tc.defaultTexPath('linux', { readdirSync: () => { throw new Error('x'); } }), '/usr/bin');
});

test('texPathDirs: configured path if it exists, else platform default, else nothing', () => {
  const have = new Set(['/cfg', '/Library/TeX/texbin']);
  const fake = { existsSync: (p) => have.has(p), readdirSync: () => { throw new Error('x'); } };
  assert.deepEqual(tc.texPathDirs('/cfg', 'darwin', fake), ['/cfg']);
  assert.deepEqual(tc.texPathDirs('/nope', 'darwin', fake), ['/Library/TeX/texbin']);
  assert.deepEqual(tc.texPathDirs('', 'darwin', fake), ['/Library/TeX/texbin']);
  assert.deepEqual(tc.texPathDirs('/nope', 'linux', fake), []); // /usr/bin not in the fake fs: plain PATH only
  assert.deepEqual(tc.texPathDirs('/nope', 'win32', fake), []);
  assert.deepEqual(tc.texPathDirs('C:\\a;/cfg', 'win32', { existsSync: (p) => p === 'C:\\a' }), ['C:\\a']);
});

test('Compiler: the latest closure runs on rerun and a later force is kept', async () => {
  const c = new tc.Compiler();
  const calls = []; let release;
  const gate = new Promise((r) => { release = r; });
  const finished = new Promise((resolve) => {
    const mk = (name) => async (o) => { calls.push(name + ':' + o.force); if (name === 'a') await gate; return { name }; };
    const onDone = (name) => (res, again) => { calls.push('done-' + name + ':' + res.name + ':' + again); if (!again) resolve(); };
    assert.equal(c.request('k', mk('a'), onDone('a'), false), true);
    assert.equal(c.request('k', mk('b'), onDone('b'), true), false);
    assert.equal(c.request('k', mk('c'), onDone('c'), false), false); // force from b is sticky
    release();
  });
  await finished;
  assert.deepEqual(calls, ['a:false', 'done-a:a:true', 'c:true', 'done-c:c:false']);
});

test('Compiler: onDone and run errors never throw and the callback always fires', async () => {
  const c = new tc.Compiler();
  const seen = [];
  let release; const gate = new Promise((r) => { release = r; });
  const finished = new Promise((resolve) => {
    c.request('k', async () => { await gate; throw new Error('boom'); }, (res, again) => { seen.push(res.banner); throw new Error('cb'); });
    c.request('k', async () => ({ ok: true }), (res, again) => { seen.push(res.ok); resolve(); });
    release();
  });
  await finished;
  assert.deepEqual(seen, ['Compile failed: boom', true]);
  // the key is free again afterwards
  assert.equal(c.request('k', async () => ({}), () => {}), true);
});
