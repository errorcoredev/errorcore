import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readAllCaptures, readCaptureFile } from './decode-captures.mjs'

const harnessRoot = path.resolve(process.argv[2] || 'harness')
const capturesRoot = path.join(harnessRoot, 'captures')
const reportsRoot = path.join(harnessRoot, 'reports')

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) {
    return fallback
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function rel(file) {
  return path.relative(harnessRoot, file).replaceAll(path.sep, '/')
}

function round(value, places = 2) {
  return Number(value.toFixed(places))
}

function ratioScore(numerator, denominator, points) {
  if (!denominator) {
    return { numerator, denominator, ratio: 0, points: 0, maxPoints: points }
  }
  const ratio = numerator / denominator
  return { numerator, denominator, ratio: round(ratio, 4), points: round(ratio * points), maxPoints: points }
}

function parseAutocannonOutput(file) {
  const buffer = fs.readFileSync(file)
  const utf8Text = buffer.toString('utf8')
  const text = utf8Text.includes('\u0000') ? buffer.toString('utf16le') : utf8Text
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return JSON.parse(trimmed)
    }
  }
  throw new Error(`no JSON autocannon summary found in ${file}`)
}

function captureRef(record) {
  return {
    service: record.package.service,
    file: rel(record.file),
    line: record.line,
    eventId: record.package.eventId,
    errorType: record.package.error?.type || null,
    errorMessage: record.package.error?.message || null,
    traceId: record.package.trace?.traceId || null,
    spanId: record.package.trace?.spanId || null,
    parentSpanId: record.package.trace?.parentSpanId || null,
  }
}

function hasHeaderMeta(headers, name) {
  return Boolean(headers && Object.prototype.hasOwnProperty.call(headers, name))
}

function isFinalized(event) {
  return event.endTime !== null && event.endTime !== undefined && typeof event.durationMs === 'number'
}

function localVariableEntries(pkg) {
  const candidates = [pkg.localVariables, pkg.locals, pkg.error?.localVariables, pkg.error?.locals]
  for (const value of candidates) {
    if (!value) {
      continue
    }
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        if (entry && typeof entry === 'object' && entry.locals && typeof entry.locals === 'object') {
          return Object.keys(entry.locals).map((name) => ({ name, entry: entry.locals[name] }))
        }
        return [entry]
      })
    }
    if (typeof value === 'object') {
      return Object.entries(value).map(([name, entry]) => ({ name, entry }))
    }
  }
  return []
}

function localName(entry) {
  return entry?.name || entry?.key || (Array.isArray(entry) ? entry[0] : null)
}

function looksOriginalLocalName(name) {
  return typeof name === 'string' && !/^[A-Za-z_$]$/.test(name)
}

function hasOriginalLocals(pkg) {
  const entries = localVariableEntries(pkg)
  return entries.length > 0 && entries.some((entry) => looksOriginalLocalName(localName(entry)))
}

function hasResolvedOriginalFrame(pkg) {
  const frame = pkg.errorOrigin?.appBoundaryFrame
  if (!frame) {
    return false
  }
  const filePath = frame.filePath || ''
  if (filePath.includes('/dist/server.js') || filePath.includes('\\dist\\server.js')) {
    return false
  }
  const normalizedPath = filePath.replaceAll('\\', '/')
  if (
    !normalizedPath.startsWith('node:') &&
    !normalizedPath.includes('/node_modules/') &&
    /\.(?:js|mjs|cjs|ts|tsx|jsx)$/.test(normalizedPath)
  ) {
    return true
  }
  const functionName = frame.functionName || ''
  return !/^[A-Za-z_$][\w$]{0,2}$/.test(functionName)
}

function pgTimelineSatisfied(pkg) {
  return (pkg.ioTimeline || []).some((event) => {
    if (event.type !== 'db-query' || !isFinalized(event)) {
      return false
    }
    const target = String(event.target || '').toLowerCase()
    const method = String(event.method || '').toLowerCase()
    return Boolean(event.dbMeta?.query) ||
      target.startsWith('postgres://') ||
      method === 'connect' ||
      method === 'acquire'
  })
}

function httpClientTimelineSatisfied(pkg) {
  return (pkg.ioTimeline || []).some((event) => {
    if (event.type !== 'http-client' && event.type !== 'undici') {
      return false
    }
    return event.method && event.url && isFinalized(event) && (event.statusCode !== null || event.error)
  })
}

function redisTimelineSatisfied(pkg) {
  return (pkg.ioTimeline || []).some((event) => {
    const type = String(event.type || '').toLowerCase()
    const target = String(event.target || '').toLowerCase()
    const method = String(event.method || '').toLowerCase()
    const query = String(event.dbMeta?.query || '').toLowerCase()
    return isFinalized(event) && (
      type.includes('redis') ||
      type.includes('ioredis') ||
      type.includes('cache') ||
      target.startsWith('redis://') ||
      /^(get|set|del|exists|expire|ping|hget|hset|hmset|zincrby|zrevrange|xadd|xread|auth|hello)\b/.test(method) ||
      /^(get|set|del|exists|expire|ping|hget|hset|hmset|zincrby|zrevrange|xadd|xread|auth|hello)\b/.test(query)
    )
  })
}

const mainCaptureFiles = [
  path.join(capturesRoot, 'conduit-api', 'events.ndjson'),
  path.join(capturesRoot, 'enrich-svc', 'events.ndjson'),
]

const records = mainCaptureFiles.flatMap((file) => readCaptureFile(file))
const allCapturedRecords = readAllCaptures(capturesRoot)
const recordsByService = Object.groupBy(records, (record) => record.package.service)

const faultCheckpoint = readJson(path.join(harnessRoot, 'checkpoints', '05-faults.json'), { scenarios: [] })
const preflight = readJson(path.join(harnessRoot, 'checkpoints', '01-preflight.json'), {})
const appA = readJson(path.join(harnessRoot, 'checkpoints', '03-app-a.json'), {})
const trafficSmoke = readJson(path.join(harnessRoot, 'checkpoints', 'traffic-smoke.json'), {})
const trafficAssets = readJson(path.join(harnessRoot, 'checkpoints', 'traffic-assets.json'), {})
const loadCheckpoint = readJson(path.join(harnessRoot, 'checkpoints', 'load-overhead.json'), {})

const faultScenarios = faultCheckpoint.scenarios.map((scenario) => {
  const refs = []
  for (const service of ['conduit-api', 'enrich-svc']) {
    const before = scenario.beforeLineCounts?.[service] || 0
    const after = scenario.afterLineCounts?.[service] || 0
    for (const record of recordsByService[service] || []) {
      if (record.line > before && record.line <= after) {
        refs.push(captureRef(record))
      }
    }
  }
  return {
    scenario: scenario.scenario,
    label: scenario.label,
    fault: scenario.fault,
    endpoint: scenario.endpoint,
    requestsIssued: scenario.requestsIssued,
    newCaptures: scenario.newCaptures,
    captured: refs.length > 0,
    captureRefs: refs,
  }
})

const localsOk = records.filter((record) => hasOriginalLocals(record.package))
const localsScore = ratioScore(localsOk.length, records.length, 20)

const appFrameCandidates = records.filter((record) => record.package.errorOrigin?.appBoundaryFrame)
const sourceMapResolved = appFrameCandidates.filter((record) => hasResolvedOriginalFrame(record.package))
const sourceMapScore = ratioScore(sourceMapResolved.length, appFrameCandidates.length, 15)

const traceGroups = Object.groupBy(
  records.filter((record) => record.package.trace?.traceId),
  (record) => record.package.trace.traceId,
)

const crossServiceGroups = []
for (const [traceId, group] of Object.entries(traceGroups)) {
  const conduitRecords = group.filter((record) => record.package.service === 'conduit-api')
  const enrichRecords = group.filter((record) => record.package.service === 'enrich-svc')
  if (!conduitRecords.length || !enrichRecords.length) {
    continue
  }
  let validPair = null
  for (const a of conduitRecords) {
    for (const b of enrichRecords) {
      const aEgress = (a.package.ioTimeline || []).find((event) => {
        return (event.type === 'http-client' || event.type === 'undici') &&
          hasHeaderMeta(event.requestHeaders, 'traceparent') &&
          hasHeaderMeta(event.requestHeaders, 'tracestate')
      })
      const bIngressHeaders = b.package.request?.headers || {}
      const parentMatches = b.package.trace?.parentSpanId === a.package.trace?.spanId
      const bReceivedTraceHeaders = hasHeaderMeta(bIngressHeaders, 'traceparent') &&
        hasHeaderMeta(bIngressHeaders, 'tracestate')
      const vendorClockPresent = String(b.package.trace?.tracestate || '').includes('ec=')
      if (parentMatches && aEgress && bReceivedTraceHeaders && vendorClockPresent) {
        validPair = { a, b }
        break
      }
    }
    if (validPair) {
      break
    }
  }
  crossServiceGroups.push({
    traceId,
    valid: Boolean(validPair),
    conduit: conduitRecords.map(captureRef),
    enrich: enrichRecords.map(captureRef),
    proof: validPair && {
      conduit: captureRef(validPair.a),
      enrich: captureRef(validPair.b),
      conduitWallClockMs: validPair.a.package.timeAnchor?.wallClockMs,
      enrichWallClockMs: validPair.b.package.timeAnchor?.wallClockMs,
      conduitClockRange: validPair.a.package.eventClockRange,
      enrichClockRange: validPair.b.package.eventClockRange,
      conduitTracestate: validPair.a.package.trace?.tracestate,
      enrichTracestate: validPair.b.package.trace?.tracestate,
    },
  })
}
const crossServiceScore = ratioScore(crossServiceGroups.filter((group) => group.valid).length, crossServiceGroups.length, 15)

const logicalClockProofs = crossServiceGroups
  .filter((group) => group.valid && group.proof)
  .filter((group) => {
    const proof = group.proof
    return proof.enrichWallClockMs < proof.conduitWallClockMs &&
      proof.enrichClockRange?.min > proof.conduitClockRange?.max
  })
  .map((group) => {
    const proof = group.proof
    return {
      traceId: group.traceId,
      wallClockOrdering: [
        { service: 'enrich-svc', wallClockMs: proof.enrichWallClockMs, note: 'appears first by wall clock' },
        { service: 'conduit-api', wallClockMs: proof.conduitWallClockMs, note: 'appears second by wall clock' },
      ],
      logicalClockOrdering: [
        { service: 'conduit-api', eventClockRange: proof.conduitClockRange, note: 'causal caller' },
        { service: 'enrich-svc', eventClockRange: proof.enrichClockRange, note: 'causal callee' },
      ],
      wallClockSkewMs: proof.enrichWallClockMs - proof.conduitWallClockMs,
      conduitRef: proof.conduit,
      enrichRef: proof.enrich,
    }
  })
const logicalClockScore = {
  numerator: logicalClockProofs.length > 0 ? 1 : 0,
  denominator: 1,
  ratio: logicalClockProofs.length > 0 ? 1 : 0,
  points: logicalClockProofs.length > 0 ? 10 : 0,
  maxPoints: 10,
}

const requestContextOk = records.filter((record) => {
  const request = record.package.request
  return request?.method && request?.url && request?.headers && record.package.trace?.traceId
})
const requestContextScore = ratioScore(requestContextOk.length, records.length, 10)

const conduitRecords = records.filter((record) => record.package.service === 'conduit-api')
const enrichRecords = records.filter((record) => record.package.service === 'enrich-svc')
const pgSatisfied = conduitRecords.filter((record) => pgTimelineSatisfied(record.package))
const httpExpected = conduitRecords.filter((record) => {
  return (record.package.ioTimeline || []).some((event) => event.type === 'http-client' || event.type === 'undici')
})
const httpSatisfied = httpExpected.filter((record) => httpClientTimelineSatisfied(record.package))
const redisSatisfied = enrichRecords.filter((record) => redisTimelineSatisfied(record.package))
const ioUnits = [
  { name: 'pg queries on App-A DB-touching captures', expected: conduitRecords.length, satisfied: pgSatisfied.length },
  { name: 'HTTP client A-to-B egress captures', expected: httpExpected.length, satisfied: httpSatisfied.length },
  { name: 'ioredis operations on App-B Redis captures', expected: enrichRecords.length, satisfied: redisSatisfied.length },
]
const ioExpected = ioUnits.reduce((sum, unit) => sum + unit.expected, 0)
const ioSatisfied = ioUnits.reduce((sum, unit) => sum + unit.satisfied, 0)
const ioTimelineScore = ratioScore(ioSatisfied, ioExpected, 15)

const piiNeedles = [
  'F7_TOKEN_SHOULD_NOT_LEAK',
  'F7_PASSWORD_SHOULD_NOT_LEAK',
  'f7.person@example.com',
]
const piiLeaks = []
for (const record of allCapturedRecords) {
  const decoded = JSON.stringify(record.package)
  for (const needle of piiNeedles) {
    if (decoded.includes(needle)) {
      piiLeaks.push({ needle, ...captureRef(record) })
    }
  }
}
const piiPenaltyPerLeak = 2
const piiScore = {
  leaks: piiLeaks.length,
  scannedCaptureRecords: allCapturedRecords.length,
  needles: piiNeedles,
  penaltyPerLeak: piiPenaltyPerLeak,
  points: Math.max(0, 8 - piiLeaks.length * piiPenaltyPerLeak),
  maxPoints: 8,
  leakRefs: piiLeaks,
}

const capturedScenarios = faultScenarios.filter((scenario) => scenario.captured)
const captureRateScore = ratioScore(capturedScenarios.length, faultScenarios.length, 5)

const loadEnabledFile = loadCheckpoint.enabled ? path.resolve(loadCheckpoint.enabled) : path.join(capturesRoot, 'load', 'errorcore-enabled.json')
const loadDisabledFile = loadCheckpoint.disabled ? path.resolve(loadCheckpoint.disabled) : path.join(capturesRoot, 'load', 'errorcore-disabled.json')
const loadEnabled = fs.existsSync(loadEnabledFile) ? parseAutocannonOutput(loadEnabledFile) : null
const loadDisabled = fs.existsSync(loadDisabledFile) ? parseAutocannonOutput(loadDisabledFile) : null
let performanceScore = {
  points: 0,
  maxPoints: 2,
  reason: 'load outputs unavailable',
}
if (loadEnabled && loadDisabled) {
  const p975DeltaMs = loadEnabled.latency.p97_5 - loadDisabled.latency.p97_5
  const p50DeltaMs = loadEnabled.latency.p50 - loadDisabled.latency.p50
  const throughputRatio = loadEnabled.requests.average / loadDisabled.requests.average
  const latencyBudgetMs = 20
  const minimumThroughputRatioForFullCredit = 0.9
  const latencyComponent = Math.min(1, latencyBudgetMs / Math.max(p975DeltaMs, 0.001))
  const throughputComponent = Math.min(1, throughputRatio / minimumThroughputRatioForFullCredit)
  performanceScore = {
    enabled: {
      file: rel(loadEnabledFile),
      p50Ms: loadEnabled.latency.p50,
      p97_5Ms: loadEnabled.latency.p97_5,
      requestsPerSecond: loadEnabled.requests.average,
      requestsTotal: loadEnabled.requests.total,
    },
    disabled: {
      file: rel(loadDisabledFile),
      p50Ms: loadDisabled.latency.p50,
      p97_5Ms: loadDisabled.latency.p97_5,
      requestsPerSecond: loadDisabled.requests.average,
      requestsTotal: loadDisabled.requests.total,
    },
    p50DeltaMs,
    p97_5DeltaMs: p975DeltaMs,
    throughputRatio: round(throughputRatio, 4),
    budget: {
      latencyPercentile: 'p97.5',
      fullCreditDeltaMs: latencyBudgetMs,
      fullCreditThroughputRatio: minimumThroughputRatioForFullCredit,
      formula: '2 * min(1, 20 / p97.5_delta_ms) * min(1, enabled_rps / (disabled_rps * 0.9))',
    },
    points: round(2 * latencyComponent * throughputComponent),
    maxPoints: 2,
  }
}

const dimensions = {
  localsCaptureQuality: {
    ...localsScore,
    definition: 'records with at least one captured local variable whose name is not a single-letter minified identifier / all scored captures * 20',
    passingRefs: localsOk.map(captureRef),
  },
  sourceMapUnminification: {
    ...sourceMapScore,
    definition: 'app-boundary top frames resolved away from /app/dist/server.js into original source files/functions / app-boundary frame candidates * 15',
    passingRefs: sourceMapResolved.map(captureRef),
  },
  crossServiceCorrelation: {
    ...crossServiceScore,
    definition: 'trace groups containing both services with matching parent span and traceparent/tracestate metadata across A egress and B ingress / all cross-service trace groups * 15',
    groups: crossServiceGroups,
  },
  ioTimelineCompleteness: {
    ...ioTimelineScore,
    definition: 'satisfied pg + A-to-B HTTP + ioredis timeline units / expected units * 15; satisfied means operation/op, timing, outcome, and finalized end time were present',
    units: ioUnits,
  },
  logicalClockOrderingUnderSkew: {
    ...logicalClockScore,
    definition: 'full credit when at least one A-to-B capture proves wall-clock order is wrong while eventClockRange order preserves causal order',
    proofs: logicalClockProofs,
  },
  requestContextAttribution: {
    ...requestContextScore,
    definition: 'captures with method, URL, scrubbed headers, and trace correlation / all scored captures * 10',
  },
  piiScrubbing: {
    ...piiScore,
    definition: '8 points minus 2 points per raw hostile-traffic token/password/email leak in decoded capture payloads, floored at 0',
  },
  crashTimeReliabilityCaptureRate: {
    ...captureRateScore,
    definition: 'fault scenarios with at least one new capture / total fault scenarios * 5',
    capturedScenarios: capturedScenarios.map((scenario) => scenario.scenario),
    missedScenarios: faultScenarios.filter((scenario) => !scenario.captured).map((scenario) => scenario.scenario),
  },
  performanceOverhead: performanceScore,
}

const finalScore = round(Object.values(dimensions).reduce((sum, dimension) => sum + dimension.points, 0))

const rawCaptureFiles = []
function collectNdjsonFiles(dir) {
  if (!fs.existsSync(dir)) {
    return
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectNdjsonFiles(full)
    } else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
      rawCaptureFiles.push({
        path: full,
        relativePath: rel(full),
        bytes: fs.statSync(full).size,
        sha256: sha256(full),
      })
    }
  }
}
collectNdjsonFiles(capturesRoot)
rawCaptureFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

const results = {
  generatedAt: new Date().toISOString(),
  harnessRoot,
  finalScore,
  maxScore: 100,
  summary: {
    scoredCaptureCount: records.length,
    allDecodedCaptureCountForPiiScan: allCapturedRecords.length,
    services: Object.fromEntries(Object.entries(recordsByService).map(([service, group]) => [service, group.length])),
    faultScenariosCaptured: `${capturedScenarios.length}/${faultScenarios.length}`,
    appCNextStore: 'skipped',
  },
  metadata: {
    preflight,
    appA,
    trafficSmoke,
    trafficAssets,
    appB: {
      provenance: 'local Fastify service assembled for this harness from a standard production Fastify layout; uses real ioredis reads/writes and public errorcore Fastify plugin',
      productionBuild: {
        entry: 'server.js',
        bundle: 'harness/apps/enrich-svc/dist/server.js',
        sourceMap: 'harness/apps/enrich-svc/dist/server.js.map',
        esbuild: '0.25.12',
        clockSkew: 'FAKETIME=-45s with libfaketime LD_PRELOAD in enrich-svc container',
      },
    },
  },
  faultScenarios,
  dimensions,
  examples: {
    minifiedFrameUnresolved: appFrameCandidates[0] && {
      ref: captureRef(appFrameCandidates[0]),
      appBoundaryFrame: appFrameCandidates[0].package.errorOrigin.appBoundaryFrame,
      stackExcerpt: String(appFrameCandidates[0].package.error?.stack || '').split('\n').slice(0, 3),
    },
    ioTimeline: records.find((record) => (record.package.ioTimeline || []).some((event) => event.type === 'db-query' && event.type !== 'http-server')) && {
      ref: captureRef(records.find((record) => (record.package.ioTimeline || []).some((event) => event.type === 'db-query'))),
      events: records
        .find((record) => (record.package.ioTimeline || []).some((event) => event.type === 'db-query'))
        .package.ioTimeline.map((event) => ({
          seq: event.seq,
          type: event.type,
          method: event.method || null,
          url: event.url || null,
          operation: event.operation || null,
          statusCode: event.statusCode,
          error: event.error?.message || event.error || null,
          durationMs: event.durationMs,
          finalized: isFinalized(event),
          query: event.dbMeta?.query || null,
        })),
    },
    piiScrubbedUrl: records.find((record) => record.package.request?.url?.includes('%5BREDACTED%5D')) && {
      ref: captureRef(records.find((record) => record.package.request?.url?.includes('%5BREDACTED%5D'))),
      url: records.find((record) => record.package.request?.url?.includes('%5BREDACTED%5D')).package.request.url,
    },
  },
  rawCaptureAppendix: rawCaptureFiles,
}

fs.mkdirSync(reportsRoot, { recursive: true })
fs.writeFileSync(path.join(reportsRoot, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
console.log(JSON.stringify({ finalScore, results: path.join(reportsRoot, 'results.json') }, null, 2))
