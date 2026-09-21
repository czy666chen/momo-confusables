export type RestorableState = {
  selected: string[]
  customMeanings: Record<string, string>
  drafts: Record<string, string>
  manualText: string
  candidateText: string
}

export const EMPTY_RESTORABLE_STATE: RestorableState = {
  selected: [], customMeanings: {}, drafts: {}, manualText: '', candidateText: '',
}

export function readRestorableState(storage: Pick<Storage, 'getItem'>, key: string): RestorableState {
  try {
    const value = JSON.parse(storage.getItem(key) ?? '') as Partial<RestorableState>
    return {
      selected: Array.isArray(value.selected) ? value.selected.filter(v => typeof v === 'string').slice(0, 5000) : [],
      customMeanings: value.customMeanings && typeof value.customMeanings === 'object' ? value.customMeanings : {},
      drafts: value.drafts && typeof value.drafts === 'object' ? value.drafts : {},
      manualText: typeof value.manualText === 'string' ? value.manualText.slice(0, 5000) : '',
      candidateText: typeof value.candidateText === 'string' ? value.candidateText.slice(0, 2_000_000) : '',
    }
  } catch { return EMPTY_RESTORABLE_STATE }
}

export function writeRestorableState(storage: Pick<Storage, 'setItem'>, key: string, value: RestorableState): void {
  try { storage.setItem(key, JSON.stringify(value)) } catch { /* 浏览器禁用或存储已满时保持内存模式 */ }
}
