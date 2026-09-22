import fs from 'node:fs'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { PRONUNCIATION_ASSET_URL, parsePronunciationAsset, parsePredictionAsset, mergePronunciations } from '../src/pronunciation.ts'
import { autoDiscoverMatches, manualFindMatches, toSimWord } from '../src/similarity.ts'

const snapshot = JSON.parse(fs.readFileSync('p0/private/p5-account-snapshot.json', 'utf8'))
const bytes = fs.readFileSync(`public${PRONUNCIATION_ASSET_URL}`)
let dictionary = parsePronunciationAsset(JSON.parse(bytes)).dictionary
const supplement = fs.readdirSync('p0/private').filter(name => /^pronunciation-predictions-.*\.json$/u.test(name)).sort()
if (supplement.length === 1) dictionary = mergePronunciations(dictionary, parsePredictionAsset(JSON.parse(fs.readFileSync(`p0/private/${supplement[0]}`, 'utf8'))).dictionary)
const words = snapshot.rows.map(row => toSimWord(row.voc_id, row.voc_spelling))
const weak = snapshot.rows.filter(row => ['FORGET', 'VAGUE'].includes(row.last_response)).map(row => toSimWord(row.voc_id, row.voc_spelling))
const queries = 'sea knight flower pair write peace meat weak sun blue buy one hear whole break plain waist wait read lead'.split(' ').map(word => toSimWord(`query-${word}`, word))
const types = ['spelling', 'reorder', 'pronunciation']
const results = []
for (const [name, count, budgetMs, run] of [
  ['actual-weak', weak.length, 5000, () => autoDiscoverMatches(weak, 65, 100, types, dictionary)],
  ['actual-1000', Math.min(words.length, 1000), 5000, () => autoDiscoverMatches(words.slice(0, 1000), 65, 100, types, dictionary)],
  ['actual-manual-20', words.length, 3000, () => manualFindMatches(words, queries, types, dictionary)],
]) {
  const runs = []
  for (let iteration = 0; iteration < 3; iteration++) {
    const start = performance.now()
    const cpu = process.cpuUsage()
    const result = run()
    const used = process.cpuUsage(cpu)
    runs.push({ wallMs: Math.round(performance.now() - start), cpuMs: Math.round((used.user + used.system) / 1000), comparisons: result.comparisons, results: result.pairs?.length ?? result.hits.length })
  }
  results.push({ name, count, budgetMs, runs, passed: runs.every(run => run.wallMs <= budgetMs) })
}
const report = { environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0].model }, snapshot: { rows: words.length, total: snapshot.total, finished: snapshot.finished, weak: weak.length }, resources: { dictionaryBytes: bytes.length, dictionaryGzipBytes: gzipSync(bytes).length, predictionFilesUsed: supplement.length === 1 ? 1 : 0 }, results, cloudflare: { measured: false, reason: 'Local-only acceptance; no production traffic or account analytics queried.' } }
fs.writeFileSync('docs/pronunciation-performance.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (results.some(result => !result.passed)) process.exitCode = 1
