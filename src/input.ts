import { normalize } from './similarity.ts'

const ENGLISH_TERM = /^[a-z]+(?:[ '-][a-z]+)*$/u

export function parseManualInput(text: string) {
  const items = text.split(/[\r\n,，]+/).map(s => s.trim()).filter(Boolean)
  const invalid: string[] = []
  const words: string[] = []
  const seen = new Set<string>()
  let duplicates = 0
  for (const item of items) {
    const norm = normalize(item)
    if (!ENGLISH_TERM.test(norm)) invalid.push(item)
    else if (seen.has(norm)) duplicates++
    else { seen.add(norm); words.push(item) }
  }
  return { words, invalid, duplicates }
}

export function parseCandidateList(text: string) {
  const items = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const words: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  let duplicates = 0
  for (const item of items) {
    const norm = normalize(item)
    if (!ENGLISH_TERM.test(norm)) invalid.push(item)
    else if (seen.has(norm)) duplicates++
    else { seen.add(norm); words.push(item) }
  }
  return { words, invalid, duplicates, total: items.length }
}

// Soundex 只作为独立、可解释的英文读音近似信号，不参与现有拼写分排序。
export function soundex(value: string): string {
  const letters = normalize(value).replace(/[^a-z]/g, '')
  if (!letters) return ''
  const groups: Record<string, string> = {
    b: '1', f: '1', p: '1', v: '1', c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3', l: '4', m: '5', n: '5', r: '6',
  }
  let previous = groups[letters[0]] ?? ''
  let digits = ''
  for (const letter of letters.slice(1)) {
    const next = groups[letter] ?? ''
    if (next && next !== previous) digits += next
    previous = next
  }
  return (letters[0].toUpperCase() + digits + '000').slice(0, 4)
}

export type ConfusionSignal = { phoneticScore: number; phoneticMatch: boolean; explanation: string }

export function confusionSignal(a: string, b: string): ConfusionSignal {
  const left = soundex(a)
  const right = soundex(b)
  const matches = left && right ? [...left].filter((char, index) => char === right[index]).length : 0
  const phoneticScore = matches / 4
  const phoneticMatch = Boolean(left && left === right)
  const explanation = phoneticMatch
    ? `读音编码同为 ${left}，可能听起来接近；这是启发式提示，不代表词典音标结论。`
    : `读音近似 ${Math.round(phoneticScore * 100)}%；主要混淆仍来自拼写形态。`
  return { phoneticScore, phoneticMatch, explanation }
}
