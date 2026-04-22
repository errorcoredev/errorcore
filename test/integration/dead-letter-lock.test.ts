import { beforeAll, describe, expect, it } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'concurrent-rewriter.js');

beforeAll(() => {
  const compiledLock = path.join(REPO_ROOT, 'dist', 'transport', 'file-lock.js');
  if (!fs.existsSync(compiledLock)) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  }
}, 120_000);

describe('dead-letter cross-process lock', () => {
  it('two concurrent rewriters produce a consistent file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'errorcore-lock-'));
    const dataPath = path.join(dir, 'dead-letter.jsonl');
    const lockPath = dataPath + '.lock';
    const iterations = 25;
    const linesPerIter = 4;

    const initial = ['init-1', 'init-2', 'init-3'];
    fs.writeFileSync(dataPath, initial.join('\n') + '\n');

    try {
      const run = (label: string) =>
        new Promise<{ code: number; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [FIXTURE, lockPath, dataPath, label, String(iterations), String(linesPerIter)],
            { stdio: ['ignore', 'ignore', 'pipe'] }
          );
          let stderr = '';
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
          });
          child.on('error', reject);
          child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
        });

      const [a, b] = await Promise.all([run('A'), run('B')]);
      expect(a.code, `process A failed: ${a.stderr}`).toBe(0);
      expect(b.code, `process B failed: ${b.stderr}`).toBe(0);

      const finalLines = fs
        .readFileSync(dataPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);

      const expectedTotal = initial.length + 2 * iterations * linesPerIter;
      expect(finalLines.length).toBe(expectedTotal);

      for (const line of finalLines) {
        expect(line).toMatch(/^(init-\d+|A-\d+-\d+|B-\d+-\d+)$/);
      }

      const countA = finalLines.filter((l) => l.startsWith('A-')).length;
      const countB = finalLines.filter((l) => l.startsWith('B-')).length;
      expect(countA).toBe(iterations * linesPerIter);
      expect(countB).toBe(iterations * linesPerIter);

      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
