import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildErrorcoreCaptureOptions } from '../../apps/benchmark-app/lib/sdk-adapter.mjs';

describe('Errorcore benchmark capture options', () => {
  it('preserves explicit request evidence for every capture mode', () => {
    const context = {
      scenarioId: 'S6',
      request: {
        method: 'POST',
        path: '/scenario/S6',
        headers: { Traceparent: '00-11111111111111111111111111111111-2222222222222222-01' },
        body: { accepted: true },
        statusCode: 202
      }
    };

    for (const captureMode of ['safe', 'balanced', 'forensic', 'fast']) {
      const options = buildErrorcoreCaptureOptions({
        scenarioId: 'S6',
        errorcoreCaptureMode: captureMode
      }, context);

      assert.equal(options.request.method, 'POST');
      assert.equal(options.request.url, '/scenario/S6');
      assert.equal(options.request.statusCode, 202);
      assert.equal(
        options.request.traceparent,
        '00-11111111111111111111111111111111-2222222222222222-01'
      );
      assert.equal(options.request.bodyLength > 0, true);
      assert.match(options.request.bodyHash, /^sha256:[0-9a-f]{64}$/);
    }
  });
});
