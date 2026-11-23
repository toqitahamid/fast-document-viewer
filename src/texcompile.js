'use strict';
// Compile-based LaTeX preview: mirror a root's folder tree to local disk, pick an engine,
// run latexmk, and turn its log into a short error. No vscode state is kept here.
// `vscode` is used only for Uri.joinPath and FileType, so the mirror works with any workspace.fs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTS = new Set('tex sty cls bst bib bbx cbx dbx lbx def cfg clo fd ldf png jpg jpeg gif pdf eps ps svg ttf otf ttc woff woff2 bbl ist'.split(' '));
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const MAX_FILE = 25 * 1024 * 1024;
const MAX_DEPTH = 6;
const CONCURRENCY = 8;

// Run fn over items with at most n in flight.
async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

const cacheDirFor = (storageDir, rootUri) =>
  path.join(storageDir, 'tex', crypto.createHash('sha1').update(String(rootUri)).digest('hex').slice(0, 16));

// Copy the tree under dirUri into <cacheDir>/src. Returns stats, or { tooBig: true, totalBytes } when over the limit.
async function mirror(vscode, dirUri, cacheDir, opts) {
  const t0 = Date.now();
  const o = opts || {};
  const maxBytes = (o.maxMB || 200) * 1024 * 1024;
  const wfs = vscode.workspace.fs;
  const FT = vscode.FileType || { File: 1, Directory: 2 };
  const srcRoot = path.join(cacheDir, 'src');
  const manPath = path.join(cacheDir, 'manifest.json');
  let manifest = {};
  if (!o.force) { try { manifest = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) { manifest = {}; } }
  fs.mkdirSync(srcRoot, { recursive: true });

  // 1. Scan: list directories (limited concurrency), stat the wanted files.
  const found = []; // { rel, uri, size, mtime }
  let scanned = 0;
  let level = [{ rel: '', uri: dirUri }];
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next = [];
    const files = [];
    await pool(level, CONCURRENCY, async (d) => {
      let ents = [];
      try { ents = await wfs.readDirectory(d.uri); } catch (e) { return; }
      for (const [name, type] of ents) {
        scanned++;
        if (name.startsWith('.')) continue;
        const rel = d.rel ? d.rel + '/' + name : name;
        const isDir = (type & FT.Directory) !== 0;
        if (isDir) { if (!SKIP_DIRS.has(name) && depth < MAX_DEPTH) next.push({ rel, uri: vscode.Uri.joinPath(d.uri, name) }); continue; }
        const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
        if (EXTS.has(ext)) files.push({ rel, uri: vscode.Uri.joinPath(d.uri, name) });
      }
    });
    await pool(files, CONCURRENCY, async (f) => {
      try {
        const st = await wfs.stat(f.uri);
        if (st.size > MAX_FILE) return;
        f.size = st.size; f.mtime = st.mtime; found.push(f);
      } catch (e) { /* vanished */ }
    });
    level = next;
  }
  const totalBytes = found.reduce((a, f) => a + f.size, 0);
  if (totalBytes > maxBytes) {
    return { tooBig: true, totalBytes, scanned, files: found.length, ms: Date.now() - t0 };
  }

  // 2. Copy files whose size or mtime changed (or that are missing in the cache).
  const todo = found.filter((f) => {
    const m = manifest[f.rel];
    return !m || m.size !== f.size || m.mtime !== f.mtime || !fs.existsSync(path.join(srcRoot, f.rel));
  });
  let copied = 0; let bytes = 0;
  const next = {};
  for (const f of found) next[f.rel] = { size: f.size, mtime: f.mtime };
  await pool(todo, CONCURRENCY, async (f) => {
    try {
      const data = await wfs.readFile(f.uri);
      const dst = path.join(srcRoot, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, data);
      copied++; bytes += data.byteLength;
    } catch (e) { delete next[f.rel]; }
  });

  // 3. Delete cached files that are gone from the source.
  let removed = 0;
  const keep = new Set(Object.keys(next));
  (function walk(dir, rel) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (!keep.has(r)) { try { fs.unlinkSync(path.join(dir, e.name)); removed++; } catch (x) { /* ignore */ } }
    }
  })(srcRoot, '');
  fs.writeFileSync(manPath, JSON.stringify(next));
  return { tooBig: false, scanned, files: found.length, copied, bytes, removed, totalBytes, ms: Date.now() - t0 };
}

const uncomment = (t) => String(t).replace(/(^|[^\\])%.*$/gm, '$1');

// Engine from the root text and its preamble files (local .tex/.sty/.cls found in the mirror, depth 2).
function detectEngine(rootFile) {
  const dir = path.dirname(rootFile);
  const seen = new Set();
  const texts = [];
  const add = (p, depth) => {
    if (seen.has(p) || seen.size > 30) return;
    seen.add(p);
    let t;
    try { t = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
    texts.push(t);
    if (depth >= 2) return;
    const u = uncomment(t);
    const cand = [];
    let m;
    const re = /\\(?:input|include|usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    while ((m = re.exec(u))) for (const n of m[1].split(',')) cand.push(n.trim());
    for (const n of cand) {
      if (!n) continue;
      for (const ext of ['', '.tex', '.sty', '.cls']) {
        const f = path.join(dir, n + ext);
        if (/\.(tex|sty|cls)$/.test(f) && fs.existsSync(f)) { add(f, depth + 1); break; }
      }
    }
  };
  add(rootFile, 0);
  const raw = texts[0] || '';
  const mm = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(raw.split('\n').slice(0, 20).join('\n'));
  if (mm) {
    const p = mm[1].toLowerCase();
    if (p === 'xelatex') return 'xelatex';
    if (p === 'lualatex') return 'lualatex';
    if (p === 'pdflatex') return 'pdflatex';
  }
  const all = uncomment(texts.join('\n'));
  if (/\\directlua|\\luaexec|\{luacode\*?\}|\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexja|luatexbase|lualatex-math)\b/.test(all)) return 'lualatex';
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|xeCJK|polyglossia)\b/.test(all)) return 'xelatex';
  return 'pdflatex';
}
const usesBiblatex = (rootFile) => { try { return /\\usepackage(?:\[[^\]]*\])?\{[^}]*\bbiblatex\b/.test(uncomment(fs.readFileSync(rootFile, 'utf8'))); } catch (e) { return false; } };

// First error of a TeX log with two lines of context, plus a friendly text for a missing package.
function parseLog(logText) {
  if (!logText) return null;
  const lines = logText.split(/\r?\n/);
  let at = lines.findIndex((l) => /^! /.test(l));
  if (at < 0) at = lines.findIndex((l) => /^(?:\.\/)?[^\s:][^:]*\.(?:tex|sty|cls|bbl|def|cfg|clo|fd|ldf|bst):\d+: /.test(l));
  if (at < 0) return null;
  const text = lines.slice(at, at + 3).join('\n');
  const mp = /File [`'‘]([^'’]+\.(?:sty|cls))['’] not found/.exec(lines.slice(at, at + 3).join('\n'));
  if (mp) {
    const f = mp[1]; const pkg = f.replace(/\.(sty|cls)$/, '');
    return { text, missing: f, banner: `Missing package ${f}. Install with: sudo tlmgr install ${pkg} (BasicTeX). Or run 'tlmgr search --global --file ${f}' to find the package name.` };
  }
  return { text, banner: text };
}

// One compile per root at a time; a request during a run sets `rerun`.
class Compiler {
  constructor() { this.state = new Map(); }

  // run(): async () => result. Returns the results of every run it started, via onDone.
  request(key, run, onDone) {
    let s = this.state.get(key);
    if (!s) { s = { running: false, rerun: false }; this.state.set(key, s); }
    if (s.running) { s.rerun = true; return false; }
    s.running = true;
    (async () => {
      try {
        do {
          s.rerun = false;
          let res;
          try { res = await run(); } catch (e) { res = { ok: false, banner: 'Compile failed: ' + (e && e.message) }; }
          onDone(res, s.rerun);
        } while (s.rerun);
      } finally { s.running = false; }
    })();
    return true;
  }
}

// Run latexmk for rootFile (in the mirror). Resolves { ok, ms, engine, pdf, logPath, banner }.
function compile(rootFile, cacheDir, o) {
  const outDir = path.join(cacheDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(rootFile).replace(/\.tex$/i, '');
  const logPath = path.join(outDir, base + '.log');
  const pdfPath = path.join(outDir, base + '.pdf');
  const engine = detectEngine(rootFile);
  const flag = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[engine];
  const args = [flag, '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', '-synctex=1', '-outdir=' + outDir];
  if (o.force) args.push('-g');
  args.push(path.basename(rootFile));
  const env = Object.assign({}, process.env, { PATH: (o.texPath ? o.texPath + ':' : '') + (process.env.PATH || '') });
  const t0 = Date.now();
  try { fs.unlinkSync(logPath); } catch (e) { /* none */ }
  return new Promise((resolve) => {
    let out = ''; let settled = false; let timedOut = false; let child;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(Object.assign({ engine, logPath, pdfPath, ms: Date.now() - t0 }, r)); };
    const noTex = `TeX not found. Set paperMd.tex.texPath to the folder that holds latexmk and ${engine} (for example /Library/TeX/texbin on macOS).`;
    try {
      child = spawn('latexmk', args, { cwd: path.dirname(rootFile), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { done({ ok: false, banner: noTex }); return; }
    const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (x) { /* gone */ } }
    }, o.timeoutMs || 180000);
    child.on('error', (e) => {
      done({ ok: false, banner: e && e.code === 'ENOENT' ? noTex : 'Could not start latexmk: ' + (e && e.message) });
    });
    child.on('close', (code) => {
      if (timedOut) { done({ ok: false, timedOut: true, banner: `Compile timed out after ${Math.round((o.timeoutMs || 180000) / 1000)} s and was killed.` }); return; }
      let logText = ''; try { logText = fs.readFileSync(logPath, 'utf8'); } catch (e) { /* no log */ }
      if (code === 0 && fs.existsSync(pdfPath)) { done({ ok: true, pdf: pdfPath }); return; }
      const pe = parseLog(logText);
      let banner;
      if (pe) banner = pe.banner;
      else if (/not found|No such file|not recognized|Cannot find/i.test(out) && !logText) banner = noTex + '\n' + out.trim().split('\n').slice(-3).join('\n');
      else banner = 'latexmk failed (exit ' + code + '). ' + out.trim().split('\n').slice(-4).join('\n');
      if (usesBiblatex(rootFile) && /biber/i.test(out + logText) && /not found|Can't locate|fail|could not/i.test(out + logText)) {
        banner += '\nThis document uses biblatex with biber, and biber is missing. Copy a current .bbl file next to the root document, or install biber.';
      }
      done({ ok: false, code, banner, parsed: pe });
    });
  });
}

module.exports = { mirror, detectEngine, parseLog, compile, Compiler, cacheDirFor, pool, EXTS };
