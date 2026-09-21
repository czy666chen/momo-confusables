export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function api<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  let result: ({ error?: string; data?: T } & Partial<T>) | null = null
  try { result = await response.json() as ({ error?: string; data?: T } & Partial<T>) }
  catch { throw new ApiError(response.ok ? '服务器返回了无法识别的数据' : `请求失败（${response.status}）`, response.status) }
  if (!response.ok) throw new ApiError(result.error || '请求失败', response.status)
  return (result.data ?? result) as T
}

export function query<T>(payload: object): Promise<T> {
  return api<T>('query', { operation: 'study', payload })
}

export type MetricName = 'sync_complete' | 'similarity_complete' | 'notepad_pending' | 'dictionary_error'

export function reportMetric(name: MetricName, values: Record<string, number | string | boolean>): void {
  void api('metrics', { name, values }).catch(() => undefined)
}
