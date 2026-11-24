# Agent guide

Fast Document Viewer is a VS Code and Cursor extension (plain CommonJS JavaScript, no build step) that shows Markdown, PDF, HTML and LaTeX in one reused webview panel. It runs on the UI side (`extensionKind: ["ui"]`) so it stays fast over Remote-SSH.

## Commands

- `npm ci` install dependencies
- `npm run check` syntax-check every source file
- `npm test` run the `node:test` suite in `test/` (no network, no TeX needed)
- `npm run package` build the `.vsix`

Run `npm run check && npm test` before every commit. CI runs the same commands plus `vsce package`.

## Layout

- `extension.js`: activation, `FollowPanel`, `Manager` (one panel per editor column), `HtmlPanel`, file polling
- `src/render.js`: Markdown rendering
- `src/tex.js`: LaTeX to HTML preview. `src/texroot.js`: root-file detection. `src/texcompile.js`: compile mode (local copy, `latexmk`, log parsing)
- `media/`: webview script and styles, bundled pdf.js
- `docs/latex.md`: LaTeX behaviour in detail

## Rules

- Settings, command and custom-editor IDs keep the `paperMd.` prefix. Do not rename them without a migration.
- No network requests, telemetry or `-shell-escape`. Webview CSP changes need a security note in the PR.
- Compile mode never writes into the user's project. It only writes under the extension's global storage.
- Add or update a test for every behaviour change. Mark a known, unfixed bug with `{ todo: '...' }` instead of deleting the test.
- Work on a branch and open a pull request. Do not push to `main`, edit the publisher or registry tokens, or publish a release without the maintainer's approval.
- Keep the README short. Put detail in `docs/`.
