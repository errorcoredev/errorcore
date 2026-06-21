import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as blind from '../blind-diagnosability.mjs';

describe('blind diagnosability judge', () => {
  it('marks the judge not-run when no judge command is configured', async () => {
    assert.equal(typeof blind.runBlindJudge, 'function');
    const previous = process.env.BENCH_BLIND_JUDGE_COMMAND;
    delete process.env.BENCH_BLIND_JUDGE_COMMAND;
    try {
      const result = await blind.runBlindJudge({
        promptsPath: path.join(os.tmpdir(), 'missing-prompts.jsonl')
      });

      assert.deepEqual(result, {
        status: 'not-run',
        reason: 'BENCH_BLIND_JUDGE_COMMAND is not configured',
        results: []
      });
    } finally {
      if (previous === undefined) delete process.env.BENCH_BLIND_JUDGE_COMMAND;
      else process.env.BENCH_BLIND_JUDGE_COMMAND = previous;
    }
  });

  it('writes one prompt per scenario SDK payload set', () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-prompts-test-'));
    try {
      const promptsPath = blind.writeBlindDiagnosabilityPrompts({
        resultsDir,
        scenarioResults: [
          {
            scenarioId: 'S1',
            variants: [
              { sdk: 'errorcore', payloads: [{ error: { message: 'x' } }] },
              { sdk: 'sentry', payloads: [{ exception: { values: [] } }] }
            ]
          }
        ]
      });

      const lines = fs.readFileSync(promptsPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.deepEqual(lines.map((line) => JSON.parse(line).sdk), ['errorcore', 'sentry']);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it('writes prompts to a caller-selected filename for alternate OSS comparisons', () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-prompts-alt-test-'));
    try {
      const promptsPath = blind.writeBlindDiagnosabilityPrompts({
        resultsDir,
        filename: 'blind-diagnosability-prompts-bugsnag.jsonl',
        scenarioResults: [
          {
            scenarioId: 'S1',
            variants: [
              { sdk: 'errorcore', payloads: [] },
              { sdk: 'bugsnag', payloads: [] }
            ]
          }
        ]
      });

      assert.equal(path.basename(promptsPath), 'blind-diagnosability-prompts-bugsnag.jsonl');
      assert.equal(fs.existsSync(path.join(resultsDir, 'blind-diagnosability-prompts.jsonl')), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});
