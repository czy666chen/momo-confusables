import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { DEFAULT_MATCH_TYPES, type CombinedManualHit, type CombinedPair, type MatchType } from './similarity'
import { CHAPTER_TITLE, MAX_NOTEPAD_BYTES, chapterContent, classifyOutcomes, contentWords, dedupeSpellings, detectMode, findRecentByTitle, parsedWords, planAppend, planCreate, snapshotUnchanged, utf8Length, writeMatchesPlan, type BriefNotepad, type NotepadDetail, type WordOutcome } from './notepad'
import { ApiError, api, reportMetric } from './api'
import { parseCandidateList, parseManualInput } from './input'
import { fetchMeanings, supplementRecords, syncStudyRecords, type Coverage, type RecordRow } from './study-data'
import { readRestorableState, writeRestorableState } from './session-state'
import { ApiGuide, MatchTypeBadges, MatchTypeSelector, MeaningForm, Pager, PairCheck, PronunciationBadge, SyncProgress, type ProgressState } from './ui'
import { extractCandidateFile } from './candidate-file'
import { DEFAULT_PRONUNCIATION_THRESHOLD, MAX_PREDICTION_FILE_BYTES, parsePredictionAsset, type PredictionAsset } from './pronunciation'

type DiscoveryStats = { before: number; comparisons: number; qualified: number }
type DiscoverStatus = 'idle' | 'running' | 'done' | 'error'
const PAGE_WORDS = 25
const PAGE_RESULTS = 30
const THRESHOLD_DEFAULT = DEFAULT_PRONUNCIATION_THRESHOLD
const THRESHOLD_STEP = 0.05
const MAX_WEAK = 1000
const MAX_MANUAL_QUERY = 20
const PRONUNCIATION_THRESHOLD = DEFAULT_PRONUNCIATION_THRESHOLD
const RESPONSE_LABELS: Record<string, string> = { FORGET: '忘记', VAGUE: '模糊', REMEMBER: '记得', WELL_FAMILIAR: '熟知', CANCEL_WELL_FAMILIAR: '取消熟知' }
const OUTCOME_LABELS: Record<WordOutcome['status'], string> = { added: '已确认加入', already: '已在词本中', unrecognized: '未在解析结果中确认' }
const MATCH_TYPE_NAMES: Record<MatchType, string> = { spelling: '相似', reorder: '换序', pronunciation: '发音' }

function responseLabel(row?: RecordRow): string {
  return row?.last_response ? RESPONSE_LABELS[row.last_response] ?? row.last_response : '反馈未知'
}

type WorkerMessage = { taskId: number; type: string; done?: number; total?: number; pairs?: CombinedPair[]; hits?: CombinedManualHit[]; stats?: DiscoveryStats; comparisons?: number; message?: string; pronunciationError?: string; pronunciationCoverage?: { missingWords: number; missingQueries?: string[] } }
const SESSION_STATE_KEY = 'momo-confusables:workspace'
const restored = readRestorableState(window.sessionStorage, SESSION_STATE_KEY)
type ViewMode = 'words' | 'discover' | 'manual'
const initialParams = new URLSearchParams(window.location.search)
const initialMode = (['words', 'discover', 'manual'] as const).find(value => value === initialParams.get('view')) ?? 'words'
const initialPage = (key: string) => {
  const value = Number(initialParams.get(key))
  return Number.isSafeInteger(value) && value > 0 ? value - 1 : 0
}
const initialThreshold = (() => {
  const value = Number(initialParams.get('threshold'))
  return initialParams.has('threshold') && Number.isFinite(value) && value >= 0 && value <= 1 ? value : THRESHOLD_DEFAULT
})()
const initialMatchTypes = (() => {
  const requested = initialParams.get('types')?.split(',') ?? []
  const selected = DEFAULT_MATCH_TYPES.filter(type => requested.includes(type))
  return selected.length ? selected : DEFAULT_MATCH_TYPES
})()

function App() {
  const [guideOpen, setGuideOpen] = useState(() => window.location.hash === '#api-guide')
  const [connected, setConnected] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState<Coverage | null>(null)
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [page, setPage] = useState(() => initialPage('page'))
  const [meanings, setMeanings] = useState<Record<string, string | null>>({})
  const [customMeanings, setCustomMeanings] = useState<Record<string, string>>(restored.customMeanings)
  const [drafts, setDrafts] = useState<Record<string, string>>(restored.drafts)
  const [meaningError, setMeaningError] = useState('')
  const [meaningRetry, setMeaningRetry] = useState(0)
  const [filter, setFilter] = useState(() => initialParams.get('filter') ?? '')
  const [candidateText, setCandidateText] = useState(restored.candidateText)
  const [candidateNotice, setCandidateNotice] = useState('')
  const [predictions, setPredictions] = useState<PredictionAsset | undefined>()
  const [predictionNotice, setPredictionNotice] = useState('')
  const [predictionError, setPredictionError] = useState('')
  const predictionImportRef = useRef(0)

  // P2：薄弱词自动发现；P3：手动查找
  const [mode, setMode] = useState<ViewMode>(initialMode)
  const [threshold, setThreshold] = useState(initialThreshold)
  const [weakFilter, setWeakFilter] = useState(() => initialParams.get('weak') ?? '')
  const [matchTypes, setMatchTypes] = useState<MatchType[]>(initialMatchTypes)
  const [matchTypeMessage, setMatchTypeMessage] = useState('')
  const [status, setStatus] = useState<DiscoverStatus>('idle')
  const [discoverError, setDiscoverError] = useState('')
  const [runningText, setRunningText] = useState('')
  const [pairs, setPairs] = useState<CombinedPair[]>([])
  const [pronunciationWarning, setPronunciationWarning] = useState('')
  const [pronunciationMissing, setPronunciationMissing] = useState(0)
  const [stats, setStats] = useState<DiscoveryStats | null>(null)
  const [pairPage, setPairPage] = useState(() => initialPage('pairs'))
  const [ranConfig, setRanConfig] = useState<{ threshold: number; filter: string; matchTypes: MatchType[] } | null>(null)
  const [manualText, setManualText] = useState(restored.manualText)
  const [manualStatus, setManualStatus] = useState<DiscoverStatus>('idle')
  const [manualError, setManualError] = useState('')
  const [manualNotice, setManualNotice] = useState('')
  const [manualRunningText, setManualRunningText] = useState('')
  const [manualHits, setManualHits] = useState<CombinedManualHit[]>([])
  const [manualPronunciationWarning, setManualPronunciationWarning] = useState('')
  const [manualPronunciationMissing, setManualPronunciationMissing] = useState<{ missingWords: number; missingQueries: string[] } | null>(null)
  const [manualComparisons, setManualComparisons] = useState(0)
  const [manualPage, setManualPage] = useState(() => initialPage('matches'))
  const [ranQueries, setRanQueries] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set(restored.selected))
  const [clearedSelection, setClearedSelection] = useState<Set<string> | null>(null)
  const manualQueryRef = useRef<HTMLTextAreaElement>(null)
  // P4：批量加入云词本
  const [submitOpen, setSubmitOpen] = useState(false)
  const [target, setTarget] = useState<string>('create') // 'create' 或已有词本 id（'' 表示尚未选择）
  const [notepadList, setNotepadList] = useState<BriefNotepad[] | null>(null)
  const [notepadListError, setNotepadListError] = useState('')
  const [detail, setDetail] = useState<NotepadDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [newTitle, setNewTitle] = useState(CHAPTER_TITLE)
  const [newBrief, setNewBrief] = useState('手动筛选的拼写相近单词')
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'done' | 'pending'>('idle')
  const [submitError, setSubmitError] = useState('')
  const [submitNotice, setSubmitNotice] = useState('')
  const [outcomes, setOutcomes] = useState<WordOutcome[] | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const taskRef = useRef(0)

  useEffect(() => { api('session').then(() => setConnected(true)).catch(() => {}) }, [])
  useEffect(() => {
    writeRestorableState(window.sessionStorage, SESSION_STATE_KEY, { selected: [...selected], customMeanings, drafts, manualText, candidateText })
  }, [selected, customMeanings, drafts, manualText, candidateText])
  useEffect(() => {
    const syncRoute = () => { setGuideOpen(window.location.hash === '#api-guide'); window.scrollTo({ top: 0 }) }
    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])
  useEffect(() => {
    const url = new URL(window.location.href)
    const values: Record<string, string> = {
      view: mode === 'words' ? '' : mode,
      page: page ? String(page + 1) : '',
      filter,
      pairs: pairPage ? String(pairPage + 1) : '',
      matches: manualPage ? String(manualPage + 1) : '',
      weak: weakFilter,
      threshold: threshold === THRESHOLD_DEFAULT ? '' : String(threshold),
      types: matchTypes.length === DEFAULT_MATCH_TYPES.length ? '' : matchTypes.join(','),
    }
    for (const [key, value] of Object.entries(values)) {
      if (value) url.searchParams.set(key, value)
      else url.searchParams.delete(key)
    }
    window.history.replaceState(null, '', url)
  }, [mode, page, filter, pairPage, manualPage, weakFilter, threshold, matchTypes])
  useEffect(() => {
    const restoreView = () => {
      const params = new URLSearchParams(window.location.search)
      setMode((['words', 'discover', 'manual'] as const).find(value => value === params.get('view')) ?? 'words')
      const readPage = (key: string) => { const value = Number(params.get(key)); return Number.isSafeInteger(value) && value > 0 ? value - 1 : 0 }
      setPage(readPage('page')); setPairPage(readPage('pairs')); setManualPage(readPage('matches'))
      setFilter(params.get('filter') ?? ''); setWeakFilter(params.get('weak') ?? '')
      const value = Number(params.get('threshold'))
      setThreshold(params.has('threshold') && Number.isFinite(value) && value >= 0 && value <= 1 ? value : THRESHOLD_DEFAULT)
      const requested = params.get('types')?.split(',') ?? []
      const selected = DEFAULT_MATCH_TYPES.filter(type => requested.includes(type))
      setMatchTypes(selected.length ? selected : DEFAULT_MATCH_TYPES)
    }
    window.addEventListener('popstate', restoreView)
    return () => window.removeEventListener('popstate', restoreView)
  }, [])

  // 自动发现与手动查找共用一个 Worker 与任务号；任一取消/重跑/断开都须丢弃旧任务。
  function spawnWorker(handle: (worker: Worker, message: WorkerMessage) => void): Worker {
    workerRef.current?.terminate()
    const task = ++taskRef.current
    const worker = new Worker(new URL('./similarity.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerMessage
      if (message.taskId !== task || workerRef.current !== worker) return
      handle(worker, message)
    }
    return worker
  }

  function resetSearch() {
    workerRef.current?.terminate(); workerRef.current = null; taskRef.current += 1
    setStatus('idle'); setDiscoverError(''); setRunningText(''); setPairs([]); setStats(null); setPairPage(0); setRanConfig(null); setPronunciationWarning(''); setPronunciationMissing(0)
    setManualStatus('idle'); setManualError(''); setManualNotice(''); setManualRunningText(''); setManualHits([]); setManualComparisons(0); setManualPage(0); setRanQueries(null); setManualPronunciationWarning(''); setManualPronunciationMissing(null)
  }

  function clearPredictions() {
    predictionImportRef.current += 1
    setPredictions(undefined); setPredictionNotice(''); setPredictionError(''); resetSearch()
  }

  async function importPredictions(file: File) {
    const generation = ++predictionImportRef.current
    setPredictionError('')
    try {
      if (file.size > MAX_PREDICTION_FILE_BYTES) throw new Error('预测读音文件不能超过 2 MB')
      const text = await file.text()
      if (generation !== predictionImportRef.current) return
      const { asset, dictionary } = parsePredictionAsset(JSON.parse(text))
      resetSearch(); setPredictions(asset)
      setPredictionNotice(`已载入 ${dictionary.size} 个预测读音，供自动发现和手动查找共用。`)
    } catch (e) {
      if (generation === predictionImportRef.current) setPredictionError(`预测读音导入失败：${(e as Error).message}。已有读音仍保留。`)
    }
  }

  // 断开、换 Token 或提交面板关闭时都不保留词本列表、详情与写入结果。
  function resetSubmit() {
    setSubmitOpen(false); setTarget('create'); setNotepadList(null); setNotepadListError(''); setDetail(null); setDetailError('')
    setSubmitState('idle'); setSubmitError(''); setSubmitNotice(''); setOutcomes(null)
  }

  async function authenticate(payload: { token?: string; useDevToken?: boolean }) {
    setBusy(true); setError('')
    try { await api('connect', payload); setToken(''); setConnected(true); setData(null); setSelected(new Set()); setClearedSelection(null); clearPredictions(); resetSubmit() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  function connect(event: React.FormEvent) { event.preventDefault(); void authenticate({ token }) }

  async function refresh() {
    const startedAt = performance.now()
    setBusy(true); setError(''); setProgress({ label: '正在核对总量…' }); resetSearch()
    // A failed refresh must not leave an old snapshot labelled as freshly verified.
    setData(current => current ? { ...current, finished: false } : null)
    try {
      const next = await syncStudyRecords(snapshot => { setData(snapshot); setProgress({ label: `已同步 ${snapshot.rows.length.toLocaleString()} / ${snapshot.total.toLocaleString()}`, current: snapshot.rows.length, total: snapshot.total }) })
      setData(next); setMeanings({}); setMeaningError('')
      reportMetric('sync_complete', { durationMs: Math.round(performance.now() - startedAt), rows: next.rows.length, total: next.total, finished: next.finished })
    } catch (e) {
      setError((e as Error).message + '。已取回的部分记录仍保留。')
      if (e instanceof ApiError && e.status === 401) setConnected(false)
    } finally { setBusy(false); setProgress(null) }
  }

  async function disconnect() {
    if ((selected.size || Object.keys(drafts).length || candidateText.trim() || manualText.trim()) && !window.confirm('断开连接会清除当前选择和未保存的输入，确定断开吗？')) return
    try { await api('disconnect', {}) } finally { setConnected(false); setData(null); setMeanings({}); setCustomMeanings({}); setDrafts({}); setCandidateText(''); setError(''); setPage(0); setSelected(new Set()); setClearedSelection(null); setMode('words'); clearPredictions(); resetSubmit() }
  }

  async function supplement() {
    if (!data) return
    const parsed = parseCandidateList(candidateText)
    const words = parsed.words
    if (parsed.invalid.length) { setError(`词表包含 ${parsed.invalid.length} 个无效项（例如：${parsed.invalid.slice(0, 3).join('、')}），请先修正。`); return }
    if (!words.length) { setError('候选词表为空，请每行填写一个完整拼写或短语。'); return }
    setCandidateNotice(`已解析 ${parsed.total} 行：${words.length} 个有效词${parsed.duplicates ? `，忽略 ${parsed.duplicates} 个重复项` : ''}。`)
    setBusy(true); setError(''); setProgress({ label: `已核对候选 0 / ${words.length.toLocaleString()}`, current: 0, total: words.length })
    try {
      const next = await supplementRecords(data, words, (done, total, snapshot) => {
        setData(snapshot)
        setProgress({ label: `已核对候选 ${done.toLocaleString()} / ${total.toLocaleString()}`, current: done, total })
      })
      setData(next)
      setCandidateText('')
    } catch (e) { setError((e as Error).message + '。已确认的候选记录仍保留。') }
    finally { setBusy(false); setProgress(null) }
  }

  // —— 薄弱词集合与自动发现 ——
  const weakRows = useMemo(() => {
    const needle = weakFilter.trim().toLowerCase()
    return (data?.rows ?? []).filter(r => (r.last_response === 'FORGET' || r.last_response === 'VAGUE') && (!needle || r.voc_spelling.toLowerCase().includes(needle)))
  }, [data, weakFilter])

  const unknownCount = useMemo(() => (data?.rows ?? []).filter(r => !r.last_response).length, [data])

  function runDiscovery(thresholdOverride?: number, matchTypesOverride: MatchType[] = matchTypes) {
    const startedAt = performance.now()
    const useThreshold = thresholdOverride ?? threshold
    if (weakRows.length < 2) { setStatus('error'); setDiscoverError('薄弱词不足两个，无法组成词对；请放宽筛选或先同步更多学习记录。'); setPairs([]); setStats(null); return }
    if (weakRows.length > MAX_WEAK) { setStatus('error'); setDiscoverError(`当前薄弱词 ${weakRows.length} 个，超过首版上限 ${MAX_WEAK}；请用下方筛选缩小范围，结果不做静默截断。`); setPairs([]); setStats(null); return }
    const worker = spawnWorker((w, message) => {
      if (message.type === 'progress') setRunningText(`正在比较 ${message.done?.toLocaleString()} / ${message.total?.toLocaleString()} 个词对…`)
      else if (message.type === 'done') { setPairs(message.pairs ?? []); setStats(message.stats ?? null); setStatus('done'); setDiscoverError(''); setPronunciationWarning(message.pronunciationError ?? ''); setPronunciationMissing(message.pronunciationCoverage?.missingWords ?? 0); setPairPage(0); reportMetric('similarity_complete', { mode: 'auto', durationMs: Math.round(performance.now() - startedAt), results: message.pairs?.length ?? 0 }); w.terminate(); workerRef.current = null }
      else if (message.type === 'error') { setStatus('error'); setDiscoverError(message.message ?? '相似度计算失败'); w.terminate(); workerRef.current = null }
    })
    setStatus('running'); setDiscoverError(''); setPronunciationWarning(''); setPronunciationMissing(0); setPairs([]); setStats(null); setPairPage(0); setRunningText('正在准备…'); setRanConfig({ threshold: useThreshold, filter: weakFilter, matchTypes: matchTypesOverride })
    if (manualStatus === 'running') { setManualStatus('idle'); setManualRunningText('') }
    worker.postMessage({ taskId: taskRef.current, kind: 'auto', words: weakRows.map(r => ({ id: r.voc_id, spelling: r.voc_spelling })), p: Math.round(useThreshold * 100), r: 100, matchTypes: matchTypesOverride, predictions: matchTypesOverride.includes('pronunciation') ? predictions : undefined })
  }

  function cancelDiscovery() { resetSearch() }

  function runManual(matchTypesOverride: MatchType[] = matchTypes) {
    const startedAt = performance.now()
    workerRef.current?.terminate()
    const parsed = parseManualInput(manualText)
    const fail = (message: string) => { setManualStatus('error'); setManualError(message); setManualNotice(''); manualQueryRef.current?.focus() }
    if (parsed.invalid.length) { fail(`无法识别的输入词：${parsed.invalid.join('、')}。请每行或用逗号分隔输入英文单词。`); return }
    if (!parsed.words.length) { fail('请输入至少一个英文查询词。'); return }
    if (parsed.words.length > MAX_MANUAL_QUERY) { fail(`去重后 ${parsed.words.length} 个查询词，超过本网站上限 ${MAX_MANUAL_QUERY} 个（这不是墨墨接口限制）；请减少查询词。`); return }
    if (!data || !data.rows.length) { fail('没有可比较的候选：请先同步学习记录。'); return }
    setManualStatus('running'); setManualError(''); setManualHits([]); setManualComparisons(0); setManualPronunciationWarning(''); setManualPronunciationMissing(null); setManualPage(0); setManualRunningText('正在准备…')
    setManualNotice(`已解析 ${parsed.words.length} 个查询词${parsed.duplicates ? `，忽略 ${parsed.duplicates} 个重复项` : ''}。`)
    setRanQueries(parsed.words)
    if (status === 'running') { setStatus('idle'); setRunningText('') }
    const worker = spawnWorker((w, message) => {
      if (message.type === 'progress') setManualRunningText(`正在比较 ${message.done?.toLocaleString()} / ${message.total?.toLocaleString()} 对（候选 × 查询词）…`)
      else if (message.type === 'manualDone') { setManualHits(message.hits ?? []); setManualComparisons(message.comparisons ?? 0); setManualStatus('done'); setManualError(''); setManualPronunciationWarning(message.pronunciationError ?? ''); setManualPronunciationMissing(message.pronunciationCoverage ? { missingWords: message.pronunciationCoverage.missingWords, missingQueries: message.pronunciationCoverage.missingQueries ?? [] } : null); setManualPage(0); reportMetric('similarity_complete', { mode: 'manual', durationMs: Math.round(performance.now() - startedAt), results: message.hits?.length ?? 0 }); w.terminate(); workerRef.current = null }
      else if (message.type === 'error') { fail(message.message ?? '相似度计算失败'); w.terminate(); workerRef.current = null }
    })
    worker.postMessage({ taskId: taskRef.current, kind: 'manual', queries: parsed.words.map((w, i) => ({ id: 'q' + i, spelling: w })), words: data.rows.map(r => ({ id: r.voc_id, spelling: r.voc_spelling })), matchTypes: matchTypesOverride, pronunciationThreshold: PRONUNCIATION_THRESHOLD, predictions: matchTypesOverride.includes('pronunciation') ? predictions : undefined })
  }

  function cancelManual() { resetSearch() }

  function toggleMatchType(type: MatchType) {
    const selectedType = matchTypes.includes(type)
    if (selectedType && matchTypes.length === 1) { setMatchTypeMessage('至少选择一种匹配类型'); return }
    const next = selectedType ? matchTypes.filter(value => value !== type) : DEFAULT_MATCH_TYPES.filter(value => value === type || matchTypes.includes(value))
    setMatchTypes(next); setMatchTypeMessage(''); setPairPage(0); setManualPage(0)
    workerRef.current?.terminate(); workerRef.current = null; taskRef.current += 1
    if (mode === 'discover' && (status === 'done' || status === 'running')) runDiscovery(undefined, next)
    else { setStatus('idle'); setPairs([]); setStats(null); setRanConfig(null); setPronunciationWarning(''); setPronunciationMissing(0) }
    if (mode === 'manual' && (manualStatus === 'done' || manualStatus === 'running')) runManual(next)
    else { setManualStatus('idle'); setManualHits([]); setManualComparisons(0); setRanQueries(null); setManualPronunciationWarning(''); setManualPronunciationMissing(null) }
  }

  useEffect(() => () => workerRef.current?.terminate(), [])

  function toggleWord(id: string) { setClearedSelection(null); setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next }) }
  function togglePair(a: string, b: string) { setClearedSelection(null); setSelected(old => { const next = new Set(old); if (next.has(a) && next.has(b)) { next.delete(a); next.delete(b) } else { next.add(a); next.add(b) } return next }) }
  function clearSelection() { setClearedSelection(new Set(selected)); setSelected(new Set()) }
  function undoClearSelection() { if (clearedSelection) { setSelected(new Set(clearedSelection)); setClearedSelection(null) } }

  const wordById = useMemo(() => new Map((data?.rows ?? []).map(r => [r.voc_id, r])), [data])
  const keyOf = (spelling: string) => spelling.trim().toLowerCase()
  const displayMeaning = (spelling: string): string => { const k = keyOf(spelling); const value = customMeanings[k] ?? meanings[k]; if (value) return value; if (value === null) return '（词典无中文释义，请在词表中补充）'; return '' }

  // —— 词表浏览 ——
  const filtered = data?.rows.filter(r => r.voc_spelling.toLowerCase().includes(filter.trim().toLowerCase())) ?? []
  useEffect(() => {
    if (data && !busy) setPage(current => Math.min(current, Math.max(0, Math.ceil(filtered.length / PAGE_WORDS) - 1)))
  }, [data, busy, filtered.length])
  const visible = filtered.slice(page * PAGE_WORDS, (page + 1) * PAGE_WORDS)
  const pagePairs = pairs.slice(pairPage * PAGE_RESULTS, (pairPage + 1) * PAGE_RESULTS)
  const pageHits = manualHits.slice(manualPage * PAGE_RESULTS, (manualPage + 1) * PAGE_RESULTS)
  const manualStale = manualStatus === 'done' && ranQueries !== null && JSON.stringify(ranQueries) !== JSON.stringify(parseManualInput(manualText).words)

  const displaySpellings = useMemo(() => {
    if (mode === 'discover') { const set = new Set<string>(); for (const p of pagePairs) { set.add(keyOf(p.aSpelling)); set.add(keyOf(p.bSpelling)) }; return [...set] }
    if (mode === 'manual') return [...new Set(pageHits.map(h => keyOf(h.spelling)))]
    return [...new Set(visible.map(r => keyOf(r.voc_spelling)))]
  }, [mode, pagePairs, pageHits, visible])
  const spellingKey = displaySpellings.join('\u0000')

  useEffect(() => {
    if (!connected || busy || !displaySpellings.length) return
    const missing = displaySpellings.filter(k => !Object.hasOwn(meanings, k))
    if (!missing.length) return
    let live = true
    setMeaningError('')
    fetchMeanings(missing, () => live)
      .then(merged => { if (live && merged) setMeanings(old => ({ ...old, ...merged })) })
      .catch(e => { if (live) { setMeaningError((e as Error).message); reportMetric('dictionary_error', { context: mode }) } })
    return () => { live = false }
  }, [connected, busy, spellingKey, data?.syncedAt, meaningRetry])

  const ready = displaySpellings.every(k => Object.hasOwn(meanings, k))
  const discoveryStale = ranConfig !== null && (ranConfig.threshold !== threshold || ranConfig.filter !== weakFilter)

  // —— P4：批量加入云词本（第 5.2/5.3 节）——
  const selectedWords = useMemo(() => dedupeSpellings([...selected].map(id => ({ id, spelling: wordById.get(id)?.voc_spelling ?? '' }))), [selected, wordById])
  const selectedNormKey = selectedWords.map(w => w.norm).join('\u0000')
  const meaningState = (spelling: string): 'ok' | 'missing' | 'loading' => { const k = keyOf(spelling); if (customMeanings[k]) return 'ok'; if (Object.hasOwn(meanings, k)) return meanings[k] ? 'ok' : 'missing'; return 'loading' }
  const pendingMeanings = selectedWords.filter(w => meaningState(w.spelling) === 'loading')
  const missingMeanings = selectedWords.filter(w => meaningState(w.spelling) === 'missing')
  const meaningsReady = selectedWords.length > 0 && !pendingMeanings.length && !missingMeanings.length
  const appendPlan = target !== 'create' && detail ? planAppend(detail, selectedWords) : null
  const duplicateNorms = new Set((appendPlan?.duplicates ?? []).map(w => w.norm))
  const previewContent = target === 'create' ? chapterContent(selectedWords) : appendPlan?.content ?? ''
  const contentTooLarge = selectedWords.length > 0 && utf8Length(previewContent) > MAX_NOTEPAD_BYTES
  const targetName = target === 'create' ? newTitle.trim() || '新词本' : notepadList?.find(n => n.id === target)?.title ?? '已选词本'
  const canSubmit = meaningsReady && !contentTooLarge && !busy && submitState !== 'submitting' && (target === 'create' ? selectedWords.length > 0 && Boolean(newTitle.trim()) : Boolean(detail && appendPlan?.newWords.length))

  // 面板打开时为全部已选词批量取释义（页面级效果只覆盖当前页）；缺释义的词补齐后才进入可提交预览。
  useEffect(() => {
    if (!submitOpen || !connected) return
    const missing = [...new Set(selectedWords.map(w => w.norm).filter(k => !Object.hasOwn(meanings, k)))]
    if (!missing.length) return
    let live = true
    fetchMeanings(missing, () => live)
      .then(merged => { if (live && merged) setMeanings(old => ({ ...old, ...merged })) })
      .catch(e => { if (live) { setMeaningError((e as Error).message); reportMetric('dictionary_error', { context: 'submit' }) } })
    return () => { live = false }
  }, [submitOpen, connected, selectedNormKey])

  // 写入结果确认后勾选又发生变化：回到预览状态，避免用旧结果误导。
  useEffect(() => { if (submitState === 'done') { setSubmitState('idle'); setOutcomes(null) } }, [selectedNormKey])

  async function fetchNotepadBriefs(): Promise<BriefNotepad[]> {
    const all: BriefNotepad[] = []
    for (let offset = 0; offset <= 90; offset += 10) {
      const page = await api<{ notepads?: BriefNotepad[] }>('query', { operation: 'notepads', payload: { offset } })
      const batch = page.notepads ?? []
      all.push(...batch)
      if (batch.length < 10) break
    }
    // 收藏等特殊类型不默认修改（第 5.2 节）；已删除的词本不显示。
    return all.filter(n => n.type !== 'FAVORITE' && n.status !== 'DELETED')
  }

  async function loadNotepadList() {
    setNotepadListError('')
    try { setNotepadList(await fetchNotepadBriefs()) }
    catch (e) { setNotepadList(null); setNotepadListError((e as Error).message) }
  }

  async function loadDetail(id: string) {
    setDetail(null); setDetailError(''); setOutcomes(null)
    try { setDetail((await api<{ notepad: NotepadDetail }>('query', { operation: 'notepad', payload: { id } })).notepad) }
    catch (e) { setDetailError((e as Error).message) }
  }

  function chooseTarget(next: string) {
    if (next === target) return
    setTarget(next); setDetail(null); setDetailError(''); setOutcomes(null); setSubmitNotice(''); setSubmitError(''); setSubmitState('idle')
    if (next && next !== 'create') void loadDetail(next)
  }

  function openSubmitPanel() {
    if (!submitOpen) { setSubmitOpen(true); setSubmitState('idle'); setOutcomes(null); setSubmitError(''); setSubmitNotice(''); void loadNotepadList() }
    requestAnimationFrame(() => document.getElementById('submit-panel')?.scrollIntoView({ block: 'start' }))
  }

  // 新建响应丢失时按标题 + 创建时间窗 + 正文逐字比对，仅在唯一命中时认定创建成功。
  async function reconcileCreate(title: string, sinceMs: number, expectedContent: string): Promise<string> {
    try {
      const candidates = findRecentByTitle(await fetchNotepadBriefs(), title, sinceMs)
      const matched: string[] = []
      for (const item of candidates.slice(0, 5)) {
        try {
          const read = await api<{ notepad?: NotepadDetail }>('query', { operation: 'notepad', payload: { id: item.id } })
          if (read.notepad?.content === expectedContent) matched.push(item.id)
        } catch { /* 读不到的候选不计入确认 */ }
      }
      return matched.length === 1 ? matched[0] : ''
    } catch { return '' }
  }

  async function submitToNotepad() {
    if (submitState === 'submitting' || !selectedWords.length || !meaningsReady) return
    setSubmitState('submitting'); setSubmitError(''); setSubmitNotice(''); setOutcomes(null)
    try {
      if (target === 'create') {
        if (utf8Length(chapterContent(selectedWords)) > MAX_NOTEPAD_BYTES) { setSubmitState('idle'); setSubmitError(`新建正文将超过网站上限 ${MAX_NOTEPAD_BYTES.toLocaleString()} 字节（官方最大容量未核实），请减少所选词或分批提交。`); return }
        const payload = planCreate(selectedWords, newTitle, newBrief)
        const sinceMs = Date.now() - 5 * 60 * 1000
        let createdId = ''
        let writeError = ''
        try {
          createdId = (await api<{ notepad?: NotepadDetail }>('query', { operation: 'notepad_create', payload: { notepad: payload } })).notepad?.id ?? ''
        } catch (e) {
          writeError = (e as Error).message
          createdId = await reconcileCreate(payload.title, sinceMs, payload.content)
        }
        if (!createdId) { setSubmitState('pending'); reportMetric('notepad_pending', { operation: 'create' }); setSubmitError((writeError ? writeError + '。' : '创建响应缺少词本 ID。') + '无法唯一确认是否已创建，结果为“待确认”；请勿重复新建，先点“重新加载列表核对”或到墨墨 App 核对。'); return }
        const read = await api<{ notepad: NotepadDetail }>('query', { operation: 'notepad', payload: { id: createdId } })
        setOutcomes(classifyOutcomes(selectedWords, new Set(), read.notepad))
        setSubmitState('done')
        setSubmitNotice(`已新建词本「${read.notepad.title || payload.title}」${writeError ? '（写入请求曾超时或失败，回读确认已成功）' : ''}，加入云词本不等于加入学习规划。`)
        void loadNotepadList()
        return
      }
      if (!detail) throw new Error('请先选择目标词本并等待详情读取完成')
      // 请求发出前复检外部改动（无事务保证，只能尽力）：变化则采用最新内容重新合并，要求用户再确认。
      const fresh = (await api<{ notepad: NotepadDetail }>('query', { operation: 'notepad', payload: { id: detail.id } })).notepad
      if (!snapshotUnchanged(fresh, detail)) {
        setDetail(fresh); setSubmitState('idle')
        setSubmitNotice('目标词本在预览期间被外部修改，已重新读取并按最新内容合并；请核对更新后的预览再提交。')
        return
      }
      const plan = planAppend(detail, selectedWords)
      if (!plan.newWords.length) { setSubmitState('idle'); setSubmitNotice('所选词已全部存在于该词本，无需写入；重复提交不会重复添加。'); return }
      if (utf8Length(plan.content) > MAX_NOTEPAD_BYTES) { setSubmitState('idle'); setSubmitError(`合并后正文将超过网站上限 ${MAX_NOTEPAD_BYTES.toLocaleString()} 字节（官方最大容量未核实），请分批提交。`); return }
      const before = new Set([...parsedWords(detail.list), ...contentWords(detail.content)])
      const body = { id: detail.id, notepad: { status: detail.status ?? 'UNPUBLISHED', content: plan.content, title: detail.title ?? '', brief: detail.brief ?? '', tags: detail.tags ?? [] } }
      let writeError = ''
      try { await api('query', { operation: 'notepad_update', payload: body }) }
      catch (e) { writeError = (e as Error).message } // 超时或 5xx 可能已写入成功，先回读核对，不盲目重试
      let read: NotepadDetail
      try {
        read = (await api<{ notepad: NotepadDetail }>('query', { operation: 'notepad', payload: { id: detail.id } })).notepad
      } catch (e) {
        setSubmitState('pending'); reportMetric('notepad_pending', { operation: 'update_readback' }); setSubmitError((writeError || (e as Error).message) + '。回读也失败，结果为“待确认”；请点“重新核对”，勿直接重复提交。')
        return
      }
      setDetail(read)
      const result = classifyOutcomes(plan.newWords, before, read)
      setOutcomes(result)
      if (!writeMatchesPlan(read, plan.content)) {
        setSubmitState('pending'); reportMetric('notepad_pending', { operation: 'content_mismatch' })
        setSubmitError('回读正文与提交预览不一致，可能发生了双端并发修改；结果为“待确认”，请重新读取并在墨墨 App 中核对。')
        return
      }
      const unrecognized = result.filter(o => o.status === 'unrecognized').length
      if (writeError && result.every(o => o.status === 'unrecognized')) {
        setSubmitState('pending'); reportMetric('notepad_pending', { operation: 'update_unconfirmed' }); setSubmitError(writeError + '。回读未见任何新增词，写入可能未成功；可修正后重新提交（提交前会重新合并，不会重复已确认的词）。')
      } else {
        setSubmitState('done')
        setSubmitNotice([writeError ? '写入请求曾超时或失败，但回读确认词已加入。' : '', unrecognized ? `${unrecognized} 个词未出现在词本解析结果中，请在墨墨内核对拼写。` : ''].filter(Boolean).join(' '))
      }
    } catch (e) {
      setSubmitState('idle'); setSubmitError((e as Error).message)
      if (e instanceof ApiError && e.status === 401) setConnected(false)
    }
  }

  async function recheckPending() {
    if (target === 'create' || !detail) return
    setSubmitState('submitting'); setSubmitError('')
    try {
      const read = (await api<{ notepad: NotepadDetail }>('query', { operation: 'notepad', payload: { id: detail.id } })).notepad
      setDetail(read); setSubmitState('idle')
      setSubmitNotice('已重新读取词本详情；上方预览显示“已在词本中”即上次写入实际成功。')
    } catch (e) { setSubmitState('pending'); reportMetric('notepad_pending', { operation: 'recheck' }); setSubmitError((e as Error).message) }
  }

  const selectedPanel = <aside className="selectedPanel" aria-label="已选清单"><h2>已选清单</h2><p>{selected.size === 0 ? '勾选词对或单个词后在此汇总。' : `已选 ${selected.size} 个词（按 ID 去重）。`}</p><div className="selectedActions">{selected.size > 0 && <button onClick={openSubmitPanel} disabled={busy || submitState === 'submitting'}>{submitOpen ? '查看提交面板' : '加入云词本'}</button>}{selected.size > 0 && <button className="ghost" onClick={clearSelection}>清空选择</button>}{clearedSelection && <button className="ghost" onClick={undoClearSelection}>撤销清空 {clearedSelection.size} 词</button>}</div>{selected.size > 0 && <ul className="selectedList">{[...selected].map(id => { const row = wordById.get(id); const spelling = row?.voc_spelling ?? id; return <li key={id}><strong>{spelling}</strong><span>{displayMeaning(spelling) || '正在获取释义…'}</span><button className="ghost" onClick={() => toggleWord(id)} aria-label={`移除 ${spelling}`}>移除</button></li> })}</ul>}</aside>

  const supplementPanel = data && !data.finished && <section className="supplement"><h3>导入墨墨词表补齐缺口</h3><p>选择墨墨导出的 PDF，或每行一个拼写的 UTF-8 文本。PDF 在浏览器本地解析，不会上传原文件；请根据解析报告检查标题、页码等无效行。</p><label className="fileLabel">选择 PDF 或文本词表 <input name="candidate-file" type="file" accept=".pdf,application/pdf,.txt,text/plain" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { const result = await extractCandidateFile(file); const parsed = parseCandidateList(result.text); setCandidateText(result.text); setCandidateNotice(`已读取${result.format === 'pdf' ? ` PDF ${result.pages} 页、` : '文本 '} ${parsed.total} 行：${parsed.words.length} 个有效词、${parsed.duplicates} 个重复项、${parsed.invalid.length} 个无效项。`) } catch (reason) { setError(`文件解析失败：${(reason as Error).message}`) } }}/></label>{candidateNotice && <p className="notice" role="status">{candidateNotice}</p>}<textarea name="candidate-list" autoComplete="off" spellCheck={false} aria-label="候选英文词表" value={candidateText} onChange={e => { setCandidateText(e.target.value); setCandidateNotice('') }} placeholder={'adapt\nadopt\na phrase…'} rows={4}/><button disabled={busy || !candidateText.trim()} onClick={supplement}>校验并补齐</button></section>

  const submitPanel = submitOpen && <section id="submit-panel" className="submitPanel" aria-label="加入云词本">
    <div className="submitHead"><div><span className="eyebrow">NOTEPAD SUBMIT</span><h2>加入云词本</h2></div><button className="ghost" onClick={() => setSubmitOpen(false)} disabled={submitState === 'submitting'}>关闭</button></div>
    <div className="submitTargets"><label><input type="radio" name="notepad-target" checked={target === 'create'} disabled={submitState === 'submitting'} onChange={() => chooseTarget('create')}/>新建词本</label><label><input type="radio" name="notepad-target" checked={target !== 'create'} disabled={submitState === 'submitting'} onChange={() => chooseTarget('')}/>追加到已有词本</label></div>
    {target === 'create' ? <div className="submitFields"><label>标题<input name="notepad-title" autoComplete="off" value={newTitle} maxLength={100} disabled={submitState === 'submitting'} onChange={e => setNewTitle(e.target.value)} placeholder="易混淆词…"/></label><label>简介<input name="notepad-brief" autoComplete="off" value={newBrief} maxLength={500} disabled={submitState === 'submitting'} onChange={e => setNewBrief(e.target.value)}/></label><p className="hint">新建为未发布的章节模式专用词本（推荐）；中文释义只在本页对照展示，不写入词本正文。</p></div>
      : <div className="submitFields">
        {notepadListError ? <p className="error">词本列表加载失败：{notepadListError} <button className="ghost" onClick={loadNotepadList}>重试</button></p>
          : !notepadList ? <p className="notice" role="status">正在读取词本列表…（首版最多前 100 个普通词本）</p>
          : notepadList.length === 0 ? <p className="empty">没有可写的普通云词本（收藏与已删除类型不在列表内）。</p>
           : <label>选择已有词本 <select name="notepad-existing" value={target} disabled={submitState === 'submitting'} onChange={e => chooseTarget(e.target.value)}><option value="">请选择…</option>{notepadList.map(n => <option key={n.id} value={n.id}>{n.title || '（无标题）'}</option>)}</select></label>}
        {detailError && <p className="error">词本详情加载失败：{detailError} <button className="ghost" onClick={() => target && loadDetail(target)}>重试</button></p>}
        {detail && <p className="scopeLine">「{detail.title}」· {detail.content?.trim() ? detectMode(detail.content) === 'chapter' ? '章节模式' : '文本模式' : '空正文'} · 已收录 {new Set([...parsedWords(detail.list), ...contentWords(detail.content)]).size} 词 · 状态 {detail.status ?? '未知'}。追加将保留原标题、简介、标签、发布状态与既有正文。</p>}
      </div>}
    {selectedWords.length === 0 ? <p className="notice">先在结果行或已选清单中勾选单词。</p> : <>
      {pendingMeanings.length > 0 && <p className="notice" role="status">正在获取 {pendingMeanings.length} 个已选词的中文释义…</p>}
      {missingMeanings.length > 0 && <div className="submitMeanings"><p className="warning">以下 {missingMeanings.length} 个词缺少中文释义；缺失状态不算满足中英同时显示，补齐后才进入可提交预览：</p>{missingMeanings.map(w => { const k = keyOf(w.spelling); return <MeaningForm key={w.id} inputId={'submit-meaning-' + w.id} label={w.spelling} value={drafts[k] ?? ''} onChange={v => setDrafts(old => ({ ...old, [k]: v }))} onCommit={v => setCustomMeanings(old => ({ ...old, [k]: v }))}/> })}</div>}
      {meaningsReady && <ul className="submitPreview">{selectedWords.map(w => <li key={w.id}><strong>{w.spelling}</strong><span>{displayMeaning(w.spelling)}</span><em>{target !== 'create' && duplicateNorms.has(w.norm) ? '已在词本中' : '将新增'}</em></li>)}</ul>}
      {meaningsReady && target !== 'create' && detail && <p className="scopeLine">已选 {selectedWords.length} 词 · 预计新增 {appendPlan?.newWords.length ?? 0} · 重复（已在目标词本）{appendPlan?.duplicates.length ?? 0} · 合并后正文 {utf8Length(previewContent).toLocaleString()} 字节（网站上限 {MAX_NOTEPAD_BYTES.toLocaleString()}，官方最大值未核实）。</p>}
      {meaningsReady && target === 'create' && <p className="scopeLine">新建词本将包含 {selectedWords.length} 词 · 正文 {utf8Length(previewContent).toLocaleString()} 字节（网站上限 {MAX_NOTEPAD_BYTES.toLocaleString()}，官方最大值未核实）。</p>}
      {contentTooLarge && <p className="error">合并后正文超过网站上限 {MAX_NOTEPAD_BYTES.toLocaleString()} 字节；请减少所选词或分批提交。</p>}
      {submitError && <p className="error" role="alert">{submitError}</p>}
      {submitNotice && <p className="notice" role="status">{submitNotice}</p>}
      {outcomes && <ul className="submitOutcomes">{outcomes.map(o => <li key={o.norm}><strong>{o.spelling}</strong><em>{OUTCOME_LABELS[o.status]}</em></li>)}</ul>}
      <div className="submitActions">
        <button disabled={!canSubmit} onClick={submitToNotepad}>{submitState === 'submitting' ? '正在写入并回读…' : `加入「${targetName}」`}</button>
        {submitState === 'pending' && target !== 'create' && <button className="ghost" onClick={recheckPending}>重新核对</button>}
        {submitState === 'pending' && target === 'create' && <button className="ghost" onClick={loadNotepadList}>重新加载列表核对</button>}
      </div>
      {target !== 'create' && !target && meaningsReady && <p className="hint">选择目标词本并等待详情读取完成后才能提交。</p>}
    </>}
    <p className="hint">相似词查询、勾选和预览均不会触发写入；加入云词本不等于加入学习规划，本站不调用学习添加接口。</p>
  </section>

  return <div className="shell">
    <a className="skipLink" href="#main-content">跳转到主要内容</a>
    <header className="top"><div><span className="eyebrow">MEMO / WORD STUDY</span><h1>{guideOpen ? 'API 获取指南' : '易混淆词'}</h1></div><div className="topActions">{guideOpen ? <a className="navLink" href="#">返回工具</a> : <><a className="navLink" href="#api-guide">如何获取 API</a><span className={'status ' + (connected ? 'online' : '')}>{connected ? '已连接' : '未连接'}</span>{connected && <button className="ghost" onClick={disconnect}>断开连接</button>}</>}</div></header>
    {guideOpen ? <ApiGuide/> : !connected ? <main id="main-content" className="connectPanel"><h2>连接墨墨账号</h2><p>Token 只保存在服务端短期会话中。连接后先验证学习记录读取权限。还没有 Token？<a href="#api-guide">查看获取教程</a>。</p><form onSubmit={connect}><label htmlFor="token">OpenAPI Token</label><input id="token" name="token" type="password" autoComplete="off" spellCheck={false} required value={token} onChange={e => setToken(e.target.value)} placeholder="粘贴 Token…"/><button disabled={busy}>{busy ? '正在验证…' : '连接并验证'}</button></form>{import.meta.env.DEV && <button type="button" className="ghost" disabled={busy} onClick={() => void authenticate({ useDevToken: true })}>使用本机开发 Token 连接</button>}{error && <p className="error" role="alert">{error}</p>}</main> : <main id="main-content">
      <section className="toolbar"><div><span className="eyebrow">DATA COVERAGE</span><h2>已加入单词</h2></div><button onClick={refresh} disabled={busy}>{busy ? '正在同步…' : data ? '手动刷新' : '开始同步'}</button></section>
      {busy && progress && <SyncProgress state={progress}/>} {error && <p className="error" role="alert">{error}</p>}
      {data ? <><section className="metrics" aria-label="同步范围"><div><span>已同步</span><strong>{data.rows.length.toLocaleString()}</strong></div><div><span>接口总量</span><strong>{data.total.toLocaleString()}</strong></div><div><span>覆盖状态</span><strong>{data.finished ? '本次已核对' : '部分范围'}</strong></div><div><span>上次同步</span><strong className="date">{new Date(data.syncedAt).toLocaleString('zh-CN')}</strong></div></section>
        {!data.finished && <p className="warning">还有 {Math.max(0, data.total - data.rows.length).toLocaleString()} 条未同步。</p>}
        <nav className="tabs" aria-label="视图模式"><button className={'tab' + (mode === 'words' ? ' active' : '')} aria-pressed={mode === 'words'} onClick={() => setMode('words')}>已同步词表</button><button className={'tab' + (mode === 'discover' ? ' active' : '')} aria-pressed={mode === 'discover'} onClick={() => setMode('discover')}>自动发现</button><button className={'tab' + (mode === 'manual' ? ' active' : '')} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>手动查找</button></nav>
        {submitPanel}
        {mode !== 'words' && <details className="notice"><summary>补充预测读音{predictions ? `（已载入 ${Object.keys(predictions.entries).length} 个）` : ''}</summary><p>导入本机生成的读音文件，仅在当前页面使用，不上传；刷新页面或断开账号后需重新导入。预测可能有误，词典读音优先。</p><label>导入预测读音 <input name="prediction-file" type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importPredictions(file) }}/></label>{predictions && <button className="ghost" onClick={clearPredictions}>移除预测读音</button>}{predictionNotice && <p role="status">{predictionNotice}</p>}{predictionError && <p className="error" role="alert">{predictionError}</p>}</details>}
        {mode === 'discover' ? <div className="workspace"><section className="records discover"><div className="recordsHead"><div><span className="eyebrow">AUTO DISCOVERY</span><h2>薄弱词自动发现</h2></div></div>
          <div className="controls"><MatchTypeSelector value={matchTypes} message={matchTypeMessage} onChange={toggleMatchType}/><label className="thresholdControl">相似度阈值 <span className="thresholdSlider"><input name="threshold" type="range" min={0} max={1} step={THRESHOLD_STEP} value={threshold} disabled={status === 'running' || !matchTypes.some(type => type === 'spelling' || type === 'pronunciation')} aria-valuetext={threshold.toFixed(2)} onChange={e => setThreshold(Number(e.target.value))}/><output>{threshold.toFixed(2)}</output></span><span className="hint">用于拼写与发音路径；词块换序不受阈值限制。</span></label><label>缩小薄弱词范围 <input name="weak-filter" autoComplete="off" spellCheck={false} value={weakFilter} disabled={status === 'running'} onChange={e => setWeakFilter(e.target.value)} placeholder="例如：adapt…"/></label><div className="controlActions">{status === 'running' ? <button className="ghost" onClick={cancelDiscovery}>取消</button> : <button onClick={() => runDiscovery()} disabled={busy}>{status === 'done' ? '重新查找' : '开始查找'}</button>}</div></div>
          <p className="scopeLine">薄弱词（忘记/模糊）<strong>{weakRows.length}</strong> 个 · 反馈未知 <strong>{unknownCount}</strong> 个单独呈现，不参与自动发现。{!data.finished && ' 当前为部分同步范围，可能漏检未同步的词对。'}</p>
          {status === 'running' && <p className="notice" role="status">{runningText}</p>}
          {status === 'error' && <p className="error" role="alert">{discoverError}</p>}
          {pronunciationWarning && <p className="warning" role="status">部分发音数据不可用：{pronunciationWarning}。其他已选类型的结果仍保留。</p>}
          {pronunciationMissing > 0 && <p className="notice" role="status">当前范围有 {pronunciationMissing} 个词暂无可用读音；这些词不会按零分参与发音判断，仍可经其他已选类型命中。</p>}
          {meaningError && <p className="error" role="alert">词典查询失败：{meaningError} <button className="ghost" onClick={() => setMeaningRetry(n => n + 1)}>重试释义</button></p>}
          {status === 'done' && <>
            {discoveryStale && <p className="notice">阈值或筛选条件已修改，当前结果仍属于上次查找（阈值 {(ranConfig?.threshold ?? 0).toFixed(2)}）。点击“重新查找”后结果才会更新。</p>}
            <p className="scopeLine" role="status">{(ranConfig?.matchTypes ?? matchTypes).map(type => MATCH_TYPE_NAMES[type]).join('、')} · 阈值 {(ranConfig?.threshold ?? threshold).toFixed(2)} 下找到 <strong>{pairs.length}</strong> 对{stats ? ` · 候选 ${stats.before.toLocaleString()} 词对，比较 ${stats.comparisons.toLocaleString()}，命中 ${stats.qualified.toLocaleString()}` : ''}。</p>
            {pairs.length === 0 ? <p className="empty">当前选择下没有匹配项，不会自动改回全选。{matchTypes.some(type => type === 'spelling' || type === 'pronunciation') && <button className="ghost" disabled={threshold <= 0 || busy} onClick={() => { const next = Math.max(0, Math.round((threshold - THRESHOLD_STEP) * 100) / 100); setThreshold(next); runDiscovery(next) }}>降低阈值并重查</button>}</p> : !ready ? <p className="empty" role="status">正在准备本页中英对照…</p> : <ul className="pairList">{pagePairs.map(pair => {
              const both = selected.has(pair.aId) && selected.has(pair.bId)
              const half = !both && (selected.has(pair.aId) || selected.has(pair.bId))
              return <li key={pair.aId + '|' + pair.bId}><div className="pairActions"><PairCheck checked={both} indeterminate={half} onChange={() => togglePair(pair.aId, pair.bId)} label={`选择词对 ${pair.aSpelling} 与 ${pair.bSpelling}`}/><MatchTypeBadges value={pair.matchTypes}/>{pair.spellingMatch && <span className="simScore">拼写 {Math.round(pair.spellingMatch.similarity * 100)}</span>}<PronunciationBadge match={pair.pronunciation}/></div><div className="pairWords">{[{ id: pair.aId, spelling: pair.aSpelling }, { id: pair.bId, spelling: pair.bSpelling }].map(side => { const row = wordById.get(side.id); return <div className="pairSide" key={side.id}><label className="pairPick"><input type="checkbox" checked={selected.has(side.id)} onChange={() => toggleWord(side.id)} aria-label={`选择单词 ${side.spelling}`}/><strong>{side.spelling}</strong></label><span className="pairMeaning">{displayMeaning(side.spelling) || '正在获取释义…'}</span><span className="pairMeta">{responseLabel(row)}</span></div> })}</div></li>
            })}</ul>}
            <Pager page={pairPage} total={pairs.length} size={PAGE_RESULTS} summary={`共 ${pairs.length} 对`} onPage={setPairPage}/>
          </>}
          {status !== 'done' && status !== 'running' && <div className="empty large">选择匹配类型后，在薄弱词内分别召回并按并集合并；同一词对只显示一次并标注全部命中类型。</div>}
        </section>
          {selectedPanel}
        </div> : mode === 'manual' ? <div className="workspace"><section className="records discover manual"><div className="recordsHead"><div><span className="eyebrow">MANUAL LOOKUP</span><h2>手动查找相似词</h2></div></div>
          <div className="controls manualControls"><MatchTypeSelector value={matchTypes} message={matchTypeMessage} onChange={toggleMatchType}/><label className="manualQueryLabel">查询英文词（换行、英文逗号或中文逗号分隔，最多 {MAX_MANUAL_QUERY} 个）<textarea ref={manualQueryRef} name="manual-query" autoComplete="off" spellCheck={false} aria-label="查询英文词" aria-invalid={manualStatus === 'error'} aria-describedby={manualStatus === 'error' ? 'manual-error' : undefined} value={manualText} disabled={manualStatus === 'running'} rows={3} placeholder={'adapt\nadopt，a band…'} onChange={e => setManualText(e.target.value)}/><span className="hint">手动发音匹配阈值为 {PRONUNCIATION_THRESHOLD.toFixed(2)}。</span></label><div className="controlActions">{manualStatus === 'running' ? <button className="ghost" onClick={cancelManual}>取消</button> : <button onClick={() => runManual()} disabled={busy}>{manualStatus === 'done' ? '重新查找' : '开始查找'}</button>}</div></div>
          <p className="scopeLine">候选范围：已同步的 <strong>{data.rows.length}</strong> 个已加入单词。换序优先；包含相似时保留原有拼写顺序，仅发音命中项追加在后。</p>
          {manualStatus === 'running' && <p className="notice" role="status">{manualRunningText}</p>}
          {manualStatus === 'error' && <p id="manual-error" className="error" role="alert">{manualError}</p>}
          {manualPronunciationWarning && <p className="warning" role="status">部分发音数据不可用：{manualPronunciationWarning}。其他已选类型的结果仍保留。</p>}
          {manualPronunciationMissing && (manualPronunciationMissing.missingWords > 0 || manualPronunciationMissing.missingQueries.length > 0) && <p className="notice" role="status">{manualPronunciationMissing.missingQueries.length > 0 ? `查询词 ${manualPronunciationMissing.missingQueries.join('、')} 暂无可用读音；` : ''}候选范围有 {manualPronunciationMissing.missingWords} 个词暂无可用读音。缺失读音不按零分参与判断；尚未支持实时预测新词。</p>}
          {manualNotice && manualStatus !== 'error' && manualStatus !== 'running' && <p className="notice">{manualNotice}</p>}
          {meaningError && <p className="error" role="alert">词典查询失败：{meaningError} <button className="ghost" onClick={() => setMeaningRetry(n => n + 1)}>重试释义</button></p>}
          {manualStatus === 'done' && <>
            {manualStale && <p className="notice">查询词已修改，当前结果仍属于上次查找（{(ranQueries ?? []).length} 个词）。点击“重新查找”后结果才会更新。</p>}
            <p className="scopeLine" role="status">查询词：{(ranQueries ?? []).join('、')} · 返回 <strong>{manualHits.length}</strong> 个候选 · 比较 {manualComparisons.toLocaleString()} 对。</p>
            {manualHits.length === 0 ? <p className="empty">当前选择下没有匹配项，不会自动改回全选。</p> : !ready ? <p className="empty" role="status">正在准备本页中英对照…</p> : <ul className="manualList">{pageHits.map(hit => { const row = wordById.get(hit.id); return <li key={hit.id}><div className="hitMain"><label className="hitPick"><input type="checkbox" checked={selected.has(hit.id)} onChange={() => toggleWord(hit.id)} aria-label={`选择单词 ${hit.spelling}`}/><strong>{hit.spelling}</strong></label><MatchTypeBadges value={hit.matchTypes}/>{hit.spellingMatch && <span className="simScore">拼写 {Math.round(hit.spellingMatch.similarity * 100)}</span>}<PronunciationBadge match={hit.pronunciation}/>{hit.tiedQueries.length > 1 ? <details className="hitQuery"><summary>最接近输入词“{hit.bestQuery}”（{hit.tiedQueries.length} 个并列，展开查看）</summary><span>{hit.tiedQueries.join('、')}</span></details> : <span className="hitQuery">最接近输入词“{hit.bestQuery}”</span>}</div><div className="pairMeaning">{displayMeaning(hit.spelling) || '正在获取释义…'}</div><div className="hitMeta"><span>{responseLabel(row)}</span><span>{typeof row?.study_count === 'number' ? `学习 ${row.study_count} 次` : '次数未知'}</span></div></li> })}</ul>}
            <Pager page={manualPage} total={manualHits.length} size={PAGE_RESULTS} summary={`共 ${manualHits.length} 个候选`} onPage={setManualPage}/>
          </>}
          {manualStatus !== 'done' && manualStatus !== 'running' && <div className="empty large">输入一个或多个英文词，按所选类型分别查找；每个候选只显示一次并标注全部命中类型，与自动发现共用选择状态。</div>}
        </section>
          {selectedPanel}
        </div> : <section className="records"><div className="recordsHead"><div><span className="eyebrow">STUDY RECORDS</span><h2>词语与释义</h2></div><label>查找已同步词 <input name="word-filter" autoComplete="off" spellCheck={false} value={filter} onChange={e => { setFilter(e.target.value); setPage(0) }} placeholder="例如：adapt…"/></label></div>
          {supplementPanel}
          {meaningError && <p className="error" role="alert">词典查询失败：{meaningError} <button className="ghost" onClick={() => setMeaningRetry(n => n + 1)}>重试释义</button></p>}
          {filtered.length === 0 ? <p className="empty">{data.rows.length ? '已同步范围内没有匹配的单词。' : '当前账号没有可展示的学习记录。'}</p> : meaningError ? null : !ready ? <p className="empty" role="status">正在准备本页中英对照…</p> : <ul className="wordList">{visible.map(row => { const key = keyOf(row.voc_spelling); const meaning = customMeanings[key] ?? meanings[key]; return <li key={row.voc_id}><div className="word"><strong>{row.voc_spelling}</strong>{meaning ? <span>{meaning}</span> : <MeaningForm inputId={'meaning-' + row.voc_id} label="中文释义缺失，补充后才可提交" value={drafts[key] ?? ''} onChange={v => setDrafts(old => ({ ...old, [key]: v }))} onCommit={v => setCustomMeanings(old => ({ ...old, [key]: v }))}/> }</div><div className="meta"><span>{responseLabel(row)}</span><span>{typeof row.study_count === 'number' ? `学习 ${row.study_count} 次` : '次数未知'}</span></div></li> })}</ul>}
          <Pager always page={page} total={filtered.length} size={PAGE_WORDS} summary={`匹配 ${filtered.length} 条`} onPage={setPage}/>
        </section>}
      </> : <div className="empty large">连接已验证。点击“开始同步”读取学习记录。</div>}
    </main>}
    {connected && data && mode !== 'words' && (selected.size > 0 || clearedSelection) && <div className="mobileSelectionBar" role="group" aria-label="已选词操作"><span>{selected.size ? `已选 ${selected.size} 词` : `已清空 ${clearedSelection?.size ?? 0} 词`}</span>{selected.size ? <button onClick={openSubmitPanel} disabled={busy || submitState === 'submitting'}>{submitOpen ? '查看提交面板' : '加入云词本'}</button> : <button onClick={undoClearSelection}>撤销清空</button>}</div>}
    <footer>数据来自墨墨 OpenAPI · 中文释义来自 ECDICT（<a href="/ECDICT-LICENSE.txt">许可与署名</a>）· 断开连接后清除会话</footer>
  </div>
}

createRoot(document.getElementById('root')!).render(<App />)
