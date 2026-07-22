import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPerfSuite } from './perf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');
const resultsDir = process.env.BENCH_RESULTS_DIR ?? path.join(benchRoot, 'results');
const compareSdk = process.env.BENCH_COMPARE_SDK ?? 'sentry';
const resultSuffix = compareSdk === 'sentry' ? '' : `-${compareSdk}`;
const perfDirName = `perf${resultSuffix}`;
const perfDir = path.join(resultsDir, perfDirName);

fs.mkdirSync(perfDir, { recursive: true });

const result = await runPerfSuite({
  resultsDir,
  perfDir,
  compareSdk,
  resultSuffix
});

fs.writeFileSync(path.join(perfDir, 'perf.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  ok: true,
  perfPath: path.join(perfDir, 'perf.json'),
  aggregates: result.aggregates.length
}));
