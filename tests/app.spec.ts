import { expect, test } from '@playwright/test'

test('完整前端流程不会请求空词本 ID，并显示独立读音信号', async ({ page }) => {
  const rows = [
    { voc_id: '1', voc_spelling: 'adapt', last_response: 'VAGUE', study_count: 2 },
    { voc_id: '2', voc_spelling: 'adopt', last_response: 'FORGET', study_count: 3 },
  ]
  const requestedNotepadIds: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const body = request.postDataJSON?.() ?? {}
    if (path === '/api/session') return route.fulfill({ json: { connected: true } })
    if (path === '/api/metrics') return route.fulfill({ status: 202, json: { accepted: true } })
    if (path === '/api/meanings') return route.fulfill({ json: { meanings: { adapt: '适应', adopt: '采用' } } })
    if (path === '/api/query' && body.operation === 'study') {
      if (body.payload?.as_count) return route.fulfill({ json: { data: { count: 2 } } })
      return route.fulfill({ json: { data: { records: rows } } })
    }
    if (path === '/api/query' && body.operation === 'notepads') return route.fulfill({ json: { data: { notepads: [{ id: 'np-test', title: '测试词本', status: 'UNPUBLISHED' }] } } })
    if (path === '/api/query' && body.operation === 'notepad') {
      requestedNotepadIds.push(body.payload?.id ?? '')
      return route.fulfill({ json: { data: { notepad: { id: body.payload.id, title: '测试词本', status: 'UNPUBLISHED', content: '', list: [] } } } })
    }
    return route.fulfill({ status: 404, json: { error: 'mock route missing' } })
  })

  await page.goto('/')
  await page.getByRole('button', { name: '开始同步' }).click()
  await expect(page.getByText('本次已核对')).toBeVisible()
  await page.getByRole('button', { name: '自动发现' }).click()
  await page.getByRole('button', { name: '开始查找' }).click()
  await expect(page.getByText(/读音近似/)).toBeVisible()
  await page.getByRole('checkbox', { name: /选择词对/ }).click()
  await page.getByRole('button', { name: '加入云词本' }).click()
  await page.getByLabel('追加到已有词本').click()
  await expect(page.getByLabel('选择已有词本')).toBeVisible()
  expect(requestedNotepadIds).toEqual([])
  await page.getByLabel('选择已有词本').selectOption('np-test')
  await expect.poll(() => requestedNotepadIds).toEqual(['np-test'])
})

test('API 获取指南可键盘导航且返回工具', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: { error: '未连接' } }))
  await page.goto('/')
  await page.getByRole('link', { name: '如何获取 API' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'API 获取指南' })).toBeVisible()
  await page.getByRole('link', { name: '返回工具' }).click()
  await expect(page.getByRole('heading', { name: '连接墨墨账号' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(await page.getByRole('button', { name: '连接并验证' }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
})
