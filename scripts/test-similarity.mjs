import assert from 'node:assert/strict'
import { normalize, toSimWord, osaNaive, osaBanded, autoDiscover, autoDiscoverNaive, manualFind, isBlockSwap } from '../src/similarity.ts'

const cps = (s) => Array.from(normalize(s))
let passed = 0
function ok(name, fn) { fn(); passed++; console.log('  ✓', name) }

// 固定种子随机数（mulberry32），保证可复现。
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

console.log('P2 相似度一致性测试')

// —— 已知词对：距离与分数 ——
ok('adapt/adopt 距离1 分数0.8', () => {
  assert.equal(osaNaive(cps('adapt'), cps('adopt')), 1)
  assert.equal(osaBanded(cps('adapt'), cps('adopt'), 1), 1)
  assert.equal(1 - 1 / 5, 0.8)
})
ok('form/from 相邻调换 距离1 分数0.75', () => {
  assert.equal(osaNaive(cps('form'), cps('from')), 1)
  assert.equal(osaBanded(cps('form'), cps('from'), 1), 1)
})
ok('quiet/quite 相邻调换 距离1 分数0.8', () => {
  assert.equal(osaNaive(cps('quiet'), cps('quite')), 1)
})
ok('正反向分数相同', () => {
  assert.equal(osaNaive(cps('adapt'), cps('adopt')), osaNaive(cps('adopt'), cps('adapt')))
  assert.equal(osaBanded(cps('form'), cps('from'), 1), osaBanded(cps('from'), cps('form'), 1))
})
ok('OSA 非 unrestricted：连续调换不被当一次', () => {
  // 'abcdef' -> 'badcfe' 三次不相邻调换，朴素 OSA = 3
  assert.equal(osaNaive(cps('abcdef'), cps('badcfe')), 3)
})

// —— 带状 vs 朴素：距离恰为 k 保留、k+1 明确超阈值 ——
ok('距离恰为 k 与 k+1 边界', () => {
  const a = cps('kitten'); const b = cps('sitting') // naive 距离 3
  const d = osaNaive(a, b)
  assert.equal(d, 3)
  assert.equal(osaBanded(a, b, 3), 3)      // 恰为 k -> 精确
  assert.equal(osaBanded(a, b, 2), null)   // k+1 超阈值 -> null
  assert.equal(osaBanded(a, b, 0), null)
})
ok('词长差大于 k 直接排除', () => {
  const a = cps('abcdefgh'); const b = cps('ab') // 长度差 6
  assert.equal(osaBanded(a, b, 5), null)
})

// —— 带状与朴素在小字母表短串上完全一致（穷举）——
ok('小字母表穷举：带状与朴素一致', () => {
  const alphabet = ['a', 'b', 'c']
  const words = ['']
  for (let len = 1; len <= 4; len++) {
    const next = []
    for (const w of words) for (const ch of alphabet) next.push(w + ch)
    words.push(...next)
  }
  for (const x of words) {
    for (const y of words) {
      const nx = Array.from(x); const ny = Array.from(y)
      const trueDist = osaNaive(nx, ny)
      for (let k = 0; k <= 5; k++) {
        const band = osaBanded(nx, ny, k)
        if (trueDist <= k) assert.equal(band, trueDist, `band k=${k} ${x}|${y} true=${trueDist}`)
        else assert.equal(band, null, `band should exceed k=${k} ${x}|${y} true=${trueDist}`)
      }
    }
  }
})

// —— 自动发现：带状与朴素在随机词集上结果集合、距离、排序完全一致 ——
ok('autoDiscover 与朴素参照：集合/距离/排序一致（多阈值）', () => {
  const rand = rng(20260918)
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  function makeSpelling() {
    const len = 3 + Math.floor(rand() * 9)
    let s = ''
    for (let i = 0; i < len; i++) s += letters[Math.floor(rand() * letters.length)]
    return s
  }
  for (const [p, r] of [[60, 100], [50, 100], [75, 100], [0, 100], [100, 100], [3, 5]]) {
    const words = []
    const seen = new Set()
    for (let i = 0; i < 220; i++) {
      const sp = makeSpelling()
      if (seen.has(sp)) continue
      seen.add(sp)
      words.push(toSimWord('id' + i, sp))
    }
    const fast = autoDiscover(words, p, r)
    const slow = autoDiscoverNaive(words, p, r)
    assert.equal(fast.pairs.length, slow.pairs.length, `count mismatch p=${p}/${r}`)
    for (let i = 0; i < fast.pairs.length; i++) {
      const f = fast.pairs[i]; const s = slow.pairs[i]
      assert.equal(f.aId, s.aId, `order@${i} p=${p}/${r}`)
      assert.equal(f.bId, s.bId, `order@${i} p=${p}/${r}`)
      assert.equal(f.distance, s.distance, `dist@${i} p=${p}/${r}`)
      assert.ok(f.similarity - s.similarity < 1e-12 && s.similarity - f.similarity < 1e-12)
    }
    // 阈值 t=p/r 内分数都应 >= t；除 p=0 外
    if (p > 0) for (const pair of fast.pairs) assert.ok(pair.similarity + 1e-12 >= p / r, `below threshold ${pair.similarity} < ${p}/${r}`)
  }
})

// —— 重复字符与带边界调换（滚动行不得复用旧值）——
ok('重复字符+调换 带状一致', () => {
  const rand = rng(7)
  const letters = 'ab'
  for (let t = 0; t < 20000; t++) {
    const len = 1 + Math.floor(rand() * 7)
    let x = ''; let y = ''
    for (let i = 0; i < len; i++) x += letters[Math.floor(rand() * letters.length)]
    const len2 = 1 + Math.floor(rand() * 7)
    for (let i = 0; i < len2; i++) y += letters[Math.floor(rand() * letters.length)]
    const nx = Array.from(x); const ny = Array.from(y)
    const trueDist = osaNaive(nx, ny)
    const k = Math.min(4, Math.max(nx.length, ny.length))
    const band = osaBanded(nx, ny, k)
    if (trueDist <= k) assert.equal(band, trueDist, `${x}|${y}`)
    else assert.equal(band, null, `${x}|${y} true=${trueDist}`)
  }
})

// —— 标准化与阈值降低后重算 ——
ok('normalize：NFKC + trim + lowercase', () => {
  assert.equal(normalize('  ＡＤＡＰＴ  '), 'adapt')
  assert.equal(normalize('ﬁle'), 'file') // NFKC 连字展开
})
ok('大小写归一只影响比较，分桶与距离同单位', () => {
  const a = toSimWord('1', ' Form '); const b = toSimWord('2', 'form')
  assert.equal(a.norm, b.norm)
  // 相同标准化拼写不产生词对
  const res = autoDiscover([a, b], 60, 100)
  assert.equal(res.pairs.length, 0)
})
ok('阈值降低后原先被过滤的候选重新出现', () => {
  // quiet(5)/quite(5) 距离1 分数0.8；加一个更低分对
  const words = ['from', 'form', 'quite', 'quiet', 'abcxyz', 'abd'].map((s, i) => toSimWord('w' + i, s))
  const strict = autoDiscover(words, 90, 100)   // 只留 >=0.90
  const loose = autoDiscover(words, 50, 100)     // 放宽到 >=0.50
  const strictKeys = new Set(strict.pairs.map(p => p.aId + '|' + p.bId))
  const reappeared = loose.pairs.filter(p => !strictKeys.has(p.aId + '|' + p.bId))
  assert.ok(reappeared.length > 0, '降低阈值应放出更多候选')
  for (const p of reappeared) { assert.ok(p.similarity < 0.9); assert.ok(p.similarity + 1e-12 >= 0.5) }
})
ok('词块换序：turnover / overturn 不受编辑阈值限制', () => {
  const words = [toSimWord('a', 'turnover'), toSimWord('b', 'overturn')]
  const result = autoDiscover(words, 95, 100)
  assert.equal(result.pairs.length, 1)
  assert.equal(result.pairs[0].matchType, 'block-swap')
  assert.equal(result.pairs[0].similarity, 0)
  assert.deepEqual(result.pairs, autoDiscoverNaive(words, 95, 100).pairs)
})
ok('词块换序：每个词块至少 3 个字符', () => {
  assert.equal(isBlockSwap(Array.from('turnover'), Array.from('overturn')), true)
  assert.equal(isBlockSwap(Array.from('abcdef'), Array.from('defabc')), true)
  assert.equal(isBlockSwap(Array.from('abcdef'), Array.from('cdefab')), false)
})
// —— 自匹配/反向重复 ——
ok('无自匹配、无反向重复', () => {
  const words = ['adapt', 'adopt', 'agreed', 'greed'].map((s, i) => toSimWord('x' + i, s))
  const res = autoDiscover(words, 40, 100)
  const seen = new Set()
  for (const p of res.pairs) {
    assert.notEqual(p.aId, p.bId)
    const key = [p.aId, p.bId].sort().join('|')
    assert.ok(!seen.has(key), 'reverse duplicate')
    seen.add(key)
  }
})

console.log('P3 手动查找测试')

ok('手动模式：词块换序优先显示并明确标记', () => {
  const result = manualFind([toSimWord('swap', 'overturn'), toSimWord('edit', 'turnovers')], [toSimWord('q', 'turnover')])
  assert.equal(result.hits[0].id, 'swap')
  assert.equal(result.hits[0].matchType, 'block-swap')
  assert.equal(result.hits[1].matchType, 'edit')
})

// —— 低分候选全部保留，准确分数降序，不借用自动模式阈值 ——
ok('手动模式：低分候选保留且严格降序', () => {
  const cands = ['adopt', 'banana', 'quiet'].map((s, i) => toSimWord('c' + i, s))
  const res = manualFind(cands, [toSimWord('q0', 'adapt')])
  assert.equal(res.hits.length, 3)  // banana/quiet 低分不剔除
  for (let i = 1; i < res.hits.length; i++) assert.ok(res.hits[i - 1].similarity >= res.hits[i].similarity)
  assert.equal(res.hits[0].id, 'c0')
  assert.equal(res.hits[0].similarity, 0.8)
  const banana = res.hits.find(h => h.id === 'c1')
  assert.ok(banana.similarity < 0.5, '低分候选应仍在列表内')
  assert.equal(res.total, 3)
  assert.equal(res.comparisons, 3)
})
// —— 多输入命中同一候选：只出现一次，取最大分 ——
ok('手动模式：多输入取最高分且并列来源准确', () => {
  const res = manualFind([toSimWord('c0', 'adapt')], [toSimWord('q0', 'adrop'), toSimWord('q1', 'adopt')])
  assert.equal(res.hits.length, 1)
  assert.equal(res.hits[0].bestQuery, 'adopt')
  assert.deepEqual(res.hits[0].tiedQueries, ['adopt'])
  assert.equal(res.hits[0].similarity, 0.8)
  assert.equal(res.hits[0].distance, 1)
  const tie = manualFind([toSimWord('c0', 'froam')], [toSimWord('q0', 'from'), toSimWord('q1', 'form'), toSimWord('q2', 'froom')])
  assert.deepEqual(tie.hits[0].tiedQueries, ['from', 'froom'])   // form 距离2 不并列
  assert.equal(tie.hits[0].bestQuery, 'from')
  assert.equal(tie.hits[0].similarity, 0.8)
})
// —— 自匹配排除：整词相同只排除该次比较 ——
ok('手动模式：自匹配排除、候选仍可经其他输入命中', () => {
  const only = manualFind([toSimWord('c0', 'abx')], [toSimWord('q0', 'abx')])
  assert.equal(only.hits.length, 0)
  const other = manualFind([toSimWord('c0', 'abx')], [toSimWord('q0', 'abx'), toSimWord('q1', 'aby'), toSimWord('q2', 'abz')])
  assert.equal(other.hits.length, 1)
  assert.deepEqual(other.hits[0].tiedQueries, ['aby', 'abz'])
})
// —— 大小写、空白、全角统一比较 ——
ok('手动模式：大小写与空白统一（含全角 NFKC）', () => {
  const res = manualFind([toSimWord('c0', 'form'), toSimWord('c1', 'from')], [toSimWord('q0', ' Ｆorm ')])
  assert.equal(res.hits.length, 1)          // form 与查询整词相同被排除
  assert.equal(res.hits[0].id, 'c1')
  assert.equal(res.hits[0].similarity, 0.75) // 相邻调换按距离1计
})
// —— 查询词内部去重（按标准化拼写）——
ok('手动模式：查询词内部去重不计为并列来源', () => {
  const res = manualFind([toSimWord('c0', 'adapt')], [toSimWord('q0', 'Adopt'), toSimWord('q1', 'adopt')])
  assert.deepEqual(res.hits[0].tiedQueries, ['Adopt'])
  assert.equal(res.total, 1)
})
// —— 同分候选稳定序 ——
ok('手动模式：同分按标准化拼写、ID 稳定排序', () => {
  const run = () => manualFind([toSimWord('c2', 'aaaac'), toSimWord('c1', 'aaaab')], [toSimWord('q0', 'aaaad')])
  assert.deepEqual(run().hits.map(h => h.id), ['c1', 'c2'])
  assert.deepEqual(run().hits, run().hits)
})
// —— 固定种子随机集：与独立朴素核对完全一致 ——
ok('手动模式：随机词集与独立朴素核对一致', () => {
  const rand = rng(20260919)
  const letters = 'abcdefgh'
  function makeSpelling() {
    const len = 2 + Math.floor(rand() * 7)
    let s = ''
    for (let i = 0; i < len; i++) s += letters[Math.floor(rand() * letters.length)]
    return s
  }
  for (let trial = 0; trial < 20; trial++) {
    const cands = []
    const seenC = new Set()
    for (let i = 0; i < 60; i++) { const sp = makeSpelling(); if (seenC.has(sp)) continue; seenC.add(sp); cands.push(toSimWord('c' + i, sp)) }
    const qs = []
    const seenQ = new Set()
    for (let i = 0; i < 4; i++) { const sp = makeSpelling(); if (seenQ.has(sp)) continue; seenQ.add(sp); qs.push(toSimWord('q' + i, sp)) }
    const res = manualFind(cands, qs)
    // 独立核对：每个候选的最高分、并列来源
    const expected = []
    for (const v of cands) {
      let best = null, tied = []
      for (const q of qs) {
        if (v.norm === q.norm) continue
        const M = Math.max(v.cp.length, q.cp.length)
        const d = osaNaive(v.cp, q.cp)
        const s = (M - d) / M
        if (best === null || s > best + 1e-12) { best = s; tied = [q.spelling] }
        else if (Math.abs(s - best) <= 1e-12 && !tied.includes(q.spelling)) tied.push(q.spelling)
      }
      if (best !== null) expected.push({ id: v.id, best, tied })
    }
    assert.equal(res.hits.length, expected.length, `count trial=${trial}`)
    const byId = new Map(res.hits.map(h => [h.id, h]))
    for (const e of expected) {
      const h = byId.get(e.id)
      assert.ok(h, `missing ${e.id}`)
      assert.ok(Math.abs(h.similarity - e.best) < 1e-9, `score ${e.id} ${h.similarity} != ${e.best}`)
      assert.deepEqual([...h.tiedQueries].sort(), [...e.tied].sort(), `tied ${e.id}`)
    }
    for (let i = 1; i < res.hits.length; i++) assert.ok(res.hits[i - 1].similarity >= res.hits[i].similarity, `order trial=${trial}@${i}`)
    // 每个候选至多出现一次
    assert.equal(new Set(res.hits.map(h => h.id)).size, res.hits.length)
  }
})

// —— 同分稳定序 ——
ok('同分按标准化拼写、ID 稳定排序', () => {
  // 三个 5 字母词，都彼此 distance>=? 构造同分：都与公共词距离1
  const words = [toSimWord('b', 'aaaaa'), toSimWord('c', 'aaaab'), toSimWord('a', 'aaaac')]
  const r1 = autoDiscover(words, 50, 100)
  const r2 = autoDiscover(words, 50, 100)
  assert.deepEqual(r1.pairs.map(p => p.aId + p.bId), r2.pairs.map(p => p.aId + p.bId))
})

console.log(`\n全部通过：${passed} 组`)
