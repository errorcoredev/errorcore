#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
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

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function sourceCounterpartForDistFile(packedFile, tsconfig) {
  const compilerOptions = tsconfig.compilerOptions ?? {};
  const outDir = normalizePath(compilerOptions.outDir ?? 'dist');
  const rootDir = normalizePath(compilerOptions.rootDir ?? 'src');
  const prefix = `${outDir}/`;

  if (!packedFile.startsWith(prefix)) {
    return null;
  }

  const relative = packedFile.slice(prefix.length);
  const suffixes = [
    ['.d.mts.map', '.mts'],
    ['.d.ts.map', '.ts'],
    ['.d.mts', '.mts'],
    ['.d.ts', '.ts'],
    ['.mjs', '.mts'],
    ['.js', '.ts']
  ];

  for (const [outputSuffix, sourceSuffix] of suffixes) {
    if (relative.endsWith(outputSuffix)) {
      return `${rootDir}/${relative.slice(0, -outputSuffix.length)}${sourceSuffix}`;
    }
  }

  return null;
}

function verifyGeneratedDistFiles(files) {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8'));
  const missingSources = [];

  for (const packedFile of files) {
    const sourceFile = sourceCounterpartForDistFile(packedFile, tsconfig);
    if (sourceFile === null) {
      continue;
    }

    if (!fs.existsSync(path.join(root, sourceFile))) {
      missingSources.push(`${packedFile} -> ${sourceFile}`);
    }
  }

  if (missingSources.length > 0) {
    fail(
      'Packed dist files are missing source counterparts:\n' +
      missingSources.map((entry) => `  - ${entry}`).join('\n')
    );
  }
}

try {
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDir]);
  const packInfo = JSON.parse(packOutput)[0];
  if (packInfo.name !== rootPackage.name || packInfo.version !== rootPackage.version) {
    fail(
      `Packed candidate ${packInfo.name}@${packInfo.version} does not match ` +
      `root package ${rootPackage.name}@${rootPackage.version}`
    );
  }
  const tarballPath = path.join(packDir, packInfo.filename);
  const files = packInfo.files.map((entry) => entry.path.replace(/\\/g, '/'));
  const fileSet = new Set(files);

  for (const required of [
    'dist/index.js',
    'dist/integrations/nextjs/index.js',
    'dist/integrations/hono/index.js',
    'dist/ingest/index.js',
    'dist/pii/scrubber.js',
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

  verifyGeneratedDistFiles(files);

  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'errorcore-package-verify', private: true }, null, 2)
  );

  run('npm', ['install', tarballPath, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: projectDir
  });
  run('node', [
    '-e',
    "require('errorcore'); require('errorcore/nextjs'); require('errorcore/hono'); require('errorcore/ingest'); const { createDefaultPiiScrubber } = require('errorcore/pii/scrubber'); if (typeof createDefaultPiiScrubber !== 'function') throw new Error('missing createDefaultPiiScrubber'); createDefaultPiiScrubber(); console.log('runtime requires ok')"
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
