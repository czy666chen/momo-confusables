import { expect, test, type Page } from '@playwright/test'

test.use({ hasTouch: true })

async function prepare(page: Page, initial = ['adapt', 'adopt', 'flower', 'flour', 'turnover', 'overturn']) {
  const state = { words: initial, fail: false, failAfterRecords: false }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = route.request().postDataJSON() ?? {}
    if (path === '/api/session') return route.fulfill({ json: { connected: true } })
    if (path === '/api/metrics') return route.fulfill({ status: 202, json: { accepted: true } })
    if (path === '/api/meanings') return route.fulfill({ json: { meanings: Object.fromEntries((body.spellings ?? []).map((word: string) => [word, '测试释义'])) } })
    if (path === '/api/query') {
      if (state.fail) return route.fulfill({ status: 503, json: { error: '同步中断测试' } })
      if (body.payload?.as_count) return route.fulfill({ json: { data: { count: state.words.length } } })
      if (state.failAfterRecords) state.fail = true
      return route.fulfill({ json: { data: { records: state.words.map((word, i) => ({ voc_id: String(i), voc_spelling: word, last_response: 'VAGUE', study_count: 1 })) } } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '开始同步' }).click()
  await expect(page.getByText('本次已核对')).toBeVisible()
  await page.getByRole('button', { name: '自动发现', exact: true }).click()
  return state
}

async function selectTypes(page: Page, labels: string[]) {
  // Enable first, so switching singletons cannot temporarily create an empty selection.
  for (const name of labels) await page.getByRole('checkbox', { name, exact: true }).check()
  for (const name of ['相似', '换序', '发音'].filter(name => !labels.includes(name))) await page.getByRole('checkbox', { name, exact: true }).uncheck()
}

test('双入口七种选择均可运行、显示选中标签、去重，键盘与触屏不能取消最后一项', async ({ page }) => {
  await prepare(page)
  for (const labels of [['相似'], ['换序'], ['发音'], ['相似', '换序'], ['相似', '发音'], ['换序', '发音'], ['相似', '换序', '发音']]) {
    await page.getByRole('button', { name: '自动发现', exact: true }).click()
    await selectTypes(page, labels)
    await page.getByRole('button', { name: /^(开始查找|重新查找)$/ }).click()
    await expect(page.locator('.pairList')).toBeVisible()
    const pairs = await page.locator('.pairList .pairWords').allTextContents()
    expect(new Set(pairs).size).toBe(pairs.length)
    for (const badge of await page.locator('.pairList .matchBadges > span').allTextContents()) expect(labels).toContain(badge)
    await page.getByRole('button', { name: '手动查找', exact: true }).click()
    for (const name of ['相似', '换序', '发音']) await expect(page.getByRole('checkbox', { name, exact: true })).toBeChecked({ checked: labels.includes(name) })
    await page.getByLabel('查询英文词', { exact: true }).fill('flower,turnover')
    await page.getByRole('button', { name: /^(开始查找|重新查找)$/ }).click()
    await expect(page.locator('.manualList')).toBeVisible()
    const hits = await page.locator('.manualList .hitPick strong').allTextContents()
    expect(new Set(hits).size).toBe(hits.length)
    for (const badge of await page.locator('.manualList .matchBadges > span').allTextContents()) expect(labels).toContain(badge)
  }
  await selectTypes(page, ['发音'])
  const last = page.getByRole('checkbox', { name: '发音', exact: true })
  await last.focus()
  await page.keyboard.press('Space')
  await expect(last).toBeChecked()
  await expect(page.locator('#match-types-message')).toHaveText('至少选择一种匹配类型')
  await last.tap()
  await expect(last).toBeChecked()
})

test('改选重置双入口分页，空结果不会恢复全选', async ({ page }) => {
  const words = 'cat bat rat mat hat sat fat pat cut cot coat goat boat moat float gloat dog log fog bog frog clog hog jog book look took cook hook rook shook shooken shake bake cake lake make take wake fake rake sake'.split(' ')
  await prepare(page, words)
  await page.getByRole('slider').fill('0')
  await page.getByRole('button', { name: '开始查找' }).click()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByLabel('页码')).toHaveValue('2')
  await page.getByRole('checkbox', { name: '换序', exact: true }).uncheck()
  await expect(page.getByLabel('页码')).toHaveValue('1')
  await page.getByRole('button', { name: '手动查找', exact: true }).click()
  await page.getByLabel('查询英文词', { exact: true }).fill('flower')
  await page.getByRole('button', { name: '开始查找' }).click()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.getByLabel('页码')).toHaveValue('2')
  await page.getByRole('checkbox', { name: '发音', exact: true }).uncheck()
  await expect(page.getByLabel('页码')).toHaveValue('1')
  await selectTypes(page, ['发音'])
  await page.getByLabel('查询英文词', { exact: true }).fill('zznotawordzz')
  await page.getByRole('button', { name: /^(开始查找|重新查找)$/ }).click()
  await expect(page.getByText('当前选择下没有匹配项，不会自动改回全选。')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: '相似', exact: true })).not.toBeChecked()
})

test('词表更新使旧结果失效，同步中断保留记录且不标为完整核对', async ({ page }) => {
  const state = await prepare(page, ['flower', 'flour'])
  await selectTypes(page, ['发音'])
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList')).toBeVisible()
  state.words = ['sea', 'see']
  await page.getByRole('button', { name: '手动刷新' }).click()
  await expect(page.locator('.pairList')).toHaveCount(0)
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList').getByText('sea', { exact: true })).toBeVisible()
  await expect(page.locator('.pairList').getByText('flower', { exact: true })).toHaveCount(0)
  state.fail = true
  await page.getByRole('button', { name: '手动刷新' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '同步中断测试' })).toBeVisible()
  await expect(page.getByText('部分范围', { exact: true })).toBeVisible()
  await expect(page.getByText('本次已核对')).toHaveCount(0)
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList').getByText('sea', { exact: true })).toBeVisible()
  state.fail = false
  state.failAfterRecords = true
  state.words = ['night', 'knight']
  await page.getByRole('button', { name: '手动刷新' }).click()
  await expect(page.getByRole('alert').filter({ hasText: '同步中断测试' })).toBeVisible()
  await expect(page.getByText('部分范围', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList').getByText('night', { exact: true })).toBeVisible()
})

test('浏览器收到旧词典版本时重新读取资源', async ({ page, context }) => {
  let requests = 0
  await context.route('**/pronunciation/*.json', async route => {
    requests++
    if (requests === 1) return route.fulfill({ json: { schemaVersion: 1, dictionaryVersion: 'stale', entries: {} } })
    return route.continue()
  })
  await prepare(page, ['flower', 'flour'])
  await selectTypes(page, ['发音'])
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.locator('.pairList').getByText('发音 100 · 词典读音')).toBeVisible()
  expect(requests).toBe(2)
  await expect(page.getByText(/部分发音数据不可用/)).toHaveCount(0)
})

test('取消迟到的词典请求后旧结果不会回跳', async ({ page, context }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requested!: () => void
  const started = new Promise<void>(resolve => { requested = resolve })
  await context.route('**/pronunciation/*.json', async route => {
    requested()
    await gate
    try { await route.continue() } catch { /* Worker termination cancels the request. */ }
  })
  await prepare(page)
  await selectTypes(page, ['发音'])
  await page.getByRole('button', { name: '开始查找' }).click()
  await started
  await selectTypes(page, ['相似'])
  await expect(page.locator('.pairList')).toBeVisible()
  const before = await page.locator('.pairList').textContent()
  release()
  await expect(page.locator('.pairList')).toHaveText(before!)
  await expect(page.locator('.pairList .phoneticScore')).toHaveCount(0)
})
