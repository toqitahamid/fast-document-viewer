'use strict';
// Compile-based LaTeX preview: mirror a root's folder tree to local disk, pick an engine,
// run latexmk, and turn its log into a short error. No vscode state is kept here.
// `vscode` is used only for Uri.joinPath and FileType, so the mirror works with any workspace.fs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTS = new Set('tex sty cls bst bib bbx cbx dbx lbx def cfg clo fd ldf png jpg jpeg gif pdf eps ps svg ttf otf ttc woff woff2 bbl ist pfb afm tfm vf map enc'.split(' '));
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

const P = path.posix;
const stripComments = (t) => String(t).replace(/(^|[^\\])%.*$/gm, '$1');

// Relative references that leave the root folder (fonts, shared .sty, images, bib files...).
// TeX resolves them against the compile folder, so every path is resolved against the root folder.
// Returns { base: Uri, relRoot, targets: [{ kind: 'tree'|'file'|'prefix', uri }], warnings: [] }.
async function findExternal(vscode, rootFileUri, o) {
  const wfs = vscode.workspace.fs;
  const R = P.dirname(rootFileUri.path);
  const at = (p) => rootFileUri.with({ path: p });
  const readText = async (p) => { try { return Buffer.from(await wfs.readFile(at(p))).toString('utf8'); } catch (e) { return null; } };
  const inside = (p) => p === R || p.startsWith(R + '/');
  const ext = new Map(); // key -> { kind, path }
  const warnings = [];
  const addExt = (kind, p) => { if (!inside(p)) ext.set(kind + ':' + p, { kind, path: p }); };
  const res = (rel) => P.resolve(R, String(rel).trim().replace(/^\{|\}$/g, ''));
  const seen = new Set();
  const queue = [{ p: rootFileUri.path, d: 0 }];
  const maxDepth = (o && o.maxDepth) || 4;
  const follow = (rel, exts, d) => {
    const base = res(rel);
    const cands = /\.[A-Za-z0-9]+$/.test(base) && exts.some((e) => base.endsWith(e)) ? [base] : exts.map((e) => base + e);
    for (const c of cands) if (!seen.has(c)) queue.push({ p: c, d: d + 1, optional: true });
  };
  while (queue.length && seen.size < 200) {
    const { p, d } = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const raw = await readText(p);
    if (raw === null) continue;
    if (!inside(p) && p !== rootFileUri.path) { /* an external file is itself a target already */ }
    const t = stripComments(raw);
    let m;
    // '% !TEX def = \def\x{path}' in the root: values that look like paths are
    // usually \input later (\input{\x}); mirror the folder that holds them.
    if (p === rootFileUri.path) {
      const head = raw.split('\n').slice(0, 30).join('\n');
      for (const re = /^\s*%\s*!\s*TEX\s+def\s*=\s*(.+)$/gim; (m = re.exec(head));) {
        for (const re2 = /\\(?:def|gdef|edef|newcommand|renewcommand)\s*\{?\\[A-Za-z@]+\}?\s*\{([^{}]+)\}/g, line = m[1]; (m = re2.exec(line));) {
          const v = m[1].trim();
          if (!v || /\s/.test(v) || /^\d/.test(v)) continue;
          const full = res(v);
          addExt('tree', P.dirname(full));
          if (d < maxDepth) follow(v, ['.tex'], d);
        }
        m = null;
      }
    }
    const argRe = (cmds) => new RegExp('\\\\(?:' + cmds + ')\\s*(?:\\[[^\\]]*\\])?\\s*\\{([^}]*)\\}', 'g');
    // .tex inputs
    for (const re = argRe('input|include|subfile|subfileinclude'); (m = re.exec(t));) {
      const rel = m[1].trim(); if (!rel) continue;
      const base = res(rel); const full = /\.tex$/i.test(base) ? base : base + '.tex';
      addExt('file', full); if (d < maxDepth) follow(rel, ['.tex'], d);
    }
    // packages and classes: local ones are followed, path-like ones may be external
    for (const re = argRe('usepackage|RequirePackage|documentclass'); (m = re.exec(t));) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const base = res(n);
        if (/[\/]/.test(n)) { addExt('file', /\.(sty|cls)$/.test(base) ? base : base + (/documentclass/.test(m[0]) ? '.cls' : '.sty')); }
        if (d < maxDepth) follow(n, ['.sty', '.cls'], d);
      }
    }
    // fontspec: Path=dir in any option list
    for (const re = /\bPath\s*=\s*\{?\s*([^,\]\}\s]+)/g; (m = re.exec(t));) addExt('tree', res(m[1]));
    // graphics
    for (const re = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g; (m = re.exec(t));) {
      for (const g of m[1].match(/\{[^}]*\}/g) || []) addExt('tree', res(g));
    }
    for (const re = argRe('includegraphics'); (m = re.exec(t));) {
      const base = res(m[1]);
      addExt(/\.[A-Za-z0-9]{2,4}$/.test(base) ? 'file' : 'prefix', base);
    }
    // bibliographies and listings
    for (const re = argRe('bibliography|addbibresource|addglobalbib'); (m = re.exec(t));) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const base = res(n); addExt('file', /\.bib$/.test(base) ? base : base + '.bib');
      }
    }
    for (const re = argRe('lstinputlisting|inputminted|verbatiminput|VerbatimInput'); (m = re.exec(t));) addExt('file', res(m[m.length - 1]));
    // \import{dir}{file}
    for (const re = /\\(?:sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g; (m = re.exec(t));) {
      addExt('tree', res(m[1]));
      const f = P.resolve(res(m[1]), m[2].trim()); addExt('file', /\.tex$/.test(f) ? f : f + '.tex');
      if (d < maxDepth) follow(P.join(m[1], m[2]), ['.tex'], d);
    }
  }
  // Cap: at most 4 levels above the root folder.
  const rootParts = R.split('/').filter(Boolean);
  let base = R; const targets = [];
  const common = (a, b) => { const x = a.split('/').filter(Boolean), y = b.split('/').filter(Boolean); const out = []; for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i]); return '/' + out.join('/'); };
  for (const e of ext.values()) {
    const dir = e.kind === 'tree' ? e.path : P.dirname(e.path);
    const c = common(base, dir);
    if (rootParts.length - c.split('/').filter(Boolean).length > 4) { warnings.push('ignored ' + e.path + ' (more than 4 levels above the root folder)'); continue; }
    base = c; targets.push(e);
  }
  // Keep only targets that exist: a missing one is not an error here (LaTeX reports it).
  return { base: at(base), relRoot: P.relative(base, R), targets: targets.map((e) => ({ kind: e.kind, uri: at(e.path) })), warnings };
}

// Copy the root folder tree and the external targets into <cacheDir>/src, keeping their layout relative to `baseUri`.
// Returns stats, or { tooBig: true, totalBytes } when over the limit.
async function mirror(vscode, dirUri, cacheDir, opts) {
  const t0 = Date.now();
  const o = opts || {};
  const maxBytes = (o.maxMB || 200) * 1024 * 1024;
  const wfs = vscode.workspace.fs;
  const FT = vscode.FileType || { File: 1, Directory: 2 };
  const baseUri = o.baseUri || dirUri;
  const rel0 = (u) => P.relative(baseUri.path, u.path);
  const srcRoot = path.join(cacheDir, 'src');
  const manPath = path.join(cacheDir, 'manifest.json');
  const baseKey = baseUri.toString();
  let manifest = {};
  if (!o.force) {
    try {
      const j = JSON.parse(fs.readFileSync(manPath, 'utf8'));
      if (j && j.v === 2 && j.base === baseKey) manifest = j.files; else fs.rmSync(srcRoot, { recursive: true, force: true }); // layout changed: start over once
    } catch (e) { manifest = {}; }
  } else fs.rmSync(srcRoot, { recursive: true, force: true });
  fs.mkdirSync(srcRoot, { recursive: true });

  const found = new Map(); // rel -> { rel, uri, size, mtime }
  let scanned = 0;
  const extFolders = [];
  const wanted = (name) => EXTS.has(name.includes('.') ? name.split('.').pop().toLowerCase() : '');
  const statInto = async (files) => {
    await pool(files, CONCURRENCY, async (f) => {
      try {
        const st = await wfs.stat(f.uri);
        if (st.size > MAX_FILE) return;
        f.size = st.size; f.mtime = st.mtime; found.set(f.rel, f);
      } catch (e) { /* vanished */ }
    });
  };
  // Scan one tree (limited concurrency), depth <= MAX_DEPTH below its start.
  const scanTree = async (startUri) => {
    let level = [{ uri: startUri }];
    for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
      const next = []; const files = [];
      await pool(level, CONCURRENCY, async (d) => {
        let ents = [];
        try { ents = await wfs.readDirectory(d.uri); } catch (e) { return; }
        for (const [name, type] of ents) {
          scanned++;
          if (name.startsWith('.')) continue;
          const u = vscode.Uri.joinPath(d.uri, name);
          if ((type & FT.Directory) !== 0) { if (!SKIP_DIRS.has(name) && depth < MAX_DEPTH) next.push({ uri: u }); continue; }
          if (wanted(name)) files.push({ rel: rel0(u), uri: u });
        }
      });
      await statInto(files);
      level = next;
    }
  };
  await scanTree(dirUri);
  for (const tg of o.extra || []) {
    if (tg.kind === 'tree') { extFolders.push(rel0(tg.uri) || '.'); await scanTree(tg.uri); }
    else if (tg.kind === 'file') {
      if (!found.has(rel0(tg.uri))) await statInto([{ rel: rel0(tg.uri), uri: tg.uri }]);
    } else { // prefix: files next to it with the same base name
      const dir = vscode.Uri.joinPath(tg.uri, '..'); const stem = P.basename(tg.uri.path);
      let ents = []; try { ents = await wfs.readDirectory(dir); } catch (e) { ents = []; }
      await statInto(ents.filter(([n, ty]) => !(ty & FT.Directory) && n.startsWith(stem + '.') && wanted(n)).map(([n]) => { const u = vscode.Uri.joinPath(dir, n); return { rel: rel0(u), uri: u }; }));
    }
  }
  const all = [...found.values()];
  const totalBytes = all.reduce((a, f) => a + f.size, 0);
  if (totalBytes > maxBytes) return { tooBig: true, totalBytes, scanned, files: all.length, ms: Date.now() - t0 };

  const todo = all.filter((f) => {
    const m = manifest[f.rel];
    return !m || m.size !== f.size || m.mtime !== f.mtime || !fs.existsSync(path.join(srcRoot, f.rel));
  });
  let copied = 0; let bytes = 0;
  const next = {};
  for (const f of all) next[f.rel] = { size: f.size, mtime: f.mtime };
  await pool(todo, CONCURRENCY, async (f) => {
    try {
      const data = await wfs.readFile(f.uri);
      const dst = path.join(srcRoot, f.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, data);
      copied++; bytes += data.byteLength;
    } catch (e) { delete next[f.rel]; }
  });

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
  fs.writeFileSync(manPath, JSON.stringify({ v: 2, base: baseKey, files: next }));
  return { tooBig: false, scanned, files: all.length, copied, bytes, removed, totalBytes, extFolders, base: baseKey, ms: Date.now() - t0 };
}

const uncomment = (t) => String(t).replace(/(^|[^\\])%.*$/gm, '$1');

function textsOf(rootFile) { return gather(rootFile); }
// Engine from the root text and its preamble files (local .tex/.sty/.cls found in the mirror, depth 2).
function gather(rootFile) {
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
  return texts;
}

function texDefs(rootFile) {
  let head = '';
  try { head = fs.readFileSync(rootFile, 'utf8').split('\n').slice(0, 30).join('\n'); } catch (e) { return ''; }
  const defs = [];
  const re = /^\s*%\s*!\s*TEX\s+def\s*=\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(head))) defs.push(m[1]);
  return defs.join('');
}

function detectEngine(rootFile) {
  const dir = path.dirname(rootFile);
  const texts = gather(rootFile);
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
function parseLog(logText, hint) {
  if (!logText) return null;
  const lines = logText.split(/\r?\n/);
  let at = lines.findIndex((l) => /^! /.test(l));
  if (at < 0) at = lines.findIndex((l) => /^(?:\.\/)?[^\s:][^:]*\.(?:tex|sty|cls|bbl|def|cfg|clo|fd|ldf|bst):\d+: /.test(l));
  if (at < 0) return null;
  const text = lines.slice(at, at + 3).join('\n');
  const mf = /Package fontspec Error:\s*\n?\s*The font [\"“]([^\"”]+)[\"”] cannot be found/.exec(lines.slice(at, at + 6).join('\n'));
  if (mf && !(hint && hint.fontPath)) {
    return { text, banner: `Font "${mf[1]}" not found. Install the font on this Mac (open the font file in Font Book), or give its folder with Path= in \\setmainfont or \\newfontfamily.` };
  }
  if (mf) return { text, banner: `Font "${mf[1]}" not found. Check that the Path= folder exists next to the paper's folders and holds the font files. ` + '\n' + text };
  const mp = /File [`'‘]([^'’]+\.(?:sty|cls))['’] not found/.exec(lines.slice(at, at + 3).join('\n'));
  if (mp) {
    const f = mp[1]; const pkg = f.replace(/\.(sty|cls)$/, '');
    return { text, missing: f, banner: `Missing package ${f}. Install with: sudo tlmgr install ${pkg} (BasicTeX). Or run 'tlmgr search --global --file ${f}' to find the package name.` };
  }
  if (/\\def\\[A-Za-z@]+|\bpass (?:the )?[\w ]*(?:path|file|argument)|command[- ]line/i.test(lines.slice(at, at + 4).join('\n'))) {
    return { text, needsArgs: true, banner: 'This template needs arguments before it can compile. Add lines like  % !TEX def = \\def\\name{value}  in the first 30 lines of the root file. The template says:\n' + text };
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
  // '% !TEX def = <TeX code>' lines in the root's first 30 lines run before the file,
  // like: xelatex "\def\x{..}\input{root}". Several lines are joined.
  const pre = texDefs(rootFile);
  if (pre) args.push('-usepretex=' + pre);
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
      const pe = parseLog(logText, { fontPath: /\bPath\s*=/.test(uncomment(textsOf(rootFile).join('\n'))) });
      let banner;
      if (pe) banner = pe.banner;
      else if (/not found|No such file|not recognized|Cannot find/i.test(out) && !logText) banner = noTex + '\n' + out.trim().split('\n').slice(-3).join('\n');
      else {
        // No usable .log: look for the error in latexmk's own output instead of its generic advice.
        const po = parseLog(out, {});
        const key = out.split(/\r?\n/).filter((l) => /^! |:\d+: |^Latexmk: .*(?:[Ee]rror|not found|[Mm]issing|[Ff]ailed|[Bb]ad option|[Uu]nknown)/.test(l));
        banner = 'latexmk failed (exit ' + code + '). ' + (po ? po.banner : key.length ? key.slice(0, 4).join('\n') : out.trim().split('\n').slice(-4).join('\n'));
      }
      if (usesBiblatex(rootFile) && /biber/i.test(out + logText) && /not found|Can't locate|fail|could not/i.test(out + logText)) {
        banner += '\nThis document uses biblatex with biber, and biber is missing. Copy a current .bbl file next to the root document, or install biber.';
      }
      done({ ok: false, code, banner, parsed: pe });
    });
  });
}

module.exports = { texDefs, findExternal, mirror, detectEngine, parseLog, compile, Compiler, cacheDirFor, pool, EXTS };
