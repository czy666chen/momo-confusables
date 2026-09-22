import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULT_PRONUNCIATION_THRESHOLD, PRONUNCIATION_ASSET_URL, parsePronunciationAsset } from '../src/pronunciation.ts'
import { autoDiscoverMatches, manualFindMatches, toSimWord } from '../src/similarity.ts'

const dictionary = parsePronunciationAsset(JSON.parse(fs.readFileSync(`public${PRONUNCIATION_ASSET_URL}`, 'utf8'))).dictionary
const fixture = fs.readFileSync('data/pronunciation-evaluation/pairs.tsv', 'utf8').trim().split(/\r?\n/u).slice(1).map(line => line.split('\t'))
const words = [...new Set(fixture.flatMap(row => row.slice(3)))].sort().map(word => toSimWord(word, word))
// Independent full-matrix reference, deliberately not the production rolling-row code.
function referenceDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]))
  return d[a.length][b.length]
}
function referenceScore(a, b) {
  return Math.max(...dictionary.get(a).flatMap(x => dictionary.get(b).map(y => 1 - referenceDistance(x.phones, y.phones) / Math.max(x.phones.length, y.phones.length))))
}
const allPairs = []
for (let i = 0; i < words.length; i++) for (let j = i + 1; j < words.length; j++) allPairs.push({ a: words[i].id, b: words[j].id, score: referenceScore(words[i].id, words[j].id) })
for (const threshold of [0, DEFAULT_PRONUNCIATION_THRESHOLD, 0.8, 1]) {
  const expected = allPairs.filter(pair => pair.score + Number.EPSILON >= threshold).map(pair => `${pair.a}|${pair.b}`).sort()
  const actual = autoDiscoverMatches(words, threshold * 100, 100, ['pronunciation'], dictionary)
  assert.deepEqual(actual.pairs.map(pair => `${pair.aId}|${pair.bId}`).sort(), expected)
  assert.deepEqual(autoDiscoverMatches([...words].reverse(), threshold * 100, 100, ['pronunciation'], dictionary).pairs, actual.pairs, '输入顺序不能改变排序或选中的变体')
}
for (const query of words.filter((_, i) => i % 13 === 0)) {
  const expected = words.filter(word => word.id !== query.id && referenceScore(word.id, query.id) + Number.EPSILON >= DEFAULT_PRONUNCIATION_THRESHOLD).map(word => word.id).sort()
  assert.deepEqual(manualFindMatches(words, [query], ['pronunciation'], dictionary).hits.map(hit => hit.id).sort(), expected)
}
const small = ['adapt', 'adopt', 'flower', 'flour', 'turnover', 'overturn', 'sea', 'see'].map(word => toSimWord(word, word))
const kinds = ['spelling', 'reorder', 'pronunciation']
for (let mask = 1; mask < 8; mask++) {
  const types = kinds.filter((_, i) => mask & (1 << i))
  for (const mode of ['auto', 'manual']) {
    const run = selected => mode === 'auto' ? autoDiscoverMatches(small, 65, 100, selected, dictionary).pairs : manualFindMatches(small, [toSimWord('query', 'flower')], selected, dictionary).hits
    const key = item => item.id ?? `${item.aId}|${item.bId}`
    const result = run(types)
    const expected = new Set(types.flatMap(type => run([type]).map(key)))
    assert.deepEqual(new Set(result.map(key)), expected)
    assert.equal(result.length, expected.size)
    for (const item of result) assert.deepEqual(item.matchTypes, types.filter(type => run([type]).some(single => key(single) === key(item))))
    const base = types.filter(type => type !== 'pronunciation')
    if (base.length) assert.deepEqual(result.filter(item => item.matchTypes.some(type => base.includes(type))).map(key), run(base).map(key))
  }
}
console.log(`✓ ${words.length} 词 / ${allPairs.length} 词对全量独立基线，4 阈值无漏召回；双入口七组合、合并、稳定排序通过`)
