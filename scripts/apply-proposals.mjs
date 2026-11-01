#!/usr/bin/env node
/**
 * 应用睡眠进化产出的「待确认提案」——命令行版。
 *
 * 逻辑在 lib/apply.js（同进程版，和宿主插件共用一份实现），这里只做命令行包装。
 * 注意：命令行跑在独立进程里，写卡时和宿主插件不是同一把锁；正常情况用插件内的
 * 自动应用（整理完直接落），这个脚本用于手动补跑 / 排查。
 *
 * 用法：
 *   node scripts/apply-proposals.mjs --dry
 *   node scripts/apply-proposals.mjs
 *   node scripts/apply-proposals.mjs --params
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry')
const WITH_PARAMS = argv.includes('--params')

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const repo = path.resolve(here, '..')
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const surfcoreRepo = process.env.SURFCORE_REPO
  || (fs.existsSync(path.join(repo, '..', 'surfcore', 'plugins')) ? path.join(repo, '..', 'surfcore') : 'F:/feiyu/surfcore')

const { applyPendingProposals } = await import(`file://${path.join(here, '..', 'lib', 'apply.js').replace(/\\/g, '/')}`)
const r = await applyPendingProposals({ dshHome, repo: surfcoreRepo, dryRun: DRY, applyParams: WITH_PARAMS })
if (!r.ok) {
  console.error(`✗ ${r.error}`)
  process.exit(3)
}
console.log(`${DRY ? '[dry] ' : ''}应用 ${r.applied} 条 · 跳过 ${r.skipped} 条${r.note ? ' · ' + r.note : ''}`)
for (const n of r.notes || []) console.log(`  · ${n}`)
