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

test('isHostMessage: only this window or the parent', () => {
  const self = {}; const parent = {}; const child = {};
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: parent }, self, parent));
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: self }, self, parent));
  assert.ok(v.isHostMessage({ data: { type: 'x' }, source: null }, self, parent));
  assert.ok(!v.isHostMessage({ data: { type: 'x' }, source: child }, self, parent));
  assert.ok(!v.isHostMessage({ data: null, source: parent }, self, parent));
  assert.ok(!v.isHostMessage({ data: 'str', source: parent }, self, parent));
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
