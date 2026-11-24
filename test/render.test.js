'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, slugify } = require('../src/render');

const render = createRenderer({ resolveImage: (s) => 'vscode-resource://x/' + s });

test('smoke: full document renders every feature', () => {
  const h = render('# Title A\n\nText $a^2$ and\n\n$$\\int_0^1 x\\,dx$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![f](fig.png)\n\n```python\nprint(1)\n```\n\n- [x] done\n- [ ] todo\n\n[s](#title-a) <b>x</b> https://a.com\n');
  for (const k of ['id="title-a"', 'katex', '<table', 'vscode-resource://x/fig.png', 'hljs', 'task-list']) {
    assert.ok(h.includes(k), 'missing ' + k);
  }
});

test('GFM table', () => {
  const h = render('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(h, /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/);
});

test('task list renders checkboxes, checked and unchecked', () => {
  const h = render('- [x] done\n- [ ] todo\n');
  assert.equal((h.match(/type="checkbox"/g) || []).length, 2);
  assert.equal((h.match(/checked=""/g) || []).length, 1);
});

test('KaTeX inline and block', () => {
  assert.match(render('x $a^2$ y'), /<span class="katex">/);
  const b = render('$$\n\\int_0^1 x\\,dx\n$$\n');
  assert.match(b, /katex-display/);
});

test('invalid math does not throw', () => {
  assert.doesNotThrow(() => render('$\\frac{$'));
});

test('highlight.js: known language highlighted, unknown falls back', () => {
  assert.match(render('```python\ndef f(): pass\n```\n'), /<pre class="hljs"><code>[\s\S]*hljs-keyword/);
  const u = render('```nosuchlang\n<b>x</b>\n```\n');
  assert.ok(u.includes('&lt;b&gt;'), 'code must be escaped');
  assert.ok(!u.includes('<b>x</b>'));
});

test('relative image src rewritten; absolute/data/anchor kept', () => {
  assert.ok(render('![a](img/a.png)').includes('src="vscode-resource://x/img/a.png"'));
  for (const s of ['https://e.com/a.png', 'data:image/png;base64,AAAA', 'vscode-webview://q/a.png']) {
    assert.ok(render(`![a](${s})`).includes(`src="${s}"`), s);
  }
});

test('resolveImage returning null keeps src; default renderer keeps src', () => {
  assert.ok(createRenderer({ resolveImage: () => null })('![a](a.png)').includes('src="a.png"'));
  assert.ok(createRenderer()('![a](a.png)').includes('src="a.png"'));
});

test('raw HTML is kept, linkify works', () => {
  const h = render('<b>x</b> and <div class="k">y</div> https://a.com\n');
  assert.ok(h.includes('<b>x</b>'));
  assert.ok(h.includes('<div class="k">y</div>'));
  assert.ok(h.includes('<a href="https://a.com">'));
});

test('heading ids: slug, duplicates get suffix, empty falls back to "section"', () => {
  const h = render('# Hello World\n\n# Hello World\n\n# !!!\n');
  assert.ok(h.includes('id="hello-world"'));
  assert.ok(h.includes('id="hello-world-1"'));
  assert.ok(h.includes('id="section"'));
});

test('slugify', () => {
  assert.equal(slugify('  Hello, World! '), 'hello-world');
  assert.equal(slugify('Ünï cödé 2'), 'ünï-cödé-2');
});
