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

## Settings

- `paperMd.customCss` (string): CSS added after the built-in paper style.

## Build

```bash
npm install
npx @vscode/vsce package
```

## License

MIT
