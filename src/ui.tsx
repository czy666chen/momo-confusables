import { useEffect, useState } from 'react'
import { confusionSignal } from './input'
import { MATCH_TYPES, type MatchType } from './similarity'
import type { PronunciationMatch } from './pronunciation'

const HAN = /[\u3400-\u9fff]/u
const MEANING_MAX = 500

export function PairCheck(props: { checked: boolean; indeterminate: boolean; onChange: () => void; label: string }) {
  return <input type="checkbox" checked={props.checked} aria-label={props.label} onChange={props.onChange} ref={el => { if (el) el.indeterminate = props.indeterminate }} />
}

const MATCH_TYPE_LABELS: Record<MatchType, string> = { spelling: '相似', reorder: '换序', pronunciation: '发音' }

export function MatchTypeSelector({ value, message, onChange }: { value: MatchType[]; message: string; onChange: (type: MatchType) => void }) {
  return <fieldset className="matchTypes" aria-describedby="match-types-hint match-types-message">
    <legend>匹配类型</legend>
    <div>{MATCH_TYPES.map(type => <label key={type}><input type="checkbox" checked={value.includes(type)} onChange={() => onChange(type)}/>{MATCH_TYPE_LABELS[type]}</label>)}</div>
    <span id="match-types-hint" className="hint">至少选择一项；多个类型按“满足任意一项”合并。</span>
    <span id="match-types-message" className={message ? 'matchTypeMessage visible' : 'matchTypeMessage'} role="status" aria-live="polite">{message}</span>
  </fieldset>
}

export function MatchTypeBadges({ value }: { value: MatchType[] }) {
  return <span className="matchBadges" aria-label={`命中类型：${value.map(type => MATCH_TYPE_LABELS[type]).join('、')}`}>{value.map(type => <span key={type}>{MATCH_TYPE_LABELS[type]}</span>)}</span>
}

function pronunciationText(match: PronunciationMatch): string {
  const format = (phones: string[], stress: Array<number | null>) => phones.map((phone, index) => `${phone}${stress[index] ?? ''}`).join(' ')
  return `${format(match.left.phones, match.left.stress)} ↔ ${format(match.right.phones, match.right.stress)}`
}

export function PronunciationBadge({ match }: { match: PronunciationMatch | null | undefined }) {
  if (match === undefined) return null
  if (match === null) return <span className="phoneticScore unavailable">暂无读音</span>
  const source = match.source === 'dictionary' ? '词典读音' : match.source === 'prediction' ? '预测读音' : '词典读音 / 预测读音'
  const sideSource = (side: PronunciationMatch['left']) => side.source === 'prediction' ? `预测读音（${side.modelVersion}）` : '词典读音'
  return <span className="phoneticScore match" title={`${sideSource(match.left)} ↔ ${sideSource(match.right)}：${pronunciationText(match)}`}>发音 {Math.round(match.similarity * 100)} · {source}</span>
}

export function ConfusionBadge({ a, b }: { a: string; b: string }) {
  const signal = confusionSignal(a, b)
  return <span className={'phoneticScore' + (signal.phoneticMatch ? ' match' : '')} title={signal.explanation}>读音近似 {Math.round(signal.phoneticScore * 100)}%</span>
}

export function MeaningForm({ inputId, label, value, onChange, onCommit }: { inputId: string; label: string; value: string; onChange: (value: string) => void; onCommit: (value: string) => void }) {
  const trimmed = value.trim()
  const valid = trimmed.length > 0 && trimmed.length <= MEANING_MAX && HAN.test(trimmed)
  return <form className="meaningForm" onSubmit={event => { event.preventDefault(); if (valid) onCommit(trimmed) }}>
    <label htmlFor={inputId}>{label}</label>
    <div><input id={inputId} value={value} maxLength={MEANING_MAX} onChange={event => onChange(event.target.value)} placeholder="输入含汉字的中文释义"/><button disabled={!valid}>保存</button></div>
  </form>
}

export function Pager({ page, total, size, summary, onPage, always }: { page: number; total: number; size: number; summary: string; onPage: (page: number) => void; always?: boolean }) {
  const totalPages = Math.max(1, Math.ceil(total / size))
  const [pageInput, setPageInput] = useState(String(page + 1))
  useEffect(() => setPageInput(String(page + 1)), [page])
  function commitPage() {
    if (!pageInput) { setPageInput(String(page + 1)); return }
    const next = Math.min(totalPages, Math.max(1, Number(pageInput)))
    setPageInput(String(next))
    if (Number.isFinite(next)) onPage(next - 1)
  }
  if (!always && total <= size) return null
  return <div className="pager"><div className="pagerInfo"><form className="pagerJump" onSubmit={event => { event.preventDefault(); commitPage() }}><span>第</span><input aria-label="页码" inputMode="numeric" value={pageInput} onChange={event => { if (/^\d*$/.test(event.target.value)) setPageInput(event.target.value) }} onBlur={commitPage} onFocus={event => event.currentTarget.select()}/><span>/ {totalPages} 页</span></form><span>· {summary}</span></div><div className="pagerActions"><button className="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button><button className="ghost" disabled={(page + 1) * size >= total} onClick={() => onPage(page + 1)}>下一页</button></div></div>
}

export type ProgressState = { label: string; current?: number; total?: number }

export function SyncProgress({ state }: { state: ProgressState }) {
  const determinate = typeof state.current === 'number' && typeof state.total === 'number' && state.total > 0
  return <div className="syncProgress" role="status" aria-live="polite"><div className="syncProgressLabel"><span>{state.label}</span>{determinate && <strong>{Math.round(state.current! / state.total! * 100)}%</strong>}</div><progress value={determinate ? state.current : undefined} max={determinate ? state.total : undefined}/></div>
}

export function ApiGuide() {
  return <main className="apiGuide">
    <section className="guideIntro"><div><h2>获取墨墨 API Token</h2><p>整个过程通常只需一分钟。你需要在墨墨背单词中取得个人请求凭证，再回到本站完成连接。</p></div><aside><strong>先确认</strong><span>已登录自己的墨墨账号，并将 App 更新到可看到“开放 API”的版本。</span></aside></section>
    <ol className="guideSteps">
      <li><div><h3>打开墨墨背单词</h3><p>进入底部的“我的”，打开“更多设置”。</p><div className="pathLine" aria-label="操作路径"><span>我的</span><i>→</i><span>更多设置</span></div></div></li>
      <li><div><h3>进入开放 API</h3><p>在设置页进入“实验功能”，然后选择“开放 API”。</p><div className="pathLine" aria-label="操作路径"><span>实验功能</span><i>→</i><span>开放 API</span></div></div></li>
      <li><div><h3>复制个人凭证</h3><p>按页面提示获取请求凭证并完整复制。它通常是一段较长的字符；不要只复制开头或结尾，也不要添加空格。</p><div className="tokenExample"><span aria-hidden="true">••••••••••••••••••••••••</span><em>你的 Token</em></div></div></li>
      <li><div><h3>回到本站连接</h3><p>点击下方“返回连接”，把刚复制的内容粘贴进 OpenAPI Token 输入框，再点击“连接并验证”。</p><a className="primaryLink" href="#">返回连接</a></div></li>
    </ol>
    <section className="guideHelp"><div><h3>Token 就像账号钥匙</h3><p>不要截图分享、不要发给他人，也不要粘贴到不信任的网站。本站只将 Token 保存在服务端短期会话中，断开连接后会清除会话。</p></div><div><h3>没有看到“开放 API”</h3><p>先更新墨墨背单词并重新检查上述路径。也可以打开官方文档，通过文档提供的在线入口获取凭证。</p><a href="https://open.maimemo.com/" target="_blank" rel="noreferrer">查看墨墨官方文档 ↗</a></div></section>
  </main>
}
