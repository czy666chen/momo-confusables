import assert from 'node:assert/strict'
import { comparePronunciations, decodePronunciation, phonemeEditDistance } from '../src/pronunciation.ts'
import { autoDiscoverMatches, manualFindMatches, normalizeMatchTypes, toSimWord } from '../src/similarity.ts'
import { build, parseCmudict } from './build-pronunciation-data.mjs'

let passed = 0
function ok(name, fn) { fn(); passed++; console.log('  ✓', name) }

console.log('词典音素匹配测试')

ok('CMUdict 全部读音变体保留，基础音素与重音分开', () => {
  const entries = parseCmudict('read R EH1 D\nread(2) R IY1 D\n')
  assert.deepEqual(entries.read, [['R EH D', '-1-'], ['R IY D', '-1-']])
  assert.deepEqual(decodePronunciation(entries.read[0]), { phones: ['R', 'EH', 'D'], stress: [null, 1, null] })
})

ok('固定版本与评分版本写入资源', () => {
  const asset = build('sea S IY1\nsee S IY1\n')
  assert.equal(asset.dictionaryVersion, '74790861f652b15e4ac49015a90074ad62a27690')
  assert.equal(asset.scoringVersion, 'phoneme-unit-edit-v1')
})

ok('音素按 token 计算编辑距离，而不是按字符', () => {
  assert.equal(phonemeEditDistance(['SH', 'IY'], ['S', 'IY']), 1)
  assert.equal(phonemeEditDistance(['N', 'AY', 'T'], ['N', 'AY', 'T']), 0)
})

ok('多读音组合采用最高分并保留对应读音', () => {
  const left = [decodePronunciation(['R EH D', '-1-']), decodePronunciation(['R IY D', '-1-'])]
  const right = [decodePronunciation(['R EH D', '-1-'])]
  const match = comparePronunciations(left, right)
  assert.equal(match?.similarity, 1)
  assert.deepEqual(match?.left.phones, ['R', 'EH', 'D'])
})

ok('无可用读音返回 null，不伪装成零分', () => {
  assert.equal(comparePronunciations(undefined, [decodePronunciation(['S IY', '-1'])]), null)
})

ok('matchTypes 缺省全选，空数组与非法类型报错', () => {
  assert.deepEqual(normalizeMatchTypes(undefined), ['spelling', 'reorder', 'pronunciation'])
  assert.throws(() => normalizeMatchTypes([]), /至少选择一种匹配类型/)
  assert.throws(() => normalizeMatchTypes(['soundex']), /matchTypes/)
})

const dictionary = new Map([
  ['adapt', [decodePronunciation(['AH D AE P T', '0-1--'])]],
  ['adopt', [decodePronunciation(['AH D AA P T', '0-1--'])]],
  ['turnover', [decodePronunciation(['T ER N OW V ER', '-1-2-0'])]],
  ['overturn', [decodePronunciation(['OW V ER T ER N', '1-0-1-'])]],
  ['flower', [decodePronunciation(['F L AW ER', '--10'])]],
  ['flour', [decodePronunciation(['F L AW ER', '--10'])]],
])
const words = ['adapt', 'adopt', 'turnover', 'overturn', 'flower', 'flour'].map((word, index) => toSimWord(String(index), word))
const combinations = [
  ['spelling'], ['reorder'], ['pronunciation'],
  ['spelling', 'reorder'], ['spelling', 'pronunciation'], ['reorder', 'pronunciation'],
  ['spelling', 'reorder', 'pronunciation'],
]

ok('七种组合均按 OR 召回，结果去重并只标注已选命中类型', () => {
  for (const types of combinations) {
    const result = autoDiscoverMatches(words, 80, 100, types, dictionary)
    const keys = result.pairs.map(pair => `${pair.aSpelling}|${pair.bSpelling}`)
    assert.equal(new Set(keys).size, keys.length, `组合 ${types.join(',')} 出现重复`)
    for (const pair of result.pairs) for (const type of pair.matchTypes) assert.ok(types.includes(type), `组合 ${types.join(',')} 出现未选类型 ${type}`)
    if (types.includes('spelling')) assert.ok(result.pairs.some(pair => pair.matchTypes.includes('spelling') && pair.aSpelling === 'adapt' && pair.bSpelling === 'adopt'))
    if (types.includes('reorder')) assert.ok(result.pairs.some(pair => pair.matchTypes.includes('reorder') && pair.aSpelling === 'overturn' && pair.bSpelling === 'turnover'))
    if (types.includes('pronunciation')) assert.ok(result.pairs.some(pair => pair.matchTypes.includes('pronunciation') && pair.aSpelling === 'flour' && pair.bSpelling === 'flower'))
  }
})

ok('同一词对合并多个类型标签，基础结果排在仅发音结果之前', () => {
  const result = autoDiscoverMatches(words, 80, 100, ['spelling', 'reorder', 'pronunciation'], dictionary)
  const near = result.pairs.find(pair => pair.aSpelling === 'adapt' && pair.bSpelling === 'adopt')
  assert.deepEqual(near?.matchTypes, ['spelling', 'pronunciation'])
  const spellingIndex = result.pairs.findIndex(pair => pair.aSpelling === 'adapt' && pair.bSpelling === 'adopt')
  const pronunciationOnlyIndex = result.pairs.findIndex(pair => pair.aSpelling === 'flour' && pair.bSpelling === 'flower')
  assert.ok(spellingIndex >= 0 && pronunciationOnlyIndex > spellingIndex)
  assert.ok(result.pairs[pronunciationOnlyIndex].spellingMatch, '仅发音召回项仍独立展示已启用的拼写分数')
})

ok('手动纯发音可找到拼写差异词，关闭发音后不产生发音字段', () => {
  const candidates = [toSimWord('flour', 'flour'), toSimWord('unknown', 'maimemo')]
  const query = [toSimWord('query', 'flower')]
  const pronunciationOnly = manualFindMatches(candidates, query, ['pronunciation'], dictionary)
  assert.deepEqual(pronunciationOnly.hits.map(hit => hit.id), ['flour'])
  assert.equal(pronunciationOnly.hits[0].pronunciation?.similarity, 1)
  const spellingOnly = manualFindMatches(candidates, query, ['spelling'], dictionary)
  assert.ok(spellingOnly.hits.every(hit => hit.pronunciation === undefined))
})

console.log(`\n全部通过：${passed} 组`)
