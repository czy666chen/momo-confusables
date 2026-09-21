import assert from 'node:assert/strict'
import { CHAPTER_TITLE, normalizeWord, utf8Length, detectMode, parsedWords, contentWords, dedupeSpellings, planAppend, planCreate, chapterContent, snapshotUnchanged, classifyOutcomes, findRecentByTitle, writeMatchesPlan } from '../src/notepad.ts'

let passed = 0
function ok(name, fn) { fn(); passed++; console.log('  ✓', name) }

const word = (id, spelling) => ({ id, spelling })
const sw = (...spellings) => dedupeSpellings(spellings.map((s, i) => word('w' + i, s)))
const wordItems = (...spellings) => spellings.map(s => ({ type: 'WORD', data: { word: s, chapter: 'x' } }))

console.log('P4 云词本合并与核对测试')

// —— 模式检测 ——
ok('空正文按章节模式新建；首非空行以 # 开头为章节模式', () => {
  assert.equal(detectMode(''), 'text') // 裸检测不看空串，planAppend 负责空正文
  assert.equal(detectMode('# 章节A\napple'), 'chapter')
  assert.equal(detectMode('\n\n  # 章节A\napple'), 'chapter')
})
ok('文本模式判定只看首个非空行，正文中间出现 # 不误判', () => {
  assert.equal(detectMode('apple\n# not a chapter\nbanana'), 'text')
  assert.equal(detectMode('//\napple'), 'text')
})

// —— 追加合并 ——
ok('空正文追加 → 新章节结构', () => {
  const plan = planAppend({ id: 'x', content: '   \n', list: [] }, sw('adapt', 'adopt'))
  assert.equal(plan.mode, 'chapter')
  assert.equal(plan.content, `# ${CHAPTER_TITLE}\nadapt\nadopt`)
})
ok('章节模式：原正文逐字保留为前缀，空行后接新章节', () => {
  const original = '# 我的章节\nform\nfrom\n'
  const plan = planAppend({ id: 'x', content: original, list: wordItems('form', 'from') }, sw('adapt', 'adopt'))
  assert.equal(plan.mode, 'chapter')
  assert.ok(plan.content.startsWith('# 我的章节\nform\nfrom'))
  assert.equal(plan.content, `# 我的章节\nform\nfrom\n\n# ${CHAPTER_TITLE}\nadapt\nadopt`)
  assert.deepEqual(plan.newWords.map(w => w.spelling), ['adapt', 'adopt'])
  assert.equal(plan.duplicates.length, 0)
})
ok('文本模式保持原模式，以换行逐词追加且 // 原型标记不被破坏', () => {
  const original = '//\naccept\naccess'
  const plan = planAppend({ id: 'x', content: original, list: wordItems('accept', 'access') }, sw('except'))
  assert.equal(plan.mode, 'text')
  assert.equal(plan.content, '//\naccept\naccess\nexcept')
})
ok('CRLF 正文：仅规范结尾空白，既有行完整保留', () => {
  const original = '# A\r\napple\r\n\r\n'
  const plan = planAppend({ id: 'x', content: original, list: wordItems('apple') }, sw('banana'))
  assert.ok(plan.content.startsWith('# A\r\napple'))
  assert.equal(plan.content, `# A\r\napple\n\n# ${CHAPTER_TITLE}\nbanana`)
})
ok('所选词全部已存在 → 正文逐字不动、不产生写入', () => {
  const original = '# A\napple\n\n'
  const plan = planAppend({ id: 'x', content: original, list: wordItems('APPLE ') }, sw('apple'))
  assert.equal(plan.content, original)
  assert.equal(plan.newWords.length, 0)
  assert.equal(plan.duplicates.length, 1)
})
ok('已有词按解析列表识别并以标准化拼写比对（大小写/全角/空白）', () => {
  const existing = parsedWords([{ type: 'WORD', data: { word: 'Ａｄａｐｔ ' } }, { type: 'CHAPTER', data: { chapter: 'c' } }])
  assert.ok(existing.has(normalizeWord(' adapt ')))
  assert.equal(existing.size, 1)
})
// 真实账号详情的 list 为顶层字段（{type:'WORD', word, chapter}），与 OpenAPI 示例的 data 嵌套不同；
// 若只认 data 形状，去重会静默地把已有词当新词重复追加。
ok('真实账号扁平 list 形状：去重、合并与回读分类都识别顶层 word', () => {
  const flat = [{ type: 'CHAPTER', chapter: '单词列表' }, { type: 'DRAFT_WORD', word: '1' }, { type: 'WORD', word: 'Mobility', chapter: '单词列表' }]
  assert.deepEqual([...parsedWords(flat)], ['mobility'])
  const plan = planAppend({ id: 'x', content: '1\nmobility', list: flat }, sw('mobility', 'strip'))
  assert.deepEqual(plan.newWords.map(w => w.spelling), ['strip'])
  assert.deepEqual(plan.duplicates.map(w => w.spelling), ['mobility'])
  const outcomes = classifyOutcomes(sw('mobility', 'strip'), new Set(), { list: flat })
  assert.deepEqual(Object.fromEntries(outcomes.map(o => [o.spelling, o.status])), { mobility: 'added', strip: 'unrecognized' })
})
// 真实账号实测：写入后短时间的详情读取会返回滞后/空的解析列表，但 content 总是最新。
// 若去重与回读只看 list，重复提交会静默地把同一批词再追加一遍。
ok('解析列表滞后时以正文行为准：去重不重复追加，回读按正文确认加入', () => {
  assert.deepEqual([...contentWords('1\nmobility\n# 章节\n// 标记\n\n')], ['1', 'mobility'])
  const stale = { id: 'x', content: '1\nmobility', list: [{ type: 'CHAPTER', chapter: '单词列表' }] }
  const plan = planAppend(stale, sw('mobility', 'strip'))
  assert.deepEqual(plan.newWords.map(w => w.spelling), ['strip'])
  assert.deepEqual(plan.duplicates.map(w => w.spelling), ['mobility'])
  const readBack = { content: '1\nmobility\nstrip', list: [] } // list 尚未解析
  const outcomes = classifyOutcomes(sw('mobility', 'strip'), new Set(['mobility']), readBack)
  assert.deepEqual(Object.fromEntries(outcomes.map(o => [o.spelling, o.status])), { mobility: 'already', strip: 'added' })
})
ok('所选词同拼写不同 ID 只保留首次出现', () => {
  const list = dedupeSpellings([word('1', 'Adopt'), word('2', 'adopt'), word('3', 'adapt'), word('4', '  ')])
  assert.deepEqual(list.map(w => [w.id, w.spelling]), [['1', 'Adopt'], ['3', 'adapt']])
})

// —— 新建 ——
ok('planCreate：UNPUBLISHED、空标签、章节模式正文且中文不进正文', () => {
  const payload = planCreate(sw('adapt', 'adopt'), '易混淆词 ', '手动筛选的拼写相近单词')
  assert.equal(payload.status, 'UNPUBLISHED')
  assert.deepEqual(payload.tags, [])
  assert.equal(payload.title, '易混淆词')
  assert.equal(payload.content, chapterContent(sw('adapt', 'adopt')))
  assert.ok(!/[\u3400-\u9fff]/.test(payload.content.split('\n').slice(1).join('\n')))
})

// —— 快照复检 ——
ok('updated_time 或正文任一外部变化都被检出', () => {
  const a = { id: 'x', content: 'c', updated_time: 't1' }
  assert.ok(snapshotUnchanged({ ...a }, { ...a }))
  assert.ok(!snapshotUnchanged({ ...a, updated_time: 't2' }, a))
  assert.ok(!snapshotUnchanged({ ...a, content: 'changed' }, a))
  assert.ok(snapshotUnchanged({ id: 'x', content: 'c' }, { id: 'x', content: 'c' }))
})

ok('写入回读正文不一致时识别为并发或上游改写', () => {
  assert.ok(writeMatchesPlan({ id: 'x', content: '# 易混淆词\nadapt' }, '# 易混淆词\nadapt'))
  assert.ok(!writeMatchesPlan({ id: 'x', content: '# 外部修改\nadopt' }, '# 易混淆词\nadapt'))
})

// —— 回读分类 ——
ok('回读核对：已确认加入 / 已存在 / 未识别 分列，HTTP 成功不报全部成功', () => {
  const submitted = sw('adapt', 'adopt', 'adept', 'acclivity')
  const before = new Set(['adopt'])
  const readBack = wordItems('adopt', 'adapt') // adept 已在但解析缺失? 不：adept 未解析出、acclivity 也未解析
  readBack.push({ type: 'WORD', data: { word: 'ADEPT' } })
  const outcomes = classifyOutcomes(submitted, before, { list: readBack })
  assert.deepEqual(Object.fromEntries(outcomes.map(o => [o.spelling, o.status])), {
    adapt: 'added', adopt: 'already', adept: 'added', acclivity: 'unrecognized',
  })
})

// —— 新建丢失后的候选筛选 ——
ok('findRecentByTitle：标题标准化匹配且创建时间早于下界的被排除', () => {
  const t = Date.now()
  const list = [
    { id: '1', title: ' 易混淆词', created_time: new Date(t - 1000).toISOString() },
    { id: '2', title: '易混淆词', created_time: new Date(t - 600_000).toISOString() },
    { id: '3', title: '其他词本', created_time: new Date(t).toISOString() },
    { id: '4', title: '易混淆词' },
  ]
  assert.deepEqual(findRecentByTitle(list, '易混淆词', t - 60_000).map(n => n.id), ['1'])
})

// —— 字节上限 ——
ok('utf8Length 按字节计量（中文 3 字节/字），供正文上限检查', () => {
  assert.equal(utf8Length('易混'), 6)
  assert.equal(utf8Length('adopt'), 5)
})

console.log(`\n全部通过：${passed} 组`)
