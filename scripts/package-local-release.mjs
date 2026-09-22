import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

// Local artifact creation only. Never deploys or reads credentials / private word lists.
const directory = path.resolve('p0/private/releases', `phase-5-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
fs.mkdirSync(directory, { recursive: true })
fs.cpSync('dist', path.join(directory, 'dist'), { recursive: true })
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', path.join(directory, 'worker')], {
  stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: path.resolve('p0/private/wrangler-logs') },
})
if (result.error || result.status !== 0) throw result.error ?? new Error('Worker dry-run failed')
const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))
config.main = './worker/index.js'
config.assets.directory = './dist'
fs.writeFileSync(path.join(directory, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n')
function hashes(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const item = path.join(relative, entry.name)
    if (entry.isDirectory()) return hashes(root, item)
    if (/(?:\.dev\.vars|predictions-|account-snapshot|checkpoint|pronunciation-business|pronunciation-missing)/u.test(item)) throw new Error(`Private file in release: ${item}`)
    const bytes = fs.readFileSync(path.join(root, item))
    return [{ file: item.replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })
}
const manifest = { createdAt: new Date().toISOString(), status: 'local-candidate; human review and online acceptance pending', files: hashes(directory) }
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
fs.writeFileSync('p0/private/releases/latest-phase-5.txt', directory + '\n')
console.log(`Local rollback/deployment artifact: ${directory}`)
