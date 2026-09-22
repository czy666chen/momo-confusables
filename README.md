# 墨墨易混淆词

连接墨墨 OpenAPI，从已加入学习的单词中发现、比较并收集容易混淆的英文词。

正式站：<https://momo-confusables.slnin.workers.dev>

## 功能

- 同步学习记录，并明确展示完整或部分覆盖状态。
- 在薄弱词中按“相似 / 换序 / 发音”任意组合自动发现词对。
- 输入英文词，在已同步候选中按相同匹配类型手动查找。
- 使用固定版本 CMUdict 的音素 token 编辑距离，独立展示拼写与发音分数；支持导入本机预计算的词典外词读音，区分“词典读音 / 预测读音”，未覆盖的新词显示暂无可用读音。
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

G2P 模型测试及预计算需要额外安装固定依赖：`python -m pip install -r scripts/requirements-g2p.txt`（Python 3.9～3.12）。网站运行不依赖 Python，也不会下载模型。

阶段五的本地验收与发布候选见 [验收报告](docs/pronunciation-phase-5-report.md)。运行 `npm run evaluate:pronunciation` 生成草案标签评测；`npm run benchmark:pronunciation` 使用本机私有快照测量；启动 `npm run preview` 后运行 `npm run benchmark:pronunciation-browser` 测生产 Web Worker；`npm run release:local` 构建带 SHA-256 清单的本地发布候选，不执行线上部署。160 对标签待人工核验，线上消耗和正式发布尚未验收。

Windows 受限环境可将 `XDG_CONFIG_HOME` 设为项目内 `p0/private/xdg`、`WRANGLER_LOG_PATH` 设为 `p0/private/wrangler-logs`（使用绝对路径），再启动 Wrangler。已有开发服务器时可设置 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173` 运行浏览器测试，测试进程不会管理该服务器的生命周期。

本地 Worker 必须有访问墨墨 HTTPS 接口的网络权限；在禁止出站连接的沙箱内启动，页面仍可打开，但连接会返回 `502 墨墨接口连接失败`。需在允许出站访问的环境重启 `npm run preview`。配置 `.dev.vars` 后运行 `node scripts/check-local-api.mjs` 可验证真实连接、会话及学习记录计数；该检查不打印 Token、不修改云词本，并清理自己的测试会话。只检查页面 200 或未登录会话 401 不足以验证墨墨接口可用。

发音数据来自 [CMUdict](https://github.com/cmusphinx/cmudict)，固定于提交 `74790861f652b15e4ac49015a90074ad62a27690`。词典原始许可见 `THIRD_PARTY_LICENSES/CMUDICT-LICENSE.txt`；构建产物使用版本化文件名并设置长期不可变缓存。

## 词典外词预计算

运行 `npm run build:pronunciation` 从本地私有快照刷新缺失清单，再运行 `npm run build:g2p`。也可使用 `npm run build:g2p -- <缺失词文件.txt>`，每行一个英文单词。预测文件写入被 Git 忽略的 `p0/private/pronunciation-predictions-<内容哈希>.json`，命令输出路径和统计，不打印私人单词。

在“自动发现”或“手动查找”中展开“补充预测读音”，导入该 JSON 后两个入口共用。文件只保存在当前页面内存，不上传、不写入公共资源，刷新页面或断开账号后需重新导入。词典读音始终优先；尚未提供任意新词的实时预测。详见 [阶段四报告](docs/pronunciation-phase-4-report.md)。

离线模型使用 [g2p_en 2.1.0](https://pypi.org/project/g2p-en/2.1.0/) 的 NumPy 神经网络与固定权重，遵循 Apache-2.0；许可见 `THIRD_PARTY_LICENSES/G2P-EN-LICENSE.txt`，来源和校验值见 `data/g2p/README.md`。

## 许可

项目代码采用 [MIT License](LICENSE)。中文释义来自 [ECDICT 固定版本](https://github.com/skywind3000/ECDICT/tree/bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b)，遵循其单独许可，详见 [ECDICT-LICENSE](THIRD_PARTY_LICENSES/ECDICT-LICENSE)。
