export interface Env {
  SESSIONS: DurableObjectNamespace
  ASSETS: Fetcher
  DICTIONARY?: R2Bucket
  MAIMEMO_API_TOKEN?: string
}

const UPSTREAM = 'https://open.maimemo.com/open/api/v1/memo'
const TTL = 60 * 60 * 1000
const cookieName = 'momo_session'
// 真实账号实测 id 为 `np-` + 64 位 base64url（共 67 字符），上限放宽到 80 仅作防护，不承诺官方格式。
const notepadIdPattern = /^[A-Za-z0-9_-]{1,80}$/
// 官方未给出云词本正文上限；P0 仅实测 8,369 字节。此处是网站自设的保守上限，不是墨墨接口承诺。
const MAX_NOTEPAD_BYTES = 50_000

type UpstreamRequest = { method: string; path: string; body: unknown }

function utf8Length(value: string): number { return new TextEncoder().encode(value).length }

export function normalizeMeaning(value: string): string { return value.replaceAll('\\n', '\n') }

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validNotepadBody(notepad: unknown, allowPublished: boolean): boolean {
  if (!isObject(notepad)) return false
  const keys = Object.keys(notepad)
  if (keys.length !== 5 || keys.some(k => !['status', 'content', 'title', 'brief', 'tags'].includes(k))) return false
  if (notepad.status !== 'UNPUBLISHED' && !(allowPublished && notepad.status === 'PUBLISHED')) return false
  if (typeof notepad.content !== 'string' || !notepad.content.trim() || utf8Length(notepad.content) > MAX_NOTEPAD_BYTES) return false
  if (typeof notepad.title !== 'string' || !notepad.title.trim() || notepad.title.length > 100) return false
  if (typeof notepad.brief !== 'string' || notepad.brief.length > 500) return false
  if (!Array.isArray(notepad.tags) || notepad.tags.length > 10 || notepad.tags.some((t: unknown) => typeof t !== 'string' || t.length > 50)) return false
  return true
}

// 唯一的上游请求构造入口：路由与 Durable Object 各自调用一次，未通过校验的操作不会触达墨墨。
function resolveUpstream(operation: string, payload: unknown): UpstreamRequest | string {
  const value = isObject(payload) ? payload : null
  if (operation === 'study') return validStudy(payload) ? { method: 'POST', path: '/study/query_study_records', body: payload } : '学习记录参数无效'
  if (operation === 'today') return value?.limit === 1000 && Object.keys(value).length === 1 ? { method: 'POST', path: '/study/get_today_items', body: payload } : '今日记录参数无效'
  if (operation === 'vocabulary') return Array.isArray(value?.spellings) && value.spellings.length <= 1000 && !value.ids ? { method: 'POST', path: '/vocabulary/query', body: payload } : '词条参数无效'
  if (operation === 'notepads') {
    // 实测列表接口 limit=11 即 400（P0-RESULTS），固定为 10，只开放 offset 翻页。
    if (!value || Object.keys(value).some(k => k !== 'offset')) return '词本列表参数无效'
    const offset = value.offset ?? 0
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10000) return '词本列表参数无效'
    return { method: 'GET', path: `/notepads?limit=10&offset=${offset}`, body: undefined }
  }
  if (operation === 'notepad') {
    if (!value || Object.keys(value).length !== 1 || !notepadIdPattern.test(String(value.id ?? ''))) return '词本详情参数无效'
    return { method: 'GET', path: `/notepads/${encodeURIComponent(String(value.id))}`, body: undefined }
  }
  if (operation === 'notepad_create') {
    if (!value || Object.keys(value).length !== 1 || !validNotepadBody(value.notepad, false)) return '新建词本参数无效：正文超上限或字段不完整'
    return { method: 'POST', path: '/notepads', body: { notepad: value.notepad } }
  }
  if (operation === 'notepad_update') {
    if (!value || Object.keys(value).length !== 2 || !notepadIdPattern.test(String(value.id ?? '')) || !validNotepadBody(value.notepad, true)) return '更新词本参数无效：正文超上限或字段不完整'
    return { method: 'POST', path: `/notepads/${encodeURIComponent(String(value.id))}`, body: { id: value.id, notepad: value.notepad } }
  }
  return '不支持的请求'
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}

function sessionId(request: Request): string | null {
  const raw = request.headers.get('cookie')?.match(/(?:^|;\s*)momo_session=([a-f0-9]{64})(?:;|$)/)
  return raw?.[1] ?? null
}

function cookie(id: string, secure: boolean): string {
  return `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${secure ? '; Secure' : ''}`
}

function validStudy(body: unknown): boolean {
  if (!isObject(body)) return false
  const keys = Object.keys(body)
  if (keys.some(k => !['as_count', 'limit', 'next_study_date', 'spellings', 'tags'].includes(k))) return false
  if (body.as_count !== undefined && typeof body.as_count !== 'boolean') return false
  if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 1000)) return false
  if (body.tags !== undefined && body.tags !== 'STICKING') return false
  if (body.spellings !== undefined) {
    if (!Array.isArray(body.spellings) || body.spellings.length > 1000 || body.spellings.some((s: unknown) => typeof s !== 'string' || s.length > 200)) return false
    if (body.next_study_date || body.tags) return false
  }
  if (body.next_study_date !== undefined) {
    const d = body.next_study_date
    if (!isObject(d) || typeof d.start !== 'string' || typeof d.end !== 'string' || !Number.isFinite(Date.parse(d.start)) || !Number.isFinite(Date.parse(d.end))) return false
  }
  return true
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // 词典由 ASSETS binding 仅供 Worker 内部读取；外部直连不暴露原始分片。
    if (url.pathname.startsWith('/dictionary/')) return json({ error: '页面不存在' }, 404)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    const origin = request.headers.get('origin')
    // Local dev only: Vite prints http://localhost:5173 while the Worker runs on 127.0.0.1:8787,
    // so the two loopback origins differ. Production hosts never match this branch.
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    const localVite = loopback && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin ?? '')
    if (request.method !== 'GET' && origin !== url.origin && !localVite) return json({ error: '请求来源不匹配' }, 403)
    const id = sessionId(request)
    if (url.pathname === '/api/connect' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as JsonObject | null
      // Loopback-only local dev convenience: use the .dev.vars token so it never passes through the UI.
      const token = body?.useDevToken === true && loopback ? env.MAIMEMO_API_TOKEN : body?.token
      if (typeof token !== 'string' || token.length < 8 || token.length > 4096) return json({ error: body?.useDevToken === true ? '本机 .dev.vars 中没有可用的开发 Token' : '请输入有效 Token' }, 400)
      const newId = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(newId))
      const result = await stub.fetch('https://session.internal/connect', { method: 'POST', body: JSON.stringify({ token }) })
      if (!result.ok) return result
      return json({ connected: true }, 200, { 'set-cookie': cookie(newId, url.protocol === 'https:') })
    }
    if (!id) return json({ error: '未连接或会话已过期' }, 401)
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id))
    if (url.pathname === '/api/disconnect' && request.method === 'POST') {
      await stub.fetch('https://session.internal/disconnect', { method: 'POST' })
      return json({ connected: false }, 200, { 'set-cookie': cookie('', url.protocol === 'https:') + '; Max-Age=0' })
    }
    if (url.pathname === '/api/session' && request.method === 'GET') return stub.fetch('https://session.internal/session')
    if (url.pathname === '/api/meanings' && request.method === 'POST') {
      const active = await stub.fetch('https://session.internal/session')
      if (!active.ok) return active
      const startedAt = Date.now()
      const body = await request.json().catch(() => null) as JsonObject | null
      if (!Array.isArray(body?.spellings) || body.spellings.length > 50 || body.spellings.some((s: unknown) => typeof s !== 'string' || s.length > 200)) return json({ error: '单次最多查询 50 个词' }, 400)
      const shards = new Map<string, string[]>()
      for (const word of body.spellings as string[]) {
        const normalized = word.trim().toLowerCase()
        const key = normalized.charCodeAt(0) >= 97 && normalized.charCodeAt(0) <= 122 ? normalized[0] : '_'
        shards.set(key, [...(shards.get(key) ?? []), normalized])
      }
      const meanings: Record<string, string | null> = {}
      await Promise.all([...shards].map(async ([key, words]) => {
        let lookup: Record<string, string>
        if (env.DICTIONARY) {
          const item = await env.DICTIONARY.get(`ecdict/${key}.json`)
          if (!item) throw new Error('dictionary_missing')
          lookup = await item.json() as Record<string, string>
        } else {
          const asset = await env.ASSETS.fetch(new Request(new URL(`/dictionary/${key}.json`, url)))
          if (!asset.ok) throw new Error('dictionary_missing')
          lookup = await asset.json() as Record<string, string>
        }
        for (const word of words) meanings[word] = lookup[word] ? normalizeMeaning(lookup[word]) : null
      })).catch(() => null)
      if (Object.keys(meanings).length !== new Set((body.spellings as string[]).map(s => s.trim().toLowerCase())).size) {
        console.log(JSON.stringify({ event: 'dictionary_lookup', ok: false, durationMs: Date.now() - startedAt }))
        return json({ error: '词典暂不可用' }, 503)
      }
      console.log(JSON.stringify({ event: 'dictionary_lookup', ok: true, words: body.spellings.length, durationMs: Date.now() - startedAt }))
      return json({ meanings })
    }
    if (url.pathname === '/api/metrics' && request.method === 'POST') {
      const active = await stub.fetch('https://session.internal/session')
      if (!active.ok) return active
      const body = await request.json().catch(() => null) as JsonObject | null
      const names = new Set(['sync_complete', 'similarity_complete', 'notepad_pending', 'dictionary_error'])
      if (!body || typeof body.name !== 'string' || !names.has(body.name) || !isObject(body.values) || Object.keys(body.values).length > 10) return json({ error: '指标参数无效' }, 400)
      const safeValues = Object.fromEntries(Object.entries(body.values).filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean').slice(0, 10))
      console.log(JSON.stringify({ event: 'client_metric', name: body.name, values: safeValues }))
      return json({ accepted: true }, 202)
    }
    if (url.pathname === '/api/query' && request.method === 'POST') {
      const body = await request.json().catch(() => null) as JsonObject | null
      if (!body || typeof body.operation !== 'string') return json({ error: '不支持的请求' }, 400)
      const resolved = resolveUpstream(body.operation, body.payload)
      if (typeof resolved === 'string') return json({ error: resolved }, 400)
      return stub.fetch('https://session.internal/query', { method: 'POST', body: JSON.stringify(body) })
    }
    return json({ error: '页面不存在' }, 404)
  },
}

export class Session {
  private tail: Promise<unknown> = Promise.resolve()
  private ctx: DurableObjectState
  constructor(ctx: DurableObjectState, _env: Env) { this.ctx = ctx }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === '/connect') {
      const { token } = await request.json() as { token: string }
      const checked = await this.upstream(token, 'POST', '/study/query_study_records', { as_count: true })
      if (!checked.ok) return checked
      await this.ctx.storage.put('token', token)
      await this.ctx.storage.put('expires', Date.now() + TTL)
      await this.ctx.storage.put('requests', [Date.now()])
      await this.ctx.storage.setAlarm(Date.now() + TTL)
      return json({ connected: true })
    }
    if (path === '/disconnect') {
      await this.ctx.storage.deleteAll()
      return json({ connected: false })
    }
    const token = await this.ctx.storage.get<string>('token')
    const expires = await this.ctx.storage.get<number>('expires')
    if (!token || !expires || expires < Date.now()) {
      await this.ctx.storage.deleteAll()
      return json({ error: '会话已过期，请重新连接' }, 401)
    }
    if (path === '/session') return json({ connected: true, expires })
    if (path !== '/query') return json({ error: '页面不存在' }, 404)
    const body = await request.json() as { operation: string; payload: unknown }
    const resolved = resolveUpstream(body.operation, body.payload)
    if (typeof resolved === 'string') return json({ error: resolved }, 400)
    const run = this.tail.then(async () => {
      let times = (await this.ctx.storage.get<number[]>('requests') ?? []).filter(t => Date.now() - t < 18000000)
      const limits: [number, number][] = [[20, 10000], [40, 60000], [2000, 18000000]]
      const wait = Math.max(0, ...limits.map(([max, window]) => times.length >= max && times[times.length - max] > Date.now() - window ? times[times.length - max] + window - Date.now() : 0))
      if (wait) await new Promise(resolve => setTimeout(resolve, wait + 100))
      times = times.filter(t => Date.now() - t < 18000000)
      times.push(Date.now())
      await this.ctx.storage.put('requests', times)
      return this.upstream(token, resolved.method, resolved.path, resolved.body)
    })
    this.tail = run.catch(() => undefined)
    return run
  }

  private async upstream(token: string, method: string, path: string, payload: unknown): Promise<Response> {
    const startedAt = Date.now()
    try {
      const response = await fetch(UPSTREAM + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(payload) : undefined })
      const raw = await response.json().catch(() => null) as JsonObject | null
      if (!response.ok || raw?.success === false) {
        console.log(JSON.stringify({ event: 'upstream_request', path, status: response.status, durationMs: Date.now() - startedAt }))
        const message = response.status === 401 ? 'Token 无效或已过期' : response.status === 403 ? '当前 Token 无权读取学习记录' : response.status === 429 ? '墨墨接口限流，请稍后重试' : response.status >= 500 ? '墨墨服务暂不可用' : '墨墨接口返回错误'
        return json({ error: message, code: response.status }, response.status || 502, response.headers.get('retry-after') ? { 'retry-after': response.headers.get('retry-after')! } : {})
      }
      console.log(JSON.stringify({ event: 'upstream_request', path, status: response.status, durationMs: Date.now() - startedAt }))
      return json({ data: raw?.data ?? raw })
    } catch {
      console.log(JSON.stringify({ event: 'upstream_request', path, status: 0, durationMs: Date.now() - startedAt }))
      return json({ error: '墨墨接口连接失败' }, 502)
    }
  }
}
