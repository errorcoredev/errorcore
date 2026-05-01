import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.join(__dirname, '..', '..');
const SMOKE_DIR = path.join(REPO_ROOT, 'tmp-nextjs-smoke');
const RUN = path.join(SMOKE_DIR, 'run-smoke.mjs');

function smokeReady(): boolean {
  // The smoke harness expects node_modules to be installed already.
  return fs.existsSync(path.join(SMOKE_DIR, 'node_modules'));
}

const enabled = process.env.EC_SMOKE_NEXTJS === '1' && smokeReady();

describe.skipIf(!enabled)(
  'tmp-nextjs-smoke harness (EC_SMOKE_NEXTJS=1, node_modules installed)',
  () => {
    it(
      'runs end-to-end and exits zero',
      () => {
        const result = spawnSync('node', [RUN], {
          cwd: REPO_ROOT,
          stdio: 'inherit',
          timeout: 240_000,
          env: { ...process.env },
        });
        expect(result.status).toBe(0);
      },
      240_000,
    );
  },
);
