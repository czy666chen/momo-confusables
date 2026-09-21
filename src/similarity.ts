// 拼写相似度：受限 Damerau–Levenshtein（Optimal String Alignment）。
// 长度与距离统一使用 Unicode 码点单位（Array.from），不混用 UTF-16 长度。

export type SimWord = {
  id: string
  spelling: string
  norm: string
  cp: string[]
}

export type Pair = {
  aId: string
  bId: string
  aSpelling: string
  bSpelling: string
  distance: number
  similarity: number
  matchType: 'edit' | 'block-swap'
}

export type DiscoveryResult = {
  pairs: Pair[]
  before: number
  comparisons: number
  qualified: number
}

export function normalize(word: string): string {
  return word.normalize('NFKC').trim().toLowerCase()
}

export function toSimWord(id: string, spelling: string): SimWord {
  const norm = normalize(spelling)
  return { id, spelling, norm, cp: Array.from(norm) }
}

// 阈值 t = p / r 用整数比例表达；允许编辑次数 k = floor((r - p) × M / r)。
function allowedDistance(p: number, r: number, M: number): number {
  return Math.floor(((r - p) * M) / r)
}

// 达标判定 (M - distance) × r >= p × M，交叉相乘避免浮点。
function qualifies(p: number, r: number, M: number, distance: number): boolean {
  return (M - distance) * r >= p * M
}

// 朴素 OSA：完整动态规划矩阵。作为正确性基准与手动模式距离。
export function osaNaive(a: string[], b: string[]): number {
  const n = a.length
  const m = b.length
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1)
    for (let j = 0; j <= m; j++) row[j] = i === 0 ? j : j === 0 ? i : 0
    return row
  })
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + 1)
      }
      d[i][j] = best
    }
  }
  return d[n][m]
}

// 带状 OSA：只计算动态规划矩阵内 abs(i - j) <= k 的区域，保留 i-2, j-2 相邻调换转移。
// 带外与未写入位置按不可达（Infinity 基线）处理；返回精确距离（<= k）或超阈值状态（null）。
export function osaBanded(a: string[], b: string[], k: number): number | null {
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > k) return null
  const INF = k + 1
  // 行 0：d[0][j] = j，仅带内 [0, min(m, k)] 有效，其余视为不可达。
  let prev2: number[] | null = null
  let prev: number[] = new Array(m + 1).fill(INF)
  for (let j = 0; j <= Math.min(m, k); j++) prev[j] = j
  if (n === 0) return prev[m] <= k ? prev[m] : null
  for (let i = 1; i <= n; i++) {
    const cur: number[] = new Array(m + 1).fill(INF)
    if (i <= k) cur[0] = i
    const lo = Math.max(1, i - k)
    const hi = Math.min(m, i + k)
    const bandLo2 = i - 2 >= 0 ? Math.max(0, i - 2 - k) : -1
    const bandHi2 = i - 2 >= 0 ? Math.min(m, i - 2 + k) : -1
    const ai = a[i - 1]
    const aiPrev = i >= 2 ? a[i - 2] : ''
    const canTranspose = i >= 2
    for (let j = lo; j <= hi; j++) {
      const cost = ai === b[j - 1] ? 0 : 1
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (canTranspose && j >= 2 && ai === b[j - 2] && aiPrev === b[j - 1] && prev2) {
        // d[i-2][j-2]；带外读作不可达，用行 i-2 的实际带界判定。
        if (j - 2 >= bandLo2 && j - 2 <= bandHi2) best = Math.min(best, prev2[j - 2] + 1)
      }
      cur[j] = best
    }
    prev2 = prev
    prev = cur
  }
  const value = prev[m]
  return value <= k ? value : null
}

function cmpStr(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0
}

const MIN_BLOCK_LENGTH = 3

// 识别两个完整词块换序：XY ↔ YX。限制每块至少 3 个码点，避免短轮换造成大量误报。
export function isBlockSwap(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length < MIN_BLOCK_LENGTH * 2) return false
  for (let split = MIN_BLOCK_LENGTH; split <= a.length - MIN_BLOCK_LENGTH; split++) {
    let matches = true
    for (let i = 0; i < a.length; i++) {
      if (a[(i + split) % a.length] !== b[i]) { matches = false; break }
    }
    if (matches) return true
  }
  return false
}

// 稳定降序：先比未取整的分数（交叉相乘），同分按标准化拼写、ID 排序。
function compareInternal(x: Collected, y: Collected): number {
  if (x.matchType !== y.matchType) return x.matchType === 'block-swap' ? -1 : 1
  const sx = (x.M - x.distance) * y.M
  const sy = (y.M - y.distance) * x.M
  if (sx !== sy) return sy - sx
  return cmpStr(x.a.norm, y.a.norm) || cmpStr(x.b.norm, y.b.norm) || cmpStr(x.a.id, y.a.id) || cmpStr(x.b.id, y.b.id)
}

function toPair(t: Collected): Pair {
  return {
    aId: t.a.id,
    bId: t.b.id,
    aSpelling: t.a.spelling,
    bSpelling: t.b.spelling,
    distance: t.distance,
    similarity: 1 - t.distance / t.M,
    matchType: t.matchType,
  }
}

type Collected = { a: SimWord; b: SimWord; distance: number; M: number; matchType: Pair['matchType'] }

// 词对方向规范化：按 (标准化拼写, ID) 定序，使枚举顺序不同的实现产出一致结果。
function orient(x: SimWord, y: SimWord, distance: number, M: number, matchType: Pair['matchType']): Collected {
  const first = cmpStr(x.norm, y.norm) || cmpStr(x.id, y.id)
  const [a, b] = first <= 0 ? [x, y] : [y, x]
  return { a, b, distance, M, matchType }
}

// 自动发现（首版实现）：长度分桶 + 整数阈值换算 + 带状 OSA。
export function autoDiscover(words: SimWord[], p: number, r: number, onProgress?: (done: number, total: number) => void): DiscoveryResult {
  const buckets = new Map<number, SimWord[]>()
  for (const w of words) {
    const len = w.cp.length
    if (!len) continue
    const arr = buckets.get(len)
    if (arr) arr.push(w)
    else buckets.set(len, [w])
  }
  const keys = [...buckets.keys()].sort((x, y) => x - y)
  const n = words.length
  const before = (n * (n - 1)) / 2

  let comparisons = 0
  const ranges: { la: number; lb: number; k: number }[] = []
  for (let xi = 0; xi < keys.length; xi++) {
    for (let yi = xi; yi < keys.length; yi++) {
      const la = keys[xi]
      const lb = keys[yi]
      const M = Math.max(la, lb)
      const k = allowedDistance(p, r, M)
      if (lb - la > k) continue
      const sizeA = buckets.get(la)!.length
      const sizeB = buckets.get(lb)!.length
      comparisons += la === lb ? (sizeA * (sizeA - 1)) / 2 : sizeA * sizeB
      ranges.push({ la, lb, k })
    }
  }

  const collected: Collected[] = []
  let done = 0
  for (const { la, lb, k } of ranges) {
    const M = Math.max(la, lb)
    const listA = buckets.get(la)!
    const listB = buckets.get(lb)!
    if (la === lb) {
      for (let i = 0; i < listA.length; i++) {
        for (let j = i + 1; j < listA.length; j++) {
          const match = comparePairOnce(listA[i], listA[j], k, M, p, r)
          if (match) collected.push(orient(listA[i], listA[j], match.distance, M, match.matchType))
          if (onProgress && (++done & 2047) === 0) onProgress(done, comparisons)
        }
      }
    } else {
      for (const a of listA) {
        for (const b of listB) {
          const match = comparePairOnce(a, b, k, M, p, r)
          if (match) collected.push(orient(a, b, match.distance, M, match.matchType))
          if (onProgress && (++done & 2047) === 0) onProgress(done, comparisons)
        }
      }
    }
  }
  collected.sort(compareInternal)
  return { pairs: collected.map(toPair), before, comparisons, qualified: collected.length }
}

// 单对处理：跳过自匹配与标准化相同；否则带状 OSA。返回精确距离（达标）或 null（超阈值）。
function comparePairOnce(a: SimWord, b: SimWord, k: number, M: number, p: number, r: number): Pick<Collected, 'distance' | 'matchType'> | null {
  if (a.id === b.id) return null
  if (a.norm === b.norm) return null
  if (isBlockSwap(a.cp, b.cp)) return { distance: osaNaive(a.cp, b.cp), matchType: 'block-swap' }
  const dist = osaBanded(a.cp, b.cp, k)
  if (dist === null) return null
  return qualifies(p, r, M, dist) ? { distance: dist, matchType: 'edit' } : null
}

// 朴素参照实现：全量无序词对 + 完整 OSA + 整数达标判定，用于一致性对照测试。
export function autoDiscoverNaive(words: SimWord[], p: number, r: number): DiscoveryResult {
  const valid = words.filter(w => w.cp.length > 0)
  const n = valid.length
  const before = (n * (n - 1)) / 2
  const collected: Collected[] = []
  let comparisons = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = valid[i]
      const b = valid[j]
      if (a.id === b.id || a.norm === b.norm) continue
      comparisons++
      const M = Math.max(a.cp.length, b.cp.length)
      const dist = osaNaive(a.cp, b.cp)
      const blockSwap = isBlockSwap(a.cp, b.cp)
      if (blockSwap || qualifies(p, r, M, dist)) collected.push(orient(a, b, dist, M, blockSwap ? 'block-swap' : 'edit'))
    }
  }
  collected.sort(compareInternal)
  return { pairs: collected.map(toPair), before, comparisons, qualified: collected.length }
}

export type ManualHit = {
  id: string
  spelling: string
  bestQuery: string
  tiedQueries: string[]
  distance: number
  similarity: number
  matchType: 'edit' | 'block-swap'
}

export type ManualResult = { hits: ManualHit[]; comparisons: number; total: number }

// 手动查找（第 4.3 节）：不设阈值，对每个候选与每个输入词计算完整 OSA，取最高分。
// 每个候选只出现一次；与某输入词整词相同仅排除该次比较，候选仍可经其他输入命中。
export function manualFind(candidates: SimWord[], queries: SimWord[], onProgress?: (done: number, total: number) => void): ManualResult {
  const words = candidates.filter(w => w.cp.length > 0)
  const qs: SimWord[] = []
  const seenQuery = new Set<string>()
  for (const q of queries) if (q.cp.length > 0 && !seenQuery.has(q.norm)) { seenQuery.add(q.norm); qs.push(q) }
  const total = words.length * qs.length
  type Entry = { cand: SimWord; num: number; den: number; distance: number; tied: string[]; matchType: ManualHit['matchType'] }
  const entries: Entry[] = []
  let done = 0
  for (const v of words) {
    let best: Entry | null = null
    for (const q of qs) {
      done++
      if (onProgress && (done & 2047) === 0) onProgress(done, total)
      if (v.norm === q.norm) continue
      const M = Math.max(v.cp.length, q.cp.length)
      const dist = osaNaive(v.cp, q.cp)
      const num = M - dist
      const matchType = isBlockSwap(v.cp, q.cp) ? 'block-swap' : 'edit'
      if (best === null || (matchType === 'block-swap' && best.matchType === 'edit') || (matchType === best.matchType && num * best.den > best.num * M)) best = { cand: v, num, den: M, distance: dist, tied: [q.spelling], matchType }
      else if (matchType === best.matchType && num * best.den === best.num * M && !best.tied.includes(q.spelling)) best.tied.push(q.spelling)
    }
    if (best) entries.push(best)
  }
  // 降序交叉相乘比较分数（num/den 未取整），同分按标准化拼写、ID 稳定序。
  entries.sort((x, y) => {
    if (x.matchType !== y.matchType) return x.matchType === 'block-swap' ? -1 : 1
    const sx = y.num * x.den
    const sy = x.num * y.den
    if (sx !== sy) return sx - sy
    return cmpStr(x.cand.norm, y.cand.norm) || cmpStr(x.cand.id, y.cand.id)
  })
  const hits: ManualHit[] = entries.map(e => ({
    id: e.cand.id,
    spelling: e.cand.spelling,
    bestQuery: e.tied[0],
    tiedQueries: e.tied,
    distance: e.distance,
    similarity: e.num / e.den,
    matchType: e.matchType,
  }))
  return { hits, comparisons: done, total }
}
