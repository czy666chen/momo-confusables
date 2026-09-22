# 发音相似功能：阶段一现状报告

审计日期：2026-09-21

## 结论

阶段一已完成代码路径确认、现有语义固化、同步故障条件核对、可用数据审计和初始样例集建立。当前账户快照是**部分覆盖**：接口总量 7,154 条，快照取得 7,140 条，仍缺 14 条，因此后续可以基于现有数据开发和验证，但不能宣称覆盖全部用户数据。路线图中来自旧截图的 7,214 条不是当前快照的接口总量。

审计使用 CMUdict 官方仓库提交 [`74790861f652b15e4ac49015a90074ad62a27690`](https://github.com/cmusphinx/cmudict/commit/74790861f652b15e4ac49015a90074ad62a27690)。该词典仅用于本次统计，尚未作为产品资产引入；正式引入、许可保留和构建流程属于阶段三。

## 入口与现有行为

| 能力 | 入口 | 当前语义 |
| --- | --- | --- |
| 自动发现 | `src/main.tsx` 的 `runDiscovery` → `src/similarity.worker.ts` → `autoDiscover` | 仅使用反馈为 `FORGET` 或 `VAGUE` 的已同步词；默认阈值 0.65，上限 1,000 个词；按长度分桶后使用带状 OSA。 |
| 手动查找 | `src/main.tsx` 的 `runManual` → 同一 Worker → `manualFind` | 查询词最多 20 个；候选为全部已同步记录；不设相似度阈值，每个候选只保留与查询词的最佳结果。 |
| 拼写匹配 | `src/similarity.ts` | NFKC、去首尾空白、小写；按 Unicode 码点计算受限 Damerau–Levenshtein（OSA）；分数为 `1 - distance / maxLength`。标准化后相同的词不互相匹配。 |
| 换序匹配 | `src/similarity.ts` 的 `isBlockSwap` | 只识别 `XY ↔ YX` 的两个完整字符块循环换位，且 X、Y 各至少 3 个码点；不是任意字母异位，也不是短语词序交换。换序不受拼写阈值限制。 |
| Soundex | `src/input.ts` → `src/ui.tsx` 的 `ConfusionBadge` | 是独立的启发式展示信号，不参与候选召回、过滤或排序，也不是词典音素匹配。 |
| 排序 | `src/similarity.ts` | 自动与手动均先放 `block-swap`；其余按未取整拼写分降序；同分再按标准化拼写和 ID 稳定排序。每页 30 条。 |

自动发现与手动查找共用一个 Web Worker 和递增任务号。重跑或取消会终止旧 Worker，消息的 `taskId` 或 Worker 实例不匹配时会丢弃，因此已有迟到响应防护。

## 换序回归样例

- `turnover / overturn`：命中，`turn + over ↔ over + turn`。
- `abcdef / defabc`：命中，两个块均为 3 个字符。
- `abcdef / cdefab`：不命中，因为其中一个块只有 2 个字符。
- 任意字母重排（例如 `listen / silent`）：除非恰好满足上述完整块循环换位，否则不属于现有换序。
- 短语词序交换不属于现有定义；阶段二不得扩大语义。

这些行为已有 `scripts/test-similarity.mjs` 回归测试覆盖。

## “日期分区计数不一致”触发条件

同步先查询 1900-01-01 至 2200-01-01 范围内的根计数。某区间超过 1,000 条时按日期中点拆为互不重叠的左右闭区间，并分别查询计数；仅当 `left + right !== parent` 时立即抛出“日期分区计数不一致，已停止同步”。这通常意味着分页期间上游数据发生变化，或上游日期边界/计数语义不稳定。

它与另一种不完整情况不同：当单日区间仍超过 1,000 条时，查询只能取得 1,000 条，剩余数量计入 `overflow`，不会触发该错误，但最终 `finished` 为 `false`。当前快照正是这种情况：`root = before = after = total = 7,154`，`rows = 7,140`，`overflow = 14`。

只有以下条件全部成立并通过按拼写回查逐条一致性确认时，`finished` 才会为 `true`：

- 所有叶区间返回数量与计数一致；
- 同步前后总量一致；
- 根日期范围计数等于总量；
- 按 ID 去重后的记录数等于总量；
- `overflow` 为 0。

## 数据覆盖统计

输入为被 `.gitignore` 排除的 `p0/private/p5-account-snapshot.json`，报告和命令输出只保留聚合值。

| 指标 | 数量 |
| --- | ---: |
| 快照记录 | 7,140 |
| 规范化后非空记录 | 7,140 |
| 规范化后唯一项 | 7,135 |
| 重复记录（超出首个唯一项的行数） | 5 |
| 唯一英文格式项 | 7,104 |
| 唯一英文单词（含撇号或连字符，不含空格） | 6,823 |
| 唯一英文短语（含空格） | 281 |
| 唯一非英文格式项 | 31 |
| CMUdict 覆盖的英文单词 | 6,739 |
| CMUdict 缺失的英文单词 | 84 |
| CMUdict 缺失率 | 1.2311% |

分类先执行与产品一致的 NFKC、`trim`、小写规范化。英文格式项使用现有输入规则 `[a-z]+(?:[ '-][a-z]+)*`；“英文单词”允许内部撇号或连字符但不允许空格；含空格的合法英文项单列为短语；其余归为非英文格式项。CMUdict 缺失率的分母仅为 6,823 个唯一英文单词，未把短语或非英文项算作词典缺失。

可复验命令：

```powershell
node scripts/audit-pronunciation-data.mjs p0/private/p5-account-snapshot.json <cmudict.dict>
```

CLI 默认不打印具体缺失词，避免把私人词表暴露到日志。审计逻辑在 `scripts/audit-pronunciation-data.mjs`，单元测试在 `scripts/test-pronunciation-audit.mjs`。

## 初始验证样例

`data/pronunciation-samples.json` 包含 14 条可机器读取样例，覆盖：

- 同音词：`flower/flour`、`sea/see`、`night/knight`；
- 近音词：`ship/sheep`、`adapt/adopt`；
- 拼写相近但读音不同：`cough/though`、`quiet/quite`；
- 多音词：`read/red`、`lead/led`、`wind/wined`；
- 词典外词：`OpenAI`、`Maimemo`；
- 换序语义回归：`turnover/overturn` 与 `abcdef/cdefab`。

## 阶段二、三的输入约束

- 阶段二不得把“换序”改成任意 anagram 或短语词序交换。
- 三种匹配必须有独立召回路径；Soundex 不能冒充发音匹配。
- 在补齐当前缺失的 14 条记录前，任何结果和缺失率都必须标注为部分覆盖。
- 阶段三应重新对当时的完整快照运行同一审计；若 `finished !== true`，继续保留覆盖警告。
- 84 个 CMUdict 缺失仅是当前 7,140 条快照中的统计，不代表完整账户或通用英语的缺失率。
