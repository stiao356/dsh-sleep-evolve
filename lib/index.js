// dsh-sleep-evolve · DSH 宿主插件（睡眠进化）
//
// 与现有插件的分工（无冲突，各管一段）：
//   · dsh-hippocampus  → 白天在线记忆（stream.jsonl 只增不改），本插件夜里只读它的流水做巩固
//   · surfcore 记忆卡   → 每 10 分钟在线维护 + 每天 4 点衰减；本插件不写卡，只出"待确认提案"
//   · dsh-seekmemory   → 检索内核；本插件不碰
//   · efficiency-notes → 提示词纪律；无交集
// 本插件只写自己的目录 ~/.dsh/sleep-evolve/，并复用 surfcore 的 B站私信通道做夜间汇报。

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CONFIG, resolveDshHome, resolveSurfcoreRepo, resolveNodeCmd,
  loadConfig, readStatus, writeStatus, ensureBaseDir,
  inWindow, qqActiveRecently,
  collectQqPrivates, collectQqGroups, collectMemoryCard, collectHippocampus, collectBiliLearning,
  collectBiliDms, collectParamSnapshot, buildInput,
  CONSOLIDATION_SYSTEM, parseConsolidation,
  appendJournal, appendSubstrate, mergeProposals, refreshJournalMd,
  runDm, buildDmReport, maskNumbers,
} from './engine.js';

// 人格卡「生长记录」：只追加到末尾这一节，原件里的身份/边界永远不动。
const PERSONA_SECTION = '## 生长记录（睡眠进化自动追加）';
const PERSONA_MAX_LINES = 30;
const PERSONA_MERGE_AT = 12;   // 超过这个条数就做一次相似合并
const PERSONA_SIM = 0.55;      // 二元组重合率 >= 这个值视为同一件事

/** 去掉日期前缀后的正文，用于相似度比较。 */
function entryBody(line) {
  return String(line).replace(/^-\s*\[[^\]]*\]\s*/, '').trim();
}

/** 字符二元组 Dice 相似度（中文不需要分词，够用且不引依赖）。 */
function similarity(a, b) {
  const grams = (s) => {
    const t = String(s).replace(/[\s，。！？、,.!?；;：:"'「」『』（）()]/g, '');
    const out = new Set();
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
    if (!out.size) out.add(t);
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size || 1);
}

/** 把同主题的多条合并成最新一条，旧的进归档。返回 { kept, merged }。 */
function mergeSimilar(lines) {
  const kept = [];
  const merged = [];
  for (const line of lines) {
    const dupOf = kept.find((k) => similarity(entryBody(k), entryBody(line)) >= PERSONA_SIM);
    if (dupOf) { merged.push({ dropped: line, keptBy: dupOf }); continue; }
    // 新条目若和已收的相近，替换掉旧的那条（保留最近的表达）
    const idx = kept.findIndex((k) => similarity(entryBody(k), entryBody(line)) >= PERSONA_SIM);
    if (idx >= 0) { merged.push({ dropped: kept[idx], keptBy: line }); kept[idx] = line; continue; }
    kept.push(line);
  }
  return { kept, merged };
}

export function appendPersonaGrowth(charDir, line, date) {
  const file = path.join(charDir, 'persona.md');
  if (!fs.existsSync(file)) return { ok: false, error: 'persona.md 不存在' };
  const text = fs.readFileSync(file, 'utf8');

  let base = text;
  let lines = [];
  const idx = text.indexOf(PERSONA_SECTION);
  if (idx >= 0) {
    base = text.slice(0, idx).replace(/\s+$/, '');
    lines = text.slice(idx + PERSONA_SECTION.length).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  }

  // ① 判重：完全相同 → 跳过；和已有条目相似 → 不新增（保留旧的，避免复读）
  const body = entryBody(line);
  if (lines.some((l) => entryBody(l) === body)) return { ok: true, skipped: 'duplicate' };
  const near = lines.find((l) => similarity(entryBody(l), body) >= PERSONA_SIM);
  if (near) return { ok: true, skipped: 'similar', similarTo: near };

  lines.push(`- [${date}] ${line}`);

  // ② 相似合并：条数多起来就把同主题的压成一条，旧的进归档
  let merged = [];
  if (lines.length >= PERSONA_MERGE_AT) {
    const r = mergeSimilar(lines);
    lines = r.kept;
    merged = r.merged;
  }

  // ③ 硬上限兜底
  const overflow = [];
  while (lines.length > PERSONA_MAX_LINES) overflow.push(lines.shift());

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(file, `${file}.bak-growth-${ts}`); } catch { /* 备份失败不阻断，但下面照写 */ }
  fs.writeFileSync(file, `${base}\n\n${PERSONA_SECTION}\n\n${lines.join('\n')}\n`, 'utf8');

  const archived = [...merged.map((m) => m.dropped), ...overflow];
  if (archived.length) {
    const archive = path.join(charDir, 'persona-growth-archive.md');
    const header = fs.existsSync(archive) ? '' : '# 人格生长归档（从 persona.md 移出/合并的旧条目）\n\n';
    fs.appendFileSync(archive, header + archived.join('\n') + '\n', 'utf8');
  }
  return {
    ok: true,
    added: `- [${date}] ${line}`,
    trimmed: overflow.length,
    merged: merged.length,
    backedUp: `${path.basename(file)}.bak-growth-${ts}`,
  };
}

function findCharDir(dshHome) {
  try {
    const raw = fs.readFileSync(path.join(dshHome, 'surfcore', 'characters', 'current.json'), 'utf8');
    const current = JSON.parse(raw);
    const id = current?.current || current?.id;
    if (id) {
      const dir = path.join(dshHome, 'surfcore', 'characters', id);
      if (fs.existsSync(dir)) return dir;
    }
  } catch { /* ignore */ }
  try {
    const root = path.join(dshHome, 'surfcore', 'characters');
    if (fs.existsSync(root)) {
      for (const d of fs.readdirSync(root)) {
        if (d.startsWith('char-')) return path.join(root, d);
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function streamText(ctx, opts) {
  let text = '';
  let reasoning = '';
  let usage = null;
  const kinds = new Set();
  for await (const chunk of ctx.llm.stream(opts)) {
    kinds.add(chunk.type);
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'block-end') {
      const b = chunk.block || {};
      if (b.type === 'text' && b.text && !text) text += b.text;
      else if (b.type === 'reasoning' && b.text && !reasoning) reasoning += b.text;
    } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      throw new Error(`模型调用失败: ${chunk.reason.failure?.message || 'unknown'}`);
    } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
      throw new Error('模型调用被中止');
    }
  }
  if (!text && reasoning) text = reasoning;
  if (!text.trim()) {
    const err = new Error(`流已结束但没有文本（收到的 chunk 类型: ${[...kinds].join(',') || '无'}）`);
    err.code = 'EMPTY_STREAM';
    throw err;
  }
  return { text, usage };
}

function resolveModel(ctx) {
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (sel && typeof sel === 'object') {
      return {
        provider: String(sel.provider || sel.providerId || 'deepseek'),
        model: String(sel.model || sel.modelId || 'deepseek-chat'),
      };
    }
  } catch { /* ignore */ }
  return { provider: 'deepseek', model: 'deepseek-chat' };
}

/** 一次完整的夜间整理。返回结构化结果；失败时抛带 code 的错误。 */
export async function runConsolidation(ctx, config, dshHome, repo, charDir, extra = {}) {
  ensureBaseDir(dshHome);
  const socialV2 = path.join(repo, 'state', 'social-v2.json');
  const biliConfig = path.join(dshHome, 'surfcore', 'bili.config.json');
  const memoryCard = charDir ? path.join(charDir, 'memory', 'memory-card.json') : null;
  const date = new Date().toLocaleDateString('sv-SE');

  const status = readStatus(dshHome);
  if (!extra.force && status.lastRunDate === date) {
    const err = new Error('今天已经整理过，不重复跑（force=true 可强制）');
    err.code = 'ALREADY_RUN';
    throw err;
  }
  if (!extra.force && !inWindow(new Date(), config.window.start, config.window.end)) {
    const err = new Error(`现在不在睡眠窗口（${config.window.start}–${config.window.end}），夜间定时器只在窗口内触发`);
    err.code = 'NOT_IN_WINDOW';
    throw err;
  }
  if (!extra.force && fs.existsSync(socialV2) && qqActiveRecently(socialV2, config.minQuietMinutes)) {
    const err = new Error(`最近 ${config.minQuietMinutes} 分钟内 QQ 还有动静，先不整理（让出额度）`);
    err.code = 'QQ_ACTIVE';
    throw err;
  }

  const startedAt = Date.now();
  writeStatus(dshHome, { ...status, running: true, startedAt: new Date(startedAt).toISOString(), ok: false, error: '', code: '', hint: '' });

  try {
    // 1) 采集（全部只读 + 预算截断）
    const parts = {
      maxInputChars: config.maxInputChars,
      memoryCard: memoryCard ? collectMemoryCard(memoryCard, { maxChars: 10000 }) : '',
      qqPrivates: fs.existsSync(socialV2) ? collectQqPrivates(socialV2, {
        lookbackHours: config.lookbackHours,
        perConv: config.perConv,
        ownerPerConv: config.ownerPerConv,
        ownerKey: (() => {
          try {
            const bridgeCfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
            return bridgeCfg?.ownerQQ ? `private:${bridgeCfg.ownerQQ}` : '';
          } catch { return ''; }
        })(),
      }) : '',
      qqGroups: fs.existsSync(socialV2) ? collectQqGroups(socialV2, {
        lookbackHours: config.lookbackHours,
        perGroup: config.groupPerConv,
        totalChars: config.groupTotalChars,
      }) : '',
      hippocampus: collectHippocampus(dshHome, { lookbackHours: config.lookbackHours }),
      biliLearning: charDir ? collectBiliLearning(charDir) : '',
      biliDms: '',
      params: fs.existsSync(biliConfig) ? collectParamSnapshot(biliConfig, socialV2) : '',
    };
    const nodeCmd = resolveNodeCmd(config.nodeCmd);
    const dm = await collectBiliDms(dshHome, config.dmPollTimeoutMs);
    parts.biliDms = dm.text || '';
    if (!dm.text && dm.error) parts.biliDms = `（B站私信本次没取到：${maskNumbers(dm.error)}）`;
    const input = buildInput(parts);
    if (!input.trim()) {
      const err = new Error('没有可整理的数据（今天没有 QQ 私聊 / 记忆卡 / B站记录变化）');
      err.code = 'EMPTY_INPUT';
      throw err;
    }

    // 2) 模型整理（预算硬闸：请求数 + 输出 token + 超时）
    const { provider, model } = resolveModel(ctx);
    const personaName = (() => {
      try { return JSON.parse(fs.readFileSync(biliConfig, 'utf8')).self?.name || '小鱼'; } catch { return '小鱼'; }
    })();
    const lastSummary = status.lastSummary ? `\n上次整理的小结：${maskNumbers(String(status.lastSummary).slice(0, 120))}` : '';
    const system = CONSOLIDATION_SYSTEM + `\n\n你是「${maskNumbers(personaName)}」。${lastSummary}`;
    let text = '';
    let usage = null;
    let parsed = null;
    const maxAttempts = Math.max(1, config.maxRequests);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
      try {
        const messages = attempt === 0
          ? [{ role: 'user', content: [{ type: 'text', text: input }] }]
          : [
              { role: 'user', content: [{ type: 'text', text: input }] },
              { role: 'user', content: [{ type: 'text', text: '你上一次的输出不是合法 JSON。请重新输出：只要一个合法的 JSON 对象（以 { 开头、以 } 结尾），不要任何其他文字、解释或代码块。' }] },
            ];
        const r = await streamText(ctx, { provider, model, system, messages, maxTokens: config.maxTokens, temperature: 0.4, signal: ctrl.signal });
        text = r.text;
        usage = r.usage;
        try {
          parsed = parseConsolidation(text);
          break;
        } catch (parseErr) {
          if (attempt === maxAttempts - 1) {
            const err = new Error(`整理失败：模型输出无法解析（第 ${attempt + 1} 次）: ${parseErr.message}`);
            err.code = 'PARSE_FAILED';
            throw err;
          }
          // 带纠正提示重试一次
        }
      } catch (e) {
        if (e.code === 'PARSE_FAILED' || attempt === maxAttempts - 1) throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    if (!parsed) {
      const err = new Error('模型返回为空');
      err.code = 'EMPTY_OUTPUT';
      throw err;
    }

    // 3) 落盘（只写自己的目录）
    //   2026-11-01：human-world.md 是死文件（写了没人读进提示词），停写——
    //   「每天一句」留在 journal 的 substrateLine 里，人格生长改走 personaLine。
    const substrateRev = null;
    // 3.1) 人格卡生长（2026-11-01 主人授权：整理时可按经历自己改人设卡）
    //   只追加、不重写：在 persona.md 末尾的「生长记录」里每天最多加一条，改前备份，
    //   超过上限的最旧条目移到归档文件——原件里的身份/边界段落永不改动。
    let personaGrowth = null;
    if (parsed.personaLine && charDir) {
      try {
        personaGrowth = appendPersonaGrowth(charDir, parsed.personaLine, date);
      } catch (e) {
        personaGrowth = { ok: false, error: maskNumbers(String(e?.message || e)) };
      }
    }
    mergeProposals(dshHome, [
      ...parsed.memoryProposals.map((p) => ({ kind: 'memory', ...p })),
      ...parsed.paramSuggestions.map((p) => ({ kind: 'param', ...p })),
    ], date);

    // 3.5) 自动应用（2026-11-01 主人要求：整理完不用他确认，记忆类提案直接落卡）
    //   同进程调用：和宿主里的 surfcore 插件共用同一把写卡锁，不会并发覆盖；
    //   只落记忆类，参数类仍留 pending。
    let autoApply = null;
    if (config.autoApply !== false) {
      try {
        const { applyPendingProposals } = await import('./apply.js');
        autoApply = await applyPendingProposals({ dshHome, repo, dryRun: false, applyParams: false });
      } catch (e) {
        autoApply = { ok: false, error: maskNumbers(String(e.message || e)) };
      }
    }
    const entry = {
      at: new Date().toISOString(),
      date,
      summary: parsed.summary,
      journal: parsed.journal.slice(0, config.journalLimit),
      substrateLine: parsed.substrateLine,
      substrateRev,
      personaLine: parsed.personaLine || null,
      personaGrowth,
      memoryProposals: parsed.memoryProposals.slice(0, config.proposalLimit),
      paramSuggestions: parsed.paramSuggestions.slice(0, config.paramSuggestionLimit),
      usage: usage ? { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null, outputTokens: usage.outputTokens } : null,
      inputChars: input.length,
      elapsedMs: Date.now() - startedAt,
    };
    appendJournal(dshHome, entry);
    refreshJournalMd(dshHome);

    // 4) B站私信汇报（失败不吞：写进 status）
    let report = { ok: false, error: '', output: '' };
    if (config.report?.enabled && repo) {
      const msg = buildDmReport(entry, config.report.maxChars || 280);
      report = await runDm(repo, nodeCmd, msg);
    }

    const final = {
      ok: true,
      running: false,
      lastRunAt: new Date().toISOString(),
      lastRunDate: date,
      lastSummary: parsed.summary,
      code: '',
      error: '',
      hint: '',
      stats: (() => {
        // 2026-11-01：宿主偶尔只报一小段 usage（实测 27032 字却只有 101 input token）。
        // 明显不合理时标 suspicious 并给个按字数估的下限，别让人误以为真的只花了这么点。
        const inChars = input.length;
        const inTok = usage?.inputTokens ?? null;
        const suspicious = typeof inTok === 'number' && inChars > 2000 && inTok < Math.floor(inChars / 8);
        return {
          inputChars: inChars,
          inputTokens: inTok,
          inputTokensSuspicious: suspicious,
          inputTokensEstimate: suspicious ? Math.round(inChars / 2.5) : null,
          cacheReadTokens: usage?.cacheReadTokens ?? null,
          cacheWriteTokens: usage?.cacheWriteTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          // 原样留一份宿主的 usage，出争议时能直接看口径，不用再猜
          usageRaw: usage ? JSON.parse(JSON.stringify(usage)) : null,
          elapsedMs: Date.now() - startedAt,
          dmSent: report.ok,
        };
      })(),
      autoApply,
      dmError: report.error || '',
    };
    writeStatus(dshHome, final);
    return { entry, status: final };
  } catch (e) {
    const code = e.code || 'UNKNOWN';
    const final = {
      ok: false,
      running: false,
      lastErrorAt: new Date().toISOString(),
      code,
      error: maskNumbers(String(e.message || e)),
      hint: code === 'LLM_FAILED' ? '可稍后在 DSH 里让我再跑一次（sleep_evolve_run）' : '',
    };
    writeStatus(dshHome, { ...readStatus(dshHome), ...final });
    throw e;
  }
}

export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome();
  const saved = loadConfig(dshHome);
  const row = config && typeof config === 'object' ? config : {};
  const merged = {
    ...DEFAULT_CONFIG,
    ...saved,
    ...row,
    window: { ...DEFAULT_CONFIG.window, ...(saved.window || {}), ...(row.window || {}) },
    report: { ...DEFAULT_CONFIG.report, ...(saved.report || {}), ...(row.report || {}) },
  };
  ensureBaseDir(dshHome);

  let repo = null;
  try { repo = resolveSurfcoreRepo(dshHome, merged.surfcoreRepo); } catch { repo = null; }

  let running = false;
  const run = async (opts = {}) => {
    if (running) return { ok: false, code: 'BUSY', error: '一次整理正在进行中', hint: '' };
    running = true;
    try {
      const charDir = findCharDir(dshHome);
      const { entry, status } = await runConsolidation(ctx, merged, dshHome, repo, charDir, opts);
      return { ok: true, code: '', error: '', hint: '', summary: entry.summary, status };
    } catch (e) {
      return { ok: false, code: e.code || 'UNKNOWN', error: maskNumbers(String(e.message || e)), hint: e.code === 'LLM_FAILED' ? '稍后再试一次' : '' };
    } finally {
      running = false;
    }
  };

  // 定时器：每 2 分钟查一次窗口
  const stopTimer = ctx.timer?.interval?.(() => {
    const st = readStatus(dshHome);
    const date = new Date().toLocaleDateString('sv-SE');
    if (st.running) return;
    if (!inWindow(new Date(), merged.window.start, merged.window.end)) return;
    if (st.lastRunDate === date) return;
    void run().catch(() => {});
  }, 120000);

  // 工具（让鱼在任意 DSH 会话里能查看/手动触发）
  const disposers = [];
  if (merged.enableTools && ctx.tools?.register) {
    const defs = [
      {
        name: 'sleep_evolve_status',
        description: '查看睡眠进化插件上次夜间整理的状态（只读）。返回 ok/上次运行时间/统计/失败原因。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
        },
        async execute() {
          const st = readStatus(dshHome);
          const out = { ...st };
          delete out.running;
          return { text: JSON.stringify(out, null, 2) };
        },
      },
      {
        name: 'sleep_evolve_run',
        description: '立即执行一次睡眠整理（手动触发；不在睡眠窗口时默认被拒，传 force=true 强制运行）。整理所有记忆卡、QQ私聊、B站学习与私信，产出进化笔记、每日一句与待确认提案；结果默认经 B站私信汇报给主人。',
        parameters: {
          type: 'object',
          properties: { force: { type: 'boolean', description: '强制运行：跳过睡眠窗口/安静期/当日已跑检查。默认 false' } },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
        },
        async execute(args) {
          const res = await run({ force: Boolean(args?.force) });
          return { text: JSON.stringify(res, null, 2) };
        },
      },
      {
        name: 'sleep_evolve_journal',
        description: '读取睡眠进化笔记（最近 7 天整理产出，含每日一句人格基质来源）。只读。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
        },
        async execute() {
          const file = path.join(dshHome, 'sleep-evolve', 'journal.md');
          return { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8').slice(0, 6000) : '（还没有进化笔记）' };
        },
      },
      {
        name: 'sleep_evolve_proposals',
        description: '查看睡眠整理产生的待确认提案（记忆卡操作与生活参数建议；AI 只提议，需主人确认后才可应用）。只读。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
        },
        async execute() {
          const file = path.join(dshHome, 'sleep-evolve', 'proposals.json');
          if (!fs.existsSync(file)) return { text: '（还没有提案）' };
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          return { text: JSON.stringify((j.pending || []).slice(-20), null, 2) };
        },
      },
    ];
    for (const d of defs) disposers.push(ctx.tools.register(d));
  }

  return () => {
    stopTimer?.();
    disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
  };
}

export const inject = ['tools', 'llm', 'timer'];
