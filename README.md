<p align="center">
  <img src="media/icon.png" alt="Fast Document Viewer icon" width="128" height="128">
</p>

<h1 align="center">Fast Document Viewer</h1>

[![Release](https://img.shields.io/github/v/release/toqitahamid/fast-document-viewer?sort=semver)](https://github.com/toqitahamid/fast-document-viewer/releases/latest)
[![License: MIT](https://img.shields.io/github/license/toqitahamid/fast-document-viewer)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC)](https://code.visualstudio.com/)

A fast, efficient, read-only viewer for Markdown, PDF, HTML and LaTeX in VS Code and Cursor. Files appear as a clean printed page, and switching between them takes tens of milliseconds, including over Remote-SSH.

## Who is it for

Students, researchers, engineers working over SSH on clusters, and anyone who reads documents in their editor.

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

## Get started

1. Install the `.vsix` from the [latest release](https://github.com/toqitahamid/fast-document-viewer/releases/latest):

   ```bash
   code --install-extension fast-document-viewer-<version>.vsix
   cursor --install-extension fast-document-viewer-<version>.vsix
   ```

2. Open the Command Palette and run **Fast Document Viewer: Turn On All Viewers**. No settings file to edit. A short walkthrough opens under **Get Started** too.
3. Open a `.md`, `.pdf`, `.html` or `.tex` file. It shows in the viewer in place of the text tab. Use **Edit as text** to see the source.

Requires VS Code 1.85 or newer, or a recent Cursor.

**Optional: set it up by hand.** The command above does the equivalent of this in your user `settings.json`:

```json
{
  "fastDocViewer.followPanel.autoOpen": true,
  "fastDocViewer.followPanel.replaceTextTab": true,
  "fastDocViewer.pdf.enabled": true,
  "fastDocViewer.html.enabled": true,
  "fastDocViewer.tex.enabled": true,
  "workbench.editorAssociations": { "*.pdf": "default" }
}
```

To use Markdown as a custom editor instead, set `"*.md": "fastDocViewer.viewer"` in `workbench.editorAssociations`.

**Upgrading from Paper MD Viewer** (0.7.6 and earlier)? The extension ID changed, so uninstall the old one with `--uninstall-extension toqitahamid.paper-md-viewer`. The settings prefix changed from `paperMd.*` to `fastDocViewer.*` in 0.9.0. Your old values are copied over automatically on first run.

## Works on macOS, Windows and Linux

Markdown, PDF, HTML and the LaTeX preview need nothing else. Compile mode needs TeX on the machine where the editor window runs (not the remote host):

- macOS: MacTeX or BasicTeX
- Windows: MiKTeX or TeX Live
- Linux: `sudo apt install texlive-full latexmk` (or your distribution's TeX Live)

`fastDocViewer.tex.texPath` is empty by default and finds TeX for your platform. Set it only for an unusual install.

## Accessibility

Pages follow your light or dark theme, text is selectable, and the viewer works from the keyboard. Use the settings or `fastDocViewer.customCss` to change fonts and sizes.

## Settings

Find them in Settings by searching `fastDocViewer`.

| Setting | Default | Description |
| --- | --- | --- |
| `fastDocViewer.followPanel.autoOpen` | `false` | Open the viewer when a supported file becomes active |
| `fastDocViewer.followPanel.replaceTextTab` | `false` | Show the viewer in place of the text tab (needed for PDF, HTML and LaTeX) |
| `fastDocViewer.pdf.enabled` | `false` | View `.pdf` files |
| `fastDocViewer.html.enabled` | `false` | View `.html` and `.htm` files |
| `fastDocViewer.tex.enabled` | `false` | View `.tex` files |
| `fastDocViewer.tex.mode` | `"html"` | `"html"` for the preview, `"compile"` for a real PDF via `latexmk` |
| `fastDocViewer.tex.texPath` | `""` | Folder with `latexmk`; empty means auto-detect for your platform |
| `fastDocViewer.tex.maxMirrorMB` | `200` | Size limit for compile mode's local copy of the project |
| `fastDocViewer.allowRemoteImages` | `true` | Turn off to block remote `https:` images |
| `fastDocViewer.theme` | `"paper"` | `"paper"` is always the light printed page; `"auto"` goes dark in a dark editor theme |
| `fastDocViewer.customCss` | `""` | CSS added after the built-in style |

`fastDocViewer.customCss` and `fastDocViewer.tex.texPath` are read from your user settings only, not from a workspace.

## Commands

All start with **Fast Document Viewer:** in the Command Palette: Turn On All Viewers, Show Document View, Open Viewer Panel, Edit as Text, Recompile TeX and Open TeX Log. Timings go to **View > Output > Fast Document Viewer**.

## Security

- The extension sends no telemetry. Its only network use is loading `https:` images that your documents reference, which you can block with `fastDocViewer.allowRemoteImages`.
- Markdown and LaTeX previews run under a strict Content Security Policy, so scripts in them do not run.
- HTML pages run in a sandbox with the network blocked and access to their own folder only. Their scripts do run, so open only HTML you trust.
- Compile mode runs `latexmk` locally on a copy of your project, without `-shell-escape`, and never writes into your project. Template definitions go in a generated wrapper file, not on the command line. It is limited in untrusted workspaces. Compile only sources you trust.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Nothing opens in the viewer.** Run **Turn On All Viewers**, then reload the window.
- **Another extension still opens my files.** Set the pattern to `"default"` in `workbench.editorAssociations`, for example `"*.md": "default"`.
- **`latexmk failed (exit 12)`.** Run **Fast Document Viewer: Open TeX Log**. Usual causes are a missing package, a template that needs arguments, or files outside the project folder. See [docs/latex.md](docs/latex.md).
- **`latexmk: command not found`.** Install TeX (see above) or set `fastDocViewer.tex.texPath`.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE). Bundled pdf.js is Apache 2.0.
