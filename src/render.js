'use strict';
const MarkdownIt = require('markdown-it');
const katexPlugin = require('@vscode/markdown-it-katex').default;
const taskLists = require('markdown-it-task-lists');
const hljs = require('highlight.js/lib/core');

const langs = {
  python: 'python', py: 'python', bash: 'bash', sh: 'bash', shell: 'bash',
  javascript: 'javascript', js: 'javascript', typescript: 'typescript', ts: 'typescript',
  json: 'json', yaml: 'yaml', yml: 'yaml', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  xml: 'xml', html: 'xml', css: 'css', latex: 'latex', tex: 'latex',
  sql: 'sql', diff: 'diff', markdown: 'markdown', md: 'markdown',
};
for (const name of new Set(Object.values(langs))) {
  hljs.registerLanguage(name, require('highlight.js/lib/languages/' + name));
}

function slugify(s) {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

// Heading ids get this prefix so they can never collide with the viewer's own ids
// (content, pdf, pdfbar, ...). In-page links to "#title" are mapped to it by main.js.
const ID_PREFIX = 'h-';
const headingId = (slug) => ID_PREFIX + slug;
const LOCAL_SRC = /^(https?:|data:|vscode-|#|\/\/)/i;

/**
 * createRenderer({ resolveImage }) -> render(text)
 * resolveImage(src) returns a rewritten URL string, or null to keep src.
 */
function createRenderer(opts) {
  const resolveImage = (opts && opts.resolveImage) || (() => null);
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      const l = langs[(lang || '').toLowerCase()];
      if (l) {
        try {
          return '<pre class="hljs"><code>' + hljs.highlight(code, { language: l, ignoreIllegals: true }).value + '</code></pre>';
        } catch (e) { /* fall through */ }
      }
      return '';
    },
  });
  md.use(katexPlugin);
  md.use(taskLists, { enabled: false });

  md.core.ruler.push('paper_ids_and_images', (state) => {
    const used = new Map();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'heading_open') {
        const inline = toks[i + 1];
        let base = slugify(inline.children ? inline.children.map((c) => c.content).join('') : inline.content) || 'section';
        const n = used.get(base) || 0;
        used.set(base, n + 1);
        t.attrSet('id', headingId(n ? base + '-' + n : base));
      } else if (t.type === 'inline' && t.children) {
        for (const c of t.children) {
          if (c.type === 'image') {
            const src = c.attrGet('src');
            if (src && !LOCAL_SRC.test(src)) {
              const out = resolveImage(src);
              if (out) c.attrSet('src', out);
            }
          }
          if (c.type === 'html_inline') c.content = rewriteImgTags(c.content);
        }
      } else if (t.type === 'html_block') {
        t.content = rewriteImgTags(t.content);
      }
    }
  });

  // Raw <img src="..."> in HTML blocks: resolve relative sources like Markdown images.
  const SRC_ATTR = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  function rewriteImgTags(html) {
    if (!/<img\b/i.test(html)) return html;
    return html.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(SRC_ATTR, (whole, pre, a, b, c) => {
      const src = md.utils.unescapeAll(a !== undefined ? a : b !== undefined ? b : c);
      if (!src || LOCAL_SRC.test(src)) return whole;
      const out = resolveImage(src);
      return out ? pre + '"' + md.utils.escapeHtml(out) + '"' : whole;
    }));
  }
  return (text) => md.render(text);
}

module.exports = { createRenderer, slugify, headingId, ID_PREFIX };
