import { expect, test, type Page } from '@playwright/test'
import { CMUDICT_VERSION, G2P_MODEL_SHA256, G2P_MODEL_VERSION, G2P_PIPELINE_VERSION, PRONUNCIATION_SCORING_VERSION } from '../src/pronunciation'

// Synthetic pronunciations test integration without publishing private vocabulary.
const predictions = {
  schemaVersion: 1, source: 'prediction', dictionaryVersion: CMUDICT_VERSION,
  scoringVersion: PRONUNCIATION_SCORING_VERSION, pipelineVersion: G2P_PIPELINE_VERSION,
  modelVersion: G2P_MODEL_VERSION, modelSha256: G2P_MODEL_SHA256,
  entries: { flourz: [['F L AW ER Z', '--10-']], zorbulate: [['F L AW ER Z', '--10-']] },
}

async function prepare(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().postDataJSON() ?? {}
    if (path === '/api/session' || path === '/api/disconnect' || path === '/api/connect') return route.fulfill({ json: { connected: true } })
    if (path === '/api/metrics') return route.fulfill({ status: 202, json: { accepted: true } })
    if (path === '/api/meanings') return route.fulfill({ json: { meanings: { flours: '面粉', flourz: '测试词', adapt: '适应', adopt: '采用' } } })
    if (path === '/api/query' && body.operation === 'study') {
      if (body.payload?.as_count) return route.fulfill({ json: { data: { count: 4 } } })
      return route.fulfill({ json: { data: { records: ['flours', 'flourz', 'adapt', 'adopt'].map((word, i) => ({ voc_id: String(i), voc_spelling: word, last_response: 'VAGUE', study_count: 1 })) } } })
    }
    return route.fulfill({ status: 404, json: { error: 'mock route missing' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '开始同步' }).click()
  await page.getByRole('button', { name: '自动发现' }).click()
}

async function importFile(page: Page, value: unknown = predictions) {
  await page.getByLabel('导入预测读音').setInputFiles({ name: 'predictions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
}

test('预测读音双入口共用、来源可辨、未知词无伪造读音，导入和移除清空旧结果', async ({ page }) => {
  await prepare(page)
  await page.getByText('补充预测读音', { exact: true }).click()
  await importFile(page)
  await expect(page.getByText('已载入 2 个预测读音，供自动发现和手动查找共用。')).toBeVisible()
  await page.getByRole('checkbox', { name: '相似', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: '换序', exact: true }).uncheck()
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList').getByText('发音 100 · 词典读音 / 预测读音')).toBeVisible()
  await expect(page.locator('.pairList .phoneticScore').first()).toHaveAttribute('title', /g2p-en-2.1.0-checkpoint20/)

  await importFile(page, { ...predictions, modelVersion: 'old' })
  await expect(page.getByRole('alert').filter({ hasText: '预测读音版本不匹配' })).toBeVisible()
  await expect(page.locator('.pairList')).toBeVisible()
  await importFile(page)
  await expect(page.locator('.pairList')).toHaveCount(0)

  await page.getByRole('button', { name: '手动查找', exact: true }).click()
  await page.getByLabel('查询英文词', { exact: true }).fill('zorbulate')
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.manualList').getByText('发音 100 · 预测读音', { exact: true })).toBeVisible()
  await expect(page.locator('.manualList').getByText('发音 100 · 词典读音 / 预测读音')).toBeVisible()
  await page.getByLabel('查询英文词', { exact: true }).fill('zzzznotawordzzzz')
  await page.getByRole('button', { name: '重新查找' }).click()
  await expect(page.getByText(/查询词 zzzznotawordzzzz 暂无可用读音/)).toBeVisible()
  await expect(page.getByText(/尚未支持实时预测新词/)).toBeVisible()
  await expect(page.locator('.manualList')).toHaveCount(0)
  await page.getByRole('button', { name: '移除预测读音' }).click()
  await expect(page.getByText('补充预测读音', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '移除预测读音' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '开始查找' })).toBeVisible()
  await importFile(page)
  await page.reload()
  await page.getByRole('button', { name: '开始同步' }).click()
  await page.getByRole('button', { name: '手动查找', exact: true }).click()
  await expect(page.getByText('补充预测读音', { exact: true })).toBeVisible()
})

test('词典网络失败保留拼写与可用预测结果，网络恢复可重试', async ({ page, context }) => {
  let offline = true
  await context.route('**/pronunciation/*.json', route => offline ? route.fulfill({ status: 503, body: 'offline' }) : route.continue())
  await prepare(page)
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.getByText(/部分发音数据不可用/)).toBeVisible()
  await expect(page.locator('.pairList').getByText('adapt', { exact: true })).toBeVisible()
  await page.getByText('补充预测读音', { exact: true }).click()
  await importFile(page)
  await page.getByRole('button', { name: '手动查找', exact: true }).click()
  await page.getByLabel('查询英文词', { exact: true }).fill('zorbulate')
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.manualList').getByText('发音 100 · 预测读音', { exact: true })).toBeVisible()
  await expect(page.getByText(/部分发音数据不可用/)).toBeVisible()
  offline = false
  await page.getByRole('button', { name: '重新查找' }).click()
  await expect(page.getByText(/部分发音数据不可用/)).toHaveCount(0)
  await expect(page.locator('.manualList').getByText('发音 100 · 词典读音 / 预测读音')).toBeVisible()
})

test('关闭发音不加载资源，断开账号清除私人补充', async ({ page, context }) => {
  let requests = 0
  await context.route('**/pronunciation/*.json', route => { requests++; return route.abort() })
  await prepare(page)
  await page.getByText('补充预测读音', { exact: true }).click()
  await importFile(page)
  await page.getByRole('checkbox', { name: '发音', exact: true }).uncheck()
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList')).toBeVisible()
  expect(requests).toBe(0)
  await page.getByRole('button', { name: '断开连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '连接墨墨账号' })).toBeVisible()
  await page.getByPlaceholder('粘贴 Token').fill('test-token')
  await page.getByRole('button', { name: '连接并验证' }).click()
  await page.getByRole('button', { name: '开始同步' }).click()
  await page.getByRole('button', { name: '自动发现' }).click()
  await expect(page.getByText('补充预测读音', { exact: true })).toBeVisible()
})

test('两个 Worker 入口均拒绝旧预测版本并保留词典结果', async ({ page }) => {
  await prepare(page)
  const responses = await page.evaluate(async stale => {
    const result: Array<{ type: string; pronunciationError?: string; pairs?: unknown[]; hits?: unknown[] }> = []
    for (const kind of ['auto', 'manual']) {
      result.push(await new Promise(resolve => {
        const worker = new Worker('/src/similarity.worker.ts', { type: 'module' })
        worker.onmessage = event => {
          if (event.data.type === 'progress') return
          worker.terminate(); resolve(event.data)
        }
        worker.postMessage({ taskId: 1, kind, words: [{ id: '1', spelling: 'adapt' }, { id: '2', spelling: 'adopt' }], queries: [{ id: 'q', spelling: 'adapt' }], matchTypes: ['pronunciation'], p: 80, r: 100, predictions: stale })
      }))
    }
    return result
  }, { ...predictions, modelVersion: 'old' })
  for (const result of responses) {
    expect(result.pronunciationError).toContain('预测读音版本不匹配')
    expect((result.pairs ?? result.hits)?.length).toBe(1)
  }
})
