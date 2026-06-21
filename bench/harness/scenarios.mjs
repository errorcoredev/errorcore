import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(__dirname, '..');

export function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(benchRoot, 'manifest.json'), 'utf8'));
}

export function getScenarioMatrix(manifest = loadManifest()) {
  const targets = new Map(manifest.targets.map((target) => [target.id, target]));
  return manifest.scenarios.map((scenario) => ({
    ...scenario,
    targetConfig: targets.get(scenario.target),
    framework: targets.get(scenario.target)?.framework
  }));
}

export function requestForScenario(scenario) {
  return {
    method: 'POST',
    path: `/scenario/${scenario.id}`,
    headers: {
      'content-type': 'application/json',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01'
    },
    body: {
      scenarioId: scenario.id,
      order: {
        customer: { id: 42 },
        items: [{ sku: 'sku-pro', quantity: 1 }]
      }
    }
  };
}

export function expectedPayloadCount(scenario) {
  return scenario.expected?.expectedPayloadCount ?? (scenario.id === 'S5' ? 2 : 1);
}

export function getSdkVariants(compareSdk = process.env.BENCH_COMPARE_SDK ?? 'sentry') {
  return ['errorcore', compareSdk];
}

export function getPerfVariants(compareSdk = process.env.BENCH_COMPARE_SDK ?? 'sentry') {
  return ['baseline', 'errorcore', compareSdk];
}

export const SDK_VARIANTS = getSdkVariants();
export const PERF_VARIANTS = getPerfVariants();
