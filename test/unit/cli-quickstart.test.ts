import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'errorcore-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI quickstart', () => {
  it('generates a file-transport demo that points users to show and dashboard', () => {
    const projectDir = makeTempProject();
    const binPath = path.resolve(__dirname, '../../bin/errorcore.js');

    const output = execFileSync(process.execPath, [binPath, 'init', '--quickstart'], {
      cwd: projectDir,
      encoding: 'utf8'
    });

    const config = readFileSync(path.join(projectDir, 'errorcore.config.js'), 'utf8');
    const demo = readFileSync(path.join(projectDir, 'errorcore-test.js'), 'utf8');

    expect(output).toContain('npx errorcore show --latest');
    expect(output).toContain('npx errorcore dashboard');
    expect(config).toContain("transport: { type: 'file', path: '.errorcore/events.ndjson' }");
    expect(config).toContain('captureLocalVariables: true');
    expect(config).toContain('captureRequestBodies: true');
    expect(config).toContain('captureResponseBodies: true');
    expect(config).toContain('captureBodyDigest: true');
    expect(config).toContain('resolveSourceMaps: false');
    expect(config).toContain("logLevel: 'error'");
    expect(existsSync(path.join(projectDir, '.errorcore'))).toBe(true);
    expect(demo).toContain("errorcore.trackState('quickstart-cart'");
    expect(demo).toContain('await fetch(`${upstreamBaseUrl}/inventory?sku=demo-widget`');
    expect(demo).toContain('errorcore.captureError(error)');
  });
});
