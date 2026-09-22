import { autoDiscoverMatches, manualFindMatches, normalizeMatchTypes, toSimWord, type CombinedManualHit, type CombinedPair } from './similarity'
import { mergePronunciations, normalizePronunciationKey, parsePredictionAsset, type PronunciationDictionary } from './pronunciation'
import { createPronunciationLoader } from './pronunciation-loader'

type WordInput = { id: string; spelling: string }

export type SimilarityRequest =
  | { taskId: number; kind: 'auto'; words: WordInput[]; p: number; r: number; matchTypes?: unknown; predictions?: unknown }
  | { taskId: number; kind: 'manual'; words: WordInput[]; queries: WordInput[]; matchTypes?: unknown; pronunciationThreshold?: number; predictions?: unknown }

export type SimilarityResponse =
  | { type: 'progress'; taskId: number; done: number; total: number }
  | { type: 'done'; taskId: number; stats: { before: number; comparisons: number; qualified: number }; pairs: CombinedPair[]; pronunciationError?: string; pronunciationCoverage?: { missingWords: number } }
  | { type: 'manualDone'; taskId: number; comparisons: number; hits: CombinedManualHit[]; pronunciationError?: string; pronunciationCoverage?: { missingWords: number; missingQueries: string[] } }
  | { type: 'error'; taskId: number; message: string }

let lastPost = 0
const loadPronunciations = createPronunciationLoader((url, init) => fetch(new URL(url, self.location.origin), init))

self.onmessage = async (event: MessageEvent<SimilarityRequest>) => {
  const request = event.data
  const taskId = request.taskId
  lastPost = 0
  const progress = (done: number, total: number) => {
    const now = Date.now()
    if (now - lastPost >= 100) {
      lastPost = now
      self.postMessage({ type: 'progress', taskId, done, total } satisfies SimilarityResponse)
    }
  }
  try {
    const matchTypes = normalizeMatchTypes(request.matchTypes)
    let pronunciations: PronunciationDictionary | undefined
    let pronunciationError: string | undefined
    if (matchTypes.includes('pronunciation')) {
      try { pronunciations = await loadPronunciations() }
      catch (error) { pronunciationError = (error as Error).message || 'CMUdict 资源加载失败' }
      if (request.predictions !== undefined) {
        try { pronunciations = mergePronunciations(pronunciations ?? new Map(), parsePredictionAsset(request.predictions).dictionary) }
        catch (error) { pronunciationError = [pronunciationError, (error as Error).message || '预测读音加载失败'].filter(Boolean).join('；') }
      }
    }
    const words = request.words.map(w => toSimWord(w.id, w.spelling))
    if (request.kind === 'manual') {
      const queries = request.queries.map(q => toSimWord(q.id, q.spelling))
      const result = manualFindMatches(words, queries, matchTypes, pronunciations, request.pronunciationThreshold, progress)
      const pronunciationCoverage = pronunciations ? {
        missingWords: words.filter(word => !pronunciations.has(normalizePronunciationKey(word.norm))).length,
        missingQueries: queries.filter(word => !pronunciations.has(normalizePronunciationKey(word.norm))).map(word => word.spelling),
      } : undefined
      const done: SimilarityResponse = { type: 'manualDone', taskId, comparisons: result.comparisons, hits: result.hits, pronunciationError, pronunciationCoverage }
      self.postMessage(done)
    } else {
      const result = autoDiscoverMatches(words, request.p, request.r, matchTypes, pronunciations, progress)
      const pronunciationCoverage = pronunciations ? { missingWords: words.filter(word => !pronunciations.has(normalizePronunciationKey(word.norm))).length } : undefined
      const done: SimilarityResponse = { type: 'done', taskId, stats: { before: result.before, comparisons: result.comparisons, qualified: result.qualified }, pairs: result.pairs, pronunciationError, pronunciationCoverage }
      self.postMessage(done)
    }
  } catch (e) {
    const failure: SimilarityResponse = { type: 'error', taskId, message: (e as Error).message || '相似度计算出错' }
    self.postMessage(failure)
  }
}
