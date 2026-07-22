import { readAllCaptures } from './decode-captures.mjs'

const root = process.argv[2] || 'harness/captures'
const records = readAllCaptures(root)

for (const record of records) {
  const pkg = record.package
  console.log(
    JSON.stringify({
      file: record.file,
      line: record.line,
      service: pkg.service,
      eventId: pkg.eventId,
      errorType: pkg.error?.type,
      errorMessage: pkg.error?.message,
      traceId: pkg.trace?.traceId,
      spanId: pkg.trace?.spanId,
      parentSpanId: pkg.trace?.parentSpanId,
      tracestate: pkg.trace?.tracestate,
      isEntrySpan: pkg.trace?.isEntrySpan,
      wallClockMs: pkg.timeAnchor?.wallClockMs,
      errorEventSeq: pkg.errorEventSeq,
      eventClockRange: pkg.eventClockRange,
      request: pkg.request && {
        method: pkg.request.method,
        url: pkg.request.url,
      },
      ioTimelineCount: pkg.ioTimeline?.length || 0,
    })
  )
}
