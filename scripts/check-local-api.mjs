import assert from 'node:assert/strict'

// Live local smoke check: uses the server's .dev.vars credential without exposing it.
// Reads only a study count; no word-list writes. The test's own session is removed.
const origin = new URL(process.argv[2] ?? 'http://localhost:5173').origin
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Only loopback servers are allowed')
let cookie = ''
async function request(path, body) {
  const response = await fetch(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const value = await response.json()
  assert.ok(response.ok, `${path}: HTTP ${response.status}, ${value.error ?? 'API failed'}`)
  return { response, value }
}
try {
  const connected = await request('connect', { useDevToken: true })
  cookie = connected.response.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.ok(cookie, 'Connection must establish a session')
  assert.equal(connected.value.connected, true)
  assert.equal((await request('session')).value.connected, true)
  const result = (await request('query', { operation: 'study', payload: { as_count: true } })).value
  assert.ok(Number.isInteger(result.data?.count) && result.data.count >= 0, 'Study count must come from the live upstream')
  console.log('PASS: local proxy → Worker → Maimemo connection, session and study-count query')
} finally {
  if (cookie) await request('disconnect', {})
}
