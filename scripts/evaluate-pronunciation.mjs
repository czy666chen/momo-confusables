import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PRONUNCIATION_ASSET_URL, PRONUNCIATION_POLICY_VERSION, PRONUNCIATION_SCORING_VERSION, comparePronunciations, parsePronunciationAsset } from '../src/pronunciation.ts'

const input = fs.readFileSync('data/pronunciation-evaluation/pairs.tsv', 'utf8')
const rows = input.trim().split(/\r?\n/u).slice(1).map(line => {
  const [split, category, expected, left, right] = line.split('\t')
  return { split, category, expected: Number(expected), left, right }
})
assert.equal(rows.length, 160)
assert.equal(new Set(rows.map(row => [row.left, row.right].sort().join('|'))).size, rows.length)
const tuningWords = new Set(rows.filter(row => row.split === 'tune').flatMap(row => [row.left, row.right]))
assert.ok(rows.filter(row => row.split === 'acceptance').every(row => !tuningWords.has(row.left) && !tuningWords.has(row.right)), '评测集不得与调参集共享单词')
const { dictionary } = parsePronunciationAsset(JSON.parse(fs.readFileSync(`public${PRONUNCIATION_ASSET_URL}`, 'utf8')))
const scored = rows.map(row => {
  const match = comparePronunciations(dictionary.get(row.left), dictionary.get(row.right))
  assert.ok(match, `评测样例缺少词典读音：${row.left}/${row.right}`)
  return { ...row, score: match.similarity, phones: [match.left.phones.join(' '), match.right.phones.join(' ')], stress: [match.left.stress, match.right.stress] }
})
function evaluate(split, threshold, predicate = () => true) {
  const subset = scored.filter(row => row.split === split && predicate(row))
  const falsePositives = subset.filter(row => !row.expected && row.score + Number.EPSILON >= threshold)
  const falseNegatives = subset.filter(row => row.expected && row.score + Number.EPSILON < threshold)
  return { threshold, count: subset.length, falsePositiveRate: falsePositives.length / subset.filter(row => !row.expected).length, falseNegativeRate: falseNegatives.length / subset.filter(row => row.expected).length, falsePositives, falseNegatives }
}
// Only the tuning partition selects the threshold. Acceptance never affects selection.
const grid = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1].map(threshold => evaluate('tune', threshold))
const selected = [...grid].sort((a, b) => (a.falsePositiveRate + a.falseNegativeRate) - (b.falsePositiveRate + b.falseNegativeRate) || Math.abs(a.threshold - 0.65) - Math.abs(b.threshold - 0.65))[0]
const acceptance = evaluate('acceptance', selected.threshold)
const lengthAnalysis = Object.fromEntries(['short', 'long'].map(group => {
  const subset = row => (Math.max(...row.phones.map(phones => phones.split(' ').length)) <= 3) === (group === 'short')
  const candidates = grid.map(({ threshold }) => evaluate('tune', threshold, subset))
  const best = [...candidates].sort((a, b) => (a.falsePositiveRate + a.falseNegativeRate) - (b.falsePositiveRate + b.falseNegativeRate) || Math.abs(a.threshold - selected.threshold) - Math.abs(b.threshold - selected.threshold))[0]
  const { falsePositives, falseNegatives, ...summary } = best
  return [group, summary]
}))
const report = {
  schemaVersion: 1, scoringVersion: PRONUNCIATION_SCORING_VERSION, policyVersion: PRONUNCIATION_POLICY_VERSION,
  datasetSha256: createHash('sha256').update(input).digest('hex'),
  labelStatus: 'AI-authored expectations; pending human review; not an accuracy claim',
  targets: { falsePositiveRate: 0.1, falseNegativeRate: 0.1 },
  selectedThreshold: selected.threshold,
  tuningLengthAnalysis: lengthAnalysis,
  tuning: grid.map(({ falsePositives, falseNegatives, ...summary }) => summary),
  acceptance, provisionalTargetsMet: acceptance.falsePositiveRate <= 0.1 && acceptance.falseNegativeRate <= 0.1,
  releaseApproved: false,
}
fs.writeFileSync('docs/pronunciation-evaluation.json', JSON.stringify(report, null, 2) + '\n')
const review = ['# 发音样例人工核验表', '', '所有标签目前由 AI 起草，尚未人工核验。请由核验者填写最后一列，并记录姓名、日期及分歧；不能把本表的自动分数当成人工结论。', '', '正例表示英语学习场景中的同音/近音，负例表示整体读音差异较大。接受任一美式词典变体；不进行语境消歧。分区在评分前固定且单词不跨分区。验收集不用于调参；人工改标后须另建未看过的新验收集。', '', '| 分区 | 类别 | 词对 | 预期 | 音素对 | 分数 | 人工核验 |', '|---|---|---|---|---|---:|---|', ...scored.map(row => `| ${row.split} | ${row.category} | ${row.left} / ${row.right} | ${row.expected ? '近音' : '非近音'} | ${row.phones.join(' / ')} | ${row.score.toFixed(3)} | 待核验 |`)]
// Never overwrite a reviewer's annotations on subsequent evaluation runs.
if (!fs.existsSync('docs/pronunciation-human-review.md')) fs.writeFileSync('docs/pronunciation-human-review.md', review.join('\n') + '\n')
console.log(JSON.stringify({ pairs: rows.length, selectedThreshold: selected.threshold, acceptance: { falsePositiveRate: acceptance.falsePositiveRate, falseNegativeRate: acceptance.falseNegativeRate }, provisionalTargetsMet: report.provisionalTargetsMet, releaseApproved: false }))
