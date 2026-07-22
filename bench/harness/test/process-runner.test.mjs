import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatSpawnFailure } from '../process-runner.mjs';

describe('benchmark process runner', () => {
  it('turns a spawn EINVAL into actionable diagnostics without exposing environment values', () => {
    const error = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
    const message = formatSpawnFailure(error, {
      executable: '/node',
      cwd: '/benchmark/app',
      environmentEntries: 42
    });

    assert.match(message, /spawn failed EINVAL: spawn EINVAL/);
    assert.match(message, /executable=\/node/);
    assert.match(message, /cwd=\/benchmark\/app/);
    assert.match(message, /environmentEntries=42/);
    assert.match(message, /process\/environment limits/);
  });
});
