import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(benchRoot, '..');
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.join(benchRoot, 'results');
const hostPreflightCachePath = path.join(resultsDir, 'preflight-host.json');

export const REQUIRED_TARGETS = new Map([
  ['express', { repo: 'gothinkster/node-express-realworld-example-app', pin: '30b68e1e881462b2f4164ea09ab4c4f5699c7b0b' }],
  ['fastify', { repo: 'fastify/demo', pin: '5fa922df34d0ace9f8a63279bfd72ea06cf358da' }],
  ['koa', { repo: 'eflem00/koa-boilerplate', pin: '98265346877a30f3595baf6f574726078b2b6c54' }],
  ['hapi', { repo: 'agendor/sample-hapi-rest-api', pin: '4706ead645949fb4e32c62f2582bfd4c1c7659a1' }],
  ['hono', { repo: 'honojs/examples', pin: '3b0b62875a0e1265763fea1c6388866d5697ef81' }],
  ['nextjs', { repo: 'vercel/next.js', pin: 'fb5a153bf0389719139d9e820afd170191b026ae', tag: 'v15.3.4' }]
]);

export const REQUIRED_SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function hasSha256Digest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{16,}$/i.test(value);
}

function isCommandError(value) {
  return String(value ?? '').startsWith('ERROR:');
}

export function readHostPreflightCache() {
  return readJsonIfExists(hostPreflightCachePath);
}

export function applyHostToolCache(facts, cache = readHostPreflightCache()) {
  const next = { ...facts };
  if (isCommandError(next.docker) && !isCommandError(cache?.facts?.docker) && cache?.facts?.docker !== undefined) {
    next.docker = cache.facts.docker;
  }
  if (isCommandError(next.compose) && !isCommandError(cache?.facts?.compose) && cache?.facts?.compose !== undefined) {
    next.compose = cache.facts.compose;
  }
  return next;
}

function validateExpectedGroundTruth(scenario, errors) {
  const expected = scenario.expected;
  if (expected === undefined || expected === null || typeof expected !== 'object') {
    errors.push(`scenario ${scenario.id} expected ground truth is missing`);
    return;
  }
  for (const field of ['expectedErrorType', 'expectedMessage', 'expectedOriginatingFrame', 'expectedPayloadCount']) {
    if (expected[field] === undefined || expected[field] === null || expected[field] === '') {
      errors.push(`scenario ${scenario.id} expected.${field} is required`);
    }
  }
  if (!Number.isInteger(expected.expectedPayloadCount) || expected.expectedPayloadCount < 1) {
    errors.push(`scenario ${scenario.id} expected.expectedPayloadCount must be a positive integer`);
  }
  if (!Array.isArray(expected.applicableDimensions) || expected.applicableDimensions.length === 0) {
    errors.push(`scenario ${scenario.id} expected.applicableDimensions is required`);
  }
}

export function validateBenchmarkManifest(manifest) {
  const errors = [];

  if (manifest?.nodeImage !== 'node:22.14.0-bookworm-slim') {
    errors.push('nodeImage must be node:22.14.0-bookworm-slim');
  }
  if (!hasSha256Digest(manifest?.nodeImageDigest)) {
    errors.push('nodeImageDigest is required');
  }
  if (manifest?.errorcore?.version !== '0.2.0') {
    errors.push('errorcore version must be 0.2.0');
  }
  if (manifest?.sentry?.node !== '10.56.0') {
    errors.push('@sentry/node version must be 10.56.0');
  }
  if (manifest?.sentry?.nextjs !== '10.56.0') {
    errors.push('@sentry/nextjs version must be 10.56.0');
  }
  if (manifest?.bugsnag !== undefined) {
    if (manifest.bugsnag.js !== '8.9.0') {
      errors.push('@bugsnag/js version must be 8.9.0');
    }
    if (typeof manifest.bugsnag.npmIntegrity !== 'string' || manifest.bugsnag.npmIntegrity.length === 0) {
      errors.push('@bugsnag/js npmIntegrity is required');
    }
  }

  const targets = new Map((manifest?.targets ?? []).map((target) => [target.id, target]));
  for (const [id, required] of REQUIRED_TARGETS) {
    const actual = targets.get(id);
    if (actual === undefined) {
      errors.push(`target ${id} is missing`);
      continue;
    }
    if (actual.repo !== required.repo) {
      errors.push(`target ${id} repo must be ${required.repo}`);
    }
    if (actual.pin !== required.pin) {
      errors.push(`target ${id} pin must be ${required.pin}`);
    }
    if (required.tag !== undefined && actual.tag !== required.tag) {
      errors.push(`target ${id} tag must be ${required.tag}`);
    }
  }

  const scenarioIds = new Set();
  for (const scenario of manifest?.scenarios ?? []) {
    if (scenarioIds.has(scenario.id)) {
      errors.push(`scenario ${scenario.id} is duplicated`);
    }
    scenarioIds.add(scenario.id);
    if (scenario.frozen !== true) {
      errors.push(`scenario ${scenario.id} must be frozen before scoring`);
    }
    validateExpectedGroundTruth(scenario, errors);
  }
  for (const id of REQUIRED_SCENARIOS) {
    if (!scenarioIds.has(id)) {
      errors.push(`scenario ${id} is missing`);
    }
  }

  return errors;
}

function listIntegrityFiles(rootDir) {
  const includePaths = [
    'package.json',
    'package-lock.json',
    '.npmignore',
    'tsconfig.json',
    'src',
    'dist',
    'bin',
    'config-template'
  ];
  const files = [];
  const ignoredDirectoryNames = new Set(['node_modules', '.git']);

  function walk(current) {
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      if (ignoredDirectoryNames.has(path.basename(current))) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        walk(path.join(current, entry.name));
      }
      return;
    }
    if (stat.isFile()) {
      files.push(current);
    }
  }

  for (const relative of includePaths) {
    const absolute = path.join(rootDir, relative);
    if (fs.existsSync(absolute)) {
      walk(absolute);
    }
  }

  return files.sort((left, right) => normalizePath(path.relative(rootDir, left)).localeCompare(
    normalizePath(path.relative(rootDir, right))
  ));
}

export async function computePackageIntegrity(rootDir = repoRoot) {
  const hash = createHash('sha256');
  for (const filePath of listIntegrityFiles(rootDir)) {
    const relative = normalizePath(path.relative(rootDir, filePath));
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function commandOrError(command, args, options = {}) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'cmd.exe' : command;
  const finalArgs = process.platform === 'win32' && command === 'npm'
    ? ['/d', '/s', '/c', ['npm', ...args].join(' ')]
    : args;
  try {
    const result = await execFileAsync(executable, finalArgs, {
      cwd: options.cwd ?? repoRoot,
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000
    });
    return result.stdout.trim();
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

export async function collectPreflightFacts(options = {}) {
  const manifestPath = options.manifestPath ?? path.join(benchRoot, 'manifest.json');
  const packageRoot = options.packageRoot ?? process.env.ERRORCORE_PACKAGE_ROOT ?? repoRoot;
  const manifest = readJson(manifestPath);
  const packageIntegrity = await computePackageIntegrity(packageRoot);
  const packageJson = readJson(path.join(packageRoot, 'package.json'));
  const benchmarkPackage = readJson(path.join(benchRoot, 'apps', 'benchmark-app', 'package.json'));
  const benchmarkLockPath = path.join(benchRoot, 'apps', 'benchmark-app', 'package-lock.json');
  const benchmarkLock = fs.existsSync(benchmarkLockPath) ? readJson(benchmarkLockPath) : null;
  const facts = applyHostToolCache({
    manifestPath,
    packageRoot,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    node: process.version,
    npm: await commandOrError('npm', ['--version']),
    docker: await commandOrError('docker', ['--version']),
    compose: await commandOrError('docker', ['compose', 'version']),
    sentryNodeDependency: benchmarkPackage.dependencies?.['@sentry/node'],
    sentryNextDependency: benchmarkPackage.dependencies?.['@sentry/nextjs'],
    bugsnagJsDependency: benchmarkPackage.dependencies?.['@bugsnag/js'],
    sentryNodeIntegrity: benchmarkLock?.packages?.['node_modules/@sentry/node']?.integrity,
    bugsnagJsIntegrity: benchmarkLock?.packages?.['node_modules/@bugsnag/js']?.integrity,
    packageIntegrity: {
      before: packageIntegrity,
      after: packageIntegrity
    }
  });

  return { manifest, facts };
}

export function validatePreflightFacts(facts, manifest) {
  const errors = [];

  if (facts.packageName !== 'errorcore') {
    errors.push('local package name must be errorcore');
  }
  if (facts.packageVersion !== manifest.errorcore.version) {
    errors.push(`local errorcore package version ${facts.packageVersion} does not match manifest ${manifest.errorcore.version}`);
  }
  if (isCommandError(facts.docker)) {
    errors.push(`docker --version failed: ${facts.docker}`);
  }
  if (isCommandError(facts.compose)) {
    errors.push(`docker compose version failed: ${facts.compose}`);
  }
  if (facts.sentryNodeDependency !== manifest.sentry.node) {
    errors.push('@sentry/node package dependency drifted from manifest');
  }
  if (facts.sentryNextDependency !== manifest.sentry.nextjs) {
    errors.push('@sentry/nextjs package dependency drifted from manifest');
  }
  if (facts.sentryNodeIntegrity !== manifest.sentry.npmIntegrity) {
    errors.push('@sentry/node package-lock integrity drifted from manifest');
  }
  if (manifest.bugsnag !== undefined) {
    if (facts.bugsnagJsDependency !== manifest.bugsnag.js) {
      errors.push('@bugsnag/js package dependency drifted from manifest');
    }
    if (facts.bugsnagJsIntegrity !== manifest.bugsnag.npmIntegrity) {
      errors.push('@bugsnag/js package-lock integrity drifted from manifest');
    }
  }
  if (facts.packageIntegrity?.before !== facts.packageIntegrity?.after) {
    errors.push('errorcore package integrity changed during benchmark run');
  }

  return errors;
}

export async function runPreflight(options = {}) {
  const { manifest, facts } = await collectPreflightFacts(options);
  const errors = [
    ...validateBenchmarkManifest(manifest),
    ...validatePreflightFacts(facts, manifest)
  ];

  return {
    ok: errors.length === 0,
    errors,
    facts,
    manifest
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPreflight();
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(hostPreflightCachePath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
