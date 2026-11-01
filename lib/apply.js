/**
 * 应用「待确认提案」——同进程版（2026-11-01）。
 *
 * 为什么不用子进程：surfcore 的 applyMemoryCardAction 用模块级 serialize() 串行化写卡，
 * 子进程有自己的队列，和宿主里的 surfcore 插件并发时可能互相覆盖。改成在宿主进程内
 * 直接 import 同一个模块文件（同一路径 = 同一个模块实例），就能共用那把锁。
 *
 * 只落记忆类提案；参数类默认跳过（传 applyParams 才写 bili.config.json）。
 */
import fs from 'node:fs'
import path from 'node:path'

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function backup(file) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  try { fs.copyFileSync(file, `${file}.bak-${ts}`) } catch { /* 备份失败不阻断 */ }
}

export async function applyPendingProposals({ dshHome, repo, dryRun = false, applyParams = false } = {}) {
  const proposalsFile = path.join(dshHome, 'sleep-evolve', 'proposals.json')
  const proposals = readJson(proposalsFile, null)
  if (!proposals) return { ok: false, error: `读不到 ${proposalsFile}` }
  const pending = Array.isArray(proposals.pending) ? proposals.pending : []
  if (!pending.length) return { ok: true, applied: 0, skipped: 0, note: '没有待确认提案' }

  const libFile = path.join(repo || 'F:/feiyu/surfcore', 'plugins', 'surfcore', 'lib', 'memory-card.js')
  if (!fs.existsSync(libFile)) return { ok: false, error: `找不到 surfcore 记忆卡模块：${libFile}` }
  const lib = await import(`file://${libFile.replace(/\\/g, '/')}`)

  let appliedCount = 0
  let skipped = 0
  const applied = []
  const notes = []

  for (const p of pending) {
    if (p.kind === 'param') {
      if (!applyParams) { skipped += 1; notes.push(`参数未应用：${p.path}`); continue }
      if (p.path === 'B站额度.分享') {
        const file = path.join(dshHome, 'surfcore', 'bili.config.json')
        const cfg = readJson(file, null)
        const next = Number(String(p.proposed || '').replace(/[^0-9]/g, ''))
        if (!cfg || !Number.isFinite(next)) { skipped += 1; notes.push(`参数解析失败：${p.path}`); continue }
        if (!dryRun) {
          backup(file)
          cfg.quota = { ...(cfg.quota || {}), shareDaily: next }
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
        }
        applied.push({ ...p, status: 'applied', appliedAt: new Date().toISOString(), appliedBy: 'sleep-evolve(auto)' })
        appliedCount += 1
        notes.push(`参数已应用：shareDaily→${next}`)
      } else {
        skipped += 1
        notes.push(`未知参数跳过：${p.path}`)
      }
      continue
    }

    const op = String(p.op || 'add')
    let result = null
    if (op === 'add') {
      result = dryRun ? { ok: true } : await lib.applyMemoryCardAction('add', {
        text: String(p.text || ''),
        title: String(p.title || ''),
        importance: p.importance,
        scope: p.scope,
        tags: Array.isArray(p.tags) ? p.tags : [],
      })
    } else if (op === 'strengthen') {
      const cardFile = path.join(dshHome, 'surfcore', 'characters', 'char-mvujk06p', 'memory', 'memory-card.json')
      const card = readJson(cardFile, null)
      const target = (card?.records || []).find((r) => String(r.title || '').includes(String(p.title || '')))
      if (!target) { skipped += 1; notes.push(`强化失败（找不到记录）：${p.title}`); continue }
      result = dryRun ? { ok: true } : await lib.applyMemoryCardAction('pin', { id: target.id, pinned: true })
    } else if (op === 'forget') {
      result = dryRun ? { ok: true } : await lib.applyMemoryCardAction('forget', { id: String(p.id || '') })
    } else {
      skipped += 1
      notes.push(`未知 op 跳过：${op}`)
      continue
    }

    if (!result?.ok) {
      return { ok: false, error: `应用失败（${op} / ${p.title || p.id}）：${result?.error || '未知'}`, applied: appliedCount }
    }
    applied.push({ ...p, status: 'applied', appliedAt: new Date().toISOString(), appliedBy: 'sleep-evolve(auto)' })
    appliedCount += 1
  }

  if (!dryRun && applied.length) {
    backup(proposalsFile)
    proposals.applied = [...(proposals.applied || []), ...applied]
    proposals.pending = pending.filter((p) => !applied.some((a) => a.id === p.id))
    proposals.history = [...(proposals.history || []), {
      at: new Date().toISOString(),
      action: 'apply-in-process',
      count: applied.length,
      ids: applied.map((x) => x.id),
    }]
    fs.writeFileSync(proposalsFile, JSON.stringify(proposals, null, 2) + '\n', 'utf8')
  }

  return { ok: true, applied: appliedCount, skipped, notes: notes.slice(0, 6), dryRun }
}
