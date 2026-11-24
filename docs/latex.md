# LaTeX support

Fast Document Viewer shows `.tex` files in two modes: an instant HTML preview that needs no TeX install, and a compile mode that builds the real PDF with `latexmk`. Both need `fastDocViewer.followPanel.replaceTextTab`, `fastDocViewer.followPanel.autoOpen` and `fastDocViewer.tex.enabled`. Set `"fastDocViewer.tex.mode": "compile"` for compile mode.

## Preview mode

Needs `replaceTextTab`, `autoOpen` and `fastDocViewer.tex.enabled`.

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

## Compile mode

Set `"fastDocViewer.tex.mode": "compile"` (with the LaTeX settings above) to see the real PDF for any design: CVs, papers, custom `.sty` and `.cls` files. The HTML preview stays the default and needs no TeX.

How it works:

1. When a `.tex` file becomes active, the extension finds its root document, using the same rules as the preview.
2. It shows the cached PDF of that root at once, even if out of date. If there is none yet, it shows the HTML preview with a "Compiling..." note.
3. It copies the root's folder tree to local disk (`globalStorageUri`, one folder per root). **Nothing is written into your project.** Only files whose size or modification time changed are copied. It copies TeX-related files only (`.tex .sty .cls .bst .bib .bbl`, images, PDFs, fonts and similar), skips `.git`, `node_modules`, `__pycache__`, `.venv` and names that start with `.`, skips files over 25 MB, and goes at most 6 folders deep. Folders outside the root that the sources reference, up to 4 levels above it (such as `../../fonts/`), are copied too. If the copy would exceed `fastDocViewer.tex.maxMirrorMB`, it stops and shows the size in the banner.
4. It runs `latexmk -pdf|-pdfxe|-pdflua -interaction=nonstopmode -file-line-error -halt-on-error -synctex=1` in the copy, with a 180 s limit and one compile per root at a time. A save during a compile triggers one more run when it ends.
5. The new PDF replaces the old one in the panel. Scroll position and zoom are kept.

**Engine choice.** `fontspec`, `unicode-math`, `xeCJK`, `polyglossia` or `% !TEX program = xelatex` select XeLaTeX. `luacode`, `\directlua`, `luatexja` or `% !TEX program = lualatex` select LuaLaTeX. Everything else uses pdfLaTeX. Bibliographies use BibTeX as latexmk does. For biblatex with biber, install biber or keep a current `.bbl` next to the root.

**Rebuilds** run when you save a `.tex`, `.sty`, `.cls` or `.bib` file in the root's folder tree. The status bar shows `TeX: compiling...`, `TeX: ok 2.3 s` or `TeX: error`. Files that were skipped while copying (too large, too deep or unreadable) are listed in the banner and the **Fast Document Viewer** output. The first error appears as a red banner over the last good PDF, and the full log path goes to the **Fast Document Viewer** output channel.

**Requirements**

- TeX must be installed on your **local** machine, not the remote host: MacTeX or BasicTeX on macOS, MiKTeX or TeX Live on Windows, `sudo apt install texlive-full latexmk` on Linux.
- `fastDocViewer.tex.texPath` is empty by default, which means auto-detect for your platform (macOS: `/Library/TeX/texbin`; Linux and Windows: the standard `PATH`). Set it only if TeX lives somewhere unusual. It is read from user settings only.
- Compile mode is disabled in untrusted workspaces. Trust the workspace to use it.
- A missing package shows `Missing package x.sty. Install with: sudo tlmgr install x`. With BasicTeX, `tlmgr search --global --file x.sty` finds the package name.
- Disk use is one local copy of the root's folder tree (up to `fastDocViewer.tex.maxMirrorMB`) plus build files, per root. Delete the extension's `globalStorage` folder to clear them.
- LaTeX Workshop, if installed, may also build on save. The builds use different folders and do not clash, but they use CPU twice.
- Not done yet: SyncTeX jumps between source and PDF.

**Templates that take arguments.** A root file can run TeX code before it, like `xelatex "\def\x{..}\input{root}"` on the command line. Put lines like these in its first 30 lines:

```latex
% !TEX def = \def\letterBody{letters/acme}
% !TEX def = \def\letterRecipient{letters/acme_recipient}
```

Compile mode writes them into a generated wrapper file in its local copy and compiles that, so the definitions never pass through a command line or shell. If a template stops with an error asking for such definitions, the banner says the template needs arguments and shows this syntax.

## Limits and safety

- **Blocked paths.** The preview does not read files by absolute path, `~`, a drive letter, or more than two `..` levels above the root. Such an `\input`, `\includegraphics` or `\graphicspath` shows a gray "blocked path" note. Use paths relative to the project.
- **Size and time limits.** A file that expands to a very large result, or takes unusually long to convert, stops with a gray notice instead of freezing the editor. Split the file or simplify the macro that causes it.
