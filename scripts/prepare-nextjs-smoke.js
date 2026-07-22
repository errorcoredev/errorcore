#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(repoRoot, 'test', 'integration', 'fixtures', 'nextjs-smoke');
const pkgPath = path.join(fixtureDir, 'package.json');
const stagedPackageDir = path.join(fixtureDir, '.errorcore-package');
const prepareLockDir = path.join(fixtureDir, '.prepare.lock');
const force = process.env.EC_FORCE_NEXTJS_SMOKE_CI === '1';
const candidateTarball =
  process.env.ERRORCORE_SMOKE_PACKAGE_TARBALL ??
  process.env.ERRORCORE_CANDIDATE_TARBALL;

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

function packageContentDigest(packageDir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  for (const relativeRoot of ['package.json', 'dist', 'bin', 'config-template']) {
    const absoluteRoot = path.join(packageDir, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) return null;
    const pending = [absoluteRoot];
    while (pending.length > 0) {
      const current = pending.pop();
      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current)) {
          pending.push(path.join(current, entry));
        }
      } else if (stat.isFile()) {
        files.push(current);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  for (const filePath of files) {
    hash.update(path.relative(packageDir, filePath).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
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
        throw new Error('[smoke] timed out waiting for Next.js fixture prepare lock');
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

function installCandidateTarball(tarballInput) {
  const tarballPath = path.resolve(tarballInput);
  if (!fs.existsSync(tarballPath) || !fs.statSync(tarballPath).isFile()) {
    throw new Error(`[smoke] candidate tarball does not exist: ${tarballPath}`);
  }

  console.log(`[smoke] installing exact candidate tarball: ${tarballPath}`);
  const originalPackageJson = fs.readFileSync(pkgPath, 'utf8');
  const temporaryPackage = JSON.parse(originalPackageJson);
  temporaryPackage.dependencies = {
    ...temporaryPackage.dependencies,
    errorcore: `file:${tarballPath.replace(/\\/g, '/')}`,
  };

  let result;
  try {
    fs.writeFileSync(pkgPath, `${JSON.stringify(temporaryPackage, null, 2)}\n`);
    const cacheDir = path.join(fixtureDir, '.npm-cache');
    result = runNpm([
      'install',
      '--package-lock=false',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      cacheDir,
    ], fixtureDir);
  } finally {
    fs.writeFileSync(pkgPath, originalPackageJson);
  }

  if (result.error) {
    throw new Error(`[smoke] candidate npm install failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const error = new Error(
      `[smoke] candidate npm install failed with exit code ${result.status ?? 1}`
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }

  const installedPackage = readJson(
    path.join(fixtureDir, 'node_modules', 'errorcore', 'package.json')
  );
  const expectedVersion = process.env.ERRORCORE_CANDIDATE_VERSION;
  if (expectedVersion !== undefined && installedPackage.version !== expectedVersion) {
    throw new Error(
      `[smoke] installed candidate version ${installedPackage.version} does not match ${expectedVersion}`
    );
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
    const expectedVersion = readJson(path.join(repoRoot, 'package.json')).version;
    return (
      installed.name === 'errorcore' &&
      installed.version === expectedVersion &&
      packageContentDigest(installedRoot) === packageContentDigest(stagedPackageDir) &&
      realInstalledRoot !== realRepoRoot
    );
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
  if (candidateTarball !== undefined && candidateTarball.length > 0) {
    installCandidateTarball(candidateTarball);
    process.exitCode = 0;
  } else {
    stageLocalPackage();
    if (dependenciesReady()) {
      console.log('[smoke] Next.js fixture dependencies already installed; skipping npm ci');
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
  }
} catch (error) {
  console.error(error && error.message ? error.message : error);
  process.exitCode = error && error.exitCode ? error.exitCode : 1;
} finally {
  if (releasePrepareLock) releasePrepareLock();
}
