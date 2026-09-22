import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGLISH_TERM = /^[a-z]+(?:[ '-][a-z]+)*$/u
const ENGLISH_WORD = /^[a-z]+(?:['-][a-z]+)*$/u

export function normalizeSpelling(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
}

export function parseCmudict(text) {
  const entries = new Set()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';;;')) continue
    const key = line.split(/\s+/u, 1)[0].replace(/\(\d+\)$/u, '')
    if (key) entries.add(normalizeSpelling(key))
  }
  return entries
}

export function auditSpellings(spellings, cmudictEntries) {
  const normalized = spellings.map(normalizeSpelling)
  const nonempty = normalized.filter(Boolean)
  const unique = new Set(nonempty)
  const englishTerms = [...unique].filter(value => ENGLISH_TERM.test(value))
  const phrases = englishTerms.filter(value => !ENGLISH_WORD.test(value))
  const englishWords = englishTerms.filter(value => ENGLISH_WORD.test(value))
  const nonEnglish = [...unique].filter(value => !ENGLISH_TERM.test(value))
  const missing = cmudictEntries
    ? englishWords.filter(value => !cmudictEntries.has(value)).sort()
    : []

  return {
    inputRows: spellings.length,
    normalizedNonemptyRows: nonempty.length,
    uniqueNormalizedItems: unique.size,
    duplicateRows: nonempty.length - unique.size,
    blankRows: spellings.length - nonempty.length,
    uniqueEnglishTerms: englishTerms.length,
    uniqueEnglishWords: englishWords.length,
    uniquePhrases: phrases.length,
    uniqueNonEnglishItems: nonEnglish.length,
    cmudict: cmudictEntries
      ? {
          coveredEnglishWords: englishWords.length - missing.length,
          missingEnglishWords: missing.length,
          missingRate: englishWords.length ? missing.length / englishWords.length : 0,
          missing,
        }
      : null,
  }
}

function readSpellings(sourcePath) {
  const text = fs.readFileSync(sourcePath, 'utf8')
  if (path.extname(sourcePath).toLowerCase() !== '.json') {
    return text.split(/\r?\n/u)
  }
  const value = JSON.parse(text)
  const rows = Array.isArray(value) ? value : value.rows
  if (!Array.isArray(rows)) throw new Error('JSON 必须是数组或包含 rows 数组')
  return rows.map(row => typeof row === 'string' ? row : row?.voc_spelling)
}

function main(args) {
  const [sourcePath, cmudictPath] = args
  if (!sourcePath) {
    console.error('用法: node scripts/audit-pronunciation-data.mjs <词表.json|词表.txt> [cmudict.dict]')
    process.exitCode = 1
    return
  }
  const cmudictEntries = cmudictPath
    ? parseCmudict(fs.readFileSync(cmudictPath, 'utf8'))
    : null
  const result = auditSpellings(readSpellings(sourcePath), cmudictEntries)
  const publicResult = result.cmudict
    ? { ...result, cmudict: { ...result.cmudict, missing: undefined } }
    : result
  console.log(JSON.stringify({
    source: path.resolve(sourcePath),
    cmudict: cmudictPath ? path.resolve(cmudictPath) : null,
    ...publicResult,
  }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
