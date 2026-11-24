'use strict';
// Minimal fake of the `vscode` module, for loading extension code under plain node.
// Usage: require('./helpers/vscode-stub').install(); then require the module under test.
const Module = require('node:module');
const path = require('node:path');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
  joinPath: (base, ...parts) => Uri.file(path.posix.join(base.path, ...parts)),
};
const stub = { Uri, FileType, workspace: { fs: {} }, window: {} };

function install() {
  if (install.done) return stub;
  install.done = true;
  const orig = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? stub : orig.call(this, request, ...rest);
  };
  return stub;
}
module.exports = { install, stub };
