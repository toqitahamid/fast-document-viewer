'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// The viewer ships its own copy of the KaTeX stylesheet and fonts. If they drift from the installed
// KaTeX version (for example after a Dependabot bump), math renders with the wrong styles.
test('media/katex.css matches the installed KaTeX version', () => {
  const dist = path.join(root, 'node_modules', 'katex', 'dist');
  assert.equal(fs.readFileSync(path.join(root, 'media', 'katex.css'), 'utf8'), fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8'),
    'run: cp node_modules/katex/dist/katex.min.css media/katex.css');
});

test('media/fonts has every KaTeX font file, identical to the installed version', () => {
  const src = path.join(root, 'node_modules', 'katex', 'dist', 'fonts');
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.woff2'))) {
    const mine = path.join(root, 'media', 'fonts', f);
    assert.ok(fs.existsSync(mine), 'missing font ' + f);
    assert.ok(fs.readFileSync(mine).equals(fs.readFileSync(path.join(src, f))), 'font differs: ' + f);
  }
});
