const router = require('express').Router()
const http = require('http')
const { URL } = require('url')
const { getTraceHeaders } = require('errorcore')

function postJson(url, body, timeoutMs, extraHeaders) {
  return new Promise(function(resolve, reject) {
    const target = new URL(url)
    const serialized = JSON.stringify(body)
    const request = http.request(
      target,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
          ...extraHeaders,
        },
      },
      function(response) {
        const chunks = []
        response.on('data', function(chunk) {
          chunks.push(chunk)
        })
        response.on('end', function() {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    request.on('timeout', function() {
      request.destroy()
    })
    request.on('error', reject)
    request.end(serialized)
  })
}

async function enrichTags(tags) {
  if (!process.env.ENRICH_URL) {
    return { tags: tags, source: 'local' }
  }

  const timeoutMs = Number(process.env.ENRICH_TIMEOUT_MS || 1500)
  const enrichment = await postJson(
    process.env.ENRICH_URL + '/v1/enrich/tags',
    { tags: tags },
    timeoutMs,
    getTraceHeaders() || {}
  )
  return Object.assign({}, enrichment, { tags: enrichment.tags.map(String) })
}

// return a list of tags
router.get('/', async function(req, res) {
  const tagList = (await req.app.get('sequelize').models.Tag.findAll()).map(tag => tag.name)
  const enrichment = await enrichTags(tagList)
  return res.json({ tags: enrichment.tags || tagList, enrichment: enrichment })
})

module.exports = router
