# Security policy

## Supported versions

Only the latest release receives security fixes. Please update before reporting.

## Reporting a vulnerability

Do not open a public issue. Use a private report: on the repository page, go to **Security > Report a vulnerability** (GitHub Security Advisories). Include the version, your editor and OS, and the smallest file or steps that show the problem.

This is a small project run on a best-effort basis. Expect a first reply within about a week. Fixes for confirmed problems are released as soon as practical, and reporters are credited in the changelog unless they prefer not to be.

## What counts

In scope:

- A file or workspace that makes the extension run commands, read files outside its allowed folders or reach the network when it should not.
- Scripts running in Markdown or LaTeX previews, or HTML pages escaping their sandbox.
- Compile mode writing into the project or running with options it should not.

Out of scope:

- HTML files running their own scripts inside the sandbox. That is expected, so open only HTML you trust.
- TeX documents that are slow or large when you ask for compile mode.
- Problems that need an already compromised machine or editor.
- Issues in VS Code, Cursor, pdf.js or other dependencies. Report those upstream.
