# 墨墨易混淆词

连接墨墨 OpenAPI，从已加入学习的单词中发现、比较并收集容易混淆的英文词。

正式站：<https://momo-confusables.slnin.workers.dev>

## 功能

- 同步学习记录，并明确展示完整或部分覆盖状态。
- 在薄弱词中自动发现拼写相近或词块换序的词对。
- 输入英文词，在已同步候选中手动查找相似词。
- 独立展示拼写相似度与 Soundex 读音近似提示。
- 导入墨墨导出的 PDF 或 UTF-8 文本补齐同步缺口。
- 批量新建或追加云词本，写入后回读确认并检测并发覆盖。
- 在当前标签页恢复查询草稿、自定义释义和已选清单；Token 仅保存在服务端短期会话。

## 本地运行

需要 Node.js 22、Python 3，以及 ECDICT 固定版本中的 `ecdict.csv`：

1. 将 `ecdict.csv` 放到 `p0/ecdict.csv`。
2. 运行 `npm install` 和 `npm run build`。
3. 运行 `npm run preview` 启动 Worker/API。
4. 另开终端运行 `npm run dev`，访问 <http://localhost:5173/>。

本地开发可在被忽略的 `.dev.vars` 中设置 `MAIMEMO_API_TOKEN`。该方式仅在回环地址生效；生产环境要求用户在页面连接自己的 Token。

词典构建会生成 27 个受 Worker 路由保护的静态分片，通过 `ASSETS` binding 内部读取；公网直连 `/dictionary/*` 返回 404。

## 验证与部署

```bash
npm run typecheck
npm test
npm run build
npm run deploy
```

`npm test` 包含相似度、云词本合并、Worker 边界、输入与状态恢复测试，以及 Playwright 浏览器流程。GitHub Actions 会在每次推送和 Pull Request 上运行类型检查与完整测试。

## 许可

项目代码采用 [MIT License](LICENSE)。中文释义来自 [ECDICT 固定版本](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b)，遵循其单独许可，详见 [ECDICT-LICENSE](THIRD_PARTY_LICENSES/ECDICT-LICENSE)。
