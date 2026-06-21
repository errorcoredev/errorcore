import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getPerfVariants, getSdkVariants } from '../scenarios.mjs';

describe('SDK variant selection', () => {
  it('defaults to errorcore versus sentry', () => {
    assert.deepEqual(getSdkVariants(), ['errorcore', 'sentry']);
    assert.deepEqual(getPerfVariants(), ['baseline', 'errorcore', 'sentry']);
  });

  it('can run errorcore versus BugSnag as the alternate OSS comparator', () => {
    assert.deepEqual(getSdkVariants('bugsnag'), ['errorcore', 'bugsnag']);
    assert.deepEqual(getPerfVariants('bugsnag'), ['baseline', 'errorcore', 'bugsnag']);
  });
});
