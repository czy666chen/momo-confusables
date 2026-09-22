import fs from 'node:fs'
import { chromium } from '@playwright/test'

const baseURL = process.argv[2] ?? 'http://localhost:8787'
const snapshot = JSON.parse(fs.readFileSync('p0/private/p5-account-snapshot.json', 'utf8'))
const workerFile = fs.readdirSync('dist/assets').find(file => /^similarity\.worker-.*\.js$/u.test(file))
if (!workerFile) throw new Error('Build the production bundle first')
const words = snapshot.rows.map(row => ({ id: row.voc_id, spelling: row.voc_spelling }))
const weak = snapshot.rows.filter(row => ['FORGET', 'VAGUE'].includes(row.last_response)).map(row => ({ id: row.voc_id, spelling: row.voc_spelling }))
const queries = 'sea knight flower pair write peace meat weak sun blue buy one hear whole break plain waist wait read lead'.split(' ').map(word => ({ id: `query-${word}`, spelling: word }))
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(baseURL)
  const results = []
  for (const [name, kind, rows, budgetMs] of [['actual-weak', 'auto', weak, 5000], ['actual-1000', 'auto', words.slice(0, 1000), 5000], ['actual-manual-20', 'manual', words, 3000]]) {
    const runs = []
    for (let iteration = 0; iteration < 3; iteration++) {
      runs.push(await page.evaluate(async ({ workerFile, kind, rows, queries }) => {
        const start = performance.now()
        let last = start
        let maxMainThreadGapMs = 0
        const timer = setInterval(() => { const now = performance.now(); maxMainThreadGapMs = Math.max(maxMainThreadGapMs, now - last); last = now }, 10)
        const worker = new Worker(`/assets/${workerFile}`, { type: 'module' })
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Worker timed out')), 30000)
            worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)) }
            worker.onmessage = event => {
              const result = event.data
              if (result.type === 'error') { clearTimeout(timeout); reject(new Error(result.message)) }
              if (result.type === 'done' || result.type === 'manualDone') {
                clearTimeout(timeout)
                if (result.pronunciationError) return reject(new Error(result.pronunciationError))
                resolve({ wallMs: Math.round(performance.now() - start), maxMainThreadGapMs: Math.round(Math.max(maxMainThreadGapMs, performance.now() - last)), comparisons: result.comparisons ?? result.stats.comparisons, results: result.hits?.length ?? result.pairs.length })
              }
            }
            worker.postMessage({ taskId: 1, kind, words: rows, queries, matchTypes: ['spelling', 'reorder', 'pronunciation'], p: 65, r: 100 })
          })
        } finally { clearInterval(timer); worker.terminate() }
      }, { workerFile, kind, rows, queries }))
    }
    results.push({ name, rows: rows.length, budgetMs, runs, passed: runs.every(run => run.wallMs <= budgetMs) })
  }
  const report = { browser: browser.version(), baseURL, scope: 'Production Web Worker, dictionary only, includes fetch/parse/message transfer; first run cold then browser HTTP cache; local loopback network', results }
  fs.writeFileSync('docs/pronunciation-browser-performance.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (results.some(result => !result.passed)) process.exitCode = 1
} finally { await browser.close() }
