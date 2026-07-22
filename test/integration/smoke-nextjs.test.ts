import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.join(__dirname, '..', '..');
const SMOKE_DIR = path.join(REPO_ROOT, 'test', 'integration', 'fixtures', 'nextjs-smoke');
const RUN = path.join(SMOKE_DIR, 'run-smoke.mjs');
const DEV_MEMORY_RUN = path.join(SMOKE_DIR, 'run-dev-memory.mjs');

function smokeReady(): boolean {
  // The smoke harness expects node_modules to be installed already.
  return fs.existsSync(path.join(SMOKE_DIR, 'node_modules'));
}

const enabled = process.env.EC_SMOKE_NEXTJS === '1' && smokeReady();
const devMemoryEnabled = process.env.EC_SMOKE_NEXTJS_DEV_MEMORY === '1' && smokeReady();

describe('Next.js smoke fixture guardrails', () => {
  it('fails fast when SMOKE_PORT is already occupied', async () => {
    const server = net.createServer((_socket) => {
      // Keep the port occupied until the harness preflight has completed.
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected TCP server address');
      }

      const started = Date.now();
      const result = spawnSync(process.execPath, [RUN], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          SMOKE_PORT: String(address.port),
        },
      });
      const durationMs = Date.now() - started;
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      expect(durationMs).toBeLessThan(5_000);
      expect(output).toMatch(/SMOKE_PORT .*already in use|EADDRINUSE/);
      expect(output).not.toContain('[smoke] building...');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 20_000);
});

describe.skipIf(!enabled)(
  'Next.js smoke fixture (EC_SMOKE_NEXTJS=1, node_modules installed)',
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

describe.skipIf(!devMemoryEnabled)(
  'Next.js smoke fixture dev memory harness (EC_SMOKE_NEXTJS_DEV_MEMORY=1, node_modules installed)',
  () => {
    it(
      'runs 50+ HMR route rebuilds without unbounded heap growth',
      () => {
        const result = spawnSync('node', [DEV_MEMORY_RUN], {
          cwd: REPO_ROOT,
          stdio: 'inherit',
          timeout: 300_000,
          env: { ...process.env },
        });
        expect(result.status).toBe(0);
      },
      300_000,
    );
  },
);
