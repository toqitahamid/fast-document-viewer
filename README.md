# Fast Document Viewer

[![Release](https://img.shields.io/github/v/release/toqitahamid/fast-document-viewer?sort=semver)](https://github.com/toqitahamid/fast-document-viewer/releases/latest)
[![License: MIT](https://img.shields.io/github/license/toqitahamid/fast-document-viewer)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC)](https://code.visualstudio.com/)

A fast, efficient, read-only viewer for Markdown, PDF, HTML and LaTeX in VS Code and Cursor. Files appear as a clean printed page, and switching between them takes tens of milliseconds, including over Remote-SSH.

## Why

A new webview tab costs about 1 s in VS Code and Cursor, and many viewers run on the remote host and fetch their assets over SSH. Fast Document Viewer runs locally and reuses one panel for every file, so only the first open pays the cost.

## Features

- **Markdown:** GFM, task lists, KaTeX math, syntax highlighting, relative images and links.
- **PDF:** bundled pdf.js with zoom, fit-width and selectable text.
- **HTML:** rendered in a sandboxed panel with relative assets resolved.
- **LaTeX:** an instant HTML preview with no TeX install, or the real PDF built by `latexmk`. See [docs/latex.md](docs/latex.md).
- **Side by side:** one panel per editor column, and Open to the Side adds a second viewer.
- **Live reload:** a changed file, such as a rebuilt PDF, refreshes on its own.
- **Light and read-only:** no language server, no indexing, no telemetry.

## Install

1. Download the `.vsix` from the [latest release](https://github.com/toqitahamid/fast-document-viewer/releases/latest).
2. Install it and reload the window:

   ```bash
   code --install-extension fast-document-viewer-<version>.vsix
   cursor --install-extension fast-document-viewer-<version>.vsix
   ```

Requires VS Code 1.85 or newer, or a recent Cursor. Compile mode also needs TeX on your local machine.

Upgrading from Paper MD Viewer (0.7.6 and earlier)? The extension ID changed, so uninstall the old one with `--uninstall-extension toqitahamid.paper-md-viewer`. Your `paperMd.*` settings keep working.

## Quick start

Add this to your user `settings.json` and reload:

```json
{
  "paperMd.followPanel.autoOpen": true,
  "paperMd.followPanel.replaceTextTab": true,
  "paperMd.pdf.enabled": true,
  "paperMd.html.enabled": true,
  "paperMd.tex.enabled": true,
  "workbench.editorAssociations": { "*.pdf": "default" }
}
```

Opening a `.md`, `.pdf`, `.html` or `.tex` file now shows it in the viewer in place of the text tab. Use **Edit as text** to see the source. To use Markdown as a custom editor instead, set `"*.md": "paperMd.viewer"` in `workbench.editorAssociations`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `paperMd.followPanel.autoOpen` | `false` | Open the viewer when a supported file becomes active |
| `paperMd.followPanel.replaceTextTab` | `false` | Show the viewer in place of the text tab (needed for PDF, HTML and LaTeX) |
| `paperMd.pdf.enabled` | `false` | View `.pdf` files |
| `paperMd.html.enabled` | `false` | View `.html` and `.htm` files |
| `paperMd.tex.enabled` | `false` | View `.tex` files |
| `paperMd.tex.mode` | `"html"` | `"html"` for the preview, `"compile"` for a real PDF via `latexmk` |
| `paperMd.tex.texPath` | `/Library/TeX/texbin` | Folder with `latexmk`, put in front of `PATH` |
| `paperMd.tex.maxMirrorMB` | `200` | Size limit for compile mode's local copy of the project |
| `paperMd.customCss` | `""` | CSS added after the built-in style |

## Commands

`Paper MD: Open Follow Panel`, `Paper MD: Open as Text`, `Paper MD: Show Paper View`, `Paper MD: Recompile TeX` and `Paper MD: Open TeX Log`. Timings go to **View > Output > Paper MD**.

## Security

- The extension makes no network requests and sends no telemetry.
- Markdown and LaTeX previews run under a strict Content Security Policy, so scripts in them do not run. Images may load from `https:` URLs.
- HTML pages run in a sandboxed iframe and their scripts do run, so open only HTML you trust.
- Compile mode runs `latexmk` locally on a copy of your project, without `-shell-escape`. It never writes into your project. Compile only sources you trust.

Report vulnerabilities through a private security advisory on the Security tab.

## Troubleshooting

- **Nothing opens in the viewer.** Turn on `replaceTextTab`, `autoOpen` and the setting for that file type, then reload the window.
- **Another extension still opens my files.** Set the pattern to `"default"` in `workbench.editorAssociations`, for example `"*.md": "default"`. This applies to Office Viewer and vscode-pdf.
- **`latexmk failed (exit 12)`.** Run **Paper MD: Open TeX Log**. Usual causes are a missing package, a template that needs `% !TEX def` arguments, or files outside the project folder. See [docs/latex.md](docs/latex.md).
- **`latexmk: command not found`.** Set `paperMd.tex.texPath` to the folder that holds `latexmk`.

## Development

```bash
git clone https://github.com/toqitahamid/fast-document-viewer.git
cd fast-document-viewer
npm install
node test.js                 # smoke check
npx @vscode/vsce package     # build the .vsix
```

Press F5 in VS Code to start an Extension Development Host. The code is in `extension.js`, `src/` (rendering, LaTeX preview and compile) and `media/` (webview script and styles).

## Contributing

Issues and pull requests are welcome. For a bug report, include your editor version, whether you use Remote-SSH, the file type and the **Paper MD** output. For a change, keep it small, run `node test.js` and say how you tried it. There is no automated test suite yet, so tests are welcome.

## License

[MIT](LICENSE). Bundled pdf.js is Apache 2.0.
