export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const errorcore = require('errorcore');
    errorcore.init({
      transport: { type: 'file', path: process.env.ERRORCORE_SMOKE_FILE || './smoke-errors.ndjson' },
      captureLocalVariables: true,
      allowUnencrypted: true,
      useWorkerAssembly: false,
      maxLocalsCollectionsPerSecond: 200,
      maxCachedLocals: 200,
      flushIntervalMs: 2000,
    });
  }
}
