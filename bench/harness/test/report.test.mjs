import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeReport } from '../report.mjs';

describe('benchmark report generation', () => {
  it('includes required sections in order and does not describe parity as a scoring drop gate', () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-test-'));
    try {
      const reportPath = writeReport({
        resultsDir,
        preflight: {
          ok: true,
          errors: [],
          manifest: { nodeImage: 'node:22.14.0-bookworm-slim', nodeImageDigest: 'sha256:abc' },
          facts: {
            packageName: 'errorcore',
            packageVersion: '0.2.0',
            docker: 'Docker version 28.0.0',
            compose: 'Docker Compose version v2.33.0',
            packageIntegrity: { before: 'sha256:a', after: 'sha256:a' }
          }
        },
        fingerprint: {
          node: process.version,
          npm: '10.0.0',
          docker: 'Docker version 28.0.0',
          compose: 'Docker Compose version v2.33.0'
        },
        scenarioResults: [
          {
            scenarioId: 'S1',
            framework: 'express',
            description: 'scenario one',
            expected: { expectedMessage: 'boom' },
            parity: {
              ok: false,
              failures: ['message differs'],
              closerToGroundTruth: { messageWinner: 'errorcore', frameWinner: 'tie', evidence: [] }
            },
            variants: []
          }
        ],
        perfResults: {
          repetitions: [],
          aggregates: []
        },
        scores: [
          {
            scenarioId: 'S1',
            sdk: 'errorcore',
            total: 5,
            maxTotal: 10,
            dimensions: {
              D1: { applicable: true, score: 5, max: 5, evidence: 'matched' },
              D2: { applicable: true, score: 0, max: 5, evidence: 'missed' }
            }
          }
        ],
        backlog: [],
        sdkInitConfigs: {},
        blindJudge: { status: 'not-run', reason: 'not configured' },
        promptPath: path.join(resultsDir, 'blind-diagnosability-prompts.jsonl')
      });
      const content = fs.readFileSync(reportPath, 'utf8');
      const required = [
        '## Verdict',
        '## Environment & fairness',
        '## Per-dimension head-to-head',
        '## Per-scenario results',
        '## Performance',
        '## errorcore Improvement Backlog',
        '## Threats to validity',
        '## Artifact index'
      ];

      let previous = -1;
      for (const heading of required) {
        const index = content.indexOf(heading);
        assert.notEqual(index, -1, `${heading} missing`);
        assert.equal(index > previous, true, `${heading} out of order`);
        previous = index;
      }
      assert.equal(content.includes('dropped'), false);
      assert.equal(content.includes('excluded from comparative scoring'), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });

  it('writes a caller-selected report filename for alternate OSS comparisons', () => {
    const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-alt-test-'));
    try {
      const reportPath = writeReport({
        resultsDir,
        reportFilename: 'BUGSNAG_REPORT.md',
        preflight: {
          ok: true,
          errors: [],
          manifest: { nodeImage: 'node:22.14.0-bookworm-slim', nodeImageDigest: 'sha256:abc' },
          facts: {
            packageName: 'errorcore',
            packageVersion: '0.2.0',
            docker: 'Docker version 28.0.0',
            compose: 'Docker Compose version v2.33.0',
            packageIntegrity: { before: 'sha256:a', after: 'sha256:a' }
          }
        },
        fingerprint: {
          node: process.version,
          npm: '10.0.0',
          docker: 'Docker version 28.0.0',
          compose: 'Docker Compose version v2.33.0'
        },
        scenarioResults: [],
        perfResults: { repetitions: [], aggregates: [] },
        scores: [],
        backlog: [],
        sdkInitConfigs: {},
        blindJudge: { status: 'not-run' },
        promptPath: path.join(resultsDir, 'blind-diagnosability-prompts-bugsnag.jsonl')
      });

      assert.equal(path.basename(reportPath), 'BUGSNAG_REPORT.md');
      assert.equal(fs.existsSync(path.join(resultsDir, 'REPORT.md')), false);
    } finally {
      fs.rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});
