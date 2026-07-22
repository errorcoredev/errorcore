'use strict';
const fs = require('node:fs');
const path = require('node:path');

const { withLockSync } = require(
  path.join(__dirname, '..', '..', '..', 'dist', 'transport', 'file-lock.js')
);

const [, , lockPath, dataPath, label, iterStr, perIterStr] = process.argv;
const iterations = Number(iterStr);
const linesPerIter = Number(perIterStr);

for (let i = 0; i < iterations; i++) {
  withLockSync(lockPath, () => {
    const existing = fs.existsSync(dataPath)
      ? fs.readFileSync(dataPath, 'utf8').split('\n').filter((l) => l.length > 0)
      : [];
    for (let j = 0; j < linesPerIter; j++) {
      existing.push(`${label}-${i}-${j}`);
    }
    fs.writeFileSync(dataPath, existing.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  });
}
