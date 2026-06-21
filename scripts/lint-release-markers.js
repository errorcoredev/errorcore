#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const markerPattern = /TODO|FIXME|console\.log|debugger/;
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    scanFile(fullPath);
  }
}

function scanFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!markerPattern.test(lines[index])) {
      continue;
    }
    const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
    findings.push(`${relativePath}:${index + 1}: ${lines[index].trim()}`);
  }
}

walk(srcDir);

if (findings.length > 0) {
  console.error('Release marker lint failed:');
  for (const finding of findings) {
    console.error(`  ${finding}`);
  }
  process.exit(1);
}

console.log('Release marker lint passed.');
