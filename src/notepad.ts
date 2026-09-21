// 云词本内容合并与写入核对（路线图第 5.2/5.3 节）。纯函数模块：界面与测试共用，不发请求。
// 拼写标准化与第 4.1 节一致（NFKC + trim + lowercase）；不 import similarity，供 Node 直接加载。

// 官方 OpenAPI 示例把 word/chapter 放在 data 里，真实账号详情实测为顶层字段；两种形状都要接受。
export type ParsedItem = { type?: string; word?: string; chapter?: string; data?: { word?: string; chapter?: string } }
export type BriefNotepad = { id: string; type?: string; status?: string; title?: string; brief?: string; tags?: string[]; created_time?: string; updated_time?: string }
export type NotepadDetail = BriefNotepad & { content?: string; list?: ParsedItem[] }
export type NotepadPayload = { status: string; content: string; title: string; brief: string; tags: string[] }

export type SubmitWord = { id: string; spelling: string; norm: string }
export type MergePlan = { mode: 'chapter' | 'text'; newWords: SubmitWord[]; duplicates: SubmitWord[]; content: string }
export type WordOutcome = { spelling: string; norm: string; status: 'added' | 'already' | 'unrecognized' }

export const CHAPTER_TITLE = '易混淆词'
// 与 worker 的 MAX_NOTEPAD_BYTES 同一产品约定；官方最大容量未测。
export const MAX_NOTEPAD_BYTES = 50_000

export function normalizeWord(spelling: string): string {
  return spelling.normalize('NFKC').trim().toLowerCase()
}

export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

// 章节模式按正文首个非空行是否以 # 开头判断（规范对 content 的定义）；空白正文按新建章节处理。
export function detectMode(content: string): 'chapter' | 'text' {
  const first = content.split(/\r?\n/).find(line => line.trim() !== '') ?? ''
  return first.trimStart().startsWith('#') ? 'chapter' : 'text'
}

export function parsedWords(list: ParsedItem[] | undefined): Set<string> {
  const words = new Set<string>()
  for (const item of list ?? []) {
    const word = typeof item?.word === 'string' ? item.word : item?.data?.word
    if (item?.type === 'WORD' && typeof word === 'string') words.add(normalizeWord(word))
  }
  return words
}

// 已选词按 ID 去重后仍可能出现同拼写不同 ID（跨模式勾选），按标准化拼写再去重一次。
export function dedupeSpellings(entries: { id: string; spelling: string }[]): SubmitWord[] {
  const seen = new Set<string>()
  const out: SubmitWord[] = []
  for (const entry of entries) {
    const norm = normalizeWord(entry.spelling)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push({ id: entry.id, spelling: entry.spelling.trim(), norm })
  }
  return out
}

export function chapterContent(words: SubmitWord[]): string {
  return `# ${CHAPTER_TITLE}\n${words.map(w => w.spelling).join('\n')}`
}

// 解析列表存在滞后/不一致（真实账号实测：写入后短时间内的详情读取可能仍返回旧 list），
// 而 content 字段总是同步返回，因此已有词判定 = 解析列表 ∪ 正文行（跳过 # 章节标题与 // 标记）。
export function contentWords(content: string | undefined): Set<string> {
  const words = new Set<string>()
  for (const line of (content ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    words.add(normalizeWord(t))
  }
  return words
}

// 追加必须走“读取最新详情 → 识别已有词 → 去重合并 → 提交完整内容”。
// 保留原正文（含 // 原型提取标记与既有章节），仅规范化结尾空白后接新内容；无新词时原文逐字不动。
export function planAppend(detail: NotepadDetail, selected: SubmitWord[]): MergePlan {
  const original = typeof detail.content === 'string' ? detail.content : ''
  const existing = new Set([...parsedWords(detail.list), ...contentWords(original)])
  const newWords: SubmitWord[] = []
  const duplicates: SubmitWord[] = []
  for (const word of selected) (existing.has(word.norm) ? duplicates : newWords).push(word)
  const mode: 'chapter' | 'text' = original.trim() ? detectMode(original) : 'chapter'
  if (!newWords.length) return { mode, newWords, duplicates, content: original }
  const base = original.replace(/[\r\n\t ]+$/, '')
  const lines = newWords.map(w => w.spelling).join('\n')
  const content = !base.trim()
    ? chapterContent(newWords)
    : mode === 'chapter'
      ? `${base}\n\n# ${CHAPTER_TITLE}\n${lines}`
      : `${base}\n${lines}`
  return { mode, newWords, duplicates, content }
}

export function planCreate(selected: SubmitWord[], title: string, brief: string): NotepadPayload {
  return { status: 'UNPUBLISHED', content: chapterContent(selected), title: title.trim(), brief: brief.trim(), tags: [] }
}

// 外部并发写入无法事后消除，但提交前必须复检：updated_time 与正文任一变化即视为过期快照。
export function snapshotUnchanged(read: NotepadDetail, expected: NotepadDetail): boolean {
  return (read.updated_time ?? '') === (expected.updated_time ?? '') && (read.content ?? '') === (expected.content ?? '')
}

// 上游没有 CAS；写入后只有正文与提交计划逐字一致，才能排除已观测到的并发覆盖或上游改写。
export function writeMatchesPlan(readBack: NotepadDetail, expectedContent: string): boolean {
  return (readBack.content ?? '') === expectedContent
}

// 回读核对（第 5.2 节第 5 步）：以写入前已有词集合与回读详情共同分类，HTTP 成功不等于全部成功。
// 回读判定 = 解析列表 ∪ 正文行；解析列表可能滞后，正文出现该词即可确认加入。
export function classifyOutcomes(submitted: SubmitWord[], before: Set<string>, readBack: NotepadDetail): WordOutcome[] {
  const after = new Set([...parsedWords(readBack.list), ...contentWords(readBack.content)])
  return submitted.map(word => ({
    spelling: word.spelling,
    norm: word.norm,
    status: before.has(word.norm) ? 'already' : after.has(word.norm) ? 'added' : 'unrecognized',
  }))
}

// 新建响应丢失时按标题与创建时间窗筛选候选，唯一性由调用方再取详情比对正文后判定。
export function findRecentByTitle(list: BriefNotepad[], title: string, sinceMs: number): BriefNotepad[] {
  const wanted = normalizeWord(title)
  return list.filter(item => normalizeWord(item.title ?? '') === wanted && Date.parse(item.created_time ?? '') >= sinceMs)
}
