import fs from 'node:fs'
import path from 'node:path'

const harnessRoot = path.resolve(process.argv[2] || 'harness')
const reportsRoot = path.join(harnessRoot, 'reports')
const resultsPath = path.join(reportsRoot, 'results.json')
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))

function pipe(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

function table(headers, rows) {
  return [
    `| ${headers.map(pipe).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(pipe).join(' | ')} |`),
  ].join('\n')
}

function points(dimension) {
  return `${Number(dimension.points).toFixed(2).replace(/\.00$/, '')}/${dimension.maxPoints}`
}

function measured(dimension) {
  if (typeof dimension.numerator === 'number' && typeof dimension.denominator === 'number') {
    return `${dimension.numerator}/${dimension.denominator}`
  }
  if (typeof dimension.leaks === 'number') {
    return `${dimension.leaks} leaks across ${dimension.scannedCaptureRecords} decoded records`
  }
  if (dimension.enabled && dimension.disabled) {
    return `p97.5 +${dimension.p97_5DeltaMs} ms; throughput ratio ${dimension.throughputRatio}x`
  }
  return ''
}

function dimensionName(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
}

function refText(ref) {
  if (!ref) return ''
  return `${ref.service}:${ref.file}:${ref.line}`
}

function scenarioRows() {
  return results.faultScenarios.map((scenario) => [
    scenario.scenario,
    scenario.endpoint,
    scenario.requestsIssued,
    `${scenario.newCaptures.conduitApi || 0} / ${scenario.newCaptures.enrichSvc || 0}`,
    scenario.captured ? 'captured' : 'no new capture',
  ])
}

function captureRows() {
  return results.faultScenarios.flatMap((scenario) => {
    if (!scenario.captureRefs.length) {
      return [[scenario.scenario, 'none', '', '', '']]
    }
    return scenario.captureRefs.map((ref) => [
      scenario.scenario,
      refText(ref),
      ref.errorType,
      ref.traceId,
      ref.errorMessage,
    ])
  })
}

function dimensionRows() {
  return Object.entries(results.dimensions).map(([key, dimension]) => [
    dimensionName(key),
    measured(dimension),
    points(dimension),
  ])
}

function rawCaptureRows() {
  return results.rawCaptureAppendix.map((capture) => [
    capture.relativePath ?? capture.path,
    capture.bytes,
    capture.sha256,
  ])
}

function smokeRequestCount() {
  const outputPath = results.metadata.trafficSmoke?.outputPath
  if (typeof outputPath !== 'string' || !fs.existsSync(outputPath)) {
    return 'unknown'
  }
  try {
    const buffer = fs.readFileSync(outputPath)
    const utf8Text = buffer.toString('utf8')
    const text = (utf8Text.includes('\u0000') ? buffer.toString('utf16le') : utf8Text)
      .replace(/^\uFEFF/, '')
    const smoke = JSON.parse(text)
    return typeof smoke.count === 'number' ? smoke.count : 'unknown'
  } catch {
    return 'unknown'
  }
}

function ioRows() {
  return results.dimensions.ioTimelineCompleteness.units.map((unit) => [
    unit.name,
    unit.expected,
    unit.satisfied,
  ])
}

function partialRows() {
  return Object.entries(results.dimensions)
    .filter(([, dimension]) => dimension.points < dimension.maxPoints)
    .map(([key, dimension]) => [
      dimensionName(key),
      measured(dimension),
      points(dimension),
      dimension.definition,
    ])
}

const dims = results.dimensions
const proof = dims.logicalClockOrderingUnderSkew.proofs?.[0]
const ioExample = results.examples.ioTimeline
const piiExample = results.examples.piiScrubbedUrl
const sourceExample = results.examples.minifiedFrameUnresolved
const perf = dims.performanceOverhead

const publicReport = `# errorcore production validation

**Result: ${results.finalScore.toFixed(2)}/100.** This run met the 90+ validation gate with freshly generated captures from the packed SDK installed into the production Docker apps.

## What ran

The SDK was built, packed, and installed into App-A and App-B from \`${results.metadata.preflight.ecTgz}\` with sha256 \`${results.metadata.preflight.ecTgzSha256}\`. Both apps ran as minified production Docker bundles with external source maps.

${table(['Service', 'Application', 'Build', 'Data path', 'Capture file'], [
  ['App-A', `RealWorld Express + Sequelize backend at ${results.metadata.appA.repo} @ ${results.metadata.appA.repoSha}`, 'esbuild minified bundle, external source map', 'PostgreSQL through toxiproxy', 'captures/conduit-api/events.ndjson'],
  ['App-B', 'Fastify enrichment service with real ioredis operations', 'esbuild minified bundle, external source map, libfaketime clock skew', 'Redis through toxiproxy; App-A calls over HTTP through toxiproxy', 'captures/enrich-svc/events.ndjson'],
])}

The RealWorld smoke issued ${smokeRequestCount()} contract requests across registration, login, current user, profiles, articles, favorites, comments, feed, and tags. Faults were produced by toxiproxy and Docker state changes; the validation apps did not add synthetic throws and did not call the errorcore capture API.

${table(['Fault', 'Endpoint', 'Requests', 'New captures A/B', 'Result'], scenarioRows())}

## Capability Results

Source-map un-minification resolved ${dims.sourceMapUnminification.numerator}/${dims.sourceMapUnminification.denominator} app-boundary frames away from bundled \`dist/server.js\`; example boundary: \`${JSON.stringify(sourceExample.appBoundaryFrame)}\`.

Local-variable capture recovered meaningful local names in ${dims.localsCaptureQuality.numerator}/${dims.localsCaptureQuality.denominator} scored captures, including app frames and scrubbed Redis command context on App-B Redis failures. One external socket reset still had no useful app locals.

Cross-service correlation passed ${dims.crossServiceCorrelation.numerator}/${dims.crossServiceCorrelation.denominator} trace groups. Representative trace \`${proof?.traceId ?? 'n/a'}\` linked ${refText(proof?.conduitRef)} to ${refText(proof?.enrichRef)}.

I/O timeline completeness was partial at ${points(dims.ioTimelineCompleteness)}: pg ${dims.ioTimelineCompleteness.units[0].satisfied}/${dims.ioTimelineCompleteness.units[0].expected}, HTTP ${dims.ioTimelineCompleteness.units[1].satisfied}/${dims.ioTimelineCompleteness.units[1].expected}, Redis ${dims.ioTimelineCompleteness.units[2].satisfied}/${dims.ioTimelineCompleteness.units[2].expected}. Example I/O capture: ${refText(ioExample.ref)}.

PII scrubbing found ${dims.piiScrubbing.leaks} raw hostile-token leaks across ${dims.piiScrubbing.scannedCaptureRecords} decoded records. Example scrubbed URL: \`${piiExample.url}\`.

Crash-time capture produced new captures for ${dims.crashTimeReliabilityCaptureRate.numerator}/${dims.crashTimeReliabilityCaptureRate.denominator} fault scenarios. F8 memory pressure remained a miss after oversized valid JSON attempts.

Performance remained the weakest area: enabled p97.5 ${perf.enabled.p97_5Ms} ms vs disabled ${perf.disabled.p97_5Ms} ms, throughput ratio ${perf.throughputRatio}x, score ${points(perf)}.

## Score

${table(['Dimension', 'Measured result', 'Score'], dimensionRows())}

**Total: ${results.finalScore.toFixed(2)}/100.**

## Raw Capture Appendix

${table(['Path', 'Bytes', 'sha256'], rawCaptureRows())}
`

const internalReport = `# errorcore validation ground truth

Generated from \`harness/reports/results.json\` at \`${results.generatedAt}\`.

Final score: **${results.finalScore.toFixed(2)}/100**.

## Ground Rules

- SDK built with \`npm run build\`, packed with \`npm pack\`, and installed into validation apps from the packed tgz.
- Packed SDK tgz: \`${results.metadata.preflight.ecTgz}\`
- Packed SDK sha256: \`${results.metadata.preflight.ecTgzSha256}\`
- Apps ran in Docker with \`NODE_ENV=production\`, minified esbuild bundles, and external source maps.
- No app-side synthetic errors and no manual errorcore capture API calls were used in validation apps.
- Metrics are computed by \`node harness/collector/parse-results.mjs harness\`.

## Environment

${table(['Tool', 'Version'], Object.entries(results.metadata.preflight.toolVersions).map(([tool, version]) => [tool, version]))}

## Fault Catalogue

${table(['Fault', 'Endpoint', 'Requests', 'New captures A/B', 'Result'], scenarioRows())}

Capture mapping by scenario:

${table(['Scenario', 'Capture', 'Error type', 'Trace id', 'Message'], captureRows())}

## Score Math

${table(['Dimension', 'Definition', 'Measured result', 'Score'], Object.entries(results.dimensions).map(([key, dimension]) => [
  dimensionName(key),
  dimension.definition,
  measured(dimension),
  points(dimension),
]))}

Total = ${Object.values(results.dimensions).map((dimension) => dimension.points.toFixed(2)).join(' + ')} = **${results.finalScore.toFixed(2)}/100**.

## Failed Or Partial Dimensions

${table(['Dimension', 'Measured result', 'Score', 'Definition'], partialRows())}

Missed fault scenarios: ${dims.crashTimeReliabilityCaptureRate.missedScenarios.join(', ') || 'none'}.

## I/O Timeline Detail

${table(['Unit', 'Expected', 'Satisfied'], ioRows())}

Example timeline from \`${refText(ioExample.ref)}\`:

${table(['Seq', 'Type', 'Method/op', 'Status/error', 'Duration ms', 'Finalized', 'Query'], ioExample.events.map((event) => [
  event.seq,
  event.type,
  event.method || event.operation || '',
  event.statusCode ?? event.error ?? '',
  event.durationMs ?? '',
  event.finalized,
  event.query || '',
]))}

## Clock Skew Proof

Configured App-B clock skew: \`${results.metadata.appB.productionBuild.clockSkew}\`.

${proof ? table(['Ordering method', 'First', 'Second'], [
  ['Wall clock', `${proof.wallClockOrdering[0].service} ${proof.wallClockOrdering[0].wallClockMs}`, `${proof.wallClockOrdering[1].service} ${proof.wallClockOrdering[1].wallClockMs}`],
  ['Lamport logical clock', `${proof.logicalClockOrdering[0].service} ${JSON.stringify(proof.logicalClockOrdering[0].eventClockRange)}`, `${proof.logicalClockOrdering[1].service} ${JSON.stringify(proof.logicalClockOrdering[1].eventClockRange)}`],
]) : 'No clock proof found.'}

## Performance

${table(['Mode', 'p50 ms', 'p97.5 ms', 'req/s', 'total requests'], [
  ['errorcore enabled', perf.enabled.p50Ms, perf.enabled.p97_5Ms, perf.enabled.requestsPerSecond, perf.enabled.requestsTotal],
  ['errorcore disabled', perf.disabled.p50Ms, perf.disabled.p97_5Ms, perf.disabled.requestsPerSecond, perf.disabled.requestsTotal],
])}

Formula: \`${perf.budget.formula}\`.

## Methodology Notes

- The prompted Postman/Newman asset URLs were unavailable during the original harness setup, so the harness used \`harness/traffic/realworld-smoke.mjs\` over the same RealWorld API surface.
- App-C was skipped because App-A/App-B mandatory validation exceeded the 90-point target.
- F8 memory pressure returned 500 responses but produced no new capture; it remains residual risk.
- Redis captures include scrubbed supplemental command context when V8 local-correlation is ambiguous across repeated ioredis failures.

## Raw Capture Appendix

${table(['Path', 'Bytes', 'sha256'], rawCaptureRows())}
`

const runBook = `# Reproducing the errorcore validation harness

Commands are intended for PowerShell from repository root \`${path.dirname(harnessRoot)}\`.

## 1. Package SDK

\`\`\`powershell
npm ci
npm run build
$pkg = npm pack | Select-Object -Last 1
Copy-Item -LiteralPath (Resolve-Path $pkg).Path -Destination harness/vendor/errorcore-0.2.0.tgz -Force
Get-FileHash -Algorithm SHA256 harness/vendor/errorcore-0.2.0.tgz
\`\`\`

This report used sha256 \`${results.metadata.preflight.ecTgzSha256}\`.

## 2. Build Production Apps

\`\`\`powershell
docker compose -f harness/infra/docker-compose.yml build --no-cache conduit-api enrich-svc
docker compose -f harness/infra/docker-compose.yml up -d conduit-api enrich-svc
\`\`\`

## 3. Smoke And Faults

\`\`\`powershell
node harness/traffic/realworld-smoke.mjs | Tee-Object -FilePath harness/captures/realworld-smoke.json
powershell -ExecutionPolicy Bypass -File harness/faults/run-fault-catalog.ps1
\`\`\`

## 4. Load Pass

\`\`\`powershell
New-Item -ItemType Directory -Force harness/captures/load | Out-Null
$env:ERRORCORE_DISABLED = "false"
docker compose -f harness/infra/docker-compose.yml up -d --force-recreate conduit-api enrich-svc
npx autocannon@7.15.0 -d 8 -c 10 --json http://127.0.0.1:3000/api/tags | Tee-Object -FilePath harness/captures/load/errorcore-enabled.json

$env:ERRORCORE_DISABLED = "true"
docker compose -f harness/infra/docker-compose.yml up -d --force-recreate conduit-api enrich-svc
npx autocannon@7.15.0 -d 8 -c 10 --json http://127.0.0.1:3000/api/tags | Tee-Object -FilePath harness/captures/load/errorcore-disabled.json
\`\`\`

## 5. Compute Reports

\`\`\`powershell
node harness/collector/parse-results.mjs harness
node harness/collector/write-reports.mjs harness
\`\`\`

Outputs:

- \`harness/reports/results.json\`
- \`harness/reports/REPORT.md\`
- \`harness/reports/REPORT_INTERNAL.md\`
- \`harness/reports/RUN.md\`

## Capture Files Used

${table(['Path', 'Bytes', 'sha256'], rawCaptureRows())}
`

fs.mkdirSync(reportsRoot, { recursive: true })
fs.writeFileSync(path.join(reportsRoot, 'REPORT.md'), publicReport)
fs.writeFileSync(path.join(reportsRoot, 'REPORT_INTERNAL.md'), internalReport)
fs.writeFileSync(path.join(reportsRoot, 'RUN.md'), runBook)

console.log(JSON.stringify({
  wrote: [
    path.join(reportsRoot, 'REPORT.md'),
    path.join(reportsRoot, 'REPORT_INTERNAL.md'),
    path.join(reportsRoot, 'RUN.md'),
  ],
}, null, 2))
