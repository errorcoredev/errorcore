#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const rootLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-package-'));
const packDir = path.join(tempRoot, 'pack');
const projectDir = path.join(tempRoot, 'project');
const strictLicenseSha256 = 'e2361f52ad5be22b937a6e983c824a534c5cffa454b6c34af2f8ce0c2cdf7c1a';
const strictReleaseVersion = '0.5.1';

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

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function normalizeLineEndings(contents) {
  return contents.replace(/\r\n?/g, '\n');
}

function readUtf8(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireText(contents, expected, subject) {
  if (!contents.includes(expected)) {
    fail(`${subject} must include ${JSON.stringify(expected)}`);
  }
}

function verifyLicensingSources() {
  if (rootPackage.version !== strictReleaseVersion) {
    fail(`package.json version must be ${strictReleaseVersion}`);
  }
  if (rootPackage.license !== 'SEE LICENSE IN LICENSE.md') {
    fail('package.json must use SEE LICENSE IN LICENSE.md');
  }
  if (
    rootLock.version !== strictReleaseVersion ||
    rootLock.packages?.['']?.version !== strictReleaseVersion
  ) {
    fail(`package-lock.json root versions must both be ${strictReleaseVersion}`);
  }
  if (rootLock.packages?.['']?.license !== rootPackage.license) {
    fail('package-lock.json root license must match package.json');
  }

  for (const requiredNotice of [
    'COMMERCIAL-LICENSE.md',
    'COPYRIGHT.md',
    'LICENSE.md',
    'LICENSING_HISTORY.md',
    'README.md',
    'THIRD_PARTY_NOTICES.md'
  ]) {
    if (!rootPackage.files?.includes(requiredNotice)) {
      fail(`package.json files allowlist must include ${requiredNotice}`);
    }
  }
  if (rootPackage.files?.includes('COMMERCIAL_LICENSING.md')) {
    fail('package.json files allowlist contains the obsolete commercial notice filename');
  }

  const license = fs.readFileSync(path.join(root, 'LICENSE.md'));
  if (sha256(license) !== strictLicenseSha256) {
    fail('LICENSE.md is not the exact official PolyForm Strict License 1.0.0 text');
  }

  if (rootPackage.dependencies?.['source-map-js'] !== '1.2.1') {
    fail('source-map-js must remain pinned to 1.2.1');
  }
  const upstreamNotice = fs.readFileSync(
    path.join(root, 'node_modules', 'source-map-js', 'LICENSE'),
    'utf8'
  ).trim();
  const shippedNotices = readUtf8('THIRD_PARTY_NOTICES.md');
  if (!normalizeLineEndings(shippedNotices).includes(normalizeLineEndings(upstreamNotice))) {
    fail('THIRD_PARTY_NOTICES.md must include the source-map-js@1.2.1 notice unchanged');
  }

  const currentReleaseSurfaces = [
    'README.md',
    'TEAMS.md',
    'COMMERCIAL-LICENSE.md',
    'COPYRIGHT.md',
    'package.json',
    'scripts/verify-edge-stub.js',
    'src/index.ts',
    'src/integrations/nextjs/edge.mts',
    'src/integrations/nextjs/index.ts',
    'src/integrations/nextjs/middleware.ts',
    'src/integrations/nextjs/server-action.ts',
    'src/integrations/nextjs/types.ts',
    'test/integration/fixtures/nextjs-smoke/smoke-edge.mjs',
    'test/integration/fixtures/nextjs-smoke/smoke-node.cjs'
  ];
  const obsoleteClaim = /PolyForm[- ]Small[- ]Business|\bopen[- ]?core\b|Hirdesh Viikram|COMMERCIAL_LICENSING\.md/i;
  for (const relative of currentReleaseSurfaces) {
    const contents = readUtf8(relative);
    if (obsoleteClaim.test(contents)) {
      fail(`${relative} contains an obsolete current-release licensing claim`);
    }
    for (const line of contents.split(/\r?\n/)) {
      if (/\bopen[- ]source\b/i.test(line) && !/\bnot represented as open[- ]source\b/i.test(line)) {
        fail(`${relative} contains an active open-source claim`);
      }
    }
  }

  for (const relative of ['README.md', 'TEAMS.md']) {
    const contents = readUtf8(relative);
    requireText(contents, 'Source Available / Publicly Auditable', relative);
    requireText(contents, 'not represented as open source', relative);
    requireText(contents, 'PolyForm Strict License 1.0.0', relative);
    requireText(contents, 'Cloud', relative);
    requireText(contents, 'backend', relative);
    requireText(contents, 'proprietary', relative);
    requireText(contents, 'outside the SDK license', relative);
  }

  requireText(
    readUtf8('COPYRIGHT.md'),
    'Copyright © 2026 ErrorCore Dev.',
    'COPYRIGHT.md'
  );
  for (const relative of currentReleaseSurfaces.filter((entry) => /\.(?:[cm]?[jt]s)$/.test(entry))) {
    requireText(readUtf8(relative).split(/\r?\n/, 1)[0], 'Copyright 2026 ErrorCore Dev', relative);
  }

  const commercialNotice = readUtf8('COMMERCIAL-LICENSE.md');
  requireText(commercialNotice, 'informational only', 'COMMERCIAL-LICENSE.md');
  requireText(commercialNotice, 'hv@errorcore.dev', 'COMMERCIAL-LICENSE.md');
  if (/paid subscription|Order Form|pricing|entitlement|errorcore\.dev\/legal/i.test(commercialNotice)) {
    fail('COMMERCIAL-LICENSE.md contains unsupported commercial terms or URLs');
  }

  const history = readUtf8('LICENSING_HISTORY.md');
  for (const boundary of [
    '`0.3.0` is the last repository version under PolyForm Small Business 1.0.0.',
    '`0.2.1` is the last npm-published version under PolyForm Small Business 1.0.0.',
    '`0.4.0` is the first version prepared under the unmodified PolyForm Strict License 1.0.0.'
  ]) {
    requireText(history, boundary, 'LICENSING_HISTORY.md');
  }
  requireText(
    history,
    'sha512-w58DACx4AhKY5m6asUMQ4BQNMq1E6KNxcB3ULdzk49zeiEBBtj3VJac5a1+qk3m9C7AHzvPAM38278yRfk1wIQ==',
    'LICENSING_HISTORY.md'
  );

  const changelog = readUtf8('CHANGELOG.md');
  requireText(changelog, '## 0.5.1 - 2026-08-30', 'CHANGELOG.md');
  requireText(changelog, 'No public API, configuration, schema, or wire-format changes', 'CHANGELOG.md');
  requireText(changelog, '## 0.5.0 - 2026-08-15', 'CHANGELOG.md');
  requireText(changelog, 'last repository version under PolyForm', 'CHANGELOG.md');
  requireText(changelog, 'last npm-published version under that', 'CHANGELOG.md');
}

function verifyPackedLicensing(installedRoot) {
  const packedPackage = JSON.parse(
    fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
  );
  if (packedPackage.version !== strictReleaseVersion) {
    fail(`packed package version must be ${strictReleaseVersion}`);
  }
  if (packedPackage.license !== 'SEE LICENSE IN LICENSE.md') {
    fail('packed package must use SEE LICENSE IN LICENSE.md');
  }
  const packedLicense = fs.readFileSync(path.join(installedRoot, 'LICENSE.md'));
  if (sha256(packedLicense) !== strictLicenseSha256) {
    fail('packed LICENSE.md bytes do not match the canonical Strict license');
  }
  for (const notice of [
    'COMMERCIAL-LICENSE.md',
    'COPYRIGHT.md',
    'LICENSING_HISTORY.md',
    'README.md',
    'THIRD_PARTY_NOTICES.md'
  ]) {
    const sourceBytes = fs.readFileSync(path.join(root, notice));
    const packedBytes = fs.readFileSync(path.join(installedRoot, notice));
    if (sha256(sourceBytes) !== sha256(packedBytes)) {
      fail(`packed ${notice} bytes do not match the source tree`);
    }
  }
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
  verifyLicensingSources();
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const packOutput = run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packDir
  ]);
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
  const allowedTopLevelEntries = new Set([
    'bin',
    'COMMERCIAL-LICENSE.md',
    'config-template',
    'COPYRIGHT.md',
    'dist',
    'LICENSE.md',
    'LICENSING_HISTORY.md',
    'package.json',
    'README.md',
    'THIRD_PARTY_NOTICES.md'
  ]);

  for (const packedFile of files) {
    const topLevelEntry = packedFile.split('/', 1)[0];
    if (!allowedTopLevelEntries.has(topLevelEntry)) {
      fail(`Packed tarball includes unexpected top-level entry ${topLevelEntry}`);
    }
  }

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
    'LICENSE.md',
    'COPYRIGHT.md',
    'COMMERCIAL-LICENSE.md',
    'LICENSING_HISTORY.md',
    'THIRD_PARTY_NOTICES.md'
  ]) {
    if (!fileSet.has(required)) {
      fail(`Packed tarball is missing ${required}`);
    }
  }

  const forbiddenPrefixes = [
    '.github/',
    'bench/',
    'coverage/',
    'docs/',
    'harness/',
    'test/',
    'lean-launch-test/',
    'audit-probe-',
    'perf/',
    'results/',
    'scripts/',
    'spec/',
    'src/'
  ];
  const forbiddenFiles = new Set([
    'COMMERCIAL_LICENSING.md',
    'audit-findings.md',
    'lean-launch-report.md',
    'launch-blockers.md',
    'deferred.md',
    'demo-script.md'
  ]);

  for (const packedFile of files) {
    if (/\.(?:js|mjs)\.map$/.test(packedFile)) {
      fail(`Packed tarball includes JavaScript source map ${packedFile}`);
    }
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
  verifyPackedLicensing(path.join(projectDir, 'node_modules', rootPackage.name));
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
