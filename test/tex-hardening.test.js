'use strict';
// Regression tests for hostile or unusual input to src/tex.js: URLs with %, injection, runaway work, paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const { texToHtml } = require('../src/tex');

const doc = (body, pre) => '\\documentclass{article}\n' + (pre || '') + '\\begin{document}\n' + body + '\n\\end{document}';
const noFiles = { readFile: async () => null };
const conv = (body, pre, opts) => texToHtml(doc(body, pre), opts || noFiles);
const plain = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };

test('percent inside \\url and \\href is data, not a comment', async () => {
  const { html } = await texToHtml('\\begin{document}See \\url{https://x.com/a%20b} here.\n\nSecond para.\n\n\\section{Next}\nBody\\end{document}', noFiles);
  assert.match(html, /<a href="https:\/\/x\.com\/a%20b">https:\/\/x\.com\/a%20b<\/a> here\./);
  assert.match(html, /Second para\./);
  assert.match(html, /<h2[^>]*>.*Next/);
  const h2 = (await conv('\\href{https://x.com/q?a=1\\&b=2\\%20c\\_d}{link} after % real comment\nnext')).html;
  assert.match(h2, /<a href="https:\/\/x\.com\/q\?a=1&amp;b=2%20c_d">link<\/a> after/);
  assert.doesNotMatch(h2, /real comment/);
});

test('percent in a .bbl reference url survives', async () => {
  const files = { 'main.bbl': '\\begin{thebibliography}{1}\n\\bibitem{k} A. Name. \\url{https://x.com/a%20b}. 2020.\n\\end{thebibliography}\n' };
  const { html } = await texToHtml(doc('See \\cite{k}.\\bibliography{refs}'), { readFile: async (p) => files[p] ?? null, baseName: 'main' });
  assert.match(html, /<a href="https:\/\/x\.com\/a%20b">/);
  assert.match(html, /2020\./);
});

test('crefname and aux types are escaped', async () => {
  const { html } = await conv('\\section{A}\\label{a} \\cref{a}', '\\crefname{section}{<img src=x onerror=alert(1)>}{x}\n');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  const aux = '\\newlabel{zz}{{1}{1}{A}{<img src=y onerror=1>.1}{}}';
  const r = await texToHtml(doc('\\cref{zz} \\Cref{zz}'), { readFile: async (p) => (p === 'main.aux' ? aux : null), baseName: 'main' });
  assert.doesNotMatch(r.html, /<img/);
  const r2 = await conv('\\section{A}\\label{a}\\cref{a}', '\\crefname{constructor}{x}{y}\\crefname{section}{sec}{secs}\n');
  assert.match(r2.html, /sec\s<a/);
});

test('macro that doubles its argument stops instead of filling memory', async () => {
  const { r, ms } = await timed(() => conv('\\def\\a#1{#1#1}' + '\\a{'.repeat(15) + 'x'.repeat(10000) + '}'.repeat(15)));
  assert.ok(ms < 1000, 'took ' + ms);
  assert.ok(r.html.length < 1e6, 'html ' + r.html.length);
  assert.match(r.html, /tex-note/);
  assert.ok(r.stats.bailed);
  const wide = await conv('\\def\\a#1{' + '#1'.repeat(1000) + '}\\a{' + 'y'.repeat(5000) + '}');
  assert.ok(wide.html.length < 1e6);
});

test('normal macro use is not limited', async () => {
  const { html } = await conv('\\newcommand{\\R}{\\mathbb{R}}' + 'Set $\\R$ and \\R. '.repeat(500));
  assert.doesNotMatch(html, /preview stopped/);
});

test('unclosed \\( and \\[ are literal text and fast', async () => {
  for (const unit of ['\\(', '\\[']) {
    const { r, ms } = await timed(() => conv('a' + unit.repeat(30000)));
    assert.ok(ms < 1000, unit + ' took ' + ms);
    assert.doesNotMatch(r.html, /preview stopped/);
  }
  const ok = await conv('\\( x \\) and \\[ y \\]');
  assert.match(ok.html, /katex-display/);
});

test('unclosed $ and $$ do not rescan', async () => {
  for (const unit of ['$$ x ', '$ x \\$ ', '$$ \\$ ']) {
    const { r, ms } = await timed(() => conv(unit + ' $ \\$ '.repeat(30000).replace(/\$ /g, '\\$ ')));
    assert.ok(ms < 1000, unit + ' took ' + ms);
    assert.doesNotMatch(r.html, /preview stopped/);
  }
  const ok = await conv('a $b$ c $$d$$ e');
  assert.equal((ok.html.match(/class="katex"/g) || []).length, 2);
});

test('\\\\[ without ] inside tabular is fast', async () => {
  const { r, ms } = await timed(() => conv('\\begin{tabular}{c}' + '\\\\[ '.repeat(20000) + '\\end{tabular}'));
  assert.ok(ms < 1000, 'took ' + ms);
  assert.match(r.html, /<table/);
  const sp = await conv('\\begin{tabular}{c}a\\\\[2pt]b\\\\\\end{tabular}');
  assert.equal((sp.html.match(/<tr/g) || []).length, 2);
});

test('unclosed \\cite[ is fast', async () => {
  for (const unit of ['\\cite[', '\\cite[{', '\\textbf{a}\\cite[']) {
    const { ms } = await timed(() => conv(unit.repeat(15000)));
    assert.ok(ms < 1000, unit + ' took ' + ms);
  }
});

test('many \\verb on one line is fast', async () => {
  const { r, ms } = await timed(() => conv('\\verb|a| '.repeat(15000)));
  assert.ok(ms < 1000, 'took ' + ms);
  assert.equal((r.html.match(/<code class="tt">a<\/code>/g) || []).length, 15000);
  const after = await conv('% \\verb|x| in a comment\n\\verb|y|');
  assert.doesNotMatch(after.html, /<code[^>]*>x/);
  assert.match(after.html, /<code class="tt">y<\/code>/);
});

test('exponential \\usebox and unbounded algorithm nesting stop', async () => {
  const boxes = '\\sbox{\\b0}{x}' + Array.from({ length: 40 }, (_, k) => `\\sbox{\\b${k + 1}}{\\usebox{\\b${k}}\\usebox{\\b${k}}}`).join('') + '\\usebox{\\b40}';
  const a = await timed(() => conv(boxes));
  assert.ok(a.ms < 1000, 'boxes took ' + a.ms);
  const algo = await timed(() => conv('\\begin{algorithmic}' + '\\If{c} x '.repeat(30000) + '\\end{algorithmic}'));
  assert.ok(algo.ms < 1000, 'algo took ' + algo.ms);
  assert.ok(algo.r.html.length < 5e7);
});

test('nested footnotes and the list agree', async () => {
  const { html } = await conv('A\\footnote{one \\footnote{inner} two} B\\footnote{three}');
  const refs = [...html.matchAll(/<a id="fnref-(\d+)" href="#fn-(\d+)">(\d+)<\/a>/g)].map((m) => m.slice(1, 4).join(','));
  assert.deepEqual(refs.sort(), ['1,1,1', '2,2,2', '3,3,3']);
  const items = [...html.matchAll(/<li value="(\d+)" id="fn-(\d+)">([^<]*)/g)].map((m) => m[1] + ':' + m[2] + ':' + m[3].trim());
  assert.deepEqual(items, ['1:1:one', '2:2:inner', '3:3:three']);
});

test('part mode: footnote numbers match the list', async () => {
  const text = doc('A\\footnote{a}\\input{sec}B\\footnote{b}');
  const files = { sec: 'S\\footnote{s}' };
  const r = await texToHtml(text, { readFile: async (p) => files[p] ?? null, part: { rel: 'sec.tex', text: 'S\\footnote{s}' } });
  const ref = /<a id="fnref-(\d+)" href="#fn-(\d+)">/.exec(r.html);
  assert.ok(ref);
  assert.match(r.html, new RegExp('<li value="' + ref[1] + '" id="fn-' + ref[1] + '">s'));
});

test('\\ifmmode takes the text branch and pairs its \\fi', async () => {
  const { html } = await conv('\\iftrue \\ifmmode M\\else T\\fi after\\fi done');
  assert.match(plain(html), /T after done/);
  assert.doesNotMatch(plain(html), /M/);
  const { html: h2 } = await conv('\\ifnum1<2 A\\else B\\fi Z \\iffalse hidden\\fi shown');
  assert.match(plain(h2), /A/);
  assert.doesNotMatch(plain(h2), /hidden|B\b/);
  assert.match(plain(h2), /shown/);
});

test('\\lstinline with options is inline code', async () => {
  const { html } = await conv('\\lstinline[language=C]{int x;} and \\lstinline[a=b]!int y;! then \\lstinline|z|');
  assert.match(html, /<code class="tt">int x;<\/code>/);
  assert.match(html, /<code class="tt">int y;<\/code>/);
  assert.match(html, /<code class="tt">z<\/code>/);
  assert.doesNotMatch(html, /language=/);
});

test('absolute and far parent paths are blocked', async () => {
  const read = [];
  const opts = { readFile: async (p) => { read.push(p); return /passwd|secret/.test(p) ? 'ROOT_LEAK' : null; }, exists: async () => true, resolveImage: (p) => 'vscode://' + p };
  const { html } = await conv('\\input{/etc/passwd} \\input{../../../etc/passwd} \\input{C:/x/secret} \\includegraphics{/etc/x.png} \\includegraphics{../../../x.png}', '', opts);
  assert.doesNotMatch(html, /ROOT_LEAK/);
  assert.equal((html.match(/blocked path/g) || []).length, 5);
  assert.doesNotMatch(html, /<img/);
  assert.deepEqual(read.filter((p) => /passwd|secret/.test(p)), []);
});

test('parent directories up to two levels still work', async () => {
  const files = { '../sections/x.tex': 'FROM_PARENT', '../../top.tex': 'FROM_TOP' };
  const { html } = await conv('\\input{../sections/x} \\input{../../top}', '', { readFile: async (p) => files[p] ?? null });
  assert.match(html, /FROM_PARENT/);
  assert.match(html, /FROM_TOP/);
});

test('image-only document has no empty-text banner', async () => {
  const opts = { readFile: async () => null, exists: async () => true, resolveImage: (p) => 'u://' + p };
  const { html } = await conv('\\includegraphics{a.png}', '', opts);
  assert.match(html, /<img/);
  assert.doesNotMatch(html, /no visible text/);
  const empty = await texToHtml('\\begin{document}\\end{document}', noFiles);
  assert.match(empty.html, /no visible text/);
});

test('unknown names do not hit Object.prototype', async () => {
  const { html } = await conv('\\textcolor{constructor}{hi} \\colorbox{toString}{ho} \\begin{constructor}in\\end{constructor} \\constructor');
  assert.doesNotMatch(html, /undefined|NaN|function/);
  assert.match(html, /hi/);
});

test('multicolumn spans are clamped', async () => {
  const { html } = await conv('\\begin{tabular}{cc}\\multicolumn{-5}{c}{a}\\\\\\multicolumn{99999}{c}{b}\\\\\\multicolumn{x}{c}{c}\\end{tabular}');
  const spans = html.match(/colspan="(\d+)"/g);
  assert.deepEqual(spans, ['colspan="100"']);
});

test('\\input aliases of the same file are one cycle', async () => {
  let reads = 0;
  const { html } = await conv('\\input{a}', '', { readFile: async (p) => { if (/^a(\.tex)?$/.test(p)) { reads++; return 'x\\input{./a.tex}\\input{a}\\input{./a}'; } return null; } });
  assert.ok(reads <= 2, 'reads ' + reads);
  assert.match(html, /input cycle/);
});

test('output cap: a page over the size limit is replaced by a notice', async () => {
  const { html, stats } = await conv('Some text. $x^2$', '', { readFile: async () => null, maxHtml: 500 });
  assert.ok(stats.bailed);
  assert.match(html, /too large/);
  assert.ok(html.length < 500);
});

test('overlapping conversions keep separate work budgets', async () => {
  const hostile = doc('\\input{slow}\\def\\a#1{#1#1}' + '\\a{'.repeat(15) + 'x'.repeat(10000) + '}'.repeat(15));
  const slow = async (p) => { await new Promise((res) => setTimeout(res, 20)); return p === 'slow.tex' || p === 'slow' ? 'late' : null; };
  const t = Date.now();
  const [bad, good] = await Promise.all([
    texToHtml(hostile, { readFile: slow }),
    texToHtml(doc('Benign text.'), noFiles),
  ]);
  assert.ok(bad.stats.bailed, 'hostile document must still be stopped');
  assert.ok(Date.now() - t < 1000);
  assert.ok(!good.stats.bailed);
  assert.match(good.html, /Benign text/);
});
