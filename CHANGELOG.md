# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.8.1]

### Security

- Fixed command injection in compile mode. Template definitions are no longer passed on the command line; a generated wrapper file is used instead. Found in a code audit.
- HTML pages now run with the network blocked and can only read their own folder.
- The viewer's allowed file roots (`localResourceRoots`) are reset for each file.
- Tightened the Content Security Policy of the viewer pages.
- HTML in LaTeX previews is escaped.
- The LaTeX preview no longer reads files by absolute path or from more than two folders above the root.
- Compile mode and the `paperMd.tex.mode` and `paperMd.tex.texPath` settings are limited in untrusted workspaces. `paperMd.customCss` and `paperMd.tex.texPath` are only read from user settings.

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
- Dark theme.
- Accessibility improvements.
- Automatic TeX location per platform when `paperMd.tex.texPath` is empty (now the default).
- `paperMd.allowRemoteImages` setting to block remote https images.
- Skipped files are reported in compile mode.
- All command titles use the category "Fast Document Viewer". Command and setting IDs are unchanged.

## [0.8.0]

- Renamed from Paper MD Viewer to Fast Document Viewer. The extension ID changed; `paperMd.*` settings still work.
- LaTeX compile mode with `latexmk`, and PDF and HTML viewing.

## 0.7.6 and earlier

- Paper MD Viewer: a fast Markdown viewer with KaTeX math that reuses one panel for every file, built for Remote-SSH.
