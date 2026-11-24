'use strict';
// Compile-based LaTeX preview: mirror a root's folder tree to local disk, pick an engine,
// run latexmk, and turn its log into a short error. No vscode state is kept here.
// `vscode` is used only for Uri.joinPath and FileType, so the mirror works with any workspace.fs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXTS = new Set('tex sty cls bst bib bibtex bbx cbx dbx lbx def cfg clo fd ldf png jpg jpeg gif pdf eps ps svg ttf otf ttc woff woff2 bbl ist pfb afm tfm vf map enc csv tsv dat txt json tikz pgf asy mp md lua'.split(' '));
// Build output and editor litter: not worth reporting as "skipped".
const IGNORABLE = /(?:\.(?:aux|log|out|toc|lof|lot|fls|fdb_latexmk|synctex|gz|blg|bcf|run\.xml|nav|snm|vrb|dvi|xdv|idx|ilg|ind|glo|gls|ds_store)|^latexmkrc|~)$/i;
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
  // Resolve a reference against the root folder. Absolute paths and paths more than 4 levels above the root are refused (null).
  const refusedSet = new Set();
  const refuse = (s, why) => { if (!refusedSet.has(s)) { refusedSet.add(s); warnings.push('ignored ' + s + ' (' + why + ')'); } return null; };
  const res = (rel) => {
    const s = String(rel).trim().replace(/^\{|\}$/g, '');
    if (!s) return null;
    if (/^(?:[\\/]|~|[A-Za-z]:[\\/])/.test(s)) return refuse(s, 'absolute path');
    const full = P.resolve(R, s);
    if (P.relative(R, full).split('/').filter((x) => x === '..').length > 4) return refuse(s, 'more than 4 levels above the root folder');
    return full;
  };
  const seen = new Set();
  const queue = [{ p: rootFileUri.path, d: 0 }];
  const maxDepth = (o && o.maxDepth) || 4;
  const follow = (rel, exts, d) => {
    const base = res(rel);
    if (!base) return;
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
          if (!full) continue;
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
      const base = res(rel); if (!base) continue;
      const full = /\.tex$/i.test(base) ? base : base + '.tex';
      addExt('file', full); if (d < maxDepth) follow(rel, ['.tex'], d);
    }
    // packages and classes: local ones are followed, path-like ones may be external
    for (const re = argRe('usepackage|RequirePackage|documentclass'); (m = re.exec(t));) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const base = res(n);
        if (base && /[\/]/.test(n)) { addExt('file', /\.(sty|cls)$/.test(base) ? base : base + (/documentclass/.test(m[0]) ? '.cls' : '.sty')); }
        if (d < maxDepth) follow(n, ['.sty', '.cls'], d);
      }
    }
    // fontspec: Path=dir in any option list
    for (const re = /\bPath\s*=\s*\{?\s*([^,\]\}\s]+)/g; (m = re.exec(t));) { const d0 = res(m[1]); if (d0) addExt('tree', d0); }
    // graphics
    for (const re = /\\graphicspath\s*\{((?:\s*\{[^}]*\}\s*)+)\}/g; (m = re.exec(t));) {
      for (const g of m[1].match(/\{[^}]*\}/g) || []) { const d0 = res(g); if (d0) addExt('tree', d0); }
    }
    for (const re = argRe('includegraphics'); (m = re.exec(t));) {
      const base = res(m[1]); if (!base) continue;
      addExt(/\.[A-Za-z0-9]{2,4}$/.test(base) ? 'file' : 'prefix', base);
    }
    // bibliographies and listings
    for (const re = argRe('bibliography|addbibresource|addglobalbib'); (m = re.exec(t));) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        const base = res(n); if (!base) continue;
        addExt('file', /\.bib$/.test(base) ? base : base + '.bib');
      }
    }
    for (const re = argRe('lstinputlisting|inputminted|verbatiminput|VerbatimInput'); (m = re.exec(t));) { const f0 = res(m[m.length - 1]); if (f0) addExt('file', f0); }
    // \import{dir}{file}
    for (const re = /\\(?:sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g; (m = re.exec(t));) {
      const dir = res(m[1]); if (!dir) continue;
      addExt('tree', dir);
      const f = res(P.join(m[1].trim(), m[2].trim())); if (!f) continue;
      addExt('file', /\.tex$/.test(f) ? f : f + '.tex');
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
  const FT = vscode.FileType || { File: 1, Directory: 2, SymbolicLink: 64 };
  const SL = FT.SymbolicLink || 64;
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
  // Files left out of the mirror, by reason, so a "file not found" in the log can be explained.
  const skipped = { ext: 0, big: 0, deep: 0, dot: 0, symlink: 0, outside: 0, examples: [] };
  const skipSeen = new Set(); // a file reached twice (scan and reference) is counted once
  const skip = (reason, name, key) => { const k = reason + ':' + (key || name); if (skipSeen.has(k)) return; skipSeen.add(k); skipped[reason]++; if (skipped.examples.length < 10) skipped.examples.push(name); };
  const statInto = async (files) => {
    await pool(files, CONCURRENCY, async (f) => {
      if (P.isAbsolute(f.rel) || /^\.\.(?:\/|$)/.test(f.rel)) { skip('outside', f.rel); return; }
      try {
        const st = await wfs.stat(f.uri);
        if ((st.type & SL) !== 0) { skip('symlink', f.rel); return; }
        if (st.size > MAX_FILE) { skip('big', f.rel); return; }
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
          const isDir = (type & FT.Directory) !== 0;
          if (name.startsWith('.')) { if (!isDir && !IGNORABLE.test(name)) skip('dot', name); continue; }
          if ((type & SL) !== 0) { skip('symlink', name); continue; } // never follow symlinks
          const u = vscode.Uri.joinPath(d.uri, name);
          if (isDir) {
            if (SKIP_DIRS.has(name)) continue;
            if (depth < MAX_DEPTH) next.push({ uri: u }); else skip('deep', name + '/');
            continue;
          }
          if (wanted(name)) files.push({ rel: rel0(u), uri: u });
          else if (!IGNORABLE.test(name)) skip('ext', name, rel0(u));
        }
      });
      await statInto(files);
      level = next;
    }
  };
  await scanTree(dirUri);
  for (const tg of o.extra || []) {
    if (tg.kind === 'tree') {
      try { if (((await wfs.stat(tg.uri)).type & SL) !== 0) { skip('symlink', rel0(tg.uri)); continue; } } catch (e) { continue; }
      extFolders.push(rel0(tg.uri) || '.'); await scanTree(tg.uri);
    } else if (tg.kind === 'file') {
      const nm = P.basename(tg.uri.path);
      if (!wanted(nm)) { if (!IGNORABLE.test(nm)) skip('ext', nm, rel0(tg.uri)); continue; }
      if (!found.has(rel0(tg.uri))) await statInto([{ rel: rel0(tg.uri), uri: tg.uri }]);
    } else { // prefix: files next to it with the same base name
      const dir = vscode.Uri.joinPath(tg.uri, '..'); const stem = P.basename(tg.uri.path);
      let ents = []; try { ents = await wfs.readDirectory(dir); } catch (e) { ents = []; }
      await statInto(ents.filter(([n, ty]) => !(ty & FT.Directory) && n.startsWith(stem + '.') && wanted(n)).map(([n]) => { const u = vscode.Uri.joinPath(dir, n); return { rel: rel0(u), uri: u }; }));
    }
  }
  const all = [...found.values()];
  const totalBytes = all.reduce((a, f) => a + f.size, 0);
  if (totalBytes > maxBytes) return { tooBig: true, totalBytes, scanned, files: all.length, skipped, ms: Date.now() - t0 };

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
      if (path.relative(srcRoot, dst).split(path.sep)[0] === '..') throw new Error('outside the mirror');
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
  return { tooBig: false, scanned, files: all.length, copied, bytes, removed, totalBytes, extFolders, skipped, base: baseKey, ms: Date.now() - t0 };
}

// One line for the banner when the mirror left files out, e.g. 'Not copied: 2 with an unknown extension (a.xyz), 1 over 25 MB'. '' when none.
function skippedNote(sk) {
  if (!sk) return '';
  const parts = [];
  if (sk.ext) parts.push(sk.ext + ' with an unknown extension');
  if (sk.big) parts.push(sk.big + ' over ' + MAX_FILE / 1048576 + ' MB');
  if (sk.deep) parts.push(sk.deep + ' folder(s) deeper than ' + MAX_DEPTH + ' levels');
  if (sk.dot) parts.push(sk.dot + ' dot-file(s)');
  if (sk.symlink) parts.push(sk.symlink + ' symlink(s)');
  if (sk.outside) parts.push(sk.outside + ' outside the mirror');
  return parts.length ? 'Not copied to the preview folder: ' + parts.join(', ') + (sk.examples && sk.examples.length ? ' (for example ' + sk.examples.slice(0, 5).join(', ') + ')' : '') + '.' : '';
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

// '% !TEX def = <TeX code>' lines in the first 30 lines. Returns { lines, rejected: [{ line, why }] }.
// Only \def, \newcommand, \renewcommand, \providecommand and \let lines without shell-significant characters are accepted.
const DEF_START = /^\\(?:def|newcommand|renewcommand|providecommand|let)(?![A-Za-z])/;
const DEF_BAD = /["$`|;&\r\n\x00]/;
function texDefsInfo(rootFile) {
  let head = '';
  try { head = fs.readFileSync(rootFile, 'utf8').split('\n').slice(0, 30).join('\n'); } catch (e) { return { lines: [], rejected: [] }; }
  const lines = []; const rejected = [];
  const re = /^\s*%\s*!\s*TEX\s+def\s*=\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(head))) {
    const l = m[1];
    if (DEF_BAD.test(l)) rejected.push({ line: l, why: 'contains a character that is not allowed (" $ ` | ; & or a control character)' });
    else if (!DEF_START.test(l)) rejected.push({ line: l, why: 'does not start with \\def, \\newcommand, \\renewcommand, \\providecommand or \\let' });
    else lines.push(l);
  }
  return { lines, rejected };
}
const texDefs = (rootFile) => texDefsInfo(rootFile).lines.join('');

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
  if (/\\directlua|\\luaexec|\{luacode\*?\}|\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexja|luatexbase|lualatex-math)\b/.test(all)) return 'lualatex';
  if (/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|xeCJK|polyglossia)\b/.test(all)) return 'xelatex';
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
  // Only a missing template argument: an undefined \name that the context shows as a \def\name, or the template's own "pass the ... path" message.
  // A "Runaway definition" or any other error that merely mentions \def must not trigger this.
  const first = lines[at]; const ctx = lines.slice(at, at + 4).join('\n');
  const undef = /^! Undefined control sequence/.test(first) && /\\def\\[A-Za-z@]+/.test(ctx);
  const tmpl = /^! .*\bpass (?:the )?[\w ]*(?:path|file|argument)/i.test(first) && !/Runaway/i.test(first);
  if (undef || tmpl) {
    return { text, needsArgs: true, banner: 'This template needs arguments before it can compile. Add lines like  % !TEX def = \\def\\name{value}  in the first 30 lines of the root file. The template says:\n' + text };
  }
  return { text, banner: text };
}

// One compile per root at a time. A request during a run replaces the pending one (latest run/onDone win)
// and the run is repeated once afterwards; a `force` request made meanwhile is remembered.
class Compiler {
  constructor() { this.state = new Map(); }

  // run({ force }): async () => result. onDone(result, rerunPending) fires after every run, even if run or onDone throws.
  request(key, run, onDone, force) {
    let s = this.state.get(key);
    if (!s) { s = { running: false, next: null, force: false }; this.state.set(key, s); }
    s.next = { run, onDone };
    if (force) s.force = true;
    if (s.running) return false;
    s.running = true;
    (async () => {
      try {
        while (s.next) {
          const cur = s.next; s.next = null;
          const f = s.force; s.force = false;
          let res;
          try { res = await cur.run({ force: f }); } catch (e) { res = { ok: false, banner: 'Compile failed: ' + (e && e.message) }; }
          try { cur.onDone(res, !!s.next); } catch (e) { /* a failing status callback must not stop the queue */ }
        }
      } finally { s.running = false; }
    })();
    return true;
  }
}

// ---- running latexmk ----
const live = new Set(); // running latexmk children

// Kill a child and everything it started (the engine and helpers run under latexmk).
function killTree(child, platform) {
  if (!child || !child.pid) return;
  if ((platform || process.platform) === 'win32') {
    try { const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('error', () => { /* ignore */ }); }
    catch (e) { try { child.kill(); } catch (x) { /* gone */ } }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (x) { /* gone */ } }
}

// Kill every running compile (call on deactivate). Returns how many were killed.
function killAll() {
  let n = 0;
  for (const c of [...live]) { c.fdvKilled = true; killTree(c); n++; }
  return n;
}

// Where TeX usually lives when the user has not set a path. win32: MiKTeX and TeX Live are on PATH.
function defaultTexPath(platform, fsImpl) {
  const pf = platform || process.platform; const f = fsImpl || fs;
  if (pf === 'darwin') return '/Library/TeX/texbin';
  if (pf === 'win32') return '';
  const dirs = [];
  try { // /usr/local/texlive/<year>/bin/<arch>, newest year first
    const root = '/usr/local/texlive';
    for (const y of f.readdirSync(root).sort().reverse()) {
      const b = root + '/' + y + '/bin';
      let archs = []; try { archs = f.readdirSync(b); } catch (e) { archs = []; }
      for (const a of archs.sort()) dirs.push(b + '/' + a);
    }
  } catch (e) { /* no TeX Live under /usr/local */ }
  dirs.push('/usr/bin');
  return dirs.join(':');
}

// Folders to put in front of PATH: the configured texPath if it exists, else the platform default (existing folders only).
function texPathDirs(configured, platform, fsImpl) {
  const pf = platform || process.platform; const f = fsImpl || fs;
  const delim = (pf === 'win32' ? path.win32 : path.posix).delimiter;
  const keep = (list) => String(list || '').split(delim).map((x) => x.trim()).filter((x) => x && f.existsSync(x));
  const c = keep(configured);
  return c.length ? c : keep(defaultTexPath(pf, f));
}

// Characters that latexmk's shell would act on inside double quotes (it runs the engine through a shell).
const UNSAFE_NAME = /["$`|;&\r\n\x00]/;

// Run latexmk for rootFile (in the mirror). Resolves { ok, ms, engine, pdf, logPath, pdfPath, banner, warnings }.
// o: { texPath, force, timeoutMs, platform, skipped }.
function compile(rootFile, cacheDir, o) {
  o = o || {};
  const platform = o.platform || process.platform;
  const outDir = path.join(cacheDir, 'out');
  const rootBase = path.basename(rootFile);
  const base = rootBase.replace(/\.tex$/i, '');
  const logPath = path.join(outDir, base + '.log');
  const pdfPath = path.join(outDir, base + '.pdf');
  const cwd = path.dirname(rootFile);
  const engine = detectEngine(rootFile);
  const early = (banner) => Promise.resolve({ ok: false, engine, logPath, pdfPath, ms: 0, banner, warnings });
  const warnings = [];
  if (UNSAFE_NAME.test(rootBase) || UNSAFE_NAME.test(outDir)) return early('Cannot compile: the file name or cache folder contains a character that is unsafe for the TeX runner (one of " $ ` | ; & or a line break). Rename the file.');
  if (!fs.existsSync(cwd)) return early(`The working folder ${cwd} does not exist (the local copy of the paper is missing). Save the file or run the compile again to rebuild it.`);
  fs.mkdirSync(outDir, { recursive: true });
  const flag = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[engine];
  const args = [flag, '-interaction=nonstopmode', '-file-line-error', '-halt-on-error', '-synctex=1', '-outdir=' + outDir];
  // '% !TEX def = <TeX code>' lines run before the file. They go into a wrapper file next to the root
  // (never onto the command line, which latexmk passes through a shell). The wrapper is compiled with
  // -jobname=<root name>, so the log and PDF keep the root's name.
  const info = texDefsInfo(rootFile);
  for (const r of info.rejected) warnings.push('Ignored "% !TEX def = ' + r.line + '": ' + r.why + '.');
  let target = rootBase;
  if (info.lines.length) {
    if (/[{}\\%#~^]/.test(rootBase)) warnings.push('Ignored % !TEX def lines: the file name has characters TeX cannot take in \\input.');
    else {
      const wrapper = '_fdv_main.tex';
      const arg = /\s/.test(rootBase) ? '"./' + rootBase + '"' : './' + rootBase;
      try {
        fs.writeFileSync(path.join(cwd, wrapper), info.lines.join('\n') + '\n\\input{' + arg + '}\n');
        target = wrapper; args.push('-jobname=' + base);
      } catch (e) { warnings.push('Ignored % !TEX def lines: could not write the wrapper file (' + (e && e.message) + ').'); }
    }
  }
  if (o.force) args.push('-g');
  args.push('./' + target); // './' so a name starting with '-' is not read as an option
  const dirs = texPathDirs(o.texPath, platform).concat((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  const env = Object.assign({}, process.env, { PATH: dirs.join(path.delimiter) });
  const warnText = () => warnings.length ? '\n' + warnings.join('\n') : '';
  const t0 = Date.now();
  try { fs.unlinkSync(logPath); } catch (e) { /* none */ }
  return new Promise((resolve) => {
    let out = ''; let settled = false; let timedOut = false; let child; let timer;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); if (child) live.delete(child); resolve(Object.assign({ engine, logPath, pdfPath, ms: Date.now() - t0, warnings }, r)); };
    const noTex = `TeX not found. Set paperMd.tex.texPath to the folder that holds latexmk and ${engine} (for example /Library/TeX/texbin on macOS).`;
    try {
      child = spawn('latexmk', args, { cwd, env, detached: platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { done({ ok: false, banner: noTex + warnText() }); return; }
    live.add(child);
    const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-100000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    timer = setTimeout(() => { timedOut = true; killTree(child, platform); }, o.timeoutMs || 180000);
    child.on('error', (e) => {
      done({ ok: false, banner: (e && e.code === 'ENOENT' ? noTex : 'Could not start latexmk: ' + (e && e.message)) + warnText() });
    });
    child.on('close', (code) => {
      if (child.fdvKilled) { done({ ok: false, killed: true, banner: 'Compile cancelled.' }); return; }
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
      // A missing file in the log may be one the mirror left out: say so.
      const note = skippedNote(o.skipped);
      if (note && /not found|No such file|Cannot find|Unable to load|does not exist/i.test(banner + logText)) banner += '\n' + note;
      done({ ok: false, code, banner: banner + warnText(), parsed: pe });
    });
  });
}

module.exports = { texDefs, texDefsInfo, findExternal, mirror, skippedNote, detectEngine, parseLog, compile, Compiler, killAll, killTree, defaultTexPath, texPathDirs, cacheDirFor, pool, EXTS };
