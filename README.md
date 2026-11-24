# Fast Document Viewer

[![Release](https://img.shields.io/github/v/release/toqitahamid/fast-document-viewer?sort=semver)](https://github.com/toqitahamid/fast-document-viewer/releases/latest)
[![License: MIT](https://img.shields.io/github/license/toqitahamid/fast-document-viewer)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.85-007ACC)](https://code.visualstudio.com/)
[![Cursor](https://img.shields.io/badge/Cursor-supported-black)](https://cursor.com/)

A fast, efficient, read-only viewer for Markdown, PDF, HTML and LaTeX files in VS Code and Cursor. Files appear as a clean printed page: serif type, justified text, booktabs-style tables and KaTeX math.

It is built for **Remote-SSH** work on clusters and servers. The extension runs on your local machine, so its assets load from local disk and only the file contents cross the SSH link. One reused panel replaces the slow new-tab webview, so switching between files takes tens of milliseconds.

## Contents

- [Why](#why)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Viewers](#viewers)
  - [Markdown](#markdown)
  - [PDF](#pdf)
  - [HTML](#html)
  - [LaTeX preview](#latex-preview)
  - [LaTeX compile mode](#latex-compile-mode)
- [Side-by-side and live reload](#side-by-side-and-live-reload)
- [Commands](#commands)
- [Settings](#settings)
- [Remote-SSH](#remote-ssh)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Why

On Remote-SSH, every new webview tab costs about 1 s before any extension code runs, and many viewers run on the remote host and read their assets over the link. Opening a handful of `.md` files, PDFs or LaTeX sources becomes slow.

Fast Document Viewer avoids both costs:

- It runs locally (`extensionKind: ["ui"]`).
- Follow-panel mode keeps one webview open and swaps its content. Only the first open pays the webview cost.
- It is read-only and has a small surface: no editing features, no language server, no background indexing.

## Features

| Format | What you get |
| --- | --- |
| Markdown | markdown-it with GFM tables and task lists, KaTeX math, highlight.js code blocks, relative images and links |
| PDF | Bundled pdf.js viewer with zoom, fit-width, selectable text, and remembered scroll and zoom per file |
| HTML | Rendered page in a second reused panel, with relative CSS, scripts and images resolved |
| LaTeX | Instant HTML approximation with no TeX install, or a real PDF built by `latexmk` in compile mode |

Also:

- One reused panel per editor column. **Open to the Side** creates a second viewer and leaves the first one alone.
- Shown files reload on their own when another process changes them, such as a rebuilt PDF.
- An **Edit as text** button in the panel, and **Edit** and **Paper View** buttons in the editor title bar, switch between the source and the page.
- Scroll position is remembered for every file.
- Scripts inside Markdown never run (strict Content Security Policy).

## Install

Fast Document Viewer is distributed as a `.vsix` file.

1. Download `fast-document-viewer-<version>.vsix` from the [latest release](https://github.com/toqitahamid/fast-document-viewer/releases/latest).
2. Run **Extensions: Install from VSIX...** in the command palette and pick the file. Or from a terminal:

   ```bash
   code --install-extension fast-document-viewer-<version>.vsix    # VS Code
   cursor --install-extension fast-document-viewer-<version>.vsix  # Cursor
   ```

3. Reload the window.

Requirements: VS Code 1.85 or newer, or a recent Cursor. LaTeX compile mode also needs a TeX distribution on your local machine (see [compile mode](#latex-compile-mode)).

## Quick start

Add this to your user `settings.json`, then reload the window:

```json
{
  "paperMd.followPanel.autoOpen": true,
  "paperMd.followPanel.replaceTextTab": true,
  "paperMd.pdf.enabled": true,
  "paperMd.html.enabled": true,
  "paperMd.tex.enabled": true,

  "workbench.editorAssociations": {
    "*.pdf": "default"
  }
}
```

Now opening a `.md`, `.pdf`, `.html` or `.tex` file shows it in the viewer panel in place of the text tab. Use **Edit as text** to see the source.

The `*.pdf` association makes Cursor open PDFs with its own editor first, so the extension can move them into the panel and close the tab. If another extension claims `.md` or `.pdf` files (for example Office Viewer or vscode-pdf), set those patterns to `"default"` too. See [Troubleshooting](#troubleshooting).

Want only Markdown, opened as a custom editor instead of the follow panel?

```json
"workbench.editorAssociations": {
  "*.md": "paperMd.viewer",
  "*.markdown": "paperMd.viewer"
}
```

Or right-click a file, then **Open With... > Fast Document Viewer**.

## Viewers

### Markdown

- GFM tables, task lists, raw HTML and linkified URLs.
- Math with KaTeX: `$...$` and `$$...$$`.
- Syntax highlighting for 14 common languages.
- Relative images, in-page `#anchors` and links to other `.md` files.
- Live update while you type in a text editor.
- `paperMd.customCss` adds your own styles after the built-in paper style.

### PDF

Needs `paperMd.followPanel.replaceTextTab`, `paperMd.followPanel.autoOpen` and `paperMd.pdf.enabled`, plus `"*.pdf": "default"` in `workbench.editorAssociations`.

- Opens at 100%. The toolbar has zoom out, zoom in, Fit (fit width), 100% and a page and zoom counter. Trackpad pinch and Ctrl + wheel also zoom.
- Remembers scroll position and zoom for each PDF.
- Text is selectable. Drag to select across lines and pages, Cmd/Ctrl+C copies, Cmd/Ctrl+A selects the whole document.
- The file is copied over SSH once per open. pdf.js 3.11.174 (Apache 2.0) is bundled and loads on the first PDF only.

### HTML

Needs `replaceTextTab`, `autoOpen` and `paperMd.html.enabled`.

`.html` and `.htm` files open in a second reused panel, **Paper HTML**. A `<base>` tag is added so relative CSS, scripts and images load from the file's folder. The page reloads when you save or when the file changes on disk. Run **Paper MD: Open as Text** to read the source.

> The page's own scripts run, and they can use the network. Open only HTML files you trust. The panel has no message handler, so page scripts cannot drive the extension.

### LaTeX preview

Needs `replaceTextTab`, `autoOpen` and `paperMd.tex.enabled`.

`.tex` files open as an HTML approximation of the compiled paper. No TeX engine is used, so this is a preview, not the PDF: page breaks, float positions, fonts and the exact reference style differ.

What it converts:

- **Structure:** title block, abstract, numbered sections, lists, quotes, footnotes, theorem environments, appendices.
- **Macros:** `\newcommand`, `\renewcommand`, `\def`, `\DeclareMathOperator`, `\newenvironment` and `\newif` conditionals.
- **Files:** `\input`, `\include` and `\subfile`, read relative to the main file. Cycles and depth above 10 are stopped.
- **Math (KaTeX):** inline, display, `equation`, `align`, `gather`, `multline` and `eqnarray`. Numbered equations get a right-hand number. A formula KaTeX rejects appears as gray code.
- **Figures and tables:** numbered captions, sub-figures, `tabular` with `\multicolumn`, booktabs rules and cell colors, and PNG, JPEG, GIF and SVG images. A PDF figure is drawn with the bundled pdf.js (page 1, cached per file). An EPS figure, or a PDF that fails to load, shows a gray box with the file name.
- **References:** `\ref`, `\eqref`, `\cref` and `\autoref` resolve from labels, and from a compiled `.aux` file for other documents. Citations are numbered. The list comes from the `.bbl` next to the main file, else the `.bib`, else the cited keys.
- **Everything else:** algorithms appear as pseudo-code text, unknown commands keep their argument text, and unknown environments show their content.

**Section files.** A file such as `sec/1_intro.tex` is shown with the context of its root document: macros, `\graphicspath`, section, figure and equation numbers, labels and the `.bbl`. The root comes from a `% !TEX root = ../main.tex` comment, or else from a `.tex` file with `\documentclass` in the same folder or up to two parent folders that inputs this file (`main.tex` is preferred). Only the opened file's text is shown, under a gray "Part of main.tex" line. A file with its own `\documentclass` is its own root.

**Local styles.** Local `.sty` and `.cls` files named in `\usepackage` or `\documentclass` are read from the root folder, and their macros, environments and colors are used. Spacing primitives (`\kern`, `\hskip`, `\hspace`, `\rule`) become small spaces. An unknown command with a URL as first argument becomes a link, and FontAwesome icons become small glyphs. `\hfill`, `paracol` and `tabular*` lines keep their left and right parts apart. `\setcounter{secnumdepth}{0}` turns section numbers off.

### LaTeX compile mode

Set `"paperMd.tex.mode": "compile"` (with the LaTeX settings above) to see the real PDF for any design: CVs, papers, custom `.sty` and `.cls` files. The HTML preview stays the default and needs no TeX.

How it works:

1. When a `.tex` file becomes active, the extension finds its root document, using the same rules as the preview.
2. It shows the cached PDF of that root at once, even if out of date. If there is none yet, it shows the HTML preview with a "Compiling..." note.
3. It copies the root's folder tree to local disk (`globalStorageUri`, one folder per root). **Nothing is written into your project.** Only files whose size or modification time changed are copied. It copies TeX-related files only (`.tex .sty .cls .bst .bib .bbl`, images, PDFs, fonts and similar), skips `.git`, `node_modules`, `__pycache__`, `.venv` and names that start with `.`, skips files over 25 MB, and goes at most 6 folders deep. Folders outside the root that the sources reference, up to 4 levels above it (such as `../../fonts/`), are copied too. If the copy would exceed `paperMd.tex.maxMirrorMB`, it stops and shows the size in the banner.
4. It runs `latexmk -pdf|-pdfxe|-pdflua -interaction=nonstopmode -file-line-error -halt-on-error -synctex=1` in the copy, with a 180 s limit and one compile per root at a time. A save during a compile triggers one more run when it ends.
5. The new PDF replaces the old one in the panel. Scroll position and zoom are kept.

**Engine choice.** `fontspec`, `unicode-math`, `xeCJK`, `polyglossia` or `% !TEX program = xelatex` select XeLaTeX. `luacode`, `\directlua`, `luatexja` or `% !TEX program = lualatex` select LuaLaTeX. Everything else uses pdfLaTeX. Bibliographies use BibTeX as latexmk does. For biblatex with biber, install biber or keep a current `.bbl` next to the root.

**Rebuilds** run when you save a `.tex`, `.sty`, `.cls` or `.bib` file in the root's folder tree. The status bar shows `TeX: compiling...`, `TeX: ok 2.3 s` or `TeX: error`. The first error appears as a red banner over the last good PDF, and the full log path goes to the **Paper MD** output channel.

**Requirements**

- TeX must be installed on your **local** machine, not the remote host. On macOS, BasicTeX installs to `/Library/TeX/texbin`, which spawned processes do not have on `PATH`, so set `paperMd.tex.texPath` if TeX lives elsewhere.
- A missing package shows `Missing package x.sty. Install with: sudo tlmgr install x`. With BasicTeX, `tlmgr search --global --file x.sty` finds the package name.
- Disk use is one local copy of the root's folder tree (up to `paperMd.tex.maxMirrorMB`) plus build files, per root. Delete the extension's `globalStorage` folder to clear them.
- LaTeX Workshop, if installed, may also build on save. The builds use different folders and do not clash, but they use CPU twice.
- Not done yet: SyncTeX jumps between source and PDF.

**Templates that take arguments.** A root file can run TeX code before it, like `xelatex "\def\x{..}\input{root}"` on the command line. Put lines like these in its first 30 lines:

```latex
% !TEX def = \def\letterBody{letters/acme}
% !TEX def = \def\letterRecipient{letters/acme_recipient}
```

Compile mode passes them to latexmk with `-usepretex`. If a template stops with an error asking for such definitions, the banner says the template needs arguments and shows this syntax.

## Side-by-side and live reload

With `replaceTextTab` on, each editor column has its own viewer panel. **Open to the Side** makes a second viewer in the new column and leaves the first one alone. With `replaceTextTab` off, a single panel is used.

A shown `.md`, `.tex`, `.html` or `.pdf` file reloads on its own when another process changes it. The extension checks size and modification time every 1.5 s and reloads once the write has finished, keeping scroll position and zoom. Polling is used because file watchers are unreliable for remote files outside the workspace.

## Commands

| Command | What it does |
| --- | --- |
| `Paper MD: Open Follow Panel` | Opens the reused viewer panel |
| `Paper MD: Open as Text` | Reopens the current file in the normal text editor |
| `Paper MD: Show Paper View` | Shows the current md, tex or html file in the viewer panel |
| `Paper MD: Recompile TeX` | Copies everything again and rebuilds (compile mode) |
| `Paper MD: Open TeX Log` | Opens the last compile log |

The editor title bar also has **Edit** and **Paper View** buttons to switch between source and page.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `paperMd.customCss` | string | `""` | CSS added after the built-in paper style |
| `paperMd.followPanel.autoOpen` | boolean | `false` | Open the panel when a supported file becomes active |
| `paperMd.followPanel.replaceTextTab` | boolean | `false` | Show the panel in place of the text tab. Required by the PDF, HTML and LaTeX options |
| `paperMd.pdf.enabled` | boolean | `false` | Show `.pdf` files in the panel |
| `paperMd.html.enabled` | boolean | `false` | Show `.html` and `.htm` files in the panel |
| `paperMd.tex.enabled` | boolean | `false` | Show `.tex` files in the panel |
| `paperMd.tex.mode` | `"html"` or `"compile"` | `"html"` | Preview without TeX, or build the real PDF with latexmk |
| `paperMd.tex.texPath` | string | `/Library/TeX/texbin` | Folder with `latexmk` and the engines, put in front of `PATH` for compiles |
| `paperMd.tex.maxMirrorMB` | number | `200` | Size limit for the local copy of the root's folder |

Open-time measurements go to **View > Output > Paper MD**.

## Remote-SSH

The manifest sets `extensionKind: ["ui"]`, so the extension runs in your local window even when the folder is on a remote host. The viewer's own assets load from local disk. File contents are read through the editor's file system API, so only the file crosses the SSH link. PDFs and large images are copied once per open.

If you also use Office Viewer or another extension that renders the same files, make sure it is not the one opening them. Set the editor association for the pattern to `"default"` so the follow panel takes over.

## Security and privacy

- **No network use by the extension.** Its code makes no external requests and sends no telemetry. The webview only loads its own bundled files.
- **Markdown and LaTeX previews** are rendered under a strict Content Security Policy. Scripts in Markdown do not run (script execution needs the extension's nonce), and network connections from the webview are limited to its own origin. Images may load from `https:` URLs, so a remote image in a Markdown file is fetched when you view it.
- **HTML panel:** the page runs in a sandboxed iframe, and its scripts run as in a browser. Open only HTML you trust.
- **Compile mode** runs `latexmk` on your local machine against a copy of your project. It does not pass `-shell-escape`, does not copy the project's `latexmkrc` (a global `~/.latexmkrc` is still read by latexmk), and never writes into your project folder. Compile only sources you trust, because TeX runs the file's contents.
- Your settings and file contents stay on your machine and on the SSH connection you already use.

To report a vulnerability, open a private security advisory on the repository's Security tab rather than a public issue.

## Troubleshooting

**Nothing changes after I open a file.** Check that `replaceTextTab` and `autoOpen` are on, plus the setting for that file type (`pdf.enabled`, `html.enabled` or `tex.enabled`). Reload the window after installing or changing settings.

**Another extension still opens my `.md` or `.pdf`.** Set the patterns to `"default"` in `workbench.editorAssociations`, for example `"*.md": "default", "*.pdf": "default"`. Extensions such as Office Viewer and vscode-pdf register custom editors that can take priority.

**`latexmk failed (exit 12)`.** Open the log with **Paper MD: Open TeX Log**. Common causes: a missing package (install it with `tlmgr`), a template that needs `% !TEX def` arguments (see [Templates that take arguments](#latex-compile-mode)), or a path like `../../fonts/` that is outside the root folder. Open the project from its top folder so the mirror includes it.

**`latexmk: command not found`.** TeX is not on the PATH of spawned processes. Set `paperMd.tex.texPath` to the folder that holds `latexmk`, for example `/Library/TeX/texbin` on macOS.

**The PDF does not update.** The file is polled every 1.5 s. Rebuild it, wait a moment, and check the **Paper MD** output channel for read errors.

**Side-open shows the wrong thing.** Make sure `replaceTextTab` is on. Without it a single panel is shared.

## Development

```bash
git clone https://github.com/toqitahamid/fast-document-viewer.git
cd fast-document-viewer
npm install
node test.js               # smoke check: renders a sample and prints true/false per feature
npx @vscode/vsce package   # build the .vsix
```

To try it from source, open the folder in VS Code and press F5 to start an Extension Development Host.

Layout:

- `extension.js` — activation, follow panels, PDF, HTML and file polling
- `src/render.js` — Markdown rendering
- `src/tex.js`, `src/texroot.js` — LaTeX to HTML preview and root detection
- `src/texcompile.js` — compile mode (mirror, latexmk, log parsing)
- `media/` — webview script and styles

## Contributing

Issues and pull requests are welcome. For a bug report, include your VS Code or Cursor version, whether you use Remote-SSH, the file type, and the lines from **View > Output > Paper MD**. For a change, keep it small, run `node test.js` as a smoke check, and describe how you tried it. The project has no automated test suite yet, so tests are a welcome contribution.

## Upgrading from Paper MD Viewer

This extension was called **Paper MD Viewer** up to version 0.7.6. Version 0.8.0 has a new extension ID (`toqitahamid.fast-document-viewer`), so uninstall the old one after installing it:

```bash
cursor --uninstall-extension toqitahamid.paper-md-viewer   # or: code --uninstall-extension ...
```

Settings, commands and the custom editor keep their `paperMd.*` IDs, so your `settings.json` and editor associations work unchanged.

## License

[MIT](LICENSE). Bundled pdf.js is Apache 2.0.
