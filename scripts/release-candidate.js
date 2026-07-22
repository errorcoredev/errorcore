#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function computeDigests(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    shasum: crypto.createHash('sha1').update(bytes).digest('hex')
  };
}

function readPackedPackageJson(filePath) {
  const archive = zlib.gunzipSync(fs.readFileSync(filePath));
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const archivePath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const sizeText = header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      fail(`Invalid tar entry size for ${archivePath}`);
    }
    const bodyStart = offset + 512;
    if (archivePath === 'package/package.json') {
      return JSON.parse(archive.toString('utf8', bodyStart, bodyStart + size));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  fail('Candidate tarball does not contain package/package.json');
}

function appendEnvironment(metadata) {
  const values = {
    ERRORCORE_CANDIDATE_TARBALL: metadata.tarballPath,
    ERRORCORE_SMOKE_PACKAGE_TARBALL: metadata.tarballPath,
    ERRORCORE_CANDIDATE_VERSION: metadata.version,
    ERRORCORE_CANDIDATE_SHA256: metadata.sha256,
    ERRORCORE_CANDIDATE_INTEGRITY: metadata.integrity,
    BENCH_CANDIDATE_SHA256: metadata.sha256
  };

  if (process.env.GITHUB_ENV !== undefined) {
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
    fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    const lines = Object.entries(values).map(([key, value]) => `${key.toLowerCase()}=${value}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}

function pack(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const npmCommand = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const npmArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm', 'pack', '--json', '--pack-destination', outputDir]
    : ['pack', '--json', '--pack-destination', outputDir];
  const childEnv = { ...process.env };
  delete childEnv.npm_config_dry_run;
  delete childEnv['npm_config_dry-run'];
  const result = spawnSync(npmCommand, npmArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: childEnv
  });
  if (result.error !== undefined) {
    fail(`npm pack failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`npm pack failed with exit ${result.status ?? 1}`);
  }

  const packInfo = JSON.parse(result.stdout)[0];
  const tarballPath = path.resolve(outputDir, packInfo.filename);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packedPackageJson = readPackedPackageJson(tarballPath);
  if (packInfo.name !== packageJson.name || packedPackageJson.name !== packageJson.name) {
    fail(`Packed package name does not match root package ${packageJson.name}`);
  }
  if (packInfo.version !== packageJson.version || packedPackageJson.version !== packageJson.version) {
    fail(`Packed package version does not match root package ${packageJson.version}`);
  }
  const digests = computeDigests(tarballPath);
  if (packInfo.integrity !== digests.integrity || packInfo.shasum !== digests.shasum) {
    fail('npm pack digest metadata does not match the candidate tarball bytes');
  }
  const metadata = {
    name: packInfo.name,
    version: packInfo.version,
    filename: packInfo.filename,
    tarballPath,
    ...digests
  };
  fs.writeFileSync(
    path.join(outputDir, 'candidate.json'),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  appendEnvironment(metadata);
  return metadata;
}

function verify(outputDir) {
  const metadataPath = path.join(outputDir, 'candidate.json');
  if (!fs.existsSync(metadataPath)) {
    fail(`Candidate metadata not found at ${metadataPath}`);
  }
  const stored = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const tarballPath = path.resolve(outputDir, stored.filename);
  if (!fs.existsSync(tarballPath)) {
    fail(`Candidate tarball not found at ${tarballPath}`);
  }
  const digests = computeDigests(tarballPath);
  for (const key of ['sha256', 'integrity', 'shasum']) {
    if (digests[key] !== stored[key]) {
      fail(`Candidate ${key} mismatch: expected ${stored[key]}, got ${digests[key]}`);
    }
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packedPackageJson = readPackedPackageJson(tarballPath);
  if (
    stored.name !== packageJson.name ||
    packedPackageJson.name !== packageJson.name ||
    stored.version !== packageJson.version ||
    packedPackageJson.version !== packageJson.version
  ) {
    fail('Candidate name/version metadata does not match its tarball and the root package');
  }
  const metadata = { ...stored, tarballPath };
  appendEnvironment(metadata);
  return metadata;
}

try {
  const command = process.argv[2];
  const outputDir = path.resolve(root, process.argv[3] ?? 'release-artifact');
  const metadata = command === 'pack'
    ? pack(outputDir)
    : command === 'verify'
      ? verify(outputDir)
      : fail('Usage: node scripts/release-candidate.js <pack|verify> [output-directory]');
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
