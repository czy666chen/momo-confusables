import assert from 'node:assert/strict'
import worker, { Session, normalizeMeaning } from '../worker/index.ts'

const storage = (initial = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async get(key) { return values.get(key) },
    async put(key, value) { values.set(key, value) },
    async deleteAll() { values.clear() },
    async setAlarm(value) { values.set('alarm', value) },
  }
}

let passed = 0
async function ok(name, fn) { await fn(); passed++; console.log('  ✓', name) }

console.log('Worker 边界测试')

await ok('词典字面换行转为真实换行', () => {
  assert.equal(normalizeMeaning('名词\\n动词'), '名词\n动词')
  assert.equal(normalizeMeaning('单行释义'), '单行释义')
})

await ok('过期会话返回 401 并清除存储', async () => {
  const state = storage({ token: 'secret-token', expires: Date.now() - 1, requests: [Date.now()] })
  const response = await new Session({ storage: state }, {}).fetch(new Request('https://session.internal/session'))
  assert.equal(response.status, 401)
  assert.equal(state.values.size, 0)
})

await ok('Alarm 清除会话存储', async () => {
  const state = storage({ token: 'secret-token', expires: Date.now() + 60_000 })
  await new Session({ storage: state }, {}).alarm()
  assert.equal(state.values.size, 0)
})

await ok('跨站写请求在路由入口返回 403', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/connect', {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-real-token' }),
  }), {})
  assert.equal(response.status, 403)
})

await ok('原始词典分片不能被公网直连', async () => {
  const response = await worker.fetch(new Request('https://example.com/dictionary/a.json'), { ASSETS: { fetch: async () => new Response('{}') } })
  assert.equal(response.status, 404)
})

await ok('上游 403 映射为明确错误且不保存 Token', async () => {
  const state = storage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false }), { status: 403, headers: { 'content-type': 'application/json' } })
  try {
    const response = await new Session({ storage: state }, {}).fetch(new Request('https://session.internal/connect', {
      method: 'POST', body: JSON.stringify({ token: 'not-a-real-token' }),
    }))
    assert.equal(response.status, 403)
    assert.equal((await response.json()).error, '当前 Token 无权读取学习记录')
    assert.equal(state.values.has('token'), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`\n全部通过：${passed} 组`)
