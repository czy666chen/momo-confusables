import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CMUDICT_VERSION, G2P_MODEL_SHA256, G2P_MODEL_VERSION, G2P_PIPELINE_VERSION, PRONUNCIATION_ASSET_URL, PRONUNCIATION_SCORING_VERSION, comparePronunciations, decodePronunciation, mergePronunciations, parsePredictionAsset, parsePronunciationAsset } from '../src/pronunciation.ts'
import { createPronunciationLoader } from '../src/pronunciation-loader.ts'
import { autoDiscoverMatches, manualFindMatches, toSimWord } from '../src/similarity.ts'
import { build, parseCmudict } from './build-pronunciation-data.mjs'

let passed = 0
async function ok(name, fn) { await fn(); passed++; console.log('  ✓', name) }
const fixture = () => ({ schemaVersion: 1, source: 'prediction', dictionaryVersion: CMUDICT_VERSION, scoringVersion: PRONUNCIATION_SCORING_VERSION, pipelineVersion: G2P_PIPELINE_VERSION, modelVersion: G2P_MODEL_VERSION, modelSha256: G2P_MODEL_SHA256, entries: { flourz: [['F L AW ER Z', '--10-']], flower: [['B AE D', '-1-']] } })
const dictionary = parsePronunciationAsset(build('flower F L AW1 ER0\nflours F L AW1 ER0 Z')).dictionary

await ok('拒绝旧模型、词典、评分和流水线版本及损坏音素', () => {
  for (const field of ['schemaVersion', 'source', 'dictionaryVersion', 'scoringVersion', 'pipelineVersion', 'modelVersion', 'modelSha256']) assert.throws(() => parsePredictionAsset({ ...fixture(), [field]: 'old' }))
  for (const encoded of [['XX', '-'], ['AA', '-'], ['B', '1'], ['AA', 'x'], ['', ''], ['AA B', '1'], ['<unk>', '-']]) assert.throws(() => parsePredictionAsset({ ...fixture(), entries: { example: [encoded] } }))
  for (const entries of [[], {}, { Upper: [['B', '-']] }, { word: [] }, { word: 'bad' }]) assert.throws(() => parsePredictionAsset({ ...fixture(), entries }))
})
await ok('词典优先、不污染缓存，保留预测模型来源和混合来源', () => {
  const predictions = parsePredictionAsset(fixture()).dictionary
  const merged = mergePronunciations(dictionary, predictions)
  assert.equal(dictionary.has('flourz'), false)
  assert.deepEqual(merged.get('flower'), dictionary.get('flower'))
  const mixed = comparePronunciations(merged.get('flours'), merged.get('flourz'))
  assert.equal(mixed.source, 'mixed')
  assert.equal(mixed.right.modelVersion, G2P_MODEL_VERSION)
  assert.equal(mixed.similarity, 1)
  assert.equal(comparePronunciations(merged.get('flourz'), merged.get('flourz')).source, 'prediction')
  assert.equal(comparePronunciations(merged.get('newunknown'), merged.get('flourz')), null)
})
await ok('两个入口独立召回预测读音，关闭发音后不访问读音表', () => {
  const merged = mergePronunciations(dictionary, parsePredictionAsset(fixture()).dictionary)
  const words = ['flours', 'flourz'].map(word => toSimWord(word, word))
  assert.equal(autoDiscoverMatches(words, 100, 100, ['pronunciation'], merged).pairs[0].pronunciation.source, 'mixed')
  assert.equal(manualFindMatches([words[0]], [words[1]], ['pronunciation'], merged).hits[0].pronunciation.source, 'mixed')
  const neverRead = { get() { throw new Error('disabled pronunciation accessed') } }
  autoDiscoverMatches(words, 60, 100, ['spelling'], neverRead)
  manualFindMatches([words[0]], [words[1]], ['spelling'], neverRead)
})
await ok('词典忽略行尾注释，完整构建资源通过音素和重音校验', () => {
  assert.deepEqual(parseCmudict('read R EH1 D # note\nread(2) R IY1 D # alternate').read, [['R EH D', '-1-'], ['R IY D', '-1-']])
  assert.equal(parsePronunciationAsset(JSON.parse(fs.readFileSync(`public${PRONUNCIATION_ASSET_URL}`, 'utf8'))).dictionary.size, 126052)
  assert.throws(() => decodePronunciation(['BAD', '-']))
  for (const entries of [[], {}, { word: 'bad' }, { word: [42] }]) assert.throws(() => parsePronunciationAsset({ ...build('sea S IY1'), entries }))
})
await ok('版本过期缓存自动重载，成功后复用同一读取', async () => {
  const calls = []
  const load = createPronunciationLoader(async (url, init) => {
    calls.push({ url, cache: init.cache })
    return Response.json(calls.length === 1 ? { ...build('sea S IY1'), dictionaryVersion: 'old' } : build('sea S IY1'))
  })
  const [a, b] = await Promise.all([load(), load()])
  assert.equal(a, b)
  assert.equal(await load(), a)
  assert.deepEqual(calls.map(call => call.cache), ['default', 'reload'])
  assert.ok(calls.every(call => call.url.endsWith('-v2.json')))
})
await ok('网络失败不缓存 rejected Promise，恢复后可重新读取', async () => {
  let online = false
  const load = createPronunciationLoader(async () => {
    if (!online) throw new Error('offline')
    return Response.json(build('sea S IY1'))
  })
  await assert.rejects(load(), /offline/u)
  online = true
  assert.ok((await load()).has('sea'))
})
console.log(`全部通过：${passed} 组`)
