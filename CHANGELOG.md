# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Links inside PDFs are clickable. Internal links scroll to the target page. Web and mail links open outside the editor, and other schemes are ignored.

## [0.9.3]

### Fixed

- The extension failed to activate in 0.9.2 with `Cannot find module .../markdown-it/dist/markdown-it.cjs.js`, so nothing opened in the viewer. The package leaked out markdown-it 15's entry file. CI now loads the built package to catch this.

## [0.9.2]

### Fixed

- Back to KaTeX 0.16. The math plugin supports only 0.16, and KaTeX 0.19 installed a second copy that made the package 4 MB larger and mismatched the stylesheet. Dependabot now skips KaTeX 0.17 and newer.

## [0.9.1]

### Fixed

- The bundled KaTeX stylesheet now matches KaTeX 0.19 (a dependency bump had left the old stylesheet in place). A test fails if they drift apart again.

## [0.9.0]

### Changed

- The settings, commands and custom editor now use the `fastDocViewer.*` prefix (was `paperMd.*`). Your old values are copied over automatically on first run, including the `fastDocViewer.viewer` entry in `workbench.editorAssociations`. VS Code cannot delete the old keys, so remove the old `paperMd.*` lines from `settings.json` yourself. Keybindings that use the old `paperMd.*` command IDs need the new ID.
- The output channel is now called "Fast Document Viewer". User-facing messages say Fast Document Viewer instead of Paper MD.
- The README shows the icon.

## [0.8.2]

### Fixed

- PDFs (and files outside the workspace) could stay on the empty placeholder: the viewer now waits for the page to finish reloading after its allowed folders change, and no longer drops host messages in some editor versions.

### Changed

- The printed-paper page is the default again. Following a dark editor theme is now opt-in with `fastDocViewer.theme: "auto"`. High-contrast themes always get a high-contrast page.

## [0.8.1]

### Security

- Fixed command injection in compile mode. Template definitions are no longer passed on the command line; a generated wrapper file is used instead. Found in a code audit.
- HTML pages now run with the network blocked and can only read their own folder.
- The viewer's allowed file roots (`localResourceRoots`) are reset for each file.
- Tightened the Content Security Policy of the viewer pages.
- HTML in LaTeX previews is escaped.
- The LaTeX preview no longer reads files by absolute path or from more than two folders above the root.
- Compile mode and the `fastDocViewer.tex.mode` and `fastDocViewer.tex.texPath` settings are limited in untrusted workspaces. `fastDocViewer.customCss` and `fastDocViewer.tex.texPath` are only read from user settings.

### Fixed

- Freezes on crafted `.tex` files and macro bombs.
- `%` inside `\url` was treated as a comment.
- Races when switching quickly between panels.
- Opening a git diff no longer takes over the viewer.
- Prompts about unsaved (dirty) tabs.
- Memory use when viewing large PDFs.

### Added

- `Fast Document Viewer: Turn On All Viewers`, a one-click way to turn on every viewer.
- A "Get started" walkthrough.
- Optional dark theme (`fastDocViewer.theme`).
- Accessibility improvements.
- Automatic TeX location per platform when `fastDocViewer.tex.texPath` is empty (now the default).
- `fastDocViewer.allowRemoteImages` setting to block remote https images.
- Skipped files are reported in compile mode.
- All command titles use the category "Fast Document Viewer". Command and setting IDs are unchanged.

## [0.8.0]

- Renamed from Paper MD Viewer to Fast Document Viewer. The extension ID changed.
- LaTeX compile mode with `latexmk`, and PDF and HTML viewing.

## 0.7.6 and earlier

- Paper MD Viewer: a fast Markdown viewer with KaTeX math that reuses one panel for every file, built for Remote-SSH.
