export const CMUDICT_VERSION = '74790861f652b15e4ac49015a90074ad62a27690'
export const PRONUNCIATION_SCORING_VERSION = 'phoneme-unit-edit-v1'
// Threshold policy is versioned separately: dictionary / G2P encodings stay compatible.
export const PRONUNCIATION_POLICY_VERSION = 'phoneme-threshold-v1'
export const DEFAULT_PRONUNCIATION_THRESHOLD = 0.65
export const PRONUNCIATION_ASSET_URL = `/pronunciation/cmudict-${CMUDICT_VERSION.slice(0, 8)}-v2.json`
export const G2P_MODEL_VERSION = 'g2p-en-2.1.0-checkpoint20'
export const G2P_MODEL_SHA256 = 'b8af35e4596d8dd5836dfd3fe9b2ba4f97b9c311efe8879544cbcfcbd566d8c6'
export const G2P_PIPELINE_VERSION = 'g2p-private-v1'
export const MAX_PREDICTION_FILE_BYTES = 2 * 1024 * 1024
const VOWELS = new Set('AA AE AH AO AW AY EH ER EY IH IY OW OY UH UW'.split(' '))
const CONSONANTS = new Set('B CH D DH F G HH JH K L M N NG P R S SH T TH V W Y Z ZH'.split(' '))

export type EncodedPronunciation = [phones: string, stress: string]
export type PronunciationAsset = { schemaVersion: 1; dictionaryVersion: string; scoringVersion: string; source: string; entries: Record<string, EncodedPronunciation[]> }
export type PredictionAsset = { schemaVersion: 1; source: 'prediction'; dictionaryVersion: string; scoringVersion: string; pipelineVersion: string; modelVersion: string; modelSha256: string; entries: Record<string, EncodedPronunciation[]> }
export type PronunciationVariant = { phones: string[]; stress: Array<0 | 1 | 2 | null>; source?: 'dictionary' | 'prediction'; modelVersion?: string }
export type PronunciationMatch = { similarity: number; distance: number; left: PronunciationVariant; right: PronunciationVariant; source: 'dictionary' | 'prediction' | 'mixed' }
export type PronunciationDictionary = Map<string, PronunciationVariant[]>

export function normalizePronunciationKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s*-\s*/gu, '-')
    .replace(/\s+/gu, ' ')
}

export function decodePronunciation([phones, encodedStress]: EncodedPronunciation): PronunciationVariant {
  const tokens = phones.split(' ').filter(Boolean)
  const stress = Array.from(encodedStress, value => value === '0' || value === '1' || value === '2' ? Number(value) as 0 | 1 | 2 : null)
  if (!tokens.length || stress.length !== tokens.length || tokens.some((token, index) => VOWELS.has(token) ? !/[012]/u.test(encodedStress[index]) : !CONSONANTS.has(token) || encodedStress[index] !== '-')) throw new Error('读音音素或重音格式无效')
  return { phones: tokens, stress }
}

export function parsePronunciationAsset(value: unknown): { metadata: Omit<PronunciationAsset, 'entries'>; dictionary: PronunciationDictionary } {
  if (!value || typeof value !== 'object') throw new Error('CMUdict 资源不是对象')
  const asset = value as Partial<PronunciationAsset>
  if (asset.schemaVersion !== 1 || asset.dictionaryVersion !== CMUDICT_VERSION || asset.scoringVersion !== PRONUNCIATION_SCORING_VERSION || !asset.entries || typeof asset.entries !== 'object' || Array.isArray(asset.entries)) throw new Error('CMUdict 资源版本不匹配')
  const dictionary: PronunciationDictionary = new Map()
  for (const [word, encodedVariants] of Object.entries(asset.entries)) {
    if (!Array.isArray(encodedVariants) || !encodedVariants.length) throw new Error('CMUdict 读音条目无效')
    const variants: PronunciationVariant[] = []
    for (const encoded of encodedVariants) {
      if (!Array.isArray(encoded) || encoded.length !== 2 || typeof encoded[0] !== 'string' || typeof encoded[1] !== 'string') throw new Error('CMUdict 读音条目无效')
      variants.push(decodePronunciation(encoded as EncodedPronunciation))
    }
    if (variants.length) dictionary.set(word, variants)
  }
  if (!dictionary.size) throw new Error('CMUdict 资源为空')
  return { metadata: { schemaVersion: 1, dictionaryVersion: asset.dictionaryVersion, scoringVersion: asset.scoringVersion, source: typeof asset.source === 'string' ? asset.source : '' }, dictionary }
}

export function parsePredictionAsset(value: unknown): { asset: PredictionAsset; dictionary: PronunciationDictionary } {
  if (!value || typeof value !== 'object') throw new Error('预测读音文件不是对象')
  const asset = value as Partial<PredictionAsset>
  if (asset.schemaVersion !== 1 || asset.source !== 'prediction' || asset.dictionaryVersion !== CMUDICT_VERSION || asset.scoringVersion !== PRONUNCIATION_SCORING_VERSION || asset.pipelineVersion !== G2P_PIPELINE_VERSION || asset.modelVersion !== G2P_MODEL_VERSION || asset.modelSha256 !== G2P_MODEL_SHA256) throw new Error('预测读音版本不匹配，请重新生成文件')
  if (!asset.entries || typeof asset.entries !== 'object' || Array.isArray(asset.entries)) throw new Error('预测读音条目无效')
  const entries = Object.entries(asset.entries)
  if (!entries.length || entries.length > 10000) throw new Error('预测读音文件须包含 1～10000 个词')
  const dictionary: PronunciationDictionary = new Map()
  for (const [word, encodedVariants] of entries) {
    if (word !== normalizePronunciationKey(word) || word.length > 100 || !/^[a-z]+(?:['-][a-z]+)*$/u.test(word) || !Array.isArray(encodedVariants) || !encodedVariants.length || encodedVariants.length > 10) throw new Error('预测读音条目无效')
    const variants = encodedVariants.map(encoded => {
      if (!Array.isArray(encoded) || encoded.length !== 2 || typeof encoded[0] !== 'string' || typeof encoded[1] !== 'string' || encoded[1].length > 200) throw new Error('预测读音格式无效')
      return { ...decodePronunciation(encoded as EncodedPronunciation), source: 'prediction' as const, modelVersion: G2P_MODEL_VERSION }
    })
    dictionary.set(word, variants)
  }
  return { asset: asset as PredictionAsset, dictionary }
}

export function mergePronunciations(dictionary: PronunciationDictionary, predictions: PronunciationDictionary): PronunciationDictionary {
  const merged = new Map(dictionary)
  for (const [word, variants] of predictions) if (!merged.has(word)) merged.set(word, variants)
  return merged
}

export function phonemeEditDistance(left: string[], right: string[]): number {
  if (left.length > right.length) return phonemeEditDistance(right, left)
  let previous = Array.from({ length: left.length + 1 }, (_, index) => index)
  for (let row = 1; row <= right.length; row++) {
    const current = new Array<number>(left.length + 1)
    current[0] = row
    for (let column = 1; column <= left.length; column++) {
      const substitution = previous[column - 1] + (left[column - 1] === right[row - 1] ? 0 : 1)
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[left.length]
}

function variantKey(variant: PronunciationVariant): string {
  return `${variant.phones.join(' ')}|${variant.stress.map(value => value ?? '-').join('')}`
}

export function comparePronunciations(left: PronunciationVariant[] | undefined, right: PronunciationVariant[] | undefined): PronunciationMatch | null {
  if (!left?.length || !right?.length) return null
  let best: PronunciationMatch | null = null
  for (const leftVariant of left) {
    if (!leftVariant.phones.length) continue
    for (const rightVariant of right) {
      if (!rightVariant.phones.length) continue
      const denominator = Math.max(leftVariant.phones.length, rightVariant.phones.length)
      const distance = phonemeEditDistance(leftVariant.phones, rightVariant.phones)
      const leftSource = leftVariant.source ?? 'dictionary'
      const rightSource = rightVariant.source ?? 'dictionary'
      const candidate: PronunciationMatch = { similarity: 1 - distance / denominator, distance, left: leftVariant, right: rightVariant, source: leftSource === rightSource ? leftSource : 'mixed' }
      if (!best || candidate.similarity > best.similarity || (candidate.similarity === best.similarity && `${variantKey(candidate.left)}|${variantKey(candidate.right)}` < `${variantKey(best.left)}|${variantKey(best.right)}`)) best = candidate
    }
  }
  return best
}
