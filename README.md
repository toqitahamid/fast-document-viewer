# Paper MD Viewer

A fast, read-only Markdown viewer for VS Code and Cursor. It shows a `.md` file as a clean printed page: serif font, justified text, booktabs-style tables and KaTeX math.

It is built for Remote-SSH work. The extension runs on your local machine (`extensionKind: ["ui"]`), so its page assets load from your local disk. Only the Markdown text crosses the SSH link.

## Features

- Rendering with markdown-it: GFM tables, task lists, raw HTML, linkified URLs.
- Math with KaTeX: `$...$` and `$$...$$`.
- Code highlighting with highlight.js (14 common languages).
- Relative images, in-page `#anchors`, and links to other `.md` files.
- Live update when the file changes in a text editor.
- An **Edit as text** button that reopens the file in the normal editor.
- Scripts inside Markdown files never run (strict Content Security Policy).

## Install

1. Download `paper-md-viewer-<version>.vsix` from the [Releases](https://github.com/toqitahamid/paper-md-viewer/releases) page.
2. In VS Code or Cursor, run **Extensions: Install from VSIX...** and pick the file.

## Use as the default Markdown view

Add this to your user `settings.json`:

```json
"workbench.editorAssociations": {
  "*.md": "paperMd.viewer",
  "*.markdown": "paperMd.viewer"
}
```

Without this, open a file with right-click, then **Open With... > Paper MD Viewer**.

## Follow panel (fastest)

Each new webview tab costs about 1 s in Cursor and VS Code, before any extension code runs. The follow panel avoids this cost: one panel stays open beside your text editor and shows whichever `.md` file is active. Only the first open creates a webview; switching files after that takes tens of milliseconds. The panel remembers the scroll position of each file.

1. Keep `.md` files opening in the normal text editor (do not set the editor association above).
2. Run **Paper MD: Open Follow Panel**, or set `"paperMd.followPanel.autoOpen": true` to open it automatically.
3. For one tab instead of a side-by-side view, also set `"paperMd.followPanel.replaceTextTab": true`. The panel then takes the place of each Markdown text tab you open. Its **Edit as text** button reopens the current file as text.

## PDF

The follow panel can also show `.pdf` files, so a PDF opens in the same reused panel instead of a new tab.

1. Set `"paperMd.followPanel.replaceTextTab": true` and `"paperMd.followPanel.autoOpen": true`.
2. Set `"paperMd.pdf.enabled": true`.
3. Add `"*.pdf": "default"` to `workbench.editorAssociations`, so Cursor opens its own editor first. The extension then shows the file in the panel and closes that tab.

PDFs open at 100% (actual size). The toolbar has zoom out, zoom in, Fit (fit width), 100%, and a page and zoom counter. Trackpad pinch and Ctrl + mouse wheel also zoom. It remembers the scroll position and zoom of each PDF. The PDF must still be copied over SSH once each time you open it. pdf.js 3.11.174 (Apache 2.0) is bundled and loads on the first PDF only.

## HTML

`.html` and `.htm` files open as rendered pages in a second reused panel, **Paper HTML**. Cursor opens them as text, and the panel replaces that tab.

1. Set `"paperMd.followPanel.replaceTextTab": true` and `"paperMd.followPanel.autoOpen": true`.
2. Set `"paperMd.html.enabled": true`.

The page's HTML becomes the panel document, with a `<base>` tag added so relative CSS, scripts and images load from the file's folder. Its scripts run. The panel has no message handler, so page scripts cannot drive the extension. Open only HTML files you trust: their scripts can use the network. The page reloads when you save the file. Run **Paper MD: Open as Text** to read the source.

## LaTeX

`.tex` files open as a rendered approximation of the compiled paper, in the same reused follow panel. No TeX engine is used, so the result is a preview, not the PDF. Page breaks, float positions, fonts and the exact reference style differ.

1. Set `"paperMd.followPanel.replaceTextTab": true` and `"paperMd.followPanel.autoOpen": true`.
2. Set `"paperMd.tex.enabled": true`.

What it converts:

- Structure: title block, abstract, numbered sections, lists, quotes, footnotes, theorem environments, appendices.
- Macros: `\newcommand`, `\renewcommand`, `\def`, `\DeclareMathOperator`, `\newenvironment`, and `\newif` conditionals.
- Files: `\input`, `\include` and `\subfile`, read relative to the main file (cycles and depth above 10 are stopped).
- Math with KaTeX: inline, display, `equation`, `align`, `gather`, `multline`, `eqnarray`. Numbered equations get a right-hand number. A formula that KaTeX rejects appears as gray code.
- Figures and tables: numbered captions, sub-figures, `tabular` (with `\multicolumn`, booktabs rules and cell colors), PNG, JPEG, GIF and SVG images. A PDF or EPS figure shows its PNG or JPEG twin when one sits next to it, else a gray box with the file name.
- References: `\ref`, `\eqref`, `\cref` and `\autoref` are resolved from the labels (and from a compiled `.aux` file for other documents). Citations are numbered, and the list comes from the `.bbl` file next to the main file, or from the `.bib` file, or from the cited keys.
- Algorithms appear as pseudo-code text. Unknown commands keep their argument text. Unknown environments show their content.

Use **Edit as text** to read the source. Each re-render reads the included files again (an open editor tab counts as the latest text).

## Settings

- `paperMd.customCss` (string): CSS added after the built-in paper style.
- `paperMd.followPanel.autoOpen` (boolean, default `false`): open the follow panel when a Markdown text editor becomes active.
- `paperMd.followPanel.replaceTextTab` (boolean, default `false`): show the follow panel in place of the Markdown text tab.
- `paperMd.pdf.enabled` (boolean, default `false`): show `.pdf` files in the follow panel. Needs `replaceTextTab`.
- `paperMd.html.enabled` (boolean, default `false`): show `.html` and `.htm` files in the follow panel. Needs `replaceTextTab`.
- `paperMd.tex.enabled` (boolean, default `false`): show `.tex` files as a rendered preview in the follow panel. Needs `replaceTextTab`.

Open-time measurements are written to **View > Output > Paper MD**.

## Build

```bash
npm install
npx @vscode/vsce package
```

## License

MIT
