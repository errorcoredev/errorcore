#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-package-'));
const packDir = path.join(tempRoot, 'pack');
const projectDir = path.join(tempRoot, 'project');

function childEnv() {
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  delete env['npm_config_dry-run'];
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? childEnv(),
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }

  return result.stdout;
}

function fail(message) {
  throw new Error(message);
}

try {
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDir]);
  const packInfo = JSON.parse(packOutput)[0];
  const tarballPath = path.join(packDir, packInfo.filename);
  const files = packInfo.files.map((entry) => entry.path.replace(/\\/g, '/'));
  const fileSet = new Set(files);

  for (const required of [
    'dist/index.js',
    'dist/integrations/nextjs/index.js',
    'dist/integrations/hono/index.js',
    'dist/ingest/index.js',
    'bin/errorcore.js',
    'config-template/errorcore.config.js',
    'package.json',
    'README.md',
    'LICENSE.md'
  ]) {
    if (!fileSet.has(required)) {
      fail(`Packed tarball is missing ${required}`);
    }
  }

  const forbiddenPrefixes = [
    'test/',
    'tmp-nextjs-smoke/',
    'lean-launch-test/',
    'audit-probe-',
    'perf/',
    'spec/'
  ];
  const forbiddenFiles = new Set([
    'audit-findings.md',
    'lean-launch-report.md',
    'launch-blockers.md',
    'deferred.md',
    'demo-script.md'
  ]);

  for (const packedFile of files) {
    if (forbiddenFiles.has(packedFile)) {
      fail(`Packed tarball includes ${packedFile}`);
    }
    if (forbiddenPrefixes.some((prefix) => packedFile.startsWith(prefix))) {
      fail(`Packed tarball includes ${packedFile}`);
    }
  }

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'errorcore-package-verify', private: true }, null, 2)
  );

  run('npm', ['install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: projectDir
  });
  run('node', [
    '-e',
    "require('errorcore'); require('errorcore/nextjs'); require('errorcore/hono'); require('errorcore/ingest'); console.log('runtime requires ok')"
  ], {
    cwd: projectDir
  });

  process.stdout.write(`Package verification passed for ${packInfo.filename}\n`);
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
  }
}
