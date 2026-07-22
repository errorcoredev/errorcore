const baseUrl = process.env.CONDUIT_BASE_URL || 'http://127.0.0.1:3000/api'
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`

async function request(method, path, body, token) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (token) {
    headers.authorization = `Token ${token}`
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { method, path, status: response.status, ok: response.ok, json }
}

function assertOk(result, expected = [200, 201, 204]) {
  if (!expected.includes(result.status)) {
    throw new Error(`${result.method} ${result.path} returned ${result.status}: ${JSON.stringify(result.json)}`)
  }
  return result
}

const userA = {
  username: `ec-a-${suffix}`,
  email: `ec-a-${suffix}@example.com`,
  password: `Password-${suffix}`,
}
const userB = {
  username: `ec-b-${suffix}`,
  email: `ec-b-${suffix}@example.com`,
  password: `Password-${suffix}`,
}

const results = []

results.push(assertOk(await request('POST', '/users', { user: userA }), [200, 201]))
const tokenA = results.at(-1).json.user.token
results.push(assertOk(await request('POST', '/users', { user: userB }), [200, 201]))
const tokenB = results.at(-1).json.user.token
results.push(assertOk(await request('POST', '/users/login', { user: { email: userA.email, password: userA.password } })))
results.push(assertOk(await request('GET', '/user', undefined, tokenA)))
results.push(assertOk(await request('PUT', '/user', { user: { bio: 'validation bio', image: 'https://example.com/image.png' } }, tokenA)))

const articleBody = {
  article: {
    title: `Validation ${suffix}`,
    description: 'errorcore validation article',
    body: 'This article is created by the validation harness.',
    tagList: ['errorcore', 'validation'],
  },
}
results.push(assertOk(await request('POST', '/articles', articleBody, tokenA), [200, 201]))
const slug = results.at(-1).json.article.slug
results.push(assertOk(await request('GET', '/articles')))
results.push(assertOk(await request('GET', `/articles/${slug}`)))
results.push(assertOk(await request('GET', '/tags')))
results.push(assertOk(await request('POST', ` /profiles/${userA.username}/follow`.trim(), undefined, tokenB)))
results.push(assertOk(await request('GET', `/profiles/${userA.username}`, undefined, tokenB)))
results.push(assertOk(await request('GET', '/articles/feed', undefined, tokenB)))
results.push(assertOk(await request('POST', `/articles/${slug}/favorite`, undefined, tokenB)))
results.push(assertOk(await request('DELETE', `/articles/${slug}/favorite`, undefined, tokenB)))
results.push(assertOk(await request('POST', `/articles/${slug}/comments`, { comment: { body: 'validation comment' } }, tokenB), [200, 201]))
const commentId = results.at(-1).json.comment.id
results.push(assertOk(await request('GET', `/articles/${slug}/comments`)))
results.push(assertOk(await request('DELETE', `/articles/${slug}/comments/${commentId}`, undefined, tokenB), [200, 204]))
results.push(assertOk(await request('DELETE', `/profiles/${userA.username}/follow`, undefined, tokenB)))
results.push(assertOk(await request('DELETE', `/articles/${slug}`, undefined, tokenA), [200, 204]))

console.log(JSON.stringify({ suffix, count: results.length, results }, null, 2))
