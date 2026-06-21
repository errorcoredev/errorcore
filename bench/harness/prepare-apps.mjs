import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadManifest } from './scenarios.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');

async function git(args, cwd) {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 300_000 });
  return result.stdout.trim();
}

async function prepareTarget(target) {
  const dirName = `${target.id}@${target.pin}`;
  const targetDir = path.join(benchRoot, 'apps', dirName);
  const sourceDir = path.join(targetDir, 'source');
  fs.mkdirSync(targetDir, { recursive: true });
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    await git(['clone', '--filter=blob:none', `https://github.com/${target.repo}.git`, sourceDir], benchRoot);
  }
  await git(['fetch', '--tags', 'origin', target.pin], sourceDir).catch(() => null);
  await git(['checkout', '--detach', target.pin], sourceDir);
  const actual = await git(['rev-parse', 'HEAD'], sourceDir);
  if (actual !== target.pin) {
    throw new Error(`${target.id} resolved to ${actual}, expected ${target.pin}`);
  }
  return { id: target.id, sourceDir, pin: actual };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = loadManifest();
  const prepared = [];
  for (const target of manifest.targets) {
    prepared.push(await prepareTarget(target));
  }
  console.log(JSON.stringify({ prepared }, null, 2));
}
