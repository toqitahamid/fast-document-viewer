'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findRoots, includes } = require('../src/texroot');

function makeIo(files) {
  return {
    readText: async (p) => (p in files ? files[p] : null),
    listDir: async (d) => {
      const pre = d.endsWith('/') ? d : d + '/';
      return Object.keys(files).filter((f) => f.startsWith(pre) && !f.slice(pre.length).includes('/')).map((f) => f.slice(pre.length));
    },
  };
}

test('% !TEX root directive (relative, no extension)', async () => {
  const io = makeIo({ '/p/main.tex': '\\documentclass{article}', '/p/sec/a.tex': '% !TEX root = ../main\nhi' });
  assert.deepEqual(await findRoots('/p/sec/a.tex', '% !TEX root = ../main\nhi', io), ['/p/main.tex']);
});

test('directive pointing at a missing file is ignored', async () => {
  const io = makeIo({ '/p/a.tex': 'hi' });
  assert.deepEqual(await findRoots('/p/a.tex', '% !TEX root = nope.tex\nhi', io), []);
});

test('file with \\documentclass is its own root', async () => {
  const io = makeIo({ '/p/a.tex': '\\documentclass{article}' });
  assert.deepEqual(await findRoots('/p/a.tex', '\\documentclass{article}', io), []);
});

test('commented \\documentclass does not count', async () => {
  const io = makeIo({ '/p/a.tex': '% \\documentclass{x}\nhi' });
  assert.deepEqual(await findRoots('/p/a.tex', '% \\documentclass{x}\nhi', io), []);
});

test('root found by scanning for an including documentclass file; main.tex preferred', async () => {
  const files = {
    '/p/zz.tex': '\\documentclass{a}\\input{sec/a}',
    '/p/main.tex': '\\documentclass{a}\\input{sec/a}',
    '/p/other.tex': '\\documentclass{a}no includes',
    '/p/sec/a.tex': 'body',
  };
  assert.deepEqual(await findRoots('/p/sec/a.tex', 'body', makeIo(files)), ['/p/main.tex', '/p/zz.tex']);
});

test('transitive include (depth 2) and \\input cycle terminates', async () => {
  const files = {
    '/p/main.tex': '\\documentclass{a}\\input{b}',
    '/p/b.tex': '\\input{main}\\input{c}',
    '/p/c.tex': 'leaf',
  };
  assert.deepEqual(await findRoots('/p/c.tex', 'leaf', makeIo(files)), ['/p/main.tex']);
});

test('includes() ignores commented \\input', async () => {
  const io = makeIo({});
  assert.equal(await includes('/p', '% \\input{c}\n', '/p/c.tex', io, 1, new Set()), false);
  assert.equal(await includes('/p', '\\input{c.tex}', '/p/c.tex', io, 1, new Set()), true);
});

test('no root found returns []', async () => {
  assert.deepEqual(await findRoots('/p/a.tex', 'x', makeIo({ '/p/a.tex': 'x' })), []);
});
