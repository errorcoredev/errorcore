#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testRoots = [
  path.join(root, 'bench', 'harness', 'test'),
  path.join(root, 'bench', 'sinks')
];

function collectTests(current, tests) {
  if (!fs.existsSync(current)) {
    return;
  }
  const stat = fs.statSync(current);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(current)) {
      collectTests(path.join(current, entry), tests);
    }
  } else if (stat.isFile() && current.endsWith('.test.mjs')) {
    tests.push(current);
  }
}

const tests = [];
for (const testRoot of testRoots) {
  collectTests(testRoot, tests);
}
tests.sort();

if (tests.length === 0) {
  console.error('No benchmark harness tests were found.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true
});

if (result.error !== undefined) {
  console.error(`Unable to start the benchmark test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
