import assert from 'node:assert/strict'
import { confusionSignal, parseCandidateList, parseManualInput, soundex } from '../src/input.ts'
import { readRestorableState, writeRestorableState } from '../src/session-state.ts'

let passed = 0
function ok(name, fn) { fn(); passed++; console.log('  ✓', name) }

console.log('输入、混淆信号与会话恢复测试')
ok('英文单词、短语、连字符与撇号可输入', () => assert.deepEqual(parseManualInput("adapt, a band\nmother-in-law, don't").invalid, []))
ok('混入中文或标点的输入被拒绝', () => assert.deepEqual(parseManualInput('word中文,hello!!!').invalid, ['word中文', 'hello!!!']))
ok('候选词表报告重复与无效行', () => assert.deepEqual(parseCandidateList('adapt\nadapt\n坏词').duplicates, 1))
ok('Soundex 对近似读音给出相同编码', () => assert.equal(soundex('Robert'), soundex('Rupert')))
ok('读音信号独立给出解释', () => assert.equal(confusionSignal('Robert', 'Rupert').phoneticMatch, true))
ok('会话状态可写入并安全恢复', () => {
  const memory = new Map()
  const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) }
  const value = { selected: ['1'], customMeanings: { word: '词' }, drafts: {}, manualText: 'word', candidateText: '' }
  writeRestorableState(storage, 'state', value)
  assert.deepEqual(readRestorableState(storage, 'state'), value)
})
console.log(`\n全部通过：${passed} 组`)
