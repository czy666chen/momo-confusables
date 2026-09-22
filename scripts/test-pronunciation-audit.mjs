import assert from 'node:assert/strict'
import { auditSpellings, normalizeSpelling, parseCmudict } from './audit-pronunciation-data.mjs'

assert.equal(normalizeSpelling('  ＬＥＡＤ  '), 'lead')

const dictionary = parseCmudict(`
;;; comment
lead L IY1 D
lead(2) L EH1 D
ice-cream AY1 S K R IY2 M
`)
assert.deepEqual([...dictionary].sort(), ['ice-cream', 'lead'])

const result = auditSpellings(
  ['Lead', ' lead ', 'ice-cream', 'ice cream', '你好', '', 'OpenAI'],
  dictionary,
)
assert.deepEqual({
  inputRows: result.inputRows,
  uniqueNormalizedItems: result.uniqueNormalizedItems,
  duplicateRows: result.duplicateRows,
  blankRows: result.blankRows,
  uniqueEnglishTerms: result.uniqueEnglishTerms,
  uniqueEnglishWords: result.uniqueEnglishWords,
  uniquePhrases: result.uniquePhrases,
  uniqueNonEnglishItems: result.uniqueNonEnglishItems,
  coveredEnglishWords: result.cmudict.coveredEnglishWords,
  missingEnglishWords: result.cmudict.missingEnglishWords,
}, {
  inputRows: 7,
  uniqueNormalizedItems: 5,
  duplicateRows: 1,
  blankRows: 1,
  uniqueEnglishTerms: 4,
  uniqueEnglishWords: 3,
  uniquePhrases: 1,
  uniqueNonEnglishItems: 1,
  coveredEnglishWords: 2,
  missingEnglishWords: 1,
})
assert.deepEqual(result.cmudict.missing, ['openai'])

console.log('发音数据审计测试通过')
