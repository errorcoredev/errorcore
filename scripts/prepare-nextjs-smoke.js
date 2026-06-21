#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'tmp-nextjs-smoke');
const pkgPath = path.join(fixtureDir, 'package.json');
const stagedPackageDir = path.join(fixtureDir, '.errorcore-package');
const prepareLockDir = path.join(fixtureDir, '.prepare.lock');
const force = process.env.EC_FORCE_NEXTJS_SMOKE_CI === '1';

function runNpm(args, cwd) {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args;
  return spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePrepareLock() {
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(prepareLockDir);
      fs.writeFileSync(path.join(prepareLockDir, 'pid'), `${process.pid}\n`);
      return () => fs.rmSync(prepareLockDir, { recursive: true, force: true });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt > 120_000) {
        throw new Error('[smoke] timed out waiting for tmp-nextjs-smoke prepare lock');
      }

      sleepSync(250);
    }
  }
}

function stageLocalPackage() {
  console.log('[smoke] building and staging local errorcore package');

  const build = runNpm(['run', 'build'], repoRoot);
  if (build.error) {
    throw new Error(`[smoke] npm run build failed to start: ${build.error.message}`);
  }
  if (build.status !== 0) {
    const error = new Error(`[smoke] npm run build failed with exit code ${build.status ?? 1}`);
    error.exitCode = build.status ?? 1;
    throw error;
  }

  fs.rmSync(stagedPackageDir, { recursive: true, force: true });
  fs.mkdirSync(stagedPackageDir, { recursive: true });

  const stagedPackageJson = readJson(path.join(repoRoot, 'package.json'));
  delete stagedPackageJson.devDependencies;
  delete stagedPackageJson.scripts;
  fs.writeFileSync(
    path.join(stagedPackageDir, 'package.json'),
    `${JSON.stringify(stagedPackageJson, null, 2)}\n`,
  );

  for (const name of ['dist', 'bin', 'config-template']) {
    fs.cpSync(path.join(repoRoot, name), path.join(stagedPackageDir, name), {
      recursive: true,
    });
  }
}

function dependencyInstalled(name, expectedRange) {
  const installedPath = path.join(fixtureDir, 'node_modules', name, 'package.json');
  if (!fs.existsSync(installedPath)) return false;

  const installed = readJson(installedPath);
  if (name === 'errorcore') {
    const installedRoot = path.dirname(installedPath);
    const realInstalledRoot = fs.realpathSync.native(installedRoot);
    const realRepoRoot = fs.realpathSync.native(repoRoot);
    return installed.name === 'errorcore' && realInstalledRoot !== realRepoRoot;
  }

  const expected = String(expectedRange).replace(/^[~^]/, '');
  return installed.version === expected;
}

function dependenciesReady() {
  if (force) return false;
  if (!fs.existsSync(path.join(fixtureDir, 'package-lock.json'))) return false;

  const pkg = readJson(pkgPath);
  const required = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  return Object.entries(required).every(([name, version]) => dependencyInstalled(name, version));
}

let releasePrepareLock;

try {
  releasePrepareLock = acquirePrepareLock();
  stageLocalPackage();

  if (dependenciesReady()) {
    console.log('[smoke] tmp-nextjs-smoke dependencies already installed; skipping npm ci');
    process.exitCode = 0;
  } else {
    const cacheDir = path.join(fixtureDir, '.npm-cache');
    const npmArgs = [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cacheDir,
    ];
    const result = runNpm(npmArgs, fixtureDir);

    if (result.error) {
      throw new Error(`[smoke] npm ci failed to start: ${result.error.message}`);
    }

    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = error && error.exitCode ? error.exitCode : 1;
} finally {
  if (releasePrepareLock) releasePrepareLock();
}
