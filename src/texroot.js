'use strict';
// Find the root document of a .tex file that is only a part of a paper.
// io = { readText(path) -> Promise<string|null>, listDir(path) -> Promise<string[]> }, paths are POSIX strings.
const P = require('path').posix;

const uncomment = (t) => String(t).replace(/(^|[^\\])%.*$/gm, '$1');
const hasDocClass = (t) => /\\documentclass(?![A-Za-z])/.test(uncomment(t));
const stripTex = (p) => P.normalize(String(p).replace(/^\.\//, '')).replace(/\.tex$/i, '');

function inputsOf(text) {
  const out = []; const re = /\\(?:input|include|subfile|subfileinclude)\s*\{([^}]*)\}/g; let m;
  const t = uncomment(text);
  while ((m = re.exec(t))) out.push(m[1].trim());
  return out;
}

// Does the file at rootPath include target (an absolute path) through \input, depth <= 3?
async function includes(rootDir, text, target, io, depth, seen) {
  if (depth > 3) return false;
  for (const arg of inputsOf(text)) {
    const rel = stripTex(arg);
    const abs = P.join(rootDir, rel);
    if (abs === stripTex(target)) return true;
    if (depth < 3 && !seen.has(abs)) {
      seen.add(abs);
      const sub = await io.readText(abs + '.tex');
      if (typeof sub === 'string' && await includes(rootDir, sub, target, io, depth + 1, seen)) return true;
    }
  }
  return false;
}

// Returns the candidate root paths in order of preference. [] means the file is its own root.
async function findRoots(filePath, text, io) {
  const dir = P.dirname(filePath);
  const head = String(text).split('\n').slice(0, 20).join('\n');
  const mm = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im.exec(head);
  if (mm) {
    let r = P.resolve(dir, mm[1].trim());
    if (!/\.tex$/i.test(r)) r += '.tex';
    if (r !== filePath && typeof (await io.readText(r)) === 'string') return [r];
  }
  if (hasDocClass(text)) return [];
  const found = [];
  let d = dir;
  for (let up = 0; up < 3; up++) {
    let names = [];
    try { names = await io.listDir(d); } catch (e) { names = []; }
    for (const n of names.filter((x) => /\.tex$/i.test(x)).slice(0, 40)) {
      const cand = P.join(d, n);
      if (cand === filePath || found.includes(cand)) continue;
      const t = await io.readText(cand);
      if (typeof t !== 'string' || !hasDocClass(t)) continue;
      if (await includes(d, t, filePath, io, 1, new Set([stripTex(cand)]))) found.push(cand);
    }
    const parent = P.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  found.sort((a, b) => {
    const ma = P.basename(a) === 'main.tex' ? 0 : 1; const mb = P.basename(b) === 'main.tex' ? 0 : 1;
    return ma - mb || P.basename(a).length - P.basename(b).length || a.localeCompare(b);
  });
  return found;
}

module.exports = { findRoots, includes };
