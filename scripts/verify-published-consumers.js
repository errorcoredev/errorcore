#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageSpec = process.argv[2] ?? process.env.ERRORCORE_CANDIDATE_TARBALL ?? 'errorcore@next';
const dependencySpec = packageSpec.startsWith('errorcore@')
  ? packageSpec.slice('errorcore@'.length)
  : packageSpec;
if (dependencySpec.length === 0) {
  throw new Error('The ErrorCore package spec must include a version or tag.');
}
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-consumers-'));

function run(command, args, options = {}) {
  const executable = process.platform === 'win32' && command === 'npm'
    ? process.env.ComSpec || 'cmd.exe'
    : command;
  const finalArgs = process.platform === 'win32' && command === 'npm'
    ? ['/d', '/s', '/c', 'npm', ...args]
    : args;
  const result = spawnSync(executable, finalArgs, {
    cwd: options.cwd ?? tempRoot,
    env: { ...process.env },
    encoding: 'utf8',
    shell: false
  });
  if (result.error !== undefined) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 1}`);
  }
  return result.stdout;
}

try {
  fs.writeFileSync(path.join(tempRoot, 'package.json'), `${JSON.stringify({
    name: 'errorcore-release-consumers',
    private: true,
    type: 'commonjs',
    dependencies: {
      '@types/node': '^22.0.0',
      errorcore: dependencySpec,
      hono: '4.12.28',
      typescript: '^5.9.3'
    }
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(tempRoot, 'runtime.cjs'), `
'use strict';
const core = require('errorcore');
const nextjs = require('errorcore/nextjs');
const hono = require('errorcore/hono');
const ingest = require('errorcore/ingest');
const pii = require('errorcore/pii/scrubber');

for (const [name, value] of Object.entries({
  'core.createSDK': core.createSDK,
  'nextjs.withErrorcore': nextjs.withErrorcore,
  'hono.honoMiddleware': hono.honoMiddleware,
  'ingest.receiveIngestEnvelope': ingest.receiveIngestEnvelope,
  'pii.createDefaultPiiScrubber': pii.createDefaultPiiScrubber
})) {
  if (typeof value !== 'function') throw new Error('missing ' + name);
}
pii.createDefaultPiiScrubber();
console.log('CommonJS, Next.js, Hono, ingest, and PII consumers passed');
`);

  fs.writeFileSync(path.join(tempRoot, 'consumer.ts'), `
import { createSDK, type SDKConfig } from 'errorcore';
import { withErrorcore } from 'errorcore/nextjs';
import { honoMiddleware } from 'errorcore/hono';
import { receiveIngestEnvelope } from 'errorcore/ingest';
import { createDefaultPiiScrubber } from 'errorcore/pii/scrubber';

const config: Partial<SDKConfig> = { transport: { type: 'stdout' } };
const sdkFactory: typeof createSDK = createSDK;
const nextWrapper: typeof withErrorcore = withErrorcore;
const honoAdapter: typeof honoMiddleware = honoMiddleware;
const ingestReceiver: typeof receiveIngestEnvelope = receiveIngestEnvelope;
const scrubberFactory: typeof createDefaultPiiScrubber = createDefaultPiiScrubber;
void [config, sdkFactory, nextWrapper, honoAdapter, ingestReceiver, scrubberFactory];
`);

  fs.writeFileSync(path.join(tempRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node']
    },
    include: ['consumer.ts']
  }, null, 2)}\n`);

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(process.execPath, ['runtime.cjs']);
  const installedPackage = JSON.parse(fs.readFileSync(
    path.join(tempRoot, 'node_modules', 'errorcore', 'package.json'),
    'utf8'
  ));
  if (
    installedPackage.bin?.errorcore !== 'bin/errorcore.js' ||
    installedPackage.bin?.ecd !== 'bin/errorcore.js'
  ) {
    throw new Error('Packed package has invalid errorcore/ecd bin mappings');
  }
  for (const cli of ['errorcore', 'ecd']) {
    const output = run('npm', ['exec', '--offline', '--', cli, '--help']);
    if (!output.includes('errorcore')) {
      throw new Error(`${cli} --help consumer did not render the CLI help`);
    }
  }
  run(process.execPath, [path.join(tempRoot, 'node_modules', 'typescript', 'bin', 'tsc')]);
  process.stdout.write(`Fresh consumer verification passed for ${packageSpec}\n`);
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
}
