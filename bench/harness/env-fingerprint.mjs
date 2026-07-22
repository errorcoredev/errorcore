import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { applyHostToolCache, computePackageIntegrity } from './preflight.mjs';

const execFileAsync = promisify(execFile);

async function command(command, args) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'cmd.exe' : command;
  const finalArgs = process.platform === 'win32' && command === 'npm'
    ? ['/d', '/s', '/c', ['npm', ...args].join(' ')]
    : args;
  try {
    const result = await execFileAsync(executable, finalArgs, { windowsHide: true, timeout: 20_000 });
    return result.stdout.trim();
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
}

export async function collectEnvFingerprint() {
  const toolFacts = applyHostToolCache({
    docker: await command('docker', ['--version']),
    compose: await command('docker', ['compose', 'version'])
  });
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    versions: process.versions,
    npm: await command('npm', ['--version']),
    docker: toolFacts.docker,
    compose: toolFacts.compose,
    packageIntegrity: await computePackageIntegrity(),
    env: {
      NODE_ENV: process.env.NODE_ENV,
      BENCH_RESULTS_DIR: process.env.BENCH_RESULTS_DIR,
      ERRORCORE_PACKAGE_ROOT: process.env.ERRORCORE_PACKAGE_ROOT
    }
  };
}
