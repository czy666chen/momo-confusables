import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CMUDICT_VERSION = '74790861f652b15e4ac49015a90074ad62a27690'
const SOURCE_URL = `https://github.com/cmusphinx/cmudict/commit/${CMUDICT_VERSION}`
const sourcePath = path.join(ROOT, 'data', 'cmudict', 'cmudict.dict')
const licensePath = path.join(ROOT, 'THIRD_PARTY_LICENSES', 'CMUDICT-LICENSE.txt')
const outputDir = path.join(ROOT, 'public', 'pronunciation')
const outputPath = path.join(outputDir, `cmudict-${CMUDICT_VERSION.slice(0, 8)}-v2.json`)
const ENGLISH_WORD = /^[a-z]+(?:['-][a-z]+)*$/u

export function parseCmudict(text) {
  const entries = Object.create(null)
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.split('#', 1)[0].trim()
    if (!line || line.startsWith(';;;')) continue
    const [rawWord, ...rawPhones] = line.split(/\s+/u)
    const word = rawWord.replace(/\(\d+\)$/u, '').normalize('NFKC').toLowerCase()
    if (!word || !rawPhones.length) continue
    const phones = []
    const stress = []
    for (const token of rawPhones) {
      const match = token.match(/^(.+?)([012])?$/u)
      if (!match) continue
      phones.push(match[1])
      stress.push(match[2] ?? '-')
    }
    if (!phones.length) continue
    const encoded = [phones.join(' '), stress.join('')]
    const variants = entries[word] ?? (entries[word] = [])
    if (!variants.some(value => value[0] === encoded[0] && value[1] === encoded[1])) variants.push(encoded)
  }
  return entries
}

function snapshotSpellings(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) return null
  const value = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const rows = Array.isArray(value) ? value : value.rows
  if (!Array.isArray(rows)) throw new Error('业务词表快照必须是数组或包含 rows 数组')
  return [...new Set(rows.map(row => String(typeof row === 'string' ? row : row?.voc_spelling ?? '').normalize('NFKC').trim().toLowerCase()).filter(value => ENGLISH_WORD.test(value)))].sort()
}

export function build(sourceText) {
  return {
    schemaVersion: 1,
    dictionaryVersion: CMUDICT_VERSION,
    scoringVersion: 'phoneme-unit-edit-v1',
    source: SOURCE_URL,
    entries: parseCmudict(sourceText),
  }
}

function main() {
  const asset = build(fs.readFileSync(sourcePath, 'utf8'))
  fs.mkdirSync(outputDir, { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(asset))
  fs.copyFileSync(licensePath, path.join(outputDir, 'CMUDICT-LICENSE.txt'))

  const snapshotPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'p0', 'private', 'p5-account-snapshot.json')
  const spellings = snapshotSpellings(snapshotPath)
  let business = null
  if (spellings) {
    const variants = Object.fromEntries(spellings.filter(word => asset.entries[word]).map(word => [word, asset.entries[word]]))
    const missing = spellings.filter(word => !asset.entries[word])
    const privateDir = path.join(ROOT, 'p0', 'private')
    fs.mkdirSync(privateDir, { recursive: true })
    fs.writeFileSync(path.join(privateDir, 'pronunciation-business.json'), JSON.stringify({ dictionaryVersion: CMUDICT_VERSION, entries: variants }))
    fs.writeFileSync(path.join(privateDir, 'pronunciation-missing.txt'), `${missing.join('\n')}${missing.length ? '\n' : ''}`)
    business = { words: spellings.length, covered: Object.keys(variants).length, missing: missing.length }
  }
  console.log(JSON.stringify({ output: path.relative(ROOT, outputPath), entries: Object.keys(asset.entries).length, bytes: fs.statSync(outputPath).size, business }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
