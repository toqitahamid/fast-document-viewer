'use strict';
// Pure helpers of media/main.js (the file exports them when loaded under Node).
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../media/main.js');

test('toBytes accepts the usual shapes', () => {
  assert.deepEqual(Array.from(v.toBytes(new Uint8Array([1, 2]))), [1, 2]);
  assert.deepEqual(Array.from(v.toBytes(new Uint8Array([3, 4]).buffer)), [3, 4]);
  assert.deepEqual(Array.from(v.toBytes(new Uint16Array([1]))), [1, 0]);
  assert.deepEqual(Array.from(v.toBytes([5, 6])), [5, 6]);
  assert.deepEqual(Array.from(v.toBytes({ type: 'Buffer', data: [7] })), [7]);
  assert.deepEqual(Array.from(v.toBytes({ 0: 8, 1: 9, length: 2 })), [8, 9]);
});

test('toBytes rejects hostile or wrong input without allocating', () => {
  assert.throws(() => v.toBytes({ length: 2e9 }), /unexpected|too large/);
  assert.throws(() => v.toBytes({ length: -1 }));
  assert.throws(() => v.toBytes({ length: 1.5 }));
  assert.throws(() => v.toBytes({ a: 1 }));
  assert.throws(() => v.toBytes('abc'));
  assert.throws(() => v.toBytes(5));
  assert.throws(() => v.toBytes(null));
  assert.throws(() => v.toBytes(new Uint8Array(10), 5), /too large/);
  assert.throws(() => v.toBytes(new ArrayBuffer(10), 5), /too large/);
});

test('isHostMessage: rejects frames inside the page, accepts the host', () => {
  const self = {}; const top = {}; self.parent = top; top.parent = top;
  const child = { parent: self }; const grandchild = { parent: child };
  const relay = { parent: top }; // a sibling or outer relay frame
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: top }, self));
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: relay }, self));
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: null }, self));
  assert.ok(!v.isHostMessage({ data: { type: 'x' }, source: child }, self));
  assert.ok(!v.isHostMessage({ data: { type: 'x' }, source: grandchild }, self));
  assert.ok(!v.isHostMessage({ data: null, source: top }, self));
  assert.ok(!v.isHostMessage({ data: 'str', source: top }, self));
});

test('pagesToEvict keeps the window and observer-visible pages', () => {
  const rendered = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(v.pagesToEvict(rendered, 5, 3, new Set()), [0, 1, 9]);
  assert.deepEqual(v.pagesToEvict(rendered, 5, 3, new Set([0, 9])), [1]);
  assert.deepEqual(v.pagesToEvict([0, 1], 0, 3), []);
  assert.deepEqual(v.pagesToEvict([], 4, 3, new Set()), []);
});

test('createLru caps size, evicts oldest, revokes via callback', () => {
  const gone = [];
  const c = v.createLru(2, (val, k) => gone.push(k));
  c.set('a', 1); c.set('b', 2);
  c.get('a'); // a is now newest
  c.set('c', 3);
  assert.deepEqual(gone, ['b']);
  assert.deepEqual(c.keys(), ['a', 'c']);
  c.set('a', 9); // replacing evicts the old value
  assert.deepEqual(gone, ['b', 'a']);
  c.delete('c');
  c.clear();
  assert.equal(c.size, 0);
  assert.deepEqual(gone, ['b', 'a', 'c', 'a']);
});

test('figKey drops the fragment but keeps ?v=', () => {
  assert.equal(v.figKey('x/a.pdf?v=12#page=1'), 'x/a.pdf?v=12');
  assert.notEqual(v.figKey('a.pdf?v=1'), v.figKey('a.pdf?v=2'));
  assert.ok(v.figVersioned('a.pdf?v=1') && v.figVersioned('a.pdf?x=1&v=2'));
  assert.ok(!v.figVersioned('a.pdf'));
});

test('resolveAnchor: prefixed heading id first, never outside the document', () => {
  const dom = { 'h-title-a': { in: true }, 'legacy': { in: true }, 'content': { in: false }, 'h-ünï': { in: true } };
  const byId = (id) => dom[id] || null;
  const inC = (el) => el.in;
  assert.equal(v.resolveAnchor('title-a', byId, inC), dom['h-title-a']);
  assert.equal(v.resolveAnchor('legacy', byId, inC), dom.legacy);
  assert.equal(v.resolveAnchor('content', byId, inC), null); // viewer element
  assert.equal(v.resolveAnchor('%C3%BCn%C3%AF'.replace('%C3%BCn%C3%AF', '%C3%BCn'), byId, inC), null);
  assert.equal(v.resolveAnchor('%E0%A4%A', byId, inC), null); // malformed escape does not throw
  assert.equal(v.resolveAnchor('', byId, inC), null);
});

test('isAllowedPdfUrl matches the host policy', () => {
  const u = require('../src/util');
  for (const s of ['http://a.b', 'https://a.b/c', 'mailto:x@y.z']) assert.ok(v.isAllowedPdfUrl(s) && u.isSafeExternalUrl(s), s);
  for (const s of ['javascript:alert(1)', 'JaVaScRiPt:1', 'data:text/html,x', 'file:///x', 'vscode://a', 'command:x', 'rel/path', '', 'https://a.b/\u0001', 'https://a b', 'https://a.b/' + 'x'.repeat(2100), null, 3]) {
    assert.ok(!v.isAllowedPdfUrl(s), String(s).slice(0, 30));
    assert.ok(!u.isSafeExternalUrl(s), String(s).slice(0, 30));
  }
});

test('linkBox normalizes corners and clamps to the page', () => {
  assert.deepEqual(v.linkBox([10, 20, 60, 40], 100, 200), { left: 10, top: 10, width: 50, height: 10 });
  assert.deepEqual(v.linkBox([60, 40, 10, 20], 100, 200), { left: 10, top: 10, width: 50, height: 10 });
  const c = v.linkBox([90, 190, 150, 250], 100, 200);
  assert.equal(c.left + c.width, 100); assert.equal(c.top + c.height, 100);
  assert.equal(v.linkBox([5, 5, 5, 5], 100, 100), null);
  assert.equal(v.linkBox([NaN, 0, 1, 1], 100, 100), null);
  assert.equal(v.linkBox(null, 100, 100), null);
  assert.equal(v.linkBox([0, 0, 5, 5], 0, 100), null);
});

test('resolvePdfDest handles named, explicit and bad destinations', async () => {
  const ref = { num: 7, gen: 0 };
  const doc = {
    numPages: 5,
    getDestination: async (n) => (n === 'sec' ? [ref, { name: 'XYZ' }, 0, 700, null] : null),
    getPageIndex: async (r) => { if (r !== ref) throw new Error('bad ref'); return 3; },
  };
  assert.deepEqual(await v.resolvePdfDest(doc, 'sec', 800), { page: 3, top: 0.125 });
  assert.deepEqual(await v.resolvePdfDest(doc, [ref, { name: 'Fit' }], 800), { page: 3, top: 0 });
  assert.deepEqual(await v.resolvePdfDest(doc, [ref, { name: 'FitH' }, 400], 800), { page: 3, top: 0.5 });
  assert.deepEqual(await v.resolvePdfDest(doc, [2, { name: 'Fit' }], 800), { page: 2, top: 0 });
  assert.equal(await v.resolvePdfDest(doc, 'missing', 800), null);
  assert.equal(await v.resolvePdfDest(doc, [{ num: 9, gen: 0 }], 800), null);
  assert.equal(await v.resolvePdfDest(doc, [9], 800), null);
  assert.equal(await v.resolvePdfDest(doc, [-1], 800), null);
  assert.equal(await v.resolvePdfDest(doc, 42, 800), null);
});

test('namedActionPage stays inside the document', () => {
  assert.equal(v.namedActionPage('NextPage', 0, 3), 1);
  assert.equal(v.namedActionPage('NextPage', 2, 3), null);
  assert.equal(v.namedActionPage('PrevPage', 0, 3), null);
  assert.equal(v.namedActionPage('PrevPage', 2, 3), 1);
  assert.equal(v.namedActionPage('FirstPage', 2, 3), 0);
  assert.equal(v.namedActionPage('LastPage', 0, 3), 2);
  assert.equal(v.namedActionPage('Print', 0, 3), null);
});
