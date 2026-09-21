import { autoDiscover, manualFind, toSimWord, type ManualHit, type Pair, type SimWord } from './similarity'

type WordInput = { id: string; spelling: string }

export type SimilarityRequest =
  | { taskId: number; kind: 'auto'; words: WordInput[]; p: number; r: number }
  | { taskId: number; kind: 'manual'; words: WordInput[]; queries: WordInput[] }

export type SimilarityResponse =
  | { type: 'progress'; taskId: number; done: number; total: number }
  | { type: 'done'; taskId: number; stats: { before: number; comparisons: number; qualified: number }; pairs: Pair[] }
  | { type: 'manualDone'; taskId: number; comparisons: number; hits: ManualHit[] }
  | { type: 'error'; taskId: number; message: string }

let lastPost = 0

self.onmessage = (event: MessageEvent<SimilarityRequest>) => {
  const request = event.data
  const taskId = request.taskId
  const progress = (done: number, total: number) => {
    const now = Date.now()
    if (now - lastPost >= 100) {
      lastPost = now
      self.postMessage({ type: 'progress', taskId, done, total } satisfies SimilarityResponse)
    }
  }
  try {
    const words = request.words.map(w => toSimWord(w.id, w.spelling))
    if (request.kind === 'manual') {
      const queries = request.queries.map(q => toSimWord(q.id, q.spelling))
      const result = manualFind(words, queries, progress)
      const done: SimilarityResponse = { type: 'manualDone', taskId, comparisons: result.comparisons, hits: result.hits }
      self.postMessage(done)
    } else {
      const result = autoDiscover(words, request.p, request.r, progress)
      const done: SimilarityResponse = { type: 'done', taskId, stats: { before: result.before, comparisons: result.comparisons, qualified: result.qualified }, pairs: result.pairs }
      self.postMessage(done)
    }
  } catch (e) {
    const failure: SimilarityResponse = { type: 'error', taskId, message: (e as Error).message || '相似度计算出错' }
    self.postMessage(failure)
  }
}
