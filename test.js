const { createRenderer } = require('./src/render');
const r = createRenderer({ resolveImage: (s) => 'vscode-resource://x/' + s });
const h = r('# Title A\n\nText $a^2$ and\n\n$$\\int_0^1 x\\,dx$$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![f](fig.png)\n\n```python\nprint(1)\n```\n\n- [x] done\n- [ ] todo\n\n[s](#title-a) <b>x</b> https://a.com\n');
console.log(h.length); console.log(['id="title-a"','katex','<table','vscode-resource://x/fig.png','hljs','task-list'].map(k=>k+':'+h.includes(k)).join(' '));
