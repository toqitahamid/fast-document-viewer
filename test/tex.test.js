'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { texToHtml } = require('../src/tex');

const doc = (body, pre) => '\\documentclass{article}\n' + (pre || '') + '\\title{My Title}\\author{Bob}\n\\begin{document}\\maketitle\n\\begin{abstract}Abs text\\end{abstract}\n' + body + '\n\\end{document}';
const conv = (body, pre, files) => texToHtml(doc(body, pre), {
  readFile: async (p) => { const k = String(p).replace(/^\.\//, ''); const f = files || {}; return f[k] ?? f[k + '.tex'] ?? null; },
});
const text = (h) => h.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

test('title, author, abstract, numbered sections', async () => {
  const { html } = await conv('\\section{Intro}x\\subsection{Sub}y');
  assert.match(html, /<h1>My Title<\/h1>/);
  assert.match(html, /tex-au">Bob</);
  assert.match(html, /tex-abstract[\s\S]*Abs text/);
  assert.match(html, /<h2[^>]*><span class="tex-secnum">1<\/span> Intro/);
  assert.match(html, /<h3[^>]*><span class="tex-secnum">1\.1<\/span> Sub/);
});

test('\\newcommand with argument expands', async () => {
  const { html } = await conv('\\newcommand{\\hi}[1]{Hello #1}\\hi{World}');
  assert.match(text(html), /Hello World/);
});

test('inline and display math via KaTeX', async () => {
  const { html } = await conv('$a^2$ and \\[ \\int x \\]');
  assert.match(html, /<span class="katex">/);
  assert.match(html, /katex-display/);
});

test('figure and table captions are numbered', async () => {
  const { html } = await conv('\\begin{figure}\\caption{Fig cap}\\end{figure}\\begin{table}\\caption{Tab cap}\\end{table}');
  assert.match(html, /Figure 1:<\/span> Fig cap/);
  assert.match(html, /Table 1:<\/span> Tab cap/);
});

test('\\label/\\ref resolves to the section number, \\cite links to a bib entry', async () => {
  const { html } = await conv('\\section{Intro}\\label{s:i} See \\ref{s:i} and \\cite{k}.');
  assert.match(html, /<a class="tex-ref" href="#tex-s:i">1<\/a>/);
  assert.match(html, /<a class="tex-cite" href="#tex-bib-k">/);
});

test('unknown command keeps its argument text', async () => {
  const { html } = await conv('\\foo{keep me} tail');
  assert.match(text(html), /keep me tail/);
});

test('\\input of existing file is inlined', async () => {
  const { html } = await conv('\\input{part}', '', { 'part.tex': 'Included words' });
  assert.match(text(html), /Included words/);
});

test('\\input cycle does not hang and is flagged', async () => {
  const files = { 'a.tex': 'A \\input{b}', 'b.tex': 'B \\input{a}' };
  const { html } = await conv('\\input{a}', '', files);
  assert.match(html, /input cycle/);
  assert.match(text(html), /A B/);
});

test('self-referential \\def terminates within 5 s', { timeout: 5000 }, async () => {
  const { html } = await conv('\\def\\a{\\a x}\\a');
  assert.match(html, /tex-doc/);
});

test('mutually recursive \\newcommand terminates within 5 s', { timeout: 5000 }, async () => {
  const { html } = await conv('\\newcommand{\\p}{\\q}\\newcommand{\\q}{\\p z}\\p');
  assert.match(html, /tex-doc/);
});

test('never throws on garbage input', async () => {
  const r = await texToHtml('\\begin{foo \\} $$ \\def', {});
  assert.equal(typeof r.html, 'string');
});
