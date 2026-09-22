import { parsePronunciationAsset, PRONUNCIATION_ASSET_URL, type PronunciationDictionary } from './pronunciation.ts'

// Only the public dictionary is cached. Private supplements are merged per request.
export function createPronunciationLoader(fetchAsset: (url: string, init?: RequestInit) => Promise<Response>) {
  let pending: Promise<PronunciationDictionary> | null = null
  async function read(cache: RequestCache) {
    const response = await fetchAsset(PRONUNCIATION_ASSET_URL, { cache })
    if (!response.ok) throw new Error(`CMUdict 资源加载失败（${response.status}）`)
    return parsePronunciationAsset(await response.json()).dictionary
  }
  return () => {
    if (!pending) {
      pending = read('default').catch(() => read('reload')).catch(error => {
        pending = null
        throw error
      })
    }
    return pending
  }
}
