export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const errorcore = require('errorcore');
    errorcore.init({
      transport: { type: 'file', path: './smoke-errors.ndjson' },
      captureLocalVariables: true,
      allowUnencrypted: true,
      useWorkerAssembly: false,
      flushIntervalMs: 2000,
    });
  }
}
