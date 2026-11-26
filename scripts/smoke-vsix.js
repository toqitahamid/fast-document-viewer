'use strict';
// Unpack the built .vsix and load extension.js from it, so a file missing from the package fails CI.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const vsix = path.resolve(process.argv[2] || 'fast-document-viewer.vsix');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdv-vsix-'));
execFileSync('unzip', ['-q', vsix, '-d', dir]);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return new Proxy({}, { get: () => () => ({}) });
  return load.call(this, request, ...rest);
};
require(path.join(dir, 'extension', 'extension.js'));
console.log('packaged extension.js loads');
