import { api, query } from './api'

export type RecordRow = { voc_id: string; voc_spelling: string; last_response?: string; study_count?: number; next_study_date?: string; tags?: string[] | string }
export type Coverage = { rows: RecordRow[]; total: number; before: number; after: number; root: number; overflow: number; finished: boolean; syncedAt: string }

const ROW_BATCH = 1000
const MEANING_BATCH = 50
const startDay = Math.floor(Date.UTC(1900, 0, 1) / 86400000)
const endDay = Math.floor(Date.UTC(2200, 0, 1) / 86400000)

function atNoon(day: number): string {
  return new Date(day * 86400000 + 12 * 3600000).toISOString().replace('Z', '+08:00')
}

async function confirmVerified(rows: Map<string, RecordRow>): Promise<boolean> {
  const words = [...new Set([...rows.values()].map(r => r.voc_spelling))]
  const confirmed = new Map<string, RecordRow>()
  for (let i = 0; i < words.length; i += ROW_BATCH) {
    const result = await query<{ records: RecordRow[] }>({ spellings: words.slice(i, i + ROW_BATCH), limit: ROW_BATCH })
    for (const row of result.records) confirmed.set(row.voc_id, row)
  }
  return confirmed.size === rows.size && [...rows].every(([id, row]) => JSON.stringify(confirmed.get(id)) === JSON.stringify(row))
}

export async function fetchMeanings(missing: string[], isLive: () => boolean): Promise<Record<string, string | null> | null> {
  const merged: Record<string, string | null> = {}
  for (let i = 0; i < missing.length; i += MEANING_BATCH) {
    if (!isLive()) return null
    const result = await api<{ meanings: Record<string, string | null> }>('meanings', { spellings: missing.slice(i, i + MEANING_BATCH) })
    Object.assign(merged, result.meanings)
  }
  return merged
}

export async function syncStudyRecords(onProgress: (snapshot: Coverage) => void): Promise<Coverage> {
  const before = (await query<{ count: number }>({ as_count: true })).count
  const rows = new Map<string, RecordRow>()
  const root = (await query<{ count: number }>({ as_count: true, next_study_date: { start: atNoon(startDay), end: atNoon(endDay) } })).count
  const queue: [number, number, number][] = [[startDay, endDay, root]]
  let overflow = 0
  let processed = 0
  let valid = true
  while (queue.length) {
    const [a, b, n] = queue.shift()!
    if (!n) continue
    if (n <= ROW_BATCH || a === b) {
      const response = await query<{ records: RecordRow[] }>({ limit: ROW_BATCH, next_study_date: { start: atNoon(a), end: atNoon(b) } })
      if (!Array.isArray(response.records)) throw new Error('学习记录响应格式异常')
      for (const row of response.records) if (row.voc_id && row.voc_spelling) rows.set(row.voc_id, row)
      if (response.records.length !== n) {
        if (a === b && n > ROW_BATCH && response.records.length === ROW_BATCH) overflow += n - ROW_BATCH
        else valid = false
      }
    } else {
      const mid = a + Math.floor((b - a) / 2)
      const left = (await query<{ count: number }>({ as_count: true, next_study_date: { start: atNoon(a), end: atNoon(mid) } })).count
      const right = (await query<{ count: number }>({ as_count: true, next_study_date: { start: atNoon(mid + 1), end: atNoon(b) } })).count
      if (left + right !== n) throw new Error('日期分区计数不一致，已停止同步')
      queue.push([a, mid, left], [mid + 1, b, right])
    }
    processed++
    onProgress({ rows: [...rows.values()], total: before, before, after: before, root, overflow, finished: false, syncedAt: new Date().toISOString() })
    if (processed > 300) throw new Error('达到同步请求预算，已停止同步')
  }
  const after = (await query<{ count: number }>({ as_count: true })).count
  let verified = false
  if (valid && before === after && root === before && rows.size === before && overflow === 0) verified = await confirmVerified(rows)
  return { rows: [...rows.values()], total: after, before, after, root, overflow, finished: verified, syncedAt: new Date().toISOString() }
}

export async function supplementRecords(data: Coverage, words: string[], onProgress: (done: number, total: number, snapshot: Coverage) => void): Promise<Coverage> {
  const rows = new Map(data.rows.map(r => [r.voc_id, r]))
  for (let i = 0; i < words.length; i += ROW_BATCH) {
    const batch = words.slice(i, i + ROW_BATCH)
    const result = await query<{ records: RecordRow[] }>({ spellings: batch, limit: ROW_BATCH })
    const wanted = new Set(batch.map(w => w.toLowerCase()))
    if (!Array.isArray(result.records) || result.records.some(r => !wanted.has(r.voc_spelling.toLowerCase()))) throw new Error('候选查询结果超出输入范围，已停止补齐')
    for (const row of result.records) rows.set(row.voc_id, row)
    const done = Math.min(i + ROW_BATCH, words.length)
    onProgress(done, words.length, { ...data, rows: [...rows.values()], overflow: Math.max(0, data.total - rows.size), finished: false })
  }
  const after = (await query<{ count: number }>({ as_count: true })).count
  const verified = data.before === after && data.root === after && rows.size === after ? await confirmVerified(rows) : false
  return { ...data, rows: [...rows.values()], total: after, after, overflow: Math.max(0, after - rows.size), finished: verified, syncedAt: new Date().toISOString() }
}
