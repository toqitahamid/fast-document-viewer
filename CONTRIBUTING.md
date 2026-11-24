# Contributing

Thanks for helping. Small, focused changes are easiest to review.

## Setup

```bash
git clone https://github.com/toqitahamid/fast-document-viewer.git
cd fast-document-viewer
npm ci
```

Press F5 in VS Code to start an Extension Development Host. Node 18 or newer is needed. There is no build step.

## Checks

```bash
npm run check   # syntax-checks every source file
npm test        # node:test suite, no network or TeX needed
```

Run both before you push. CI runs them too.

## Branch and pull request flow

1. Fork the repository or create a branch. Do not push to `main`.
2. Make a small change and add or update a test.
3. Open a pull request and fill in the template. Say how you tried the change.

## Commit style

Short, imperative subject line, for example `Fix crash on empty .tex file`. Add a line of detail when the reason is not obvious.

## Adding a test

Tests live in `test/*.test.js` and use `node:test` and `node:assert`. Pick the file that matches the code: `render.test.js` for Markdown, `tex.test.js` for the LaTeX preview, `texroot.test.js` for root detection, `texcompile.test.js` for compile mode. Add a `test('what it does', () => { ... })` case with the smallest input that fails before your change. Mark a known, unfixed bug with `{ todo: '...' }` instead of deleting the test.

## Code layout

See [AGENTS.md](AGENTS.md) for the file map and project rules. Setting, command and custom-editor IDs keep the `fastDocViewer.` prefix.

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
