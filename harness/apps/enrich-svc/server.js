require('./errorcore-bootstrap')

const { fastifyPlugin, getTraceHeaders } = require('errorcore')
const Fastify = require('fastify')
const Redis = require('ioredis')

const port = Number(process.env.PORT || 3001)
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0'

const app = Fastify({
  logger: process.env.FASTIFY_LOGGER === 'true',
  bodyLimit: 1024 * 1024,
})

app.register(fastifyPlugin())

const redis = new Redis(redisUrl, {
  connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 600),
  commandTimeout: Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 1000),
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
})

function parseTraceId(traceparent) {
  if (typeof traceparent !== 'string') {
    return 'missing'
  }
  const parts = traceparent.split('-')
  return parts.length >= 4 ? parts[1] : 'malformed'
}

function topTagsFromRedisPairs(pairs) {
  const topTags = []
  for (let index = 0; index < pairs.length; index += 2) {
    topTags.push({ tag: pairs[index], score: Number(pairs[index + 1]) })
  }
  return topTags
}

function writeAuditEvent(traceId, receivedTracestate, tags) {
  return redis.xadd(
    'audit:enrich',
    '*',
    'traceId',
    traceId,
    'tracestate',
    receivedTracestate || '',
    'tagCount',
    String(tags.length)
  )
}

app.get('/healthz', async function() {
  await redis.ping()
  return { ok: true, service: 'enrich-svc' }
})

app.post('/v1/enrich/tags', async function(request) {
  const tags = Array.isArray(request.body && request.body.tags) ? request.body.tags.map(String) : []
  const receivedTraceparent = request.headers.traceparent
  const receivedTracestate = request.headers.tracestate
  const traceId = parseTraceId(receivedTraceparent)
  const traceHeaders = getTraceHeaders() || {}

  writeAuditEvent(traceId, receivedTracestate, tags)

  if (redis.status === 'wait') {
    await redis.connect()
  }

  const pipeline = redis.pipeline()
  pipeline.hset('trace:last', {
    traceId: traceId,
    traceparent: receivedTraceparent || '',
    tracestate: receivedTracestate || '',
    receivedAt: new Date().toISOString(),
  })
  for (const tag of tags) {
    pipeline.zincrby('tag:usage', 1, tag)
  }
  await pipeline.exec()

  const topPairs = await redis.zrevrange('tag:usage', 0, 9, 'WITHSCORES')
  return {
    tags: tags,
    topTags: topTagsFromRedisPairs(topPairs),
    source: 'redis',
    receivedTraceparent: receivedTraceparent || null,
    receivedTracestate: receivedTracestate || null,
    egressTraceparent: traceHeaders.traceparent || null,
    egressTracestate: traceHeaders.tracestate || null,
  }
})

app.listen({ host: '0.0.0.0', port: port }, function(err, address) {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log('enrich-svc listening on ' + address)
})
