'use strict';
// LaTeX to HTML approximation for the Paper MD Viewer. No TeX engine is used.
// texToHtml(text, opts) -> Promise<{ html, stats }>. It never throws.
//   opts.readFile(rel)      async, text of a file next to the main file, or null
//   opts.exists(rel)        async, true when the file exists (used to find images)
//   opts.resolveImage(rel)  sync, webview URL of an image file, or null
//   opts.baseName           main file name without extension (for .bbl and .aux)
const katex = require('katex');

// ---------- string helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const isWs = (c) => c === 32 || c === 10 || c === 9 || c === 13;
const isLet = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64;
const idOf = (k) => 'tex-' + String(k).replace(/[^A-Za-z0-9_:.\-]/g, '_');

function skipWs(s, i) { while (i < s.length && isWs(s.charCodeAt(i))) i++; return i; }

// s[i] === '{'. Returns { text, end } with end after the matching '}'.
function readGroup(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { text: s.slice(i + 1, j), end: j + 1 }; }
  }
  return { text: s.slice(i + 1), end: s.length };
}

// s[i] === '['. Returns { text, end } or null.
function readBracket(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth <= 0) return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

// One TeX argument: a group, a control sequence, or one character.
function readArg(s, i) {
  if (s[i] === '{') return readGroup(s, i);
  if (s[i] === '\\') {
    let j = i + 1;
    if (j < s.length && isLet(s.charCodeAt(j))) { while (j < s.length && isLet(s.charCodeAt(j))) j++; } else j++;
    return { text: s.slice(i, j), end: j };
  }
  return { text: s.slice(i, i + 1), end: i + 1 };
}

function findEnd(s, from, name) {
  const re = /\\(begin|end)\s*\{([^{}]*)\}/g;
  re.lastIndex = from;
  let d = 1; let m;
  while ((m = re.exec(s))) {
    if (m[2] !== name) continue;
    if (m[1] === 'begin') d++;
    else if (--d === 0) return { start: m.index, end: re.lastIndex };
  }
  return null;
}

// Split at top level (outside braces and nested environments). finder(s, i) returns the separator length or 0.
function splitAt(s, finder) {
  const out = []; let depth = 0; let env = 0; let last = 0;
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (depth === 0 && env === 0) {
      const L = finder(s, i);
      if (L) { out.push(s.slice(last, i)); i += L; last = i; continue; }
    }
    if (ch === '\\') {
      const nx = s.charCodeAt(i + 1);
      if (isLet(nx)) {
        if (s.startsWith('\\begin', i) && !isLet(s.charCodeAt(i + 6))) env++;
        else if (s.startsWith('\\end', i) && !isLet(s.charCodeAt(i + 4))) env = Math.max(0, env - 1);
        i++;
      } else i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    i++;
  }
  out.push(s.slice(last));
  return out;
}
const rowSep = (s, i) => {
  if (s[i] !== '\\') return 0;
  if (s.startsWith('\\tabularnewline', i)) return 15;
  if (s[i + 1] !== '\\') return 0;
  let j = i + 2;
  if (s[j] === '*') j++;
  let k = j; while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (s[k] === '[') { const b = readBracket(s, k); if (b && /^[\s\d.,+\-a-zA-Z\\]*$/.test(b.text)) j = b.end; }
  return j - i;
};
const cellSep = (s, i) => (s[i] === '&' ? 1 : 0);
const itemSep = (s, i) => (s[i] === '\\' && s.startsWith('\\item', i) && !isLet(s.charCodeAt(i + 5)) ? 5 : 0);
const bibitemSep = (s, i) => (s[i] === '\\' && s.startsWith('\\bibitem', i) && !isLet(s.charCodeAt(i + 8)) ? 8 : 0);

class AR { // argument reader over a string
  constructor(s) { this.s = s; this.i = 0; }
  opt() { const j = skipWs(this.s, this.i); if (this.s[j] === '[') { const b = readBracket(this.s, j); if (b) { this.i = b.end; return b.text; } } return null; }
  arg() { const j = skipWs(this.s, this.i); if (this.s[j] === '{') { const g = readGroup(this.s, j); this.i = g.end; return g.text; } return null; }
  rest() { return this.s.slice(this.i); }
}

const needsBlock = (str) => /\\begin\s*\{|\\(?:section|subsection|subsubsection|paragraph|maketitle|bibliography|item|caption|chapter|appendix)(?![a-zA-Z])|\n[ \t]*\n/.test(str);

// ---------- colors ----------
const NAMED = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255],
  magenta: [255, 0, 255], yellow: [255, 255, 0], gray: [128, 128, 128], grey: [128, 128, 128], orange: [255, 128, 0],
  purple: [191, 0, 64], brown: [191, 128, 64], olive: [128, 128, 0], pink: [255, 191, 191], teal: [0, 128, 128],
  violet: [128, 0, 191], lime: [191, 255, 0], darkgray: [64, 64, 64], lightgray: [191, 191, 191],
};
function colorRgb(st, name) {
  name = String(name).trim();
  return st.colors.get(name) || NAMED[name] || null;
}
function cssColor(st, spec) {
  if (!spec) return null;
  const parts = String(spec).trim().split('!');
  const a = colorRgb(st, parts[0]);
  if (!a) return null;
  if (parts.length === 1) return `rgb(${a[0]},${a[1]},${a[2]})`;
  const p = parseFloat(parts[1]) / 100;
  if (!(p >= 0)) return null;
  const b = parts[2] ? colorRgb(st, parts[2]) : [255, 255, 255];
  if (!b) return null;
  const mix = (k) => Math.round(a[k] * p + b[k] * (1 - p));
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}
function defineColor(st, name, model, spec) {
  let rgb = null;
  const nums = () => spec.split(',').map((x) => parseFloat(x));
  try {
    if (/^html$/i.test(model)) { const h = spec.replace('#', ''); if (/^[0-9a-f]{6}$/i.test(h)) rgb = [0, 2, 4].map((k) => parseInt(h.substr(k, 2), 16)); }
    else if (model === 'RGB') rgb = nums().map((x) => Math.round(x));
    else if (model === 'rgb') rgb = nums().map((x) => Math.round(x * 255));
    else if (model === 'gray') rgb = (() => { const v = Math.round(nums()[0] * 255); return [v, v, v]; })();
    else if (model === 'cmyk') { const [c, m, y, k] = nums(); rgb = [c, m, y].map((x) => Math.round(255 * (1 - x) * (1 - k))); }
  } catch (e) { rgb = null; }
  if (rgb && rgb.length === 3 && rgb.every((x) => x >= 0 && x <= 255)) st.colors.set(name, rgb);
}

// ---------- accents and symbols ----------
const ACC = { "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', d: '̣', b: '̱' };
const SYM = {
  eg: 'e.g.', ie: 'i.e.', etal: 'et al.', cf: 'cf.', etc: 'etc.', vs: 'vs.', ldots: '…', dots: '…', textellipsis: '…', LaTeX: 'LaTeX', TeX: 'TeX', BibTeX: 'BibTeX', S: '§', P: '¶',
  dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡', copyright: '©', textregistered: '®',
  texttrademark: '™', ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ',
  aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', textbullet: '•', textasciitilde: '~',
  textasciicircum: '^', textless: '&lt;', textgreater: '&gt;', textpm: '±', texttimes: '×', textdegree: '°',
  textbackslash: '\\', checkmark: '✓', cmark: '✓', xmark: '✗', textendash: '–', textemdash: '—',
  textquoteleft: '‘', textquoteright: '’', textquotedblleft: '“', textquotedblright: '”', textbar: '|',
  textunderscore: '_', textdollar: '$', textpercent: '%', textampersand: '&amp;', textsection: '§', pounds: '£', euro: '€',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ', hfill: ' ', ',': ' ', ';': ' ', ':': ' ', ' ': ' ',
  '%': '%', '&': '&amp;', _: '_', '#': '#', $: '$', '{': '{', '}': '}', '!': '', '/': '', '-': '', '@': '', '|': '|',
};
const XSPACE = new Set(['eg', 'ie', 'etal', 'cf', 'etc', 'vs']);
const NOOP = new Set(['onedot', 'undefined', 'centering', 'raggedright', 'raggedleft', 'noindent', 'indent', 'newpage', 'clearpage', 'cleardoublepage',
  'pagebreak', 'nopagebreak', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize',
  'normalfont', 'rmfamily', 'upshape', 'mdseries', 'selectfont', 'relax', 'protect', 'ignorespaces', 'xspace', 'strut', 'leavevmode',
  'null', 'nobreak', 'allowbreak', 'unskip', 'vfill', 'smallskip', 'medskip', 'bigskip', 'tableofcontents', 'listoffigures',
  'listoftables', 'makeatletter', 'makeatother', 'onecolumn', 'sloppy', 'fussy', 'raggedbottom', 'flushbottom', 'hline', 'toprule',
  'midrule', 'bottomrule', 'FloatBarrier', 'endhead', 'endfirsthead', 'endfoot', 'endlastfoot', 'frenchspacing', 'hrulefill',
  'dotfill', 'bgroup', 'egroup', 'begingroup', 'endgroup', 'nonumber', 'notag', 'selectlanguage', 'noalign', 'tabularnewline',
  'DontPrintSemicolon', 'SetAlgoLined', 'LinesNumbered', 'SetAlgoNoEnd', 'RestyleAlgo', 'newblock', 'urlprefix', 'bibsection',
  'footnotemark', 'sffamily', 'maketitle_', 'clubpenalty', 'widowpenalty', 'frontmatter', 'mainmatter', 'backmatter', 'printbibliography_',
  'hyphenpenalty', 'tolerance', 'emergencystretch', 'baselineskip', 'parindent', 'parskip', 'IEEEpeerreviewmaketitle', 'iccvfinalcopy']);
// name -> argument spec: '*' star, 'o' optional, 'a' mandatory
const IGN = {
  usepackage: 'oa', RequirePackage: 'oa', documentclass: 'oa', setlength: 'aa', addtolength: 'aa', setcounter: 'aa', addtocounter: 'aa',
  stepcounter: 'a', pagestyle: 'a', thispagestyle: 'a', bibliographystyle: 'a', hypersetup: 'a', setlist: 'oa', crefname: 'aaa',
  Crefname: 'aaa', definecolor: 'aaa', colorlet: 'aa', graphicspath: 'a', DeclareGraphicsExtensions: 'a', newlength: 'a',
  AtBeginDocument: 'a', AtEndDocument: 'a', externaldocument: 'oa', usetikzlibrary: 'a', lstset: 'a', floatname: 'aa',
  theoremstyle: 'a', numberwithin: 'aa', patchcmd: 'aaaaa', typeout: 'a', geometry: 'a', pgfplotsset: 'a', tikzset: 'a',
  addcontentsline: 'aaa', thanks: 'a', vspace: '*a', hspace: '*a', vskip: '', hskip: '', phantom_: 'a', fontsize: 'aa', newcolumntype: 'aoa',
  SetKwInOut: 'aa', SetKwFunction: 'aa', SetKw: 'aa', SetKwInput: 'aa', SetKwProg: 'aaaa', label_: 'a', index: 'a', glossary: 'a',
  newcommand: 'aoa', renewcommand: 'aoa', providecommand: 'aoa', DeclareRobustCommand: 'aoa', newif: 'a', let: 'aa',
  captionsetup: 'oa', setcitestyle: 'a', bibliographystyle_: 'a', renewenvironment: 'aaa', newenvironment: 'aaa', newtheorem: 'aaa',
  pdfoutput: '', pdfminorversion: '', setstretch: 'a', hyphenation: 'a', linespread: 'a', ifthenelse_: 'a', IfFileExists_: 'a',
  icmltitlerunning: 'a', icmlsetsymbol: 'aa', icmlkeywords: 'a', icmlaffiliation: 'aa', icmlcorrespondingauthor: 'aa', icmlauthor: 'aa',
  icmlEqualContribution: '', sisetup: 'a', addbibresource: 'a', cvprfinalcopy: '', nocite_: 'a', vphantom: 'a', hphantom: 'a',
};
const DIM = /^\s*[-+]?[\d.]*\s*(?:pt|em|ex|cm|mm|in|bp|sp|pc|dd|cc|\\[a-zA-Z]+)(?:\s+(?:plus|minus)\s*[-+]?[\d.]+\s*(?:pt|em|ex|cm|mm|in|fil+|\\[a-zA-Z]+))*/;
const THEOREMS = { theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition', remark: 'Remark', example: 'Example', claim: 'Claim', conjecture: 'Conjecture', assumption: 'Assumption', observation: 'Observation', notation: 'Notation', problem: 'Problem', fact: 'Fact', property: 'Property', hypothesis: 'Hypothesis', note: 'Note' };
const SILENT_ENVS = new Set(['small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'normalsize', 'spacing', 'singlespace', 'doublespace', 'onehalfspace', 'multicols', 'appendices', 'subequations', 'titlepage', 'raggedright', 'raggedleft', 'sloppypar', 'document', 'minipage_', 'adjustwidth', 'framed', 'mdframed', 'tcolorbox', 'center_', 'figurebox', 'threeparttable', 'tablenotes', 'landscape', 'sidewaystable_', 'otherlanguage', 'CJK', 'bibunit', 'table_']);
const GFX_RASTER = /^(png|jpe?g|gif|svg|webp|bmp)$/i;
const GFX_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'eps'];

// ---------- preprocessing ----------
// Verbatim blocks and \verb become placeholders, so comments and macros do not touch them.
function extractVerbatim(text, st) {
  let out = ''; let i = 0;
  const lineHasComment = (idx) => {
    const ls = text.lastIndexOf('\n', idx) + 1;
    return /(^|[^\\])(\\\\)*%/.test(text.slice(ls, idx));
  };
  const re = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|alltt|comment)\}|\\(verb\*?|lstinline)(?![A-Za-z])/g;
  let m;
  while ((m = re.exec(text))) {
    if (lineHasComment(m.index)) continue;
    if (m[1]) {
      const name = m[1];
      const endTag = '\\end{' + name + '}';
      const e = text.indexOf(endTag, re.lastIndex);
      const stop = e < 0 ? text.length : e;
      let body = text.slice(re.lastIndex, stop);
      if (name === 'lstlisting') body = body.replace(/^\s*\[[^\]]*\]/, '');
      if (name === 'minted') body = body.replace(/^\s*(\[[^\]]*\])?\s*\{[^}]*\}/, '');
      out += text.slice(i, m.index);
      if (name === 'comment') out += '';
      else { st.verb.push(body.replace(/^\n/, '').replace(/\n\s*$/, '')); out += '\\@verbblock{' + (st.verb.length - 1) + '}'; }
      i = e < 0 ? text.length : e + endTag.length;
      re.lastIndex = i;
    } else {
      // \verb|text| or \lstinline{text}
      let j = re.lastIndex;
      if (text[j] === '*') j++;
      const d = text[j];
      if (!d || /\s/.test(d)) continue;
      const close = d === '{' ? '}' : d;
      const e = text.indexOf(close, j + 1);
      if (e < 0 || text.slice(j + 1, e).includes('\n')) continue;
      out += text.slice(i, m.index);
      st.verb.push(text.slice(j + 1, e));
      out += '\\@verbinline{' + (st.verb.length - 1) + '}';
      i = e + 1;
      re.lastIndex = i;
    }
  }
  return out + text.slice(i);
}

function stripComments(text) {
  const lines = text.split('\n');
  const out = [];
  let glue = false;
  for (let k = 0; k < lines.length; k++) {
    let line = lines[k];
    if (glue) { line = line.replace(/^[ \t]+/, ''); glue = false; }
    let idx = -1;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c === 92) j++; else if (c === 37) { idx = j; break; }
    }
    if (idx < 0) { out.push(line); continue; }
    const kept = line.slice(0, idx);
    if (kept.trim() === '') continue; // whole-line comment
    const next = lines[k + 1];
    if (/\S$/.test(kept) && next !== undefined && next.trim() !== '') { out.push(kept + '\u0000'); glue = true; } // "word%" joins the next line
    else out.push(kept);
  }
  return out.join('\n').replace(/\u0000\n/g, '');
}

// Resolve conditionals (\newif, \iftrue ...) and \input in order. Dead branches are dropped.
async function flatten(text, st, depth) {
  const re = /\\(?:newif|input|include|subfile|subfileinclude|IfFileExists|if[A-Za-z@]*|else|fi|[A-Za-z@]+(?:true|false))(?![A-Za-z@])/g;
  const parts = []; let last = 0; let m;
  const active = () => st.cond.every((c) => c.cur);
  while ((m = re.exec(text))) {
    const name = m[0].slice(1);
    const live = active();
    const emitUntil = () => { if (live) parts.push(text.slice(last, m.index)); };
    if (name === 'newif') {
      const mm = /\s*\\if([A-Za-z@]+)/y; mm.lastIndex = re.lastIndex;
      const r = mm.exec(text);
      emitUntil();
      if (r) { st.flags.set(r[1], false); re.lastIndex = mm.lastIndex; }
      last = re.lastIndex; continue;
    }
    if (name === 'input' || name === 'include' || name === 'subfile' || name === 'subfileinclude') {
      emitUntil();
      let j = skipWs(text, re.lastIndex); let p;
      if (text[j] === '{') { const g = readGroup(text, j); p = g.text; re.lastIndex = g.end; }
      else { const mm = /[^\s{}\\]+/y; mm.lastIndex = j; const r = mm.exec(text); p = r ? r[0] : ''; re.lastIndex = r ? mm.lastIndex : j; }
      if (p && p.includes('#')) { if (live) parts.push(text.slice(m.index, re.lastIndex)); last = re.lastIndex; continue; } // inside a macro definition
      last = re.lastIndex;
      if (live && p) parts.push(await loadInput(p.trim(), st, depth, name.startsWith('subfile')));
      continue;
    }
    if (name === 'IfFileExists') {
      if (!st.evalFile) continue;
      const q = skipWs(text, re.lastIndex);
      if (text[q] !== '{') continue;
      const g1 = readGroup(text, q); const q2 = skipWs(text, g1.end);
      if (text[q2] !== '{') continue;
      const g2 = readGroup(text, q2); const q3 = skipWs(text, g2.end);
      if (text[q3] !== '{') continue;
      const g3 = readGroup(text, q3);
      if (g1.text.includes('#')) continue;
      emitUntil(); re.lastIndex = g3.end; last = g3.end;
      if (live) {
        const f = g1.text.trim().replace(/^\.\//, '');
        let ok = false;
        const cands = /\.[A-Za-z0-9]{1,5}$/.test(f) ? [f] : [f + '.tex', f];
        for (const c of cands) {
          try { ok = st.exists ? !!(await st.exists(c)) : typeof (await st.readFile(c)) === 'string'; } catch (e) { ok = false; }
          if (ok) break;
        }
        parts.push(await flatten(ok ? g2.text : g3.text, st, depth));
      }
      continue;
    }
    if (name === 'else') {
      if (!st.cond.length) continue;
      emitUntil(); st.cond[st.cond.length - 1].cur = !st.cond[st.cond.length - 1].cur; last = re.lastIndex; continue;
    }
    if (name === 'fi') {
      if (!st.cond.length) continue;
      emitUntil(); st.cond.pop(); last = re.lastIndex; continue;
    }
    const tf = /^(.+)(true|false)$/.exec(name);
    if (tf && !name.startsWith('if') && st.flags.has(tf[1])) {
      emitUntil(); if (live) st.flags.set(tf[1], tf[2] === 'true'); last = re.lastIndex; continue;
    }
    if (name.startsWith('if')) {
      if (name === 'iff' || name === 'ifthenelse' || name === 'ifmmode' || name === 'ifx_') continue; // not a TeX conditional here
      emitUntil();
      const f = name.slice(2);
      let v = true;
      if (name === 'iffalse') v = false;
      else if (st.flags.has(f)) v = st.flags.get(f);
      st.cond.push({ cur: v });
      last = re.lastIndex; continue;
    }
  }
  if (active()) parts.push(text.slice(last));
  return parts.join('');
}

const normTex = (p) => require('path').posix.normalize(String(p).replace(/^\.\//, '')).replace(/\.tex$/i, '');
const sameTex = (a, b) => normTex(a) === normTex(b);

async function loadInput(p, st, depth, isSubfile) {
  const note = (msg) => '\\@texnote{' + msg + '}';
  if (depth >= st.maxDepth) return note('input depth limit: ' + p);
  const norm = p.replace(/^\.\//, '');
  const cands = /\.tex$/i.test(norm) ? [norm] : [norm + '.tex', norm];
  if (st.stack.includes(norm)) return note('input cycle: ' + p);
  if (st.inputCount > 400) return note('too many inputs');
  let txt = null;
  for (const c of cands) {
    try { txt = await st.readFile(c); } catch (e) { txt = null; }
    if (typeof txt === 'string') break;
  }
  if (typeof txt !== 'string') return note('missing file: ' + p);
  st.inputCount++;
  txt = stripComments(extractVerbatim(txt, st));
  if (st.part && !st.part.used && sameTex(norm, st.part.rel)) { // the opened section file: its live text, marked
    st.part.used = true;
    txt = '\\@partbegin ' + stripComments(extractVerbatim(st.part.text, st)) + '\\@partend ';
  }
  if (isSubfile) {
    const b = txt.indexOf('\\begin{document}');
    if (b >= 0) { const e = txt.lastIndexOf('\\end{document}'); txt = txt.slice(b + 16, e > b ? e : undefined); }
  }
  st.stack.push(norm);
  try { return await flatten(txt, st, depth + 1); } finally { st.stack.pop(); }
}

// ---------- macros ----------
const PROTECT = new Set(['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'chapter', 'maketitle', 'title', 'author',
  'date', 'label', 'ref', 'eqref', 'cite', 'citep', 'citet', 'caption', 'captionof', 'item', 'begin', 'end', 'includegraphics', 'input',
  'footnote', 'textbf', 'textit', 'emph', 'texttt', 'url', 'href', 'bibliography', 'appendix', 'cref', 'Cref', 'autoref', 'color', 'textcolor']);

function parseDef(kind, star, text, i, st) {
  const nameAt = () => {
    i = skipWs(text, i);
    if (text[i] === '{') { const g = readGroup(text, i); i = g.end; return g.text.trim().replace(/^\\/, ''); }
    const m = /^\\([A-Za-z@]+|.)/.exec(text.slice(i, i + 60));
    if (!m) return null;
    i += m[0].length; return m[1];
  };
  const group = () => { i = skipWs(text, i); if (text[i] !== '{') return null; const g = readGroup(text, i); i = g.end; return g.text; };
  const optional = () => { i = skipWs(text, i); if (text[i] === '[') { const b = readBracket(text, i); if (b) { i = b.end; return b.text; } } return null; };
  if (/^(newcommand|renewcommand|providecommand|DeclareRobustCommand)$/.test(kind)) {
    const name = nameAt(); if (name == null) return null;
    const nopt = optional(); const def = nopt != null ? optional() : null;
    const body = group(); if (body == null) return null;
    const n = nopt != null ? parseInt(nopt, 10) || 0 : 0;
    if (/^the(table|figure|equation)$/.test(name)) {
      const pm = /^([A-Za-z]*)\\arabic\{/.exec(body.trim());
      if (pm) st.numPrefix[name.slice(3)] = pm[1];
    } else if (!st.builtin.has(name) && !(kind === 'providecommand' && st.macros.has(name))) {
      st.macros.set(name, { n, def, body });
    }
    return i;
  }
  if (/^(def|gdef|edef|xdef)$/.test(kind)) {
    const name = nameAt(); if (name == null) return null;
    const j = text.indexOf('{', i); if (j < 0) return null;
    const params = text.slice(i, j).trim();
    const g = readGroup(text, j);
    if (/^(#\d)*$/.test(params) && !st.builtin.has(name)) st.macros.set(name, { n: params.length / 2, def: null, body: g.text });
    return g.end;
  }
  if (kind === 'DeclareMathOperator') {
    const name = nameAt(); const body = group(); if (name == null || body == null) return null;
    st.macros.set(name, { n: 0, def: null, body: (star ? '\\operatorname*{' : '\\operatorname{') + body + '}' });
    return i;
  }
  if (/^(newenvironment|renewenvironment)$/.test(kind)) {
    const name = group(); if (name == null) return null;
    const nopt = optional(); if (nopt != null) optional();
    const b = group(); const e = group(); if (b == null || e == null) return null;
    st.envs.set(name.trim(), { n: nopt != null ? parseInt(nopt, 10) || 0 : 0, begin: b, end: e });
    return i;
  }
  if (/^(NewDocumentCommand|DeclareDocumentCommand|RenewDocumentCommand)$/.test(kind)) {
    const name = nameAt(); const spec = group(); const body = group();
    if (name == null || spec == null || body == null) return null;
    if (/^[m\s]*$/.test(spec) && !st.builtin.has(name)) st.macros.set(name, { n: spec.replace(/\s/g, '').length, def: null, body });
    return i;
  }
  if (kind === 'newcolumntype') { group(); optional(); return group() == null ? null : i; }
  if (kind === 'newtheorem') {
    const name = group(); if (name == null) return null;
    const counter = optional(); const title = group(); if (title == null) return null; optional();
    st.theorems.set(name.trim(), { title: title.trim(), counter: counter || name.trim(), star });
    return i;
  }
  if (kind === 'definecolor') {
    const a = group(); const b = group(); const c = group(); if (a == null || b == null || c == null) return null;
    defineColor(st, a.trim(), b.trim(), c.trim()); return i;
  }
  if (kind === 'colorlet') {
    const a = group(); const b = group(); if (a == null || b == null) return null;
    const rgb = cssColor(st, b);
    const mm = rgb && /rgb\((\d+),(\d+),(\d+)\)/.exec(rgb);
    if (mm) st.colors.set(a.trim(), [+mm[1], +mm[2], +mm[3]]);
    return i;
  }
  if (kind === 'graphicspath') {
    const g = group(); if (g == null) return null;
    const re = /\{([^{}]*)\}/g; let m;
    while ((m = re.exec(g))) st.graphicsPath.push(m[1].replace(/^\.\//, ''));
    return i;
  }
  if (kind === 'crefname' || kind === 'Crefname') {
    const a = group(); const b = group(); const c = group(); if (a == null || b == null || c == null) return null;
    st[kind === 'crefname' ? 'crefLow' : 'crefCap'][a.trim()] = [b, c]; return i;
  }
  if (kind === 'numberwithin') {
    const a = group(); const b = group(); if (a == null || b == null) return null;
    if (a.trim() === 'equation' && b.trim() === 'section') st.eqWithin = true;
    return i;
  }
  if (kind === 'let') {
    const name = nameAt(); if (name == null) return null;
    i = skipWs(text, i); if (text[i] === '=') i++;
    i = skipWs(text, i);
    const m = /^\\([A-Za-z@]+|.)/.exec(text.slice(i, i + 60)); if (!m) return null;
    i += m[0].length;
    if (!st.builtin.has(name)) st.macros.set(name, { n: 0, def: null, body: '\\' + m[1] });
    return i;
  }
  return null;
}

function extractDefs(text, st) {
  const re = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def|gdef|edef|xdef|newenvironment|renewenvironment|NewDocumentCommand|DeclareDocumentCommand|RenewDocumentCommand|newcolumntype|newtheorem|definecolor|colorlet|graphicspath|crefname|Crefname|numberwithin|let)(?![A-Za-z@])(\*?)/g;
  const out = []; let last = 0; let m;
  while ((m = re.exec(text))) {
    let end = null;
    try { end = parseDef(m[1], !!m[2], text, re.lastIndex, st); } catch (e) { end = null; }
    if (end == null) continue;
    out.push(text.slice(last, m.index)); last = end; re.lastIndex = end;
  }
  out.push(text.slice(last));
  return out.join('');
}

function expandMacros(text, st, depth) {
  if (depth > 25 || (!st.macros.size && !st.envs.size)) return text;
  const n = text.length;
  const sp = /[ \t]*(?:\n[ \t]*)?/y;
  let out = ''; let last = 0; let i = 0;
  for (;;) {
    const j = text.indexOf('\\', i);
    if (j < 0 || j + 1 >= n) break;
    if (!isLet(text.charCodeAt(j + 1))) { i = j + 2; continue; }
    let k = j + 1; while (k < n && isLet(text.charCodeAt(k))) k++;
    const name = text.slice(j + 1, k);
    if ((name === 'begin' || name === 'end') && st.envs.size) {
      const q = skipWs(text, k);
      if (text[q] === '{') {
        const g = readGroup(text, q); const env = st.envs.get(g.text.trim());
        if (env && st.budget-- > 0) {
          let p = g.end; let rep;
          if (name === 'begin') {
            const args = [];
            for (let a = 0; a < env.n; a++) { const q2 = skipWs(text, p); const ar = readArg(text, q2); args.push(ar.text); p = ar.end; }
            rep = env.begin.replace(/#(\d)/g, (mm, d) => (args[+d - 1] != null ? args[+d - 1] : ''));
          } else rep = env.end;
          out += text.slice(last, j) + expandMacros(rep, st, depth + 1); last = p; i = p; continue;
        }
      }
      i = k; continue;
    }
    const rec = st.macros.get(name);
    if (!rec || st.budget-- <= 0) { i = k; continue; }
    let p = k; const args = [];
    let keepSpace = false;
    if (rec.n > 0) {
      let idx = 0;
      if (rec.def !== null) {
        const q = skipWs(text, p);
        if (text[q] === '[') { const b = readBracket(text, q); if (b) { args.push(b.text); p = b.end; } else args.push(rec.def); } else args.push(rec.def);
        idx = 1;
      }
      for (; idx < rec.n; idx++) {
        const q = skipWs(text, p);
        if (q >= n) { args.push(''); continue; }
        const a = readArg(text, q); args.push(a.text); p = a.end;
      }
    } else {
      sp.lastIndex = p; sp.exec(text);
      let e = sp.lastIndex;
      if (text[e] === '\n') { sp.lastIndex = p; const sp2 = /[ \t]*/y; sp2.lastIndex = p; sp2.exec(text); e = sp2.lastIndex; }
      keepSpace = /\\xspace\s*$/.test(rec.body) && e > p;
      p = e;
    }
    let body = rec.body.replace(/#(#|\d)/g, (mm, d) => (d === '#' ? '#' : (args[+d - 1] != null ? args[+d - 1] : '')));
    body = body.replace(/\\xspace(?![A-Za-z@])/g, '');
    out += text.slice(last, j) + expandMacros(body, st, depth + 1) + (keepSpace ? ' ' : '');
    last = p; i = p;
  }
  return out + text.slice(last);
}

// ---------- bibliography ----------
function parseBibItems(content) {
  const parts = splitAt(content, bibitemSep);
  const items = [];
  for (let k = 1; k < parts.length; k++) {
    const a = new AR(parts[k]);
    a.opt(); const key = a.arg();
    if (key == null) continue;
    items.push({ key: key.trim(), body: a.rest().trim() });
  }
  return items;
}

function parseBibFile(text) {
  const map = new Map();
  const re = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/g; let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const fields = {}; let i = re.lastIndex;
    for (;;) {
      const f = /\s*([A-Za-z\-]+)\s*=\s*/y; f.lastIndex = i;
      const fm = f.exec(text);
      if (!fm) break;
      i = f.lastIndex; let val;
      if (text[i] === '{') { const g = readGroup(text, i); val = g.text; i = g.end; }
      else if (text[i] === '"') { let j = i + 1; while (j < text.length && !(text[j] === '"' && text[j - 1] !== '\\')) j++; val = text.slice(i + 1, j); i = j + 1; }
      else { const v = /[^,}\s]+/y; v.lastIndex = i; const vm = v.exec(text); val = vm ? vm[0] : ''; i = vm ? v.lastIndex : i; }
      fields[fm[1].toLowerCase()] = val.replace(/\s+/g, ' ').trim();
      const c = /\s*,/y; c.lastIndex = i; if (c.test(text)) i = c.lastIndex; else break;
    }
    map.set(m[2], fields);
  }
  return map;
}
function formatBib(f) {
  const clean = (x) => String(x || '').replace(/[{}]/g, '').replace(/\\&/g, '&');
  let au = '';
  if (f.author) {
    const names = f.author.split(/\s+and\s+/).map((n) => { n = clean(n); const c = n.indexOf(','); return c > 0 ? n.slice(c + 1).trim() + ' ' + n.slice(0, c).trim() : n; });
    au = names.length > 4 ? names.slice(0, 3).join(', ') + ', et al.' : names.join(', ');
  }
  const venue = clean(f.journal || f.booktitle || f.publisher || f.howpublished || '');
  return [au, clean(f.title), [venue, f.year].filter(Boolean).join(', ')].filter(Boolean).join('. ') + '.';
}

function parseAux(text, prefix, map) {
  const re = /\\newlabel\{([^}]*)\}\{/g; let m;
  while ((m = re.exec(text))) {
    const g = readGroup(text, re.lastIndex - 1);
    const subs = []; let i = 0; const body = g.text;
    while (i < body.length) { if (body[i] === '{') { const s = readGroup(body, i); subs.push(s.text); i = s.end; } else i++; }
    if (subs.length) {
      const anchor = (subs[3] || '').split('.')[0].toLowerCase();
      const type = /^sub/.test(anchor) ? 'section' : anchor || 'section';
      map.set(prefix + m[1], { num: subs[0], id: null, type });
    }
  }
}

// ---------- converter ----------
const H = {};
const ENV = {};

class Run {
  constructor(conv, s, inline) { this.c = conv; this.s = s; this.n = s.length; this.i = 0; this.inline = inline; this.html = ''; this.para = ''; }
  text(t) { this.para += t; }
  flush() { if (!this.inline) { const t = this.para.trim(); if (t) this.html += '<p>' + t + '</p>'; this.para = ''; } }
  block(h) { if (this.inline) this.para += h; else { this.flush(); this.html += h; } }
  ws() { while (this.i < this.n && isWs(this.s.charCodeAt(this.i))) this.i++; }
  arg() { this.ws(); if (this.i >= this.n) return ''; const a = readArg(this.s, this.i); this.i = a.end; return a.text; }
  opt() { const j = skipWs(this.s, this.i); if (this.s[j] === '[') { const b = readBracket(this.s, j); if (b) { this.i = b.end; return b.text; } } return null; }
  star() { if (this.s[this.i] === '*') { this.i++; return true; } return false; }
  inl(str) { return this.c.run(str, true); }
  content(str) {
    if (!this.inline && needsBlock(str)) { this.flush(); this.html += this.c.run(str, false); } else this.para += this.c.run(str, true);
  }
  done() { this.flush(); return this.inline ? this.para : this.html; }
}

class Conv {
  constructor(st) {
    this.st = st; this.depth = 0;
    this.sec = [0, 0, 0]; this.chap = 0; this.secSeq = 0;
    this.counters = { figure: 0, table: 0, algorithm: 0, equation: 0, footnote: 0 };
    this.thm = new Map();
    this.labels = new Map(); this.aux = new Map();
    this.last = { num: '', id: null, type: 'section' };
    this.floats = []; this.subTop = 0; this.footnotes = [];
    this.title = null; this.author = null; this.date = null; this.titleDone = false;
    this.capType = null; this.appendix = false; this.cellBg = null; this.listDepth = 0;
    this.algoDepth = 0; this.algoLn = 0; this.algoNum = false; this.inAlgo = false; this.quiet = false;
    this.images = new Map(); this.bibItems = null; this.bibNames = []; this.bibWanted = false; this.bibFiles = new Map();
    this.hasChapter = /\\chapter(?![A-Za-z])/.test(st.text || '');
    this.stats = { sections: 0, equations: 0, numberedEquations: 0, figures: 0, tables: 0, algorithms: 0, citations: 0, uniqueCited: 0, unresolvedRefs: 0, katexErrors: 0, katexSamples: [], unknown: new Map(), unknownEnvs: new Map(), inputs: 0, errors: 0 };
  }

  unk(name, isEnv) {
    if (this.quiet) return;
    const m = isEnv ? this.stats.unknownEnvs : this.stats.unknown;
    m.set(name, (m.get(name) || 0) + 1);
  }

  run(s, inline) {
    if (this.depth > 60) return esc(s);
    this.depth++;
    const r = new Run(this, s, inline);
    try { this.loop(r); } finally { this.depth--; }
    return r.done();
  }

  loop(r) {
    const s = r.s; const n = r.n;
    const TXT = /[^\\{}$~&\-'`\s<>]+/y;
    while (r.i < n) {
      const i = r.i; const ch = s.charCodeAt(i);
      TXT.lastIndex = i;
      const tm = TXT.exec(s);
      if (tm) { r.para += tm[0]; r.i = TXT.lastIndex; continue; }
      if (isWs(ch)) {
        let j = i; while (j < n && isWs(s.charCodeAt(j))) j++;
        if (/\n[ \t]*\r?\n/.test(s.slice(i, j))) { if (!r.inline) r.flush(); else r.para += ' '; }
        else if (r.para !== '' && !r.para.endsWith(' ')) r.para += ' ';
        r.i = j; continue;
      }
      switch (s[i]) {
        case '{': {
          const g = readGroup(s, i); r.i = g.end;
          if (!r.inline && needsBlock(g.text)) { r.flush(); r.html += this.run(g.text, false); } else r.para += this.run(g.text, true);
          continue;
        }
        case '}': r.i++; continue;
        case '~': r.para += '&nbsp;'; r.i++; continue;
        case '&': r.para += '&amp;'; r.i++; continue;
        case '<': r.para += '&lt;'; r.i++; continue;
        case '>': r.para += '&gt;'; r.i++; continue;
        case '-': {
          let j = i; while (j < n && s[j] === '-') j++;
          const k = j - i; r.para += k >= 3 ? '—' : k === 2 ? '–' : '-'; r.i = j; continue;
        }
        case '`': r.para += s[i + 1] === '`' ? '“' : '‘'; r.i += s[i + 1] === '`' ? 2 : 1; continue;
        case "'": r.para += s[i + 1] === "'" ? '”' : '’'; r.i += s[i + 1] === "'" ? 2 : 1; continue;
        case '$': {
          const dbl = s[i + 1] === '$';
          const end = findDollar(s, i + (dbl ? 2 : 1), dbl);
          if (end < 0) { r.para += '$'; r.i++; continue; }
          const tex = s.slice(i + (dbl ? 2 : 1), end);
          r.i = end + (dbl ? 2 : 1);
          if (dbl) r.block(this.displayEq(tex)); else r.para += this.inlineMath(tex);
          continue;
        }
        default: break;
      }
      // backslash command
      const c2 = s.charCodeAt(i + 1);
      if (Number.isNaN(c2)) { r.i++; continue; }
      let name; let j; let word = false;
      if (isLet(c2)) { j = i + 2; while (j < n && isLet(s.charCodeAt(j))) j++; name = s.slice(i + 1, j); word = true; } else { name = s[i + 1]; j = i + 2; }
      if (name === '(' || name === '[') {
        const close = name === '(' ? '\\)' : '\\]';
        const e = s.indexOf(close, j);
        if (e < 0) { r.i = j; continue; }
        const tex = s.slice(j, e); r.i = e + 2;
        if (name === '(') r.para += this.inlineMath(tex); else r.block(this.displayEq(tex));
        continue;
      }
      r.i = j;
      if (word && !XSPACE.has(name)) { // TeX skips spaces after a control word, but not a blank line
        const sp = /[ \t]*(?:\n[ \t]*)?/y; sp.lastIndex = j; sp.exec(s);
        let e = sp.lastIndex;
        if (s[e] === '\n') { const sp2 = /[ \t]*/y; sp2.lastIndex = j; sp2.exec(s); e = sp2.lastIndex; }
        r.i = e;
      }
      try {
        const h = H[name];
        if (h) h(r, name);
        else if (!word && ACC[name]) accent(r, name);
        else if (SYM[name] !== undefined) r.para += SYM[name];
        else if (NOOP.has(name)) { /* ignored */ }
        else if (IGN[name] !== undefined) ignoreArgs(r, IGN[name]);
        else if (word && ACC[name] && /^[uvHckrdb]$/.test(name)) accent(r, name);
        else this.unknownCmd(r, name, word);
      } catch (e) {
        this.stats.errors++;
        if (r.i < j) r.i = j;
      }
    }
  }

  unknownCmd(r, name, word) {
    this.unk('\\' + name);
    const s = r.s;
    if (s[r.i] === '*' && (s[r.i + 1] === '{' || s[r.i + 1] === '[')) r.i++;
    if (s[r.i] === '[') { const b = readBracket(s, r.i); if (b && s[skipWs(s, b.end)] === '{') r.i = b.end; }
  }

  // ----- math -----
  prepMath(tex) {
    tex = tex.replace(/\\label\s*\{[^}]*\}/g, '').replace(/\\(?:nonumber|notag)(?![A-Za-z])/g, '');
    tex = tex.replace(/\\(eqref|ref|cref|Cref|autoref)\s*\{([^}]*)\}/g, (m, cmd, k) => {
      const info = this.labels.get(k.trim()) || this.aux.get(k.trim());
      if (!info) { this.stats.unresolvedRefs++; return '\\text{??}'; }
      return '\\text{' + (cmd === 'eqref' ? '(' + info.num + ')' : info.num) + '}';
    });
    tex = tex.replace(/\\(?:vspace|hspace)\*?\s*\{[^}]*\}/g, '').replace(/\\ensuremath(?![A-Za-z])/g, '')
      .replace(/\\(?:bigskip|medskip|smallskip|centering|noindent)(?![A-Za-z])/g, '').replace(/\\xspace(?![A-Za-z])/g, '')
      .replace(/\\(?:mathbbm|mathds)(?![A-Za-z])/g, '\\mathbb').replace(/\\textsc(?![A-Za-z])/g, '\\text')
      .replace(/\\mbox(?![A-Za-z])/g, '\\text');
    return tex;
  }

  renderMath(tex, display) {
    const t = this.prepMath(tex);
    try {
      return katex.renderToString(t, { displayMode: display, throwOnError: true, strict: 'ignore', trust: false, output: 'html', maxExpand: 1000, macros: { ...this.st.katexMacros } });
    } catch (e) {
      if (!this.quiet) {
        this.stats.katexErrors++;
        if (this.stats.katexSamples.length < 25) this.stats.katexSamples.push(String(e && e.message).slice(0, 110) + '  <<' + tex.trim().slice(0, 70).replace(/\s+/g, ' ') + '>>');
      }
      return '<code class="tex-err">' + esc(tex.trim()) + '</code>';
    }
  }
  inlineMath(tex) { return this.renderMath(tex, false); }
  displayEq(tex) {
    if (!this.quiet) this.stats.equations++;
    const labs = []; tex = tex.replace(/\\label\s*\{([^}]*)\}/g, (m, k) => { labs.push(k.trim()); return ''; });
    let id = null;
    for (const k of labs) { if (!id) id = idOf(k); if (!this.labels.has(k)) this.labels.set(k, { num: this.last.num, id, type: this.last.type }); }
    return '<div class="tex-eq"' + (id ? ' id="' + id + '"' : '') + '>' + this.renderMath(tex, true) + '</div>';
  }

  eqNumber() {
    const n = ++this.counters.equation;
    const pre = this.st.numPrefix.equation || '';
    const sec = this.appendix ? String.fromCharCode(64 + this.sec[0]) : this.sec[0];
    return pre + (this.st.eqWithin ? sec + '.' : '') + n;
  }

  mathEnv(name, content) {
    const star = name.endsWith('*'); const base = name.replace(/\*$/, '');
    let rows; let open = ''; let close = '';
    if (base === 'equation' || base === 'displaymath' || base === 'math') rows = [content];
    else if (base === 'gather' || base === 'multline') {
      open = base === 'gather' ? '\\begin{gather*}' : '\\begin{gathered}'; close = base === 'gather' ? '\\end{gather*}' : '\\end{gathered}';
      rows = base === 'multline' ? [content] : splitAt(content, rowSep); // multline has one number
    } else if (base === 'eqnarray') {
      open = '\\begin{align*}'; close = '\\end{align*}';
      rows = splitAt(content, rowSep).map((row) => {
        const cells = splitAt(row, cellSep);
        return cells.length >= 3 ? cells[0] + ' & ' + cells[1] + ' ' + cells.slice(2).join(' ') : row;
      });
    } else { // align, flalign, alignat
      let body = content; let k = '';
      if (base === 'alignat' || base === 'xalignat') { const a = new AR(content); k = a.arg(); body = a.rest(); open = '\\begin{alignat*}{' + (k || 1) + '}'; close = '\\end{alignat*}'; }
      else { open = '\\begin{align*}'; close = '\\end{align*}'; }
      rows = splitAt(body, rowSep);
    }
    if (rows.length > 1) rows = rows.filter((x, idx) => x.trim() !== '' || idx < rows.length - 1);
    if (rows.length > 1 && rows[rows.length - 1].trim() === '') rows.pop();
    const parts = []; let firstId = null; let anchors = '';
    for (const row of rows) {
      let t = row; const labs = [];
      t = t.replace(/\\label\s*\{([^}]*)\}/g, (m, k) => { labs.push(k.trim()); return ''; });
      const nonum = /\\(nonumber|notag)(?![A-Za-z])/.test(t);
      t = t.replace(/\\(?:nonumber|notag)(?![A-Za-z])/g, '');
      const numbered = !star && !nonum && t.trim() !== '';
      let tag = ''; let num = this.last.num;
      if (numbered) { num = this.eqNumber(); tag = '\\tag{' + num + '}'; if (!this.quiet) this.stats.numberedEquations++; }
      if (!this.quiet) this.stats.equations++;
      for (const k of labs) {
        const id = idOf(k);
        if (!firstId) firstId = id; else anchors += '<a id="' + id + '"></a>';
        if (!this.labels.has(k)) this.labels.set(k, { num, id, type: 'equation' });
      }
      parts.push(t + tag);
    }
    let tex = open ? open + parts.join('\\\\') + close : parts[0] || '';
    if (base === 'multline' && parts[0]) { const tm = /\\tag\{[^}]*\}$/.exec(parts[0]); tex = open + parts[0].replace(/\\tag\{[^}]*\}$/, '') + close + (tm ? tm[0] : ''); }
    return '<div class="tex-eq"' + (firstId ? ' id="' + firstId + '"' : '') + '>' + anchors + this.renderMath(tex, true) + '</div>';
  }

  // ----- structure -----
  fmtNum(type, n) { return (this.st.numPrefix[type] || '') + n; }

  heading(r, name) {
    const levels = { chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
    const level = levels[name];
    const star = r.star(); r.opt(); const title = r.arg();
    let num = '';
    if (!star && level <= 3) {
      if (level === 0) { this.chap++; this.sec = [0, 0, 0]; num = String(this.chap); }
      else {
        this.sec[level - 1]++; for (let k = level; k < 3; k++) this.sec[k] = 0;
        if (level === 1 && this.st.eqWithin) this.counters.equation = 0;
        const first = this.appendix ? String.fromCharCode(64 + this.sec[0]) : String(this.sec[0]);
        num = [first].concat(this.sec.slice(1, level).map(String)).join('.');
        if (this.hasChapter && !this.appendix) num = this.chap + '.' + num;
      }
    }
    const id = 'tex-sec-' + (++this.secSeq);
    if (!star && level <= 3) this.last = { num, id, type: 'section' };
    if (!this.quiet && level <= 3) this.stats.sections++;
    const html = r.inl(title);
    if (level >= 4) { r.flush(); r.text('<span class="tex-parhead" id="' + id + '">' + html + '</span> '); return; }
    const hl = Math.min(6, level + 1 + (this.hasChapter && level >= 1 ? 1 : 0));
    r.block('<h' + hl + ' id="' + id + '">' + (num ? '<span class="tex-secnum">' + esc(num) + '</span> ' : '') + html + '</h' + hl + '>');
  }

  titleBlock() {
    if (this.title == null) return '';
    this.titleDone = true;
    const strip = (t) => t.replace(/\\thanks\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/\\footnotemark(?:\[[^\]]*\])?/g, '');
    let out = '<header class="tex-title"><h1>' + this.run(strip(this.title), true) + '</h1>';
    if (this.author != null) {
      out += '<div class="tex-authors">';
      for (const blk of strip(this.author).split(/\\(?:and|And|AND)(?![A-Za-z])/)) {
        const lines = splitAt(blk, rowSep).map((x) => x.trim()).filter(Boolean);
        if (!lines.length) continue;
        out += '<div class="tex-author"><div class="tex-au">' + this.run(lines[0], true) + '</div>' +
          lines.slice(1).map((l) => '<div class="tex-aff">' + this.run(l, true) + '</div>').join('') + '</div>';
      }
      out += '</div>';
    }
    if (this.date && this.date.trim() && !/^\\today$/.test(this.date.trim())) out += '<div class="tex-date">' + this.run(this.date, true) + '</div>';
    return out + '</header>';
  }

  image(p, o) {
    const info = this.images.get(p);
    const opts = o || '';
    let style = '';
    const wm = /width\s*=\s*([^,\]]+)/.exec(opts);
    const w = wm ? parseWidth(wm[1]) : null;
    const hm = /height\s*=\s*([\d.]+)\s*(em|ex)/.exec(opts);
    if (w) style += 'width:' + w + ';';
    if (hm) style += 'height:' + hm[1] + hm[2] + ';';
    const name = p.split('/').pop();
    if (!info || !info.rel) return '<span class="tex-gfx" style="' + style + '">image not found: ' + esc(name) + '</span>';
    if (GFX_RASTER.test(info.ext)) {
      let url = null;
      try { url = this.st.resolveImage ? this.st.resolveImage(info.rel) : null; } catch (e) { url = null; }
      if (url) return '<img class="tex-img" src="' + escAttr(url) + '" alt="' + escAttr(name) + '" style="' + style + '">';
    }
    const gfx = '<span class="tex-gfx">' + esc(info.rel.split('/').pop()) + '</span>';
    if (/^pdf$/i.test(info.ext)) { // drawn in the page by pdf.js (media/main.js); the gray box is the fallback
      let url = null;
      try { url = this.st.resolveImage ? this.st.resolveImage(info.rel) : null; } catch (e) { url = null; }
      if (url) return '<span class="tex-pdffig" data-src="' + escAttr(url) + '" data-w="' + (w || '') + '"' + (style ? ' style="' + style + '"' : '') + '>' + gfx + '</span>';
    }
    return '<span class="tex-gfx" style="' + style + '">' + esc(info.rel.split('/').pop()) + '</span>';
  }

  subFigure(r, content, widthTxt) {
    const parent = this.floats[this.floats.length - 1];
    const k = parent ? parent.sub++ : this.subTop++;
    const letter = String.fromCharCode(97 + (k % 26));
    const num = (parent ? parent.num : '') + letter;
    const id = 'tex-sub-' + (++this.secSeq);
    const fl = { type: 'sub', num, id, caption: null, sub: 0 };
    this.last = { num, id, type: 'figure' };
    this.floats.push(fl);
    let inner;
    try { inner = this.run(content, false); } finally { this.floats.pop(); }
    const w = widthTxt ? parseWidth(widthTxt) : null;
    return '<div class="tex-sub" id="' + id + '"' + (w ? ' style="width:' + w + '"' : '') + '>' + inner +
      (fl.caption ? '<div class="tex-subcap">(' + letter + ') ' + fl.caption + '</div>' : '') + '</div>';
  }

  floatEnv(r, type, content, skipWrap) {
    const a = new AR(content); a.opt();
    if (skipWrap) { a.arg(); a.opt(); a.arg(); }
    const body = a.rest();
    const n = ++this.counters[type];
    const num = this.fmtNum(type, n);
    const id = 'tex-' + type + '-' + n;
    this.last = { num, id, type };
    if (!this.quiet) this.stats[type === 'figure' ? 'figures' : type === 'table' ? 'tables' : 'algorithms']++;
    const fl = { type, num, id, caption: null, sub: 0 };
    this.floats.push(fl);
    let inner;
    try { inner = this.run(body, false); } finally { this.floats.pop(); }
    const word = type === 'figure' ? 'Figure' : type === 'table' ? 'Table' : 'Algorithm';
    const cap = fl.caption ? '<figcaption><span class="tex-capno">' + word + ' ' + esc(num) + ':</span> ' + fl.caption + '</figcaption>' : '';
    const row = inner.includes('class="tex-sub"') ? ' tex-row' : '';
    r.block('<figure class="tex-fl tex-' + type + '" id="' + id + '">' + (type !== 'figure' ? cap : '') + '<div class="tex-fbody' + row + '">' + inner + '</div>' + (type === 'figure' ? cap : '') + '</figure>');
  }

  caption(r, forcedType) {
    r.star(); r.opt(); const t = r.arg();
    const html = r.inl(t);
    const fl = this.floats[this.floats.length - 1];
    if (fl) { fl.caption = fl.caption ? fl.caption + ' ' + html : html; return; }
    const type = forcedType || this.capType || 'figure';
    const key = type === 'table' ? 'table' : type === 'algorithm' ? 'algorithm' : 'figure';
    const n = ++this.counters[key];
    const num = this.fmtNum(key, n);
    this.last = { num, id: 'tex-' + key + '-' + n, type: key };
    if (!this.quiet) this.stats[key === 'figure' ? 'figures' : key === 'table' ? 'tables' : 'algorithms']++;
    const word = key === 'figure' ? 'Figure' : key === 'table' ? 'Table' : 'Algorithm';
    r.block('<div class="tex-cap" id="' + this.last.id + '"><span class="tex-capno">' + word + ' ' + esc(num) + ':</span> ' + html + '</div>');
  }

  tabular(content, spec) {
    const aligns = parseCols(spec || '');
    const rows = splitAt(content, rowSep);
    const out = []; // { cells: [...], top, cm, bg }
    for (const raw of rows) {
      let s = raw; let top = null; const cm = []; let bg = null;
      for (;;) {
        const m = /^\s*\\(hline|toprule|midrule|bottomrule|cline|cmidrule|specialrule|addlinespace|noalign|rowcolor|hdashline|Xhline|endhead|endfirsthead|endfoot|endlastfoot|arrayrulecolor|rowcolors|columncolor|vspace|rule)(?![A-Za-z])/.exec(s);
        if (!m) break;
        const a = new AR(s.slice(m[0].length)); const nm = m[1];
        if (nm === 'cline') { const g = a.arg(); const rm = g && /(\d+)\s*-\s*(\d+)/.exec(g); if (rm) cm.push([+rm[1], +rm[2]]); }
        else if (nm === 'cmidrule') {
          let j = skipWs(a.s, a.i); if (a.s[j] === '[') { a.opt(); j = skipWs(a.s, a.i); }
          if (a.s[j] === '(') { const e = a.s.indexOf(')', j); if (e > 0) a.i = e + 1; }
          const g = a.arg(); const rm = g && /(\d+)\s*-\s*(\d+)/.exec(g); if (rm) cm.push([+rm[1], +rm[2]]);
        } else if (nm === 'specialrule') { a.arg(); a.arg(); a.arg(); top = top || 'full'; }
        else if (nm === 'addlinespace' || nm === 'Xhline') { a.opt(); a.arg(); }
        else if (nm === 'rowcolor') { a.opt(); const c = a.arg(); if (c) bg = cssColor(this.st, c); }
        else if (nm === 'noalign' || nm === 'arrayrulecolor' || nm === 'columncolor') { a.opt(); a.arg(); }
        else if (nm === 'rowcolors') { a.arg(); a.arg(); a.arg(); }
        else if (nm === 'vspace') { a.arg(); }
        else if (nm === 'rule') { a.opt(); a.arg(); a.arg(); }
        else if (nm === 'hline' || nm === 'toprule' || nm === 'midrule' || nm === 'bottomrule' || nm === 'hdashline') top = 'full';
        s = a.rest();
      }
      if (s.trim() === '') {
        if (top === 'full' && out.length) out[out.length - 1].bottom = true;
        continue;
      }
      out.push({ cells: splitAt(s, cellSep), top, cm, bg });
    }
    let html = '<div class="tex-tabwrap"><table class="tex-tab"><tbody>';
    out.forEach((row, ri) => {
      let col = 0; let tr = '';
      for (const cell of row.cells) {
        let t = cell.trim(); let span = 1; let al = null;
        const mc = /^\\multicolumn(?![A-Za-z])/.exec(t);
        if (mc) {
          const a = new AR(t.slice(mc[0].length)); const k = a.arg(); const sp = a.arg(); const body = a.arg();
          if (body != null) { span = parseInt(k, 10) || 1; al = alignOf(sp); t = body; }
        }
        this.cellBg = null;
        const content2 = this.run(t, true).trim();
        const style = [];
        const a2 = al || aligns[col] || 'l';
        if (a2 === 'c') style.push('text-align:center'); else if (a2 === 'r') style.push('text-align:right');
        if (this.cellBg) style.push('background:' + this.cellBg); else if (row.bg) style.push('background:' + row.bg);
        const inCm = row.cm.some((rg) => col + 1 >= rg[0] && col + 1 <= rg[1]);
        tr += '<td' + (span > 1 ? ' colspan="' + span + '"' : '') + (inCm ? ' class="cl"' : '') + (style.length ? ' style="' + style.join(';') + '"' : '') + '>' + content2 + '</td>';
        col += span;
      }
      const cls = [row.top === 'full' && ri > 0 ? 'rl' : '', row.bottom && ri === out.length - 1 ? '' : row.bottom ? 'rb' : ''].filter(Boolean).join(' ');
      html += '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' + tr + '</tr>';
    });
    this.cellBg = null;
    return html + '</tbody></table></div>';
  }

  list(r, kind, content) {
    const a = new AR(content); a.opt();
    if (kind !== 'description') { /* enumitem options already skipped */ }
    const parts = splitAt(a.rest(), itemSep);
    const depth = this.listDepth++;
    let html = '';
    try {
      let count = 0;
      for (let k = 1; k < parts.length; k++) {
        let body = parts[k]; let label = null;
        const j = skipWs(body, 0);
        if (body[j] === '[') { const b = readBracket(body, j); if (b) { label = b.text; body = body.slice(b.end); } }
        count++;
        this.last = { num: String(count), id: null, type: 'item' };
        let h = this.run(body, false);
        const single = /^<p>((?:(?!<\/?p>)[\s\S])*)<\/p>$/.exec(h);
        if (single) h = single[1];
        if (kind === 'description') html += '<dt>' + this.run(label || '', true) + '</dt><dd>' + h + '</dd>';
        else if (label != null) html += '<li class="tex-lab"><span class="tex-itlab">' + this.run(label, true) + '</span> ' + h + '</li>';
        else html += '<li>' + h + '</li>';
      }
    } finally { this.listDepth = depth; }
    if (kind === 'itemize') r.block('<ul class="tex-list">' + html + '</ul>');
    else if (kind === 'enumerate') r.block('<ol class="tex-list" type="' + ['1', 'a', 'i', 'A'][Math.min(depth, 3)] + '">' + html + '</ol>');
    else r.block('<dl class="tex-list">' + html + '</dl>');
  }

  algoLine(r, kw, argHtml, opts) {
    // one pseudo-code line: newline, indent, optional line number, text
    const o = opts || {};
    if (o.pre) this.algoDepth = Math.max(0, this.algoDepth - o.pre);
    let t = '\n' + '    '.repeat(this.algoDepth);
    if (this.algoNum && !o.nonum) t += (++this.algoLn) + ': ';
    t += kw + argHtml + (o.suffix || '');
    if (o.post) this.algoDepth += o.post;
    r.text(t);
  }
}

function findDollar(s, from, dbl) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '$') { if (!dbl) return j; if (s[j + 1] === '$') return j; }
  }
  return -1;
}

function parseWidth(t) {
  t = String(t).trim();
  let m = /^([\d.]*)\s*\\(?:textwidth|linewidth|columnwidth|hsize|textheight)/.exec(t);
  if (m) { const v = m[1] === '' ? 1 : parseFloat(m[1]); return v > 0 ? Math.min(100, Math.round(v * 1000) / 10) + '%' : null; }
  m = /^([\d.]+)\s*(cm|mm|in|pt|em)/.exec(t);
  if (m) { const v = parseFloat(m[1]); const px = { cm: 38, mm: 3.8, in: 96, pt: 1.33, em: 16 }[m[2]] * v; return Math.round(px) + 'px'; }
  return null;
}

function alignOf(spec) {
  const s = String(spec || '').replace(/\{[^{}]*\}/g, '');
  const m = /[lcrLCRpXS]/.exec(s);
  if (!m) return 'l';
  return /[cC]/.test(m[0]) ? 'c' : /[rRS]/.test(m[0]) ? 'r' : 'l';
}
function parseCols(spec) {
  let s = String(spec);
  for (let k = 0; k < 4; k++) s = s.replace(/\*\s*\{(\d+)\}\s*\{([^{}]*)\}/g, (m, n, x) => x.repeat(Math.min(+n, 40)));
  s = s.replace(/[@!<>]\s*\{[^{}]*\}/g, '').replace(/\|/g, '').replace(/([A-Za-z])\s*\{[^{}]*\}/g, '$1');
  const out = [];
  for (const ch of s) if (/[A-Za-z]/.test(ch)) out.push(/[cC]/.test(ch) ? 'c' : /[rRS]/.test(ch) ? 'r' : 'l');
  return out;
}

function accent(r, name) {
  let base; const s = r.s;
  let j = r.i;
  if (/^[uvHckrdb]$/.test(name)) j = skipWs(s, j);
  if (s[j] === '{') { const g = readGroup(s, j); base = g.text.trim(); r.i = g.end; }
  else if (s[j] === '\\') { const a = readArg(s, j); base = a.text; r.i = a.end; }
  else { base = s[j] || ''; r.i = j + 1; }
  if (base === '\\i') base = 'ı'; else if (base === '\\j') base = 'ȷ';
  base = base.replace(/\\[A-Za-z]+\s*/g, '');
  const out = base.length ? (base[0] + ACC[name] + base.slice(1)).normalize('NFC') : '';
  r.para += esc(out);
}

function ignoreArgs(r, spec) {
  for (const ch of spec) {
    if (ch === '*') r.star(); else if (ch === 'o') r.opt(); else if (ch === 'a') r.arg();
  }
  if (spec === '') { const m = DIM.exec(r.s.slice(r.i, r.i + 80)); if (m) r.i += m[0].length; }
}

// ---------- command handlers ----------
const wrap = (open, close) => (r) => { r.text(open + r.inl(r.arg()) + close); };
Object.assign(H, {
  textbf: wrap('<b>', '</b>'), textit: wrap('<i>', '</i>'), textsl: wrap('<i>', '</i>'), emph: wrap('<em>', '</em>'),
  texttt: wrap('<code class="tt">', '</code>'), textsc: wrap('<span class="sc">', '</span>'), underline: wrap('<u>', '</u>'),
  uline: wrap('<u>', '</u>'), sout: wrap('<s>', '</s>'), textsuperscript: wrap('<sup>', '</sup>'), textsubscript: wrap('<sub>', '</sub>'),
  textrm: wrap('', ''), textsf: wrap('', ''), textmd: wrap('', ''), textnormal: wrap('', ''), textup: wrap('', ''), mbox: wrap('', ''),
  hbox: wrap('', ''), text: wrap('', ''), protect: () => {}, fbox: wrap('<span class="tex-fbox">', '</span>'),
  mathrm: wrap('', ''), textlf: wrap('', ''), nolinkurl: (r) => { const u = r.arg(); r.text(esc(u)); },
  highlight: wrap('<mark>', '</mark>'), hl: wrap('<mark>', '</mark>'), ensuremath: (r) => { r.text(r.c.inlineMath(r.arg())); },
  phantom: (r) => { r.text('<span style="visibility:hidden">' + r.inl(r.arg()) + '</span>'); },
  texorpdfstring: (r) => { const a = r.arg(); r.arg(); r.text(r.inl(a)); },
  detokenize: (r) => { r.text(esc(r.arg())); }, natexlab: wrap('', ''), afterpage: (r) => { r.content(r.arg()); },
  penalty: (r) => { const m = /^[-+]?\d+/.exec(r.s.slice(r.i, r.i + 12)); if (m) r.i += m[0].length; },
  shortstack: (r) => { r.opt(); r.text(r.inl(r.arg())); },
  subcaptionbox: (r) => { r.opt(); const cap = r.arg(); r.opt(); r.opt(); const body = r.arg(); r.block(r.c.subFigure(r, body + '\\caption{' + cap + '}', null)); },
  today: (r) => { r.text(esc(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))); },
  '\\': (r) => { r.star(); r.opt(); r.text('<br>'); },
  newline: (r) => { r.text('<br>'); }, linebreak: (r) => { r.opt(); r.text('<br>'); },
  par: (r) => { if (!r.inline) r.flush(); else r.text(' '); },
  hfill: (r) => { r.text(' '); },
  '@verbblock': (r) => { const k = +r.arg(); r.block('<pre class="tex-verb"><code>' + esc(r.c.st.verb[k] || '') + '</code></pre>'); },
  '@verbinline': (r) => { const k = +r.arg(); r.text('<code class="tt">' + esc(r.c.st.verb[k] || '') + '</code>'); },
  '@texnote': (r) => { r.text('<span class="tex-note">[' + esc(r.arg()) + ']</span>'); },
  url: (r) => { const u = r.arg().trim(); r.text(/^(https?:|mailto:)/i.test(u) ? '<a href="' + escAttr(u) + '">' + esc(u) + '</a>' : esc(u)); },
  href: (r) => { const u = r.arg().trim(); const t = r.arg(); r.text(/^(https?:|mailto:)/i.test(u) ? '<a href="' + escAttr(u) + '">' + r.inl(t) + '</a>' : r.inl(t)); },
  textcolor: (r) => { const o = r.opt(); const c = r.arg(); const t = r.arg(); const col = o ? null : cssColor(r.c.st, c); r.text(col ? '<span style="color:' + col + '">' + r.inl(t) + '</span>' : r.inl(t)); },
  colorbox: (r) => { r.opt(); const c = r.arg(); const t = r.arg(); const col = cssColor(r.c.st, c); r.text(col ? '<span style="background:' + col + '">' + r.inl(t) + '</span>' : r.inl(t)); },
  fcolorbox: (r) => { r.opt(); r.arg(); r.arg(); r.text(r.inl(r.arg())); },
  cellbg_: () => {},
  cellcolor: (r) => { r.opt(); const c = r.arg(); const col = cssColor(r.c.st, c); if (col) r.c.cellBg = col; },
  rowcolor: (r) => { r.opt(); r.arg(); }, columncolor: (r) => { r.opt(); r.arg(); },
  color: (r) => { const o = r.opt(); const c = r.arg(); const col = o ? null : cssColor(r.c.st, c); declWrap(r, col ? '<span style="color:' + col + '">' : '', col ? '</span>' : ''); },
  makecell: (r) => { r.opt(); r.text(r.inl(r.arg())); }, thead: (r) => { r.opt(); r.text(r.inl(r.arg())); },
  multirow: (r) => { r.opt(); r.arg(); r.opt(); r.arg(); r.opt(); r.text(r.inl(r.arg())); },
  multicolumn: (r) => { r.arg(); r.arg(); r.text(r.inl(r.arg())); },
  resizebox: (r) => { r.star(); r.arg(); r.arg(); r.content(r.arg()); },
  scalebox: (r) => { r.arg(); r.opt(); r.content(r.arg()); },
  adjustbox: (r) => { r.arg(); r.content(r.arg()); },
  rotatebox: (r) => { r.opt(); r.arg(); r.content(r.arg()); },
  raisebox: (r) => { r.arg(); r.opt(); r.opt(); r.content(r.arg()); },
  makebox: (r) => { r.opt(); r.opt(); r.text(r.inl(r.arg())); }, framebox: (r) => { r.opt(); r.opt(); r.text('<span class="tex-fbox">' + r.inl(r.arg()) + '</span>'); },
  parbox: (r) => { r.opt(); r.opt(); r.opt(); const w = parseWidth(r.arg()); r.text('<span class="tex-parbox"' + (w ? ' style="width:' + w + '"' : '') + '>' + r.inl(r.arg()) + '</span>'); },
  smash: (r) => { r.opt(); r.text(r.inl(r.arg())); },
  vphantom: (r) => { r.arg(); }, hphantom: (r) => { r.arg(); },
  IfFileExists: (r) => { r.arg(); r.arg(); r.content(r.arg()); },
  ifthenelse: (r) => { r.arg(); r.content(r.arg()); r.arg(); },
  hyperref: (r) => { const o = r.opt(); const t = r.arg(); const k = (o || '').trim(); r.text('\u0001R\u0002hyper\u0002' + k + '\u0002' + r.inl(t) + '\u0001'); },
  twocolumn: (r) => { const o = r.opt(); if (o != null) r.content(o); },
  footnote: (r) => {
    r.opt(); const t = r.arg(); const c = r.c;
    const n = ++c.counters.footnote;
    const fh = r.inl(t);
    if (!c.quiet) c.footnotes.push({ n, html: fh });
    r.text('<sup class="tex-fnref"><a id="fnref-' + n + '" href="#fn-' + n + '">' + n + '</a></sup>');
  },
  footnotetext: (r) => { r.opt(); r.arg(); },
  title: (r) => { r.opt(); r.c.title = r.arg(); }, author: (r) => { r.opt(); r.c.author = r.arg(); }, date: (r) => { r.c.date = r.arg(); },
  '@partbegin': (r) => { r.block('\u0003B\u0003'); r.c.quiet = false; },
  '@partend': (r) => { r.block('\u0003E\u0003'); r.c.quiet = true; },
  maketitle: (r) => { const h = r.c.titleBlock(); if (h) r.block(h); },
  maketitlesupplementary: (r) => { const h = r.c.titleBlock(); if (h) r.block(h); },
  appendix: (r) => { r.c.appendix = true; r.c.sec = [0, 0, 0]; },
  label: (r) => {
    const k = r.arg().trim(); const c = r.c;
    if (!c.labels.has(k)) c.labels.set(k, { num: c.last.num, id: idOf(k), type: c.last.type });
    r.text('<a id="' + idOf(k) + '"></a>');
  },
  caption: (r) => r.c.caption(r),
  captionof: (r) => { const t = r.arg().trim(); r.c.caption(r, t); },
  captionsetup: (r) => { r.opt(); const a = r.arg(); const m = /type\s*=\s*(figure|table)/.exec(a || ''); if (m) r.c.capType = m[1]; },
  subfloat: (r) => { const cap = r.opt(); const body = r.arg(); r.block(r.c.subFigure(r, body + (cap != null ? '\\caption{' + cap + '}' : ''), null)); },
  includegraphics: (r) => { r.star(); const o = r.opt(); const p = r.arg().trim(); r.text(r.c.image(p, o)); },
  item: (r) => { r.opt(); r.flush(); r.text('• '); },
  bibliography: (r) => { const a = r.arg(); r.c.bibWanted = true; r.c.bibNames.push(...a.split(',').map((x) => x.trim()).filter(Boolean)); r.block('\u0001B\u0001'); },
  printbibliography: (r) => { r.opt(); r.c.bibWanted = true; r.block('\u0001B\u0001'); },
  nocite: (r) => { r.arg(); },
  begin: (r) => {
    const j = skipWs(r.s, r.i);
    if (r.s[j] !== '{') return;
    const g = readGroup(r.s, j); const name = g.text.trim();
    const e = findEnd(r.s, g.end, name);
    let content;
    if (e) { content = r.s.slice(g.end, e.start); r.i = e.end; } else { content = r.s.slice(g.end); r.i = r.n; }
    const base = name.replace(/\*$/, '');
    const c = r.c;
    if (c.st.theorems.has(base) || (THEOREMS[base] && !ENV[base])) return theoremEnv(r, base, content);
    const fn = ENV[name] || ENV[base];
    if (fn) fn(r, name, content);
    else if (SILENT_ENVS.has(base)) r.content(content);
    else { c.unk('\\begin{' + name + '}', true); r.content(content); }
  },
  end: (r) => { r.arg(); },
  section: (r, n) => r.c.heading(r, n), subsection: (r, n) => r.c.heading(r, n), subsubsection: (r, n) => r.c.heading(r, n),
  paragraph: (r, n) => r.c.heading(r, n), subparagraph: (r, n) => r.c.heading(r, n), chapter: (r, n) => r.c.heading(r, n),
  // ----- algorithmic -----
  State: (r) => { r.c.algoLine(r, '', ''); }, Statex: (r) => { r.c.algoLine(r, '', '', { nonum: true }); },
  Require: (r) => { r.c.algoLine(r, '<b>Require:</b> ', '', { nonum: true }); }, Ensure: (r) => { r.c.algoLine(r, '<b>Ensure:</b> ', '', { nonum: true }); },
  Input: (r) => { r.c.algoLine(r, '<b>Input:</b> ', '', { nonum: true }); }, Output: (r) => { r.c.algoLine(r, '<b>Output:</b> ', '', { nonum: true }); },
  KwIn: (r) => { r.c.algoLine(r, '<b>Input:</b> ', r.inl(r.arg()), { nonum: true }); }, KwOut: (r) => { r.c.algoLine(r, '<b>Output:</b> ', r.inl(r.arg()), { nonum: true }); },
  KwResult: (r) => { r.c.algoLine(r, '<b>Result:</b> ', r.inl(r.arg()), { nonum: true }); }, KwRet: (r) => { r.text('<b>return</b> ' + r.inl(r.arg())); },
  Return: (r) => { r.text('<b>return</b> '); }, Comment: (r) => { r.text(' <span class="tex-algo-c">▷ ' + r.inl(r.arg()) + '</span>'); },
  tcc: (r) => { r.text(' <span class="tex-algo-c">// ' + r.inl(r.arg()) + '</span>'); }, tcp: (r) => { r.text(' <span class="tex-algo-c">// ' + r.inl(r.arg()) + '</span>'); },
  ';': (r) => { r.text(r.c.inAlgo ? '\n' : ' '); }, Call: (r) => { const f = r.arg(); const a = r.arg(); r.text('<span class="sc">' + r.inl(f) + '</span>(' + r.inl(a) + ')'); },
  True: (r) => { r.text('<b>true</b>'); }, False: (r) => { r.text('<b>false</b>'); }, And: (r) => { r.text('<b>and</b>'); }, Or: (r) => { r.text('<b>or</b>'); }, Not: (r) => { r.text('<b>not</b>'); },
  Else: (r) => { const s = r.s; if (s[skipWs(s, r.i)] === '{') { r.c.algoLine(r, '<b>else</b>', '', { pre: 0, post: 1 }); blockBody(r); } else r.c.algoLine(r, '<b>else</b>', '', { pre: 1, post: 1 }); },
  Function: (r) => { const f = r.arg(); const a = r.arg(); r.c.algoLine(r, '<b>function</b> ', r.inl(f) + '(' + r.inl(a) + ')', { post: 1 }); },
  Procedure: (r) => { const f = r.arg(); const a = r.arg(); r.c.algoLine(r, '<b>procedure</b> ', r.inl(f) + '(' + r.inl(a) + ')', { post: 1 }); },
  Loop: (r) => { r.c.algoLine(r, '<b>loop</b>', '', { post: 1 }); }, Repeat: (r) => { r.c.algoLine(r, '<b>repeat</b>', '', { post: 1 }); },
  Until: (r) => { r.c.algoLine(r, '<b>until</b> ', r.inl(r.arg()), { pre: 1 }); },
  ElsIf: (r) => { r.c.algoLine(r, '<b>else if</b> ', r.inl(r.arg()), { pre: 1, post: 1, suffix: ' <b>then</b>' }); },
});
for (const [k, kw, suffix] of [['If', 'if', ' then'], ['For', 'for', ' do'], ['ForAll', 'for all', ' do'], ['While', 'while', ' do'], ['uIf', 'if', ' then'], ['lIf', 'if', ' then'], ['ForEach', 'foreach', ' do']]) {
  H[k] = (r) => {
    const cond = r.inl(r.arg());
    const s = r.s;
    if (s[skipWs(s, r.i)] === '{') { r.c.algoLine(r, '<b>' + kw + '</b> ', cond, { suffix: '<b>' + suffix + '</b>', post: 1 }); blockBody(r); }
    else r.c.algoLine(r, '<b>' + kw + '</b> ', cond, { suffix: '<b>' + suffix + '</b>', post: 1 });
  };
}
function blockBody(r) { // algorithm2e body in braces: run it, then close the indent
  const b = r.arg(); r.text(r.inl(b)); r.c.algoDepth = Math.max(0, r.c.algoDepth - 1);
}
for (const [k, kw] of [['EndIf', 'end if'], ['EndFor', 'end for'], ['EndWhile', 'end while'], ['EndFunction', 'end function'], ['EndProcedure', 'end procedure'], ['EndLoop', 'end loop']]) {
  H[k] = (r) => { r.c.algoLine(r, '<b>' + kw + '</b>', '', { pre: 1 }); };
}
// \cite family and \ref family
for (const k of ['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar', 'citenum', 'Citep', 'Citet', 'parencite', 'textcite', 'autocite', 'footcite', 'shortcite', 'Cite']) {
  H[k] = (r) => {
    r.star(); const o1 = r.opt(); const o2 = r.opt(); const keys = r.arg();
    const post = o2 != null ? o2 : o1;
    const c = r.c; if (!c.quiet) c.stats.citations++;
    r.text('\u0001C\u0002' + keys.replace(/\s+/g, '') + '\u0002' + (post ? r.inl(post).replace(/[\u0001\u0002]/g, '') : '') + '\u0001');
  };
}
for (const [k, mode] of [['ref', 'ref'], ['eqref', 'eqref'], ['autoref', 'auto'], ['cref', 'cref'], ['Cref', 'Cref'], ['crefrange', 'cref'], ['vref', 'cref'], ['pageref', 'page'], ['nameref', 'page'], ['cpageref', 'page']]) {
  H[k] = (r) => { r.star(); const keys = r.arg(); r.text('\u0001R\u0002' + mode + '\u0002' + keys.replace(/\s+/g, '') + '\u0001'); };
}
// declarations that apply to the rest of the group
function declWrap(r, open, close) {
  const rest = r.s.slice(r.i); r.i = r.n;
  if (!open) { r.content(rest); return; }
  if (!r.inline && needsBlock(rest)) { r.flush(); r.html += open + r.c.run(rest, false) + close; } else r.para += open + r.c.run(rest, true) + close;
}
for (const [k, o, c] of [['bf', '<b>', '</b>'], ['bfseries', '<b>', '</b>'], ['it', '<i>', '</i>'], ['itshape', '<i>', '</i>'], ['em', '<em>', '</em>'], ['sl', '<i>', '</i>'], ['slshape', '<i>', '</i>'],
  ['tt', '<code class="tt">', '</code>'], ['ttfamily', '<code class="tt">', '</code>'], ['sc', '<span class="sc">', '</span>'], ['scshape', '<span class="sc">', '</span>']]) {
  H[k] = (r) => declWrap(r, o, c);
}
H.rm = H.sf = H.sffamily = () => {};
H.item = (r) => { r.opt(); r.flush(); r.text('• '); };

// ----- environments -----
const centerEnv = (cls) => (r, name, content) => { r.block('<div class="' + cls + '">' + r.c.run(content, false) + '</div>'); };
Object.assign(ENV, {
  center: centerEnv('tex-center'), flushleft: centerEnv('tex-left'), flushright: centerEnv('tex-right'),
  quote: (r, n, content) => r.block('<blockquote>' + r.c.run(content, false) + '</blockquote>'),
  quotation: (r, n, content) => r.block('<blockquote>' + r.c.run(content, false) + '</blockquote>'),
  verse: (r, n, content) => r.block('<blockquote>' + r.c.run(content, false) + '</blockquote>'),
  abstract: (r, n, content) => r.block('<div class="tex-abstract"><div class="tex-abs-h">Abstract</div>' + r.c.run(content, false) + '</div>'),
  itemize: (r, n, content) => r.c.list(r, 'itemize', content),
  enumerate: (r, n, content) => r.c.list(r, 'enumerate', content),
  description: (r, n, content) => r.c.list(r, 'description', content),
  trivlist: (r, n, content) => r.c.list(r, 'itemize', content),
  figure: (r, n, content) => r.c.floatEnv(r, 'figure', content, false),
  wrapfigure: (r, n, content) => r.c.floatEnv(r, 'figure', content, true),
  floatingfigure: (r, n, content) => r.c.floatEnv(r, 'figure', content, true),
  sidewaysfigure: (r, n, content) => r.c.floatEnv(r, 'figure', content, false),
  SCfigure: (r, n, content) => r.c.floatEnv(r, 'figure', content, false),
  table: (r, n, content) => r.c.floatEnv(r, 'table', content, false),
  wraptable: (r, n, content) => r.c.floatEnv(r, 'table', content, true),
  sidewaystable: (r, n, content) => r.c.floatEnv(r, 'table', content, false),
  algorithm: (r, n, content) => r.c.floatEnv(r, 'algorithm', content, false),
  subfigure: (r, n, content) => { const a = new AR(content); a.opt(); const w = a.arg(); r.block(r.c.subFigure(r, a.rest(), w)); },
  subtable: (r, n, content) => { const a = new AR(content); a.opt(); const w = a.arg(); r.block(r.c.subFigure(r, a.rest(), w)); },
  minipage: (r, n, content) => { const a = new AR(content); a.opt(); const w = parseWidth(a.arg() || ''); r.block('<div class="tex-mini"' + (w ? ' style="width:' + w + '"' : '') + '>' + r.c.run(a.rest(), false) + '</div>'); },
  algorithmic: (r, n, content) => {
    const c = r.c; const a = new AR(content); const o = a.opt();
    const save = [c.algoDepth, c.algoNum, c.algoLn, c.inAlgo];
    c.inAlgo = true; c.algoDepth = 0; c.algoNum = o != null; c.algoLn = 0;
    let body;
    try { body = c.run(a.rest(), true); } finally { [c.algoDepth, c.algoNum, c.algoLn, c.inAlgo] = save; }
    r.block('<div class="tex-algo">' + body.replace(/^\s+/, '') + '</div>');
  },
  thebibliography: (r, n, content) => {
    const a = new AR(content); a.arg();
    const items = parseBibItems(a.rest());
    r.c.bibItems = items.map((it) => ({ key: it.key, html: r.c.run(it.body, true) }));
    r.c.bibWanted = true; r.block('\u0001B\u0001');
  },
  proof: (r, n, content) => { const a = new AR(content); const o = a.opt(); r.block('<div class="tex-thm tex-proof"><i>' + (o != null ? r.inl(o) : 'Proof') + '.</i> ' + r.c.run(a.rest(), false) + ' <span class="tex-qed">∎</span></div>'); },
  tikzpicture: (r) => { r.block('<div class="tex-gfx tex-block">TikZ drawing (not rendered)</div>'); },
  pgfpicture: (r) => { r.block('<div class="tex-gfx tex-block">PGF drawing (not rendered)</div>'); },
  picture: (r) => { r.block('<div class="tex-gfx tex-block">picture (not rendered)</div>'); },
  filecontents: () => {}, comment: () => {},
  tabular: tabEnv(false), 'tabular*': tabEnv(true), tabularx: tabEnv(true), tabulary: tabEnv(true), longtable: tabEnv(false), array: tabEnv(false),
});
function tabEnv(hasWidth) {
  return (r, name, content) => {
    const a = new AR(content); a.opt(); if (hasWidth) a.arg(); a.opt();
    const spec = a.arg();
    if (name === 'longtable') r.c.capType = 'table';
    r.block(r.c.tabular(a.rest(), spec || ''));
  };
}
for (const nm of ['equation', 'displaymath', 'math', 'align', 'alignat', 'xalignat', 'flalign', 'gather', 'multline', 'eqnarray']) {
  ENV[nm] = (r, name, content) => r.block(r.c.mathEnv(name, content));
}
function theoremEnv(r, base, content) {
  const c = r.c; const th = c.st.theorems.get(base) || { title: THEOREMS[base], counter: base, star: false };
  const star = th.star;
  const a = new AR(content); const o = a.opt();
  let numTxt = '';
  if (!star) { const k = th.counter; const n = (c.thm.get(k) || 0) + 1; c.thm.set(k, n); numTxt = ' ' + n; c.last = { num: String(n), id: null, type: 'theorem' }; }
  const head = '<b>' + esc(th.title) + numTxt + (o != null ? ' (' + r.inl(o) + ')' : '') + '.</b> ';
  const inner = c.run(a.rest(), false);
  r.block('<div class="tex-thm">' + inner.replace(/^<p>/, '<p>' + head) .replace(/^(?!<p>)/, head) + '</div>');
}

// ---------- post processing ----------
function nameFor(st, type, cap, plural) {
  const tbl = cap ? st.crefCap : st.crefLow;
  if (tbl[type]) return tbl[type][plural ? 1 : 0];
  const base = { section: ['section', 'sections'], figure: ['figure', 'figures'], table: ['table', 'tables'], equation: ['equation', 'equations'], algorithm: ['algorithm', 'algorithms'], item: ['item', 'items'], theorem: ['theorem', 'theorems'], appendix: ['appendix', 'appendices'] }[type] || [type, type + 's'];
  const w = base[plural ? 1 : 0];
  return cap ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

function resolveRefs(html, conv) {
  const st = conv.st;
  return html.replace(/\u0001R\u0002([a-z]+)\u0002([^\u0001\u0002]*)(?:\u0002([^\u0001]*))?\u0001/gi, (m, mode, keys, text) => {
    if (mode === 'hyper') {
      const info = conv.labels.get(keys.trim()) || conv.aux.get(keys.trim());
      return info && info.id ? '<a class="tex-ref" href="#' + info.id + '">' + text + '</a>' : text;
    }
    const items = keys.split(',').filter(Boolean).map((k) => {
      const info = conv.labels.get(k) || conv.aux.get(k);
      return { k, info };
    });
    const fmt = (it) => {
      if (!it.info) { conv.stats.unresolvedRefs++; (conv.stats.unresolvedKeys = conv.stats.unresolvedKeys || []).push(it.k); return '<span class="tex-unres">??</span>'; }
      if (mode === 'page') return '<span class="tex-unres">??</span>';
      const t = esc(it.info.type === 'equation' && (mode === 'eqref' || mode === 'auto' || mode === 'cref' || mode === 'Cref') ? '(' + it.info.num + ')' : it.info.num);
      return it.info.id ? '<a class="tex-ref" href="#' + it.info.id + '">' + t + '</a>' : '<span class="tex-ref">' + t + '</span>';
    };
    if (mode === 'ref' || mode === 'eqref' || mode === 'page') return items.map(fmt).join(', ');
    const joinList = (arr) => (arr.length <= 2 ? arr.join(' and ') : arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1]);
    const known = items.filter((x) => x.info);
    const sameType = known.length === items.length && known.every((x) => x.info.type === known[0].info.type);
    const label = (type, plural) => (mode === 'auto' ? { section: 'Section', figure: 'Figure', table: 'Table', equation: 'Equation', algorithm: 'Algorithm', item: 'Item' }[type] || nameFor(st, type, true, false) : nameFor(st, type, mode === 'Cref', plural));
    if (sameType && items.length) return label(known[0].info.type, items.length > 1 && mode !== 'auto') + ' ' + joinList(items.map(fmt));
    return joinList(items.map((it) => (it.info ? label(it.info.type, false) + ' ' : '') + fmt(it)));
  });
}

function resolveCites(html, conv) {
  const st = conv.st;
  const order = new Map();
  const bibIdx = new Map();
  if (conv.bibItems) conv.bibItems.forEach((it, i) => bibIdx.set(it.key, i + 1));
  const re = /\u0001C\u0002([^\u0001\u0002]*)\u0002([^\u0001]*)\u0001/g;
  let m;
  while ((m = re.exec(html))) {
    for (const k of m[1].split(',').filter(Boolean)) if (!order.has(k)) order.set(k, order.size + 1);
  }
  conv.stats.uniqueCited = order.size;
  const numOf = (k) => (bibIdx.size ? bibIdx.get(k) || null : order.get(k));
  const out = html.replace(re, (mm, keys, post) => {
    const ks = keys.split(',').filter(Boolean);
    const nums = ks.map((k) => ({ k, n: numOf(k) }));
    const cell = (x) => (x.n ? '<a class="tex-cite" href="#' + idOf('bib-' + x.k) + '">' + x.n + '</a>' : '<span class="tex-unres">?</span>');
    // compress runs like 3, 4, 5 -> 3-5 when all numbers are known and ascending
    let parts = [];
    if (nums.every((x) => x.n) && nums.length >= 3) {
      let i = 0;
      while (i < nums.length) {
        let j = i; while (j + 1 < nums.length && nums[j + 1].n === nums[j].n + 1) j++;
        if (j - i >= 2) parts.push(cell(nums[i]) + '–' + cell(nums[j])); else for (let q = i; q <= j; q++) parts.push(cell(nums[q]));
        i = j + 1;
      }
    } else parts = nums.map(cell);
    return '[' + parts.join(', ') + (post ? ', ' + post : '') + ']';
  });
  return { html: out, order };
}

// ---------- main ----------
function newState(opts) {
  const st = {
    readFile: opts.readFile || (async () => null), exists: opts.exists || null, resolveImage: opts.resolveImage || null,
    baseName: opts.baseName || 'main', maxDepth: opts.maxDepth || 10,
    part: opts.part ? { rel: opts.part.rel, text: opts.part.text, used: false } : null, verb: [], cond: [], flags: new Map(), stack: [], inputCount: 0,
    macros: new Map(), envs: new Map(), colors: new Map(), theorems: new Map(), graphicsPath: [],
    crefLow: {}, crefCap: {}, numPrefix: {}, eqWithin: false, budget: 60000, katexMacros: {}, text: '', builtin: null,
  };
  st.builtin = new Set([...Object.keys(H), ...PROTECT]);
  return st;
}

function buildKatexMacros(st) {
  const m = { '\\mathbbm': '\\mathbb{#1}', '\\mathds': '\\mathbb{#1}', '\\bm': '\\boldsymbol{#1}', '\\textsc': '\\text{#1}', '\\mbox': '\\text{#1}' };
  for (const [name, rec] of st.macros) {
    if (name.includes('@') || rec.def !== null || !/^[A-Za-z]+$/.test(name)) continue;
    m['\\' + name] = rec.body.replace(/\\xspace(?![A-Za-z@])/g, '');
  }
  return m;
}

async function resolveImages(conv, text) {
  const st = conv.st;
  const paths = new Set();
  const re = /\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g; let m;
  while ((m = re.exec(text))) paths.add(m[1].trim());
  const join = (a, b) => (a ? (a.endsWith('/') ? a : a + '/') + b : b).replace(/\/\.\//g, '/').replace(/^\.\//, '');
  await Promise.all([...paths].map(async (p) => {
    const hasExt = /\.([A-Za-z]{2,4})$/.exec(p);
    const known = hasExt && GFX_EXTS.includes(hasExt[1].toLowerCase());
    const exts = known ? [''] : GFX_EXTS.map((e) => '.' + e);
    const prefixes = p.startsWith('/') ? [''] : ['', ...st.graphicsPath];
    const cands = [];
    for (const pre of prefixes) for (const e of exts) cands.push(join(pre, p) + e);
    let found = null;
    if (st.exists) {
      const flags = await Promise.all(cands.map((c) => Promise.resolve(st.exists(c)).then((x) => !!x, () => false)));
      const idx = flags.indexOf(true);
      if (idx >= 0) found = cands[idx];
    } else found = cands[0];
    if (found) conv.images.set(p, { rel: found, ext: (/\.([A-Za-z]+)$/.exec(found) || [0, ''])[1] });
    else conv.images.set(p, null);
  }));
}

async function texToHtml(text, opts) {
  opts = opts || {};
  const t0 = Date.now();
  let conv = null;
  try {
    const st = newState(opts);
    conv = new Conv(st);
    let src = String(text);
    if (st.part && opts.part.preambleOnly) {
      const bd = src.indexOf('\\begin{document}');
      src = (bd >= 0 ? src.slice(0, bd) : src) + '\\begin{document}\\@partbegin ' + st.part.text + '\\@partend \\end{document}';
      st.part.used = true;
    }
    let t = stripComments(extractVerbatim(src, st));
    t = await flatten(t, st, 0);
    for (let pass = 0; pass < 4; pass++) {
      st.cond = [];
      t = extractDefs(t, st);
      t = expandMacros(t, st, 0);
      if (!/\\(?:input|include|subfile|subfileinclude|IfFileExists)(?![A-Za-z@])/.test(t)) break;
      st.evalFile = true;
      const before = t;
      t = await flatten(t, st, 0);
      if (t === before) break;
    }
    st.katexMacros = buildKatexMacros(st);
    st.text = t; conv.hasChapter = /\\chapter(?![A-Za-z])/.test(t);
    conv.stats.inputs = st.inputCount;
    // aux labels (exact numbers when a compiled .aux exists), external documents, bbl
    const extern = []; const ex = /\\externaldocument(?:\[([^\]]*)\])?\{([^}]*)\}/g; let m;
    while ((m = ex.exec(t))) extern.push([m[1] || '', m[2].trim()]);
    const tasks = [];
    tasks.push(Promise.resolve(st.readFile(st.baseName + '.aux')).then((x) => { if (typeof x === 'string') parseAux(x, '', conv.aux); }, () => {}));
    for (const [pre, nm] of extern) tasks.push(Promise.resolve(st.readFile(nm + '.aux')).then((x) => { if (typeof x === 'string') parseAux(x, pre, conv.aux); }, () => {}));
    tasks.push(Promise.resolve(st.readFile(st.baseName + '.bbl')).then((x) => {
      if (typeof x !== 'string') return;
      const x2 = stripComments(x); const b = x2.indexOf('\\begin{thebibliography}');
      if (b < 0) return;
      const g = readGroup(x2, skipWs(x2, b + 23));
      const e = x2.indexOf('\\end{thebibliography}');
      conv.bblItems = parseBibItems(x2.slice(g.end, e < 0 ? undefined : e));
    }, () => {}));
    tasks.push(resolveImages(conv, t));
    await Promise.all(tasks);
    // bibliography names (for .bib fallback) are known after conversion; read them lazily below
    let body = t; let pre = '';
    const b = t.indexOf('\\begin{document}');
    if (b >= 0) {
      pre = t.slice(0, b);
      const e = t.lastIndexOf('\\end{document}');
      body = t.slice(b + 16, e > b ? e : undefined);
    }
    if (pre) { conv.quiet = true; conv.run(pre, false); conv.quiet = false; conv.last = { num: '', id: null, type: 'section' }; }
    if (st.part) conv.quiet = true; // only the opened file counts
    if (conv.bblItems) conv.bibItems = conv.bblItems.map((it) => ({ key: it.key, html: conv.run(it.body.replace(/\\newblock/g, ' '), true) }));
    let out = conv.run(body, false);
    if (!st.part && !conv.titleDone && conv.title != null && !/\\maketitle/.test(t)) out = conv.titleBlock() + out;
    // .bib fallback for the reference list
    if (conv.bibWanted && !conv.bibItems && conv.bibNames.length) {
      for (const nm of conv.bibNames) {
        try { const x = await st.readFile(/\.bib$/i.test(nm) ? nm : nm + '.bib'); if (typeof x === 'string') for (const [k, v] of parseBibFile(x)) conv.bibFiles.set(k, v); } catch (e) { /* ignore */ }
      }
    }
    const cites = resolveCites(out, conv); let html = cites.html;
    if (st.part) {
      const ib = html.indexOf('\u0003B\u0003'); const ie = html.indexOf('\u0003E\u0003');
      conv.stats.partFound = ib >= 0 && ie > ib;
      if (conv.stats.partFound) html = html.slice(ib + 3, ie);
      if (opts.rootName) html = '<div class="tex-partof">Part of ' + esc(opts.rootName) + '</div>' + html;
    }
    html = resolveRefs(html, conv);
    html = html.replace(/\u0001B\u0001/g, (() => {
      let done = false;
      return () => {
        if (done) return ''; done = true;
        let items;
        if (conv.bibItems) items = conv.bibItems;
        else items = [...cites.order.keys()].map((k) => ({ key: k, html: conv.bibFiles.has(k) ? conv.run(formatBib(conv.bibFiles.get(k)), true) : '<code class="tt">' + esc(k) + '</code>' }));
        if (!items.length) return '';
        return '<section class="tex-refs"><h2>References</h2><ol>' + items.map((it, i) => '<li id="' + idOf('bib-' + it.key) + '"><span class="tex-bibno">[' + (i + 1) + ']</span> ' + it.html + '</li>').join('') + '</ol></section>';
      };
    })());
    html = html.replace(/\u0001B\u0001/g, '');
    if (conv.footnotes.length) {
      html += '<section class="tex-footnotes"><hr><ol>' + conv.footnotes.map((f) => '<li id="fn-' + f.n + '">' + f.html + ' <a class="tex-fnback" href="#fnref-' + f.n + '">↩</a></li>').join('') + '</ol></section>';
    }
    html = html.replace(/[\u0000-\u0003]/g, '');
    const stats = conv.stats;
    stats.ms = Date.now() - t0; stats.rootName = opts.rootName;
    stats.unknownTop = [...stats.unknown.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 15);
    stats.unknownEnvTop = [...stats.unknownEnvs.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 10);
    if (!html.replace(/<[^>]*>/g, '').trim()) html = '<p class="tex-note">(This LaTeX file has no visible text.)</p>' + html;
    return { html: '<div class="tex-doc">' + html + '</div>', stats };
  } catch (e) {
    const stats = conv ? conv.stats : {}; stats.error = String(e && e.message); stats.ms = Date.now() - t0;
    return { html: '<p class="tex-note">LaTeX preview failed (' + esc(e && e.message) + '). The source is shown below.</p><pre>' + esc(text) + '</pre>', stats };
  }
}

module.exports = { texToHtml };
