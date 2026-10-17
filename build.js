'use strict';
/* Inline every source file into one self-contained aurora.html. */
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

const sources = { core: 'src/core.js', examples: 'src/examples.js', ui: 'src/ui.js' };
for (const [name, file] of Object.entries(sources)) {
  if (/<\/script/i.test(read(file))) throw new Error(file + ' contains "</script", which would end the inline script early');
}

const core = read(sources.core);
const coreLines = core.split('\n').length;

/* The core stays a CommonJS module for the tests; in the page it lives in
   its own function scope so its helpers do not leak onto window.        */
const coreScoped = 'const AURORA = (function () {\n' + core + '\nreturn AURORA;\n})();';

/* function replacers: a string replacement would expand "$&" and friends */
const html = read('src/shell.html')
  .replace('/*@@STYLE@@*/', () => read('src/style.css'))
  .replace('/*@@CORE@@*/', () => coreScoped)
  .replace('/*@@EXAMPLES@@*/', () => read(sources.examples))
  .replace('/*@@UI@@*/', () => read(sources.ui))
  .replace(/@@CORE_LINES@@/g, () => coreLines.toLocaleString('pt-BR'));

if (/@@[A-Z_]+@@/.test(html)) throw new Error('an unfilled placeholder is left in the page');

fs.writeFileSync(path.join(__dirname, 'aurora.html'), html);
console.log('aurora.html  ' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB  (core: ' + coreLines + ' lines)');
