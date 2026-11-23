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
        t.attrSet('id', n ? base + '-' + n : base);
      } else if (t.type === 'inline' && t.children) {
        for (const c of t.children) {
          if (c.type === 'image') {
            const src = c.attrGet('src');
            if (src && !/^(https?:|data:|vscode-|#)/i.test(src)) {
              const out = resolveImage(src);
              if (out) c.attrSet('src', out);
            }
          }
        }
      }
    }
  });
  return (text) => md.render(text);
}

module.exports = { createRenderer, slugify };
